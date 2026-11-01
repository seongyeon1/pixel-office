import { expect, test, vi } from 'vitest';
import { createStore } from '../src/server/store.js';
import { createServer } from '../src/server/transport.js';
import type { Adapter, Run } from '../src/shared/contracts.js';
import { createOrchestrator } from '../src/server/orchestrator.js';
test('approval settings default to manual, require authentication and validate persisted values', async () => {
  const store = createStore(':memory:');
  const adapter: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: '' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: adapter, claude: adapter };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-approval-settings' });
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: o,
    token: 'test',
    port: 4317,
  });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/settings/approvals',
          headers,
          payload: { mode: 'auto' },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: 'test' },
    });
    const authed = { ...headers, cookie: login.headers['set-cookie'] as string };
    expect((await app.inject({ url: '/api/settings/approvals', headers: authed })).json()).toEqual({
      mode: 'manual',
    });
    for (const payload of [{}, { mode: 'all' }, { mode: 'auto', sandbox: false }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/settings/approvals',
            headers: authed,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/settings/approvals',
          headers: { ...authed, origin: 'https://elsewhere.test' },
          payload: { mode: 'auto' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/settings/approvals',
          headers: authed,
          payload: { mode: 'auto' },
        })
      ).json(),
    ).toEqual({ mode: 'auto' });
    expect(store.getSetting('approvals', {})).toEqual({ mode: 'auto' });
    expect((await app.inject({ url: '/api/settings/approvals', headers: authed })).json()).toEqual({
      mode: 'auto',
    });
  } finally {
    await app.close();
    await o.shutdown();
    store.close();
  }
});
test('concurrency settings default to 3, validate the limit, and health lists active runs', async () => {
  const store = createStore(':memory:');
  const adapter: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: '' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: adapter, claude: adapter };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-concurrency-settings' });
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: o,
    token: 'test',
    port: 4317,
  });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: 'test' },
    });
    const authed = { ...headers, cookie: login.headers['set-cookie'] as string };
    const url = '/api/settings/concurrency';
    expect((await app.inject({ url, headers })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: authed })).json()).toEqual({ limit: 3 });
    for (const payload of [{}, { limit: 0 }, { limit: 9 }, { limit: 2.5 }, { limit: 2, x: 1 }])
      expect((await app.inject({ method: 'POST', url, headers: authed, payload })).statusCode).toBe(
        400,
      );
    expect(
      (await app.inject({ method: 'POST', url, headers: authed, payload: { limit: 5 } })).json(),
    ).toEqual({ limit: 5 });
    expect(store.getSetting('concurrency', {})).toEqual({ limit: 5 });
    expect((await app.inject({ url, headers: authed })).json()).toEqual({ limit: 5 });
    const health = (await app.inject({ url: '/api/health', headers: authed })).json();
    expect(health).toMatchObject({ activeIds: [], activeId: null });
  } finally {
    await app.close();
    await o.shutdown();
    store.close();
  }
});
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
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs/missing/follow-up',
        headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' },
        payload: { prompt: 'next' },
      })
    ).statusCode,
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
  const authed = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs/missing/follow-up',
        headers: { ...authed, origin: 'https://foreign.example' },
        payload: { prompt: 'next' },
      })
    ).statusCode,
  ).toBe(403);
  for (const payload of [{ prompt: '' }, { prompt: 'next', worktreePath: '/outside' }])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runs/missing/follow-up',
          headers: authed,
          payload,
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs/missing/follow-up',
        headers: authed,
        payload: { prompt: 'next' },
      })
    ).statusCode,
  ).toBe(404);
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
    expect(response.json().directAvailable).toBe(true);
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
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6WQAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(root, 'image.png'), png);
    const imagePath = `/api/workspace/image?root=${encodeURIComponent(root)}&path=image.png`;
    expect((await app.inject({ url: imagePath, headers })).statusCode).toBe(401);
    const image = await app.inject({ url: imagePath, headers: trusted });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.rawPayload).toEqual(png);
    expect(
      (await app.inject({ url: imagePath.replace('image.png', '../image.png'), headers: trusted }))
        .statusCode,
    ).toBe(400);
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
  // A folder that is neither a repository nor holds any (tmpdir itself holds test repositories).
  const plainFolder = await mkdtemp(join(tmpdir(), 'pixel-harness-plain-'));
  expect((await post({ root: plainFolder, harness })).statusCode).toBeGreaterThanOrEqual(400);
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

test('observed-only folders that are not repositories say so in the project list', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const repo = await mkdtemp(join(tmpdir(), 'pixel-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init');
  await writeFile(join(repo, 'seed.txt'), 'seed');
  git('add', '.');
  git('-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed');
  const plain = await mkdtemp(join(tmpdir(), 'pixel-plain-'));
  const remembered = await mkdtemp(join(tmpdir(), 'pixel-remembered-'));
  const store = createStore(':memory:');
  // A remembered path that is no repository (moved, or recorded by an older build) is flagged too.
  store.rememberProject(remembered);
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const o = createOrchestrator({ store, adapters, dataDir: '/tmp/pixel-unavailable-transport' });
  const session = (id: string, projectPath: string) =>
    ({
      id,
      sessionId: id,
      provider: 'claude',
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
      sessions: [session('one', repo), session('two', plain)],
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
  const projects: { root: string; connected?: boolean; unavailable?: string }[] = (
    await app.inject({ url: '/api/projects', headers: { host, cookie } })
  ).json();
  const byRoot = new Map(projects.map((p) => [p.root, p]));
  expect(byRoot.get(repo)?.unavailable).toBeUndefined();
  expect(byRoot.get(plain)?.unavailable).toContain('Git');
  expect(byRoot.get(plain)?.connected).toBeUndefined();
  expect(byRoot.get(remembered)?.connected).toBe(true);
  expect(byRoot.get(remembered)?.unavailable).toContain('Git');
  await app.close();
  store.close();
});

test('coworker routes require authentication and enforce the roster rules', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'pixel-coworker-routes-')));
  const store = createStore(':memory:');
  const adapter: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: '' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: adapter, claude: adapter };
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir }),
    token: 't',
    port: 4317,
    dataDir,
  });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
  expect((await app.inject({ url: '/api/coworkers', headers })).statusCode).toBe(401);
  const login = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
    payload: { token: 't' },
  });
  const authed = { ...headers, cookie: login.headers['set-cookie'] as string };
  const body = {
    id: 'dev',
    name: 'dev',
    folder: dataDir,
    engine: 'claude',
    role: '',
    mode: 'solo',
    bindings: ['C1'],
    createdBy: 'user',
  };
  const call = (method: 'POST' | 'DELETE' | 'GET', url: string, payload?: object) =>
    app.inject({ method, url, headers: authed, payload });
  const saved = await call('POST', '/api/coworkers', body);
  expect(saved.statusCode).toBe(200);
  expect(saved.json().rules.length).toBeGreaterThan(0);
  expect(saved.json()).not.toHaveProperty('warnings');
  const codex = (await call('POST', '/api/coworkers', { ...body, engine: 'codex' })).json();
  expect(codex.warnings).toEqual([
    'Codex는 외부 도구를 하나씩 승인받을 수 없어요. 승인 규칙이 있는 동안 Codex 실행에서는 모든 MCP 서버, 플러그인, 앱 연결(커넥터)을 끄고 실행해요.',
  ]);
  expect((await call('POST', '/api/coworkers', { ...body, id: 'Bad Id' })).statusCode).toBe(400);
  const list = (await call('GET', '/api/coworkers')).json();
  expect(list.map((c: { id: string }) => c.id)).toEqual(['coordinator', 'dev']);
  expect((await call('GET', '/api/coworkers/suggestions')).json()).toEqual([]);
  expect((await call('DELETE', '/api/coworkers/coordinator')).statusCode).toBe(400);
  expect((await call('DELETE', '/api/coworkers/dev')).statusCode).toBe(200);
  await app.close();
  store.close();
});

test('Slack settings test the connection, store it privately and never echo tokens', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-slack-transport-'));
  const calls: string[] = [];
  let failWith: string | undefined;
  const slack = {
    test: async () => {
      calls.push('test');
      if (failWith) throw new Error(failWith);
    },
    connect: async () => void calls.push('connect'),
    disconnect: async () => void calls.push('disconnect'),
  };
  const make = (withSlack: boolean) =>
    createServer({
      store,
      adapters,
      orchestrator: createOrchestrator({ store, adapters, dataDir }),
      token: 't',
      port: 4317,
      dataDir,
      ...(withSlack ? { slack } : {}),
    });
  const host = '127.0.0.1:4317';
  const origin = 'http://127.0.0.1:4317';
  const login = async (server: Awaited<ReturnType<typeof make>>['app']) =>
    (
      await server.inject({
        method: 'POST',
        url: '/api/session',
        headers: { host, origin },
        payload: { token: 't' },
      })
    ).headers['set-cookie'] as string;
  const { app } = await make(true);
  const cookie = await login(app);
  const call = (method: 'GET' | 'POST' | 'DELETE', payload?: Record<string, unknown>) =>
    app.inject({ method, url: '/api/settings/slack', headers: { host, origin, cookie }, payload });
  const body = {
    botToken: 'xoxb-111-secret-wxyz',
    appToken: 'xapp-1-secret-app',
    ownerId: 'U01ABC',
  };
  try {
    expect((await call('GET')).json()).toEqual({ configured: false });
    expect((await call('POST', { ...body, botToken: 'bad' })).statusCode).toBe(400);
    expect((await call('POST', { ...body, ownerId: 'u01' })).statusCode).toBe(400);
    failWith = 'invalid_auth';
    const failed = await call('POST', body);
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toBe('Slack 연결을 확인하지 못했어요: invalid_auth');
    expect(failed.body).not.toContain('secret');
    expect((await call('GET')).json()).toEqual({ configured: false });
    expect(calls).toEqual(['test']);
    failWith = undefined;
    const ok = await call('POST', body);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain('secret');
    const got = await call('GET');
    expect(got.json()).toEqual({ configured: true, ownerId: 'U01ABC', botToken: 'xoxb-…wxyz' });
    expect(got.body).not.toContain('secret');
    expect(calls).toEqual(['test', 'test', 'connect']);
    expect((await call('DELETE')).statusCode).toBe(200);
    expect((await call('GET')).json()).toEqual({ configured: false });
    expect(calls.at(-1)).toBe('disconnect');
  } finally {
    await app.close();
  }
  const { app: bare } = await make(false);
  const res = await bare.inject({
    method: 'POST',
    url: '/api/settings/slack',
    headers: { host, origin, cookie: await login(bare) },
    payload: body,
  });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toBe('Slack 연결 기능을 사용할 수 없어요.');
  await bare.close();
});

test('a Slack connect failure after saving reports only the code and is remembered', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-slack-connect-'));
  let fail = true;
  let disconnectFails = false;
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir }),
    token: 't',
    port: 4317,
    dataDir,
    slack: {
      test: async () => {},
      connect: async () => {
        if (fail)
          throw Object.assign(new Error('boom xoxb-111-secret-wxyz'), { code: 'socket_closed' });
      },
      disconnect: async () => {
        if (disconnectFails) throw new Error('xoxb-111-secret-wxyz');
      },
    },
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
  const call = (method: 'GET' | 'POST' | 'DELETE', payload?: Record<string, unknown>) =>
    app.inject({ method, url: '/api/settings/slack', headers: { host, origin, cookie }, payload });
  const body = {
    botToken: 'xoxb-111-secret-wxyz',
    appToken: 'xapp-1-secret-app',
    ownerId: 'U01ABC',
  };
  try {
    const failed = await call('POST', body);
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toBe('Slack 연결을 확인하지 못했어요: socket_closed');
    expect(failed.body).not.toContain('secret');
    const got = await call('GET');
    expect(got.json()).toEqual({
      configured: true,
      ownerId: 'U01ABC',
      botToken: 'xoxb-…wxyz',
      error: 'socket_closed',
    });
    expect(got.body).not.toContain('secret');
    fail = false;
    expect((await call('POST', body)).statusCode).toBe(200);
    expect((await call('GET')).json()).not.toHaveProperty('error');
    disconnectFails = true;
    expect((await call('DELETE')).statusCode).toBe(200);
    expect((await call('GET')).json()).toEqual({ configured: false });
  } finally {
    await app.close();
  }
});

test('a boot-time Slack error shows in settings, and the server uses the given coworkers', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createCoworkers } = await import('../src/server/coworkers.js');
  const { writeSlackConfig } = await import('../src/server/slack/secrets.js');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-slack-boot-'));
  await writeSlackConfig(dataDir, {
    botToken: 'xoxb-111-secret-wxyz',
    appToken: 'xapp-1-secret-app',
    ownerId: 'U01ABC',
  });
  const coworkers = createCoworkers(store, { dataDir });
  const listed = vi.spyOn(coworkers, 'list');
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir }),
    token: 't',
    port: 4317,
    dataDir,
    coworkers,
    slack: {
      test: async () => {},
      connect: async () => {},
      disconnect: async () => {},
      error: () => 'invalid_auth',
    },
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
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { host, origin, cookie } });
  try {
    expect((await get('/api/settings/slack')).json()).toEqual({
      configured: true,
      ownerId: 'U01ABC',
      botToken: 'xoxb-…wxyz',
      error: 'invalid_auth',
    });
    expect((await get('/api/coworkers')).statusCode).toBe(200);
    expect(listed).toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('office desk and pending interactions are read-only and carry no secrets', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeSlackConfig } = await import('../src/server/slack/secrets.js');
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const adapters = { codex: a, claude: a };
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-desk-'));
  const { app } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir }),
    token: 't',
    port: 4317,
    dataDir,
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
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { host, origin, cookie } });
  try {
    expect((await get('/api/office/desk')).json()).toEqual({ slack: 'off', requests: [] });
    store.createRun({ id: 'live', status: 'waiting_approval' } as Run);
    store.createRun({ id: 'over', status: 'completed' } as Run);
    for (const runId of ['live', 'over'])
      store.saveInteraction({
        id: `i-${runId}`,
        runId,
        agentId: 'codex',
        kind: 'approval',
        title: 'Run it?',
        details: {},
        resolved: false,
      });
    await writeSlackConfig(dataDir, {
      botToken: 'xoxb-111-secret-wxyz',
      appToken: 'xapp-1-secret-app',
      ownerId: 'U01ABC',
    });
    const desk = await get('/api/office/desk');
    expect(desk.json()).toEqual({ slack: 'connected', requests: [] });
    const pending = await get('/api/interactions');
    expect(pending.json()).toHaveLength(1);
    expect(desk.body + pending.body).not.toContain('xox');
  } finally {
    await app.close();
  }
});
