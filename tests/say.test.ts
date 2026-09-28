import { expect, test, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as resume from '../src/server/resume.js';
import { createStore } from '../src/server/store.js';
import { createServer } from '../src/server/transport.js';
import { createOrchestrator } from '../src/server/orchestrator.js';
import { createChatService } from '../src/server/chat.js';
import type { Adapter, ObservedDetail } from '../src/shared/contracts.js';
import type { Observation } from '../src/server/observation/observer.js';

const id = '3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const adapter: Adapter = {
  probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
  execute: async () => ({ outcome: 'completed', text: '' }),
  close: async () => {},
};

test('instructions reach the resume terminal with the configured command, and settings are validated', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-say-')));
  const store = createStore(':memory:');
  const session: ObservedDetail = {
    id: 'one',
    sessionId: id,
    provider: 'codex',
    projectPath: root,
    cwd: root,
    label: '',
    prompt: '',
    model: '',
    status: 'idle',
    activity: 'idle',
    updatedAt: new Date().toISOString(),
    processAlive: null,
    truncated: false,
    events: [],
  };
  const observation = {
    get: (i: string) => (i === 'one' ? session : undefined),
    list: () => ({ sessions: [session], scannedAt: null, scanning: false, warnings: [] }),
  } as unknown as Observation;
  const chat = createChatService({
    store,
    getSession: observation.get,
    listSessions: () => observation.list().sessions,
    respond: async () => {},
    direct: async (input, update) => update(`direct: ${input.text}`),
  });
  const { app } = await createServer({
    store,
    adapters: { codex: adapter, claude: adapter },
    orchestrator: createOrchestrator({
      store,
      adapters: { codex: adapter, claude: adapter },
      dataDir: root,
    }),
    token: 'test',
    port: 4317,
    terminalShell: '/bin/sh',
    observation,
    chat,
    // Stand-ins print their arguments and echo every line they read, like a CLI would.
    agentCommands: {
      claude: `sh -c 'echo FAKE-CLAUDE "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake`,
      codex: `sh -c 'echo FAKE-CODEX "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake`,
    },
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
    const post = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: authed, payload });
    // Defaults come from the server; a wrapper name is accepted, a shell snippet is not.
    expect((await app.inject({ url: '/api/settings/direct', headers: authed })).json()).toEqual({
      commands: {
        claude: expect.stringContaining('FAKE-CLAUDE'),
        codex: expect.stringContaining('FAKE-CODEX'),
      },
    });
    expect(
      (await post('/api/settings/direct', { commands: { claude: 'sy; rm -rf ~', codex: 'syc' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/api/settings/direct', { commands: { claude: 'sy', codex: 'syc' } })).json(),
    ).toEqual({
      commands: { claude: 'sy', codex: 'syc' },
    });
    // With no terminal open, an instruction is a direct turn.
    expect((await post('/api/observed/missing/say', { text: 'hi' })).statusCode).toBe(404);
    expect((await post('/api/observed/one/say', { text: ' ' })).statusCode).toBe(400);
    const chatBefore = (
      await app.inject({ url: '/api/observed/one/chat', headers: authed })
    ).json();
    expect(chatBefore.channels).toMatchObject({ terminal: false, running: false, next: 'direct' });
    const direct = await post('/api/observed/one/say', { text: '정리해줘' });
    expect(direct.statusCode).toBe(202);
    expect(direct.json().channels.busy).toBe('direct');
    await new Promise((r) => setTimeout(r, 50));
    const afterDirect = (
      await app.inject({ url: '/api/observed/one/chat', headers: authed })
    ).json();
    expect(afterDirect.messages.at(-1)).toMatchObject({
      text: 'direct: 정리해줘',
      channel: 'direct',
      status: 'completed',
    });
    // A resume terminal runs the configured command; the next instruction is typed into it.
    store.setSetting('direct', {
      commands: {
        claude: 'true',
        codex: `sh -c 'echo FAKE-CODEX "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake`,
      },
    });
    store.setSetting('direct', { commands: { claude: 'true', codex: 'codex' } });
    const resumed = await post('/api/observed/one/resume', { mode: 'resume', cols: 80, rows: 24 });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().command).toBe(`codex resume ${id}`);
    const chatAfter = (await app.inject({ url: '/api/observed/one/chat', headers: authed })).json();
    expect(chatAfter.channels).toMatchObject({ terminal: true, next: 'terminal' });
    const typed = await post('/api/observed/one/say', {
      text: '테스트 돌려줘',
      channel: 'terminal',
    });
    expect(typed.statusCode).toBe(202);
    expect(typed.json().messages.at(-2)).toMatchObject({ role: 'user', channel: 'terminal' });
    expect(typed.json().messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'pending',
      channel: 'terminal',
    });
    expect((await post('/api/observed/one/say', { text: '또' })).statusCode).toBe(409);
    expect((await post('/api/observed/one/chat/cancel', {})).statusCode).toBe(200);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('app coworkers use the common conversation API with separate histories and refuse concurrent workflow writes', async () => {
  const { defaultTeam } = await import('../src/shared/contracts.js');
  const store = createStore(':memory:');
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-unified-'));
  store.createRun({
    id: 'app-run',
    projectPath: dataDir,
    worktreePath: dataDir,
    branch: 'main',
    baseCommit: 'base',
    prompt: 'build feature',
    mode: 'collaborate',
    implementer: 'codex',
    status: 'running',
    phase: 'implement',
    revision: 0,
    createdAt: new Date().toISOString(),
    team: defaultTeam(),
    executionMode: 'personal',
    sessions: {
      codex: { implementer: id },
      claude: { reviewer: '4f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6' },
    },
  });
  const reached: string[] = [];
  const chat = createChatService({
    store,
    getSession: () => undefined,
    respond: async (_, update) => update('기록 답변'),
    direct: async (input, update) => {
      reached.push(input.session.sessionId);
      expect(input.fork).toBe(false);
      if (input.text === 'hold') {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return;
      }
      update(`개별 답변: ${input.text}`, { sessionId: input.session.sessionId });
    },
  });
  const o = createOrchestrator({ store, adapters: { codex: adapter, claude: adapter }, dataDir });
  const { app, origin } = await createServer({
    store,
    adapters: { codex: adapter, claude: adapter },
    orchestrator: o,
    chat,
    token: 'test',
    port: 4317,
  });
  const headers = { host: '127.0.0.1:4317', origin };
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: 'test' },
    });
    const auth = { ...headers, cookie: login.headers['set-cookie'] as string };
    const get = async (url: string) => (await app.inject({ url, headers: auth })).json();
    const post = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: auth, payload });
    const all = (await get('/api/observed')).sessions;
    expect(all).toHaveLength(2);
    const codex = all.find((s: any) => s.provider === 'codex'),
      claude = all.find((s: any) => s.provider === 'claude');
    expect((await post(`/api/observed/${codex.id}/say`, { text: 'change it' })).statusCode).toBe(
      409,
    );
    expect((await post(`/api/observed/${codex.id}/resume`, { mode: 'fork' })).statusCode).toBe(409);
    store.updateRun('app-run', { status: 'completed', phase: 'done' });
    expect((await post(`/api/observed/${codex.id}/say`, { text: 'only codex' })).statusCode).toBe(
      202,
    );
    await expect
      .poll(async () => (await get(`/api/observed/${codex.id}/chat`)).messages.at(-1)?.status)
      .toBe('completed');
    expect(reached).toEqual([id]);
    expect((await get(`/api/observed/${claude.id}/chat`)).messages).toEqual([]);
    expect((await get(`/api/observed/${codex.id}/chat`)).messages.at(-1).text).toBe(
      '개별 답변: only codex',
    );
    // A direct turn can arrive while the original folder is being resolved.
    let releaseFolder!: () => void;
    const folderLookup = vi.spyOn(resume, 'resumeFolder').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseFolder = () => resolve(dataDir);
        }),
    );
    const resuming = post(`/api/observed/${codex.id}/resume`, { mode: 'resume' }).then((r) => r);
    await expect.poll(() => !!releaseFolder).toBe(true);
    expect((await post(`/api/observed/${codex.id}/say`, { text: 'hold' })).statusCode).toBe(202);
    releaseFolder();
    expect((await resuming).statusCode).toBe(409);
    folderLookup.mockRestore();
    const follow = await post('/api/runs/app-run/follow-up', { prompt: 'continue' });
    expect(follow.statusCode).toBe(409);
    expect(follow.json().error).toContain('개별 대화');
    await post(`/api/observed/${codex.id}/chat/cancel`, {});
  } finally {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
