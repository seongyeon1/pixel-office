import { expect, test } from 'vitest';
import { createStore } from '../src/server/store.js';
import { createServer } from '../src/server/transport.js';
import type { Adapter } from '../src/shared/contracts.js';
import { createOrchestrator } from '../src/server/orchestrator.js';
test('rejects foreign origins and unauthenticated actions; bootstrap grants a session', async () => {
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-transport-test' });
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: o,
    token: 'test-token',
    port: 4317,
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        headers: { host: '127.0.0.1:4317', origin: 'https://foreign.example' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: '/api/runs', headers: { host: '127.0.0.1:4317' } })).statusCode,
  ).toBe(401);
  const r = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' },
    payload: { token: 'test-token' },
  });
  expect(r.statusCode).toBe(200);
  const cookie = r.headers['set-cookie'] as string;
  expect(
    (await app.inject({ url: '/api/runs', headers: { host: '127.0.0.1:4317', cookie } })).json(),
  ).toEqual([]);
  await app.close();
  store.close();
});

test('chat routes require authentication, validate input, and cancel only their own reply', async () => {
  const { createChatService } = await import('../src/server/chat.js');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-chat-transport' });
  const snapshot: import('../src/shared/contracts.js').ObservedDetail = {
    id: 'one',
    sessionId: 'one',
    provider: 'codex',
    projectPath: '/repo',
    cwd: '/repo',
    label: '',
    prompt: 'test',
    model: '',
    status: 'active',
    activity: 'reading',
    updatedAt: new Date().toISOString(),
    processAlive: null,
    truncated: false,
    events: [],
  };
  const getSession = (id: string) => (id === 'one' ? snapshot : undefined);
  const chat = createChatService({
    store,
    getSession,
    respond: async (input, update) => {
      update('pending');
      await new Promise<void>((r) =>
        input.signal.addEventListener('abort', () => r(), { once: true }),
      );
    },
  });
  const observation = {
    get: getSession,
  } as import('../src/server/observation/observer.js').Observation;
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: o,
    token: 'test',
    port: 4317,
    observation,
    chat,
  });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
  try {
    expect((await app.inject({ url: '/api/observed/one/chat', headers })).statusCode).toBe(401);
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: 'test' },
    });
    const authed = { ...headers, cookie: session.headers['set-cookie'] as string };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/observed/one/chat',
          headers: { ...authed, origin: 'https://foreign.test' },
          payload: { question: 'hi' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/observed/one/chat',
          headers: authed,
          payload: { question: ' ' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/observed/missing/chat',
          headers: authed,
          payload: { question: 'hi' },
        })
      ).statusCode,
    ).toBe(404);
    const response = await app.inject({
      method: 'POST',
      url: '/api/observed/one/chat',
      headers: authed,
      payload: { question: 'hello' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().directAvailable).toBe(false);
    expect(response.json().mode).toBe('records');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/observed/one/chat',
          headers: authed,
          payload: { question: 'duplicate' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ url: '/api/observed/two/chat', headers: authed })).json().messages,
    ).toEqual([]);
    await app.inject({
      method: 'POST',
      url: '/api/observed/one/chat/cancel',
      headers: authed,
      payload: {},
    });
    expect(chat.list('one').at(-1)?.status).toBe('cancelled');
  } finally {
    await app.close();
    store.close();
  }
});

test('workspace routes and terminal websocket reject foreign origins and unknown roots', async () => {
  const { mkdtemp, realpath, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer: createNetServer } = await import('node:net');
  const { WebSocket } = await import('ws');
  const { once } = await import('node:events');
  const reserve = createNetServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = (reserve.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-workspace-api-')));
  await writeFile(join(root, 'README.md'), 'workspace fixture');
  const store = createStore(':memory:');
  store.rememberProject(root);
  const adapter: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: '' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: adapter, claude: adapter };
  const { app, origin } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir: root }),
    token: 'test',
    terminalShell: '/bin/sh',
    port,
  });
  const headers = { host: `127.0.0.1:${port}`, origin };
  try {
    await app.listen({ port, host: '127.0.0.1' });
    const path = `/api/workspace/file?root=${encodeURIComponent(root)}&path=README.md`;
    expect((await app.inject({ url: path, headers })).statusCode).toBe(401);
    const auth = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: 'test' },
    });
    const cookie = (auth.headers['set-cookie'] as string).split(';')[0];
    const trusted = { ...headers, cookie };
    expect((await app.inject({ url: path, headers: trusted })).json().text).toBe(
      'workspace fixture',
    );
    expect(
      (await app.inject({ url: path, headers: { ...trusted, origin: 'https://foreign.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/terminals', headers, payload: { root } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/terminals',
          headers: trusted,
          payload: { root: '/' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/terminals',
          headers: { ...trusted, origin: 'https://foreign.example' },
          payload: { root },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: trusted,
      payload: { root },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    for (const wsHeaders of [
      { origin },
      { origin: 'https://foreign.example', cookie },
      { cookie },
    ]) {
      const denied = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?id=${id}`, {
          headers: wsHeaders,
        });
        ws.on('error', () => {});
        ws.on('unexpected-response', (_req, response) => {
          const code = response.statusCode!;
          response.destroy();
          ws.terminate();
          resolve(code);
        });
        ws.on('open', () => {
          ws.terminate();
          reject(new Error('Unauthorized websocket accepted'));
        });
      });
      expect(denied).toBe(403);
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?id=${id}`, {
      headers: { origin, cookie },
    });
    const [raw] = await once(ws, 'message');
    expect(JSON.parse(raw.toString()).type).toBe('ready');
    ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: -1 }));
    const error = await new Promise<any>((r) =>
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      }),
    );
    expect(error.message).toContain('입력을 처리');
    const closed = once(ws, 'close');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/terminals/${id}/close`,
          headers: trusted,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await closed;
    expect((await app.inject({ url: `/api/terminals/${id}`, headers: trusted })).statusCode).toBe(
      404,
    );
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('harness routes need a session, validate settings and store them per real repository', async () => {
  const { mkdtemp, writeFile, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { emptyHarness } = await import('../src/shared/contracts.js');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-harness-transport' });
  let listed = 0;
  const catalog = {
    claude: {
      plugins: [{ id: 'superpowers@mk', name: 'superpowers', description: '' }],
      skills: [],
    },
    codex: { plugins: [], skills: [], error: 'codex not installed' },
  };
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: o,
    token: 'test-token',
    port: 4317,
    harnessCatalog: async () => {
      listed++;
      return catalog;
    },
  });
  const host = '127.0.0.1:4317';
  const origin = 'http://127.0.0.1:4317';
  expect((await app.inject({ url: '/api/harness/catalog', headers: { host } })).statusCode).toBe(
    401,
  );
  const cookie = (
    await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: 'test-token' },
    })
  ).headers['set-cookie'] as string;
  const get = (url: string) => app.inject({ url, headers: { host, cookie } });
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/harness', headers: { host, origin, cookie }, payload });
  expect((await get('/api/harness/catalog')).json()).toEqual(catalog);
  await get('/api/harness/catalog');
  expect(listed).toBe(1);
  const repo = await mkdtemp(join(tmpdir(), 'pixel-harness-repo-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  await writeFile(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-m', 's'],
    {
      cwd: repo,
      stdio: 'pipe',
    },
  );
  const harness = emptyHarness();
  harness.claude.plugins = ['superpowers@mk'];
  harness.codex.projectDoc = true;
  expect((await post({ root: repo, harness })).statusCode).toBe(200);
  const root = await realpath(repo);
  expect((await get(`/api/harness?root=${encodeURIComponent(root)}`)).json()).toEqual(harness);
  // Unknown keys, non-repositories and foreign origins are refused.
  expect((await post({ root: repo, harness: { ...harness, extra: {} } })).statusCode).toBe(400);
  expect((await post({ root: tmpdir(), harness })).statusCode).toBeGreaterThanOrEqual(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/harness',
        headers: { host, origin: 'https://foreign.example', cookie },
        payload: { root: repo, harness },
      })
    ).statusCode,
  ).toBe(403);
  await app.close();
  store.close();
});

test('rooms merged by hand move their sessions to the target room and can be split again', async () => {
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-rooms-transport' });
  const session = (id: string, projectPath: string) =>
    ({
      id,
      sessionId: id,
      provider: 'codex',
      projectPath,
      cwd: projectPath,
      label: '',
      prompt: '',
      model: '',
      status: 'active',
      activity: 'editing',
      updatedAt: new Date().toISOString(),
      processAlive: null,
      truncated: false,
    }) as import('../src/shared/contracts.js').ObservedSession;
  const observation = {
    list: () => ({
      sessions: [
        session('one', '/work/langconnect'),
        session('two', '/work/langconnect/repo'),
        { ...session('smoke', '/tmp/pixel-smoke/project'), automated: true },
      ],
      scannedAt: null,
      scanning: false,
      warnings: [],
    }),
    get: () => undefined,
  } as unknown as import('../src/server/observation/observer.js').Observation;
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: o,
    token: 't',
    port: 4317,
    observation,
  });
  const host = '127.0.0.1:4317';
  const origin = 'http://127.0.0.1:4317';
  const cookie = (
    await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: 't' },
    })
  ).headers['set-cookie'] as string;
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { host, origin, cookie }, payload });
  const rooms = async () =>
    (await app.inject({ url: '/api/observed', headers: { host, cookie } }))
      .json()
      .sessions.map((s: { projectPath: string }) => s.projectPath);
  expect(
    (
      await post('/api/rooms/merge', {
        source: '/work/langconnect',
        target: '/work/langconnect/repo',
      })
    ).statusCode,
  ).toBe(200);
  expect(await rooms()).toEqual([
    '/work/langconnect/repo',
    '/work/langconnect/repo',
    '/tmp/pixel-smoke/project',
  ]);
  const projects = (await app.inject({ url: '/api/projects', headers: { host, cookie } })).json();
  expect(projects.map((p: { root: string }) => p.root)).toEqual(['/work/langconnect/repo']);
  // Script-started sessions never make a folder a project.
  expect(projects.map((p: { root: string }) => p.root)).not.toContain('/tmp/pixel-smoke/project');
  // Merging back would loop.
  expect(
    (
      await post('/api/rooms/merge', {
        source: '/work/langconnect/repo',
        target: '/work/langconnect',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await app.inject({ url: '/api/rooms/aliases', headers: { host, cookie } })).json(),
  ).toEqual([{ source: '/work/langconnect', target: '/work/langconnect/repo' }]);
  await post('/api/rooms/split', { source: '/work/langconnect' });
  expect(await rooms()).toEqual([
    '/work/langconnect',
    '/work/langconnect/repo',
    '/tmp/pixel-smoke/project',
  ]);
  await app.close();
  store.close();
});

test('departments are named folders, stored by their real path, one per folder', async () => {
  const { mkdtemp, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-departments' });
  const { app } = await createServer({ store, adapters, orchestrator: o, token: 't', port: 4317 });
  const host = '127.0.0.1:4317';
  const origin = 'http://127.0.0.1:4317';
  const cookie = (
    await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host, origin },
      payload: { token: 't' },
    })
  ).headers['set-cookie'] as string;
  const folder = await mkdtemp(join(tmpdir(), 'pixel-dept-'));
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { host, origin, cookie },
      payload,
    });
  const created = await post({ name: 'skt', root: folder });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ name: 'skt', root: await realpath(folder) });
  expect((await post({ name: 'again', root: folder })).statusCode).toBe(400);
  expect((await post({ name: 'relative', root: 'project/skt' })).statusCode).toBe(400);
  expect((await post({ name: '', root: '/x' })).statusCode).toBe(400);
  const list = (await app.inject({ url: '/api/departments', headers: { host, cookie } })).json();
  expect(list.map((d: { name: string }) => d.name)).toEqual(['skt']);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/departments/${created.json().id}`,
        headers: { host, origin: 'https://foreign.example', cookie },
      })
    ).statusCode,
  ).toBe(403);
  await app.inject({
    method: 'DELETE',
    url: `/api/departments/${created.json().id}`,
    headers: { host, origin, cookie },
  });
  expect((await app.inject({ url: '/api/departments', headers: { host, cookie } })).json()).toEqual(
    [],
  );
  await app.close();
  store.close();
});

test('terminal questions: the hook needs its own token, answering needs the browser session', async () => {
  const { createQuestionDesk } = await import('../src/server/questions.js');
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const claudeHome = await mkdtemp(join(tmpdir(), 'pixel-claude-home-'));
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-transport-test' }),
    token: 'test-token',
    port: 4317,
    questions: createQuestionDesk(),
    hookToken: 'hook-secret',
    hookSetup: { claudeHome, command: 'node /opt/pixel/scripts/ask-hook.mjs' },
  });
  const host = { host: '127.0.0.1:4317' };
  const payload = { sessionId: 's-1', cwd: '/work', questions: [{ question: 'Q?' }] };
  const ask = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/hook/questions', headers, payload });
  try {
    expect((await ask(host)).statusCode).toBe(403);
    expect((await ask({ ...host, 'x-pixel-hook': 'wrong' })).statusCode).toBe(403);
    // The browser session is not a hook token.
    const browser = { ...host, origin: 'http://127.0.0.1:4317' };
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: browser,
      payload: { token: 'test-token' },
    });
    const authed = { ...browser, cookie: session.headers['set-cookie'] as string };
    expect((await ask(authed)).statusCode).toBe(403);
    const opened = await ask({ ...host, 'x-pixel-hook': 'hook-secret' });
    expect(opened.statusCode).toBe(200);
    const { id } = opened.json();

    // The hook token cannot read or answer questions as the browser.
    expect(
      (
        await app.inject({
          url: '/api/questions',
          headers: { ...host, 'x-pixel-hook': 'hook-secret' },
        })
      ).statusCode,
    ).toBe(401);
    const list = await app.inject({ url: '/api/questions', headers: authed });
    expect(list.json()).toMatchObject([{ id, sessionId: 's-1', questions: payload.questions }]);
    const answer = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/api/questions/${id}/answer`,
        headers,
        payload: { answers: { 'Q?': ['yes'] } },
      });
    expect((await answer({ ...authed, origin: 'https://foreign.example' })).statusCode).toBe(403);
    expect((await answer(authed)).statusCode).toBe(200);
    expect((await answer(authed)).statusCode).toBe(400);
    const outcome = await app.inject({
      url: `/api/hook/questions/${id}?wait=0`,
      headers: { ...host, 'x-pixel-hook': 'hook-secret' },
    });
    expect(outcome.json()).toEqual({ status: 'answered', answers: { 'Q?': 'yes' } });

    const hook = (path: string) =>
      app.inject({
        method: 'POST',
        url: `/api/terminal-hook${path}`,
        headers: authed,
        payload: {},
      });
    expect((await app.inject({ url: '/api/terminal-hook', headers: authed })).json()).toMatchObject(
      {
        available: true,
        installed: false,
      },
    );
    expect((await hook('/install')).json()).toMatchObject({ installed: true });
    const settings = JSON.parse(await readFile(join(claudeHome, 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      'node /opt/pixel/scripts/ask-hook.mjs',
    );
    expect((await hook('/uninstall')).json()).toMatchObject({ installed: false });
  } finally {
    await app.close();
    store.close();
  }
});
