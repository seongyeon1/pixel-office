import { expect, test } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumeConflict, resumeCommand, resumeFolder } from '../src/server/resume.js';
import { createStore } from '../src/server/store.js';
import { createServer } from '../src/server/transport.js';
import { createOrchestrator } from '../src/server/orchestrator.js';
import type { Adapter, ObservedDetail } from '../src/shared/contracts.js';
import type { Observation } from '../src/server/observation/observer.js';

const id = '3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6';

test('builds provider resume and fork commands from a plain session id only', () => {
  const claude = { provider: 'claude' as const, sessionId: id, processAlive: false };
  const codex = { provider: 'codex' as const, sessionId: id, processAlive: null };
  expect(resumeCommand(claude, 'resume')).toBe(`claude --resume ${id}`);
  expect(resumeCommand(claude, 'fork')).toBe(`claude --resume ${id} --fork-session`);
  expect(resumeCommand(codex, 'resume')).toBe(`codex resume ${id}`);
  expect(resumeCommand(codex, 'fork')).toBe(`codex fork ${id}`);
  expect(() => resumeCommand({ ...claude, sessionId: `${id}; rm -rf ~` }, 'resume')).toThrow(
    '세션 ID',
  );
  // A live process may only be forked, never written to from a second process.
  expect(() => resumeCommand({ ...claude, processAlive: true }, 'resume')).toThrow(ResumeConflict);
  expect(resumeCommand({ ...claude, processAlive: true }, 'fork')).toContain('--fork-session');
  expect(() => resumeCommand({ ...codex, status: 'active' }, 'resume')).toThrow(ResumeConflict);
});

test('resumes in the recorded folder and refuses a deleted worktree', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-resume-folder-')));
  try {
    expect(await resumeFolder({ cwd: root, projectPath: '/nope' })).toBe(root);
    await expect(resumeFolder({ cwd: join(root, 'removed'), projectPath: root })).rejects.toThrow(
      '작업 폴더',
    );
    await expect(resumeFolder({ cwd: '', projectPath: 'relative' })).rejects.toThrow('작업 폴더');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume route opens one tagged terminal per session and refuses live resumes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-resume-api-')));
  const session = (over: Partial<ObservedDetail>): ObservedDetail => ({
    id: 'observed-a',
    sessionId: id,
    provider: 'claude',
    projectPath: root,
    cwd: root,
    label: '',
    prompt: '',
    model: '',
    status: 'idle',
    activity: 'idle',
    updatedAt: '',
    processAlive: false,
    truncated: false,
    events: [],
    ...over,
  });
  const sessions = [session({}), session({ id: 'observed-live', processAlive: true })];
  const observation = {
    list: () => ({ sessions, scannedAt: null, scanning: false, warnings: [] }),
    get: (key: string) => sessions.find((s) => s.id === key),
  } as unknown as Observation;
  const store = createStore(':memory:');
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
    port: 4318,
    terminalShell: '/bin/sh',
    observation,
    agentCommands: { claude: 'echo claude', codex: 'echo codex' },
  });
  const headers = { host: '127.0.0.1:4318', origin };
  try {
    const post = (url: string, payload: Record<string, unknown>, extra = {}) =>
      app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload });
    expect((await post('/api/observed/observed-a/resume', { mode: 'resume' })).statusCode).toBe(
      401,
    );
    const auth = await post('/api/session', { token: 'test' });
    const cookie = (auth.headers['set-cookie'] as string).split(';')[0];
    const resume = (key: string, mode: string) =>
      post(`/api/observed/${key}/resume`, { mode }, { cookie });
    expect(
      (
        await post(
          '/api/observed/observed-a/resume',
          { mode: 'resume' },
          {
            cookie,
            origin: 'https://foreign.example',
          },
        )
      ).statusCode,
    ).toBe(403);
    expect((await resume('missing', 'resume')).statusCode).toBe(404);
    expect((await resume('observed-a', 'rewrite')).statusCode).toBe(400);
    const live = await resume('observed-live', 'resume');
    expect(live.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          url: '/api/observed/observed-a/terminal',
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(404);
    const concurrent = await Promise.all([
      resume('observed-a', 'resume'),
      resume('observed-a', 'resume'),
    ]);
    expect(concurrent[0].json().id).toBe(concurrent[1].json().id);
    const first = concurrent[0];
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      root,
      tag: 'observed-a',
      command: `echo claude --resume ${id}`,
    });
    // A second click reattaches instead of starting another process on the same transcript.
    expect((await resume('observed-a', 'fork')).json().id).toBe(first.json().id);
    expect(
      (
        await app.inject({
          url: '/api/observed/observed-a/terminal',
          headers: { ...headers, cookie },
        })
      ).json().id,
    ).toBe(first.json().id);
    const get = (url: string) => app.inject({ url, headers: { ...headers, cookie } });
    expect(
      (
        await post(
          '/api/observed/observed-a/retire',
          {},
          { cookie, origin: 'https://foreign.example' },
        )
      ).statusCode,
    ).toBe(403);
    expect((await post('/api/observed/missing/retire', {}, { cookie })).statusCode).toBe(404);
    expect((await post('/api/observed/observed-a/retire', {}, { cookie })).statusCode).toBe(200);
    expect((await get(`/api/terminals/${first.json().id}`)).statusCode).toBe(404);
    const snapshot = (await get('/api/observed')).json();
    expect(snapshot.sessions.map((s: ObservedDetail) => s.id)).toEqual(['observed-live']);
    expect(snapshot.retired[0]).toMatchObject({ id: 'observed-a', available: true });
    expect((await get('/api/projects')).json()[0].observedCount).toBe(1);
    expect((await resume('observed-a', 'resume')).statusCode).toBe(409);
    expect((await post('/api/observed/observed-a/restore', {}, { cookie })).statusCode).toBe(200);
    expect((await get('/api/observed')).json().sessions).toHaveLength(2);
    expect((await get('/api/observed')).json().retired).toEqual([]);
    // Retirement affects only this app's viewer/terminal, never another provider process.
    expect((await post('/api/observed/observed-live/retire', {}, { cookie })).statusCode).toBe(200);
    expect(sessions[1].processAlive).toBe(true);
    expect((await post('/api/observed/observed-live/restore', {}, { cookie })).statusCode).toBe(
      200,
    );
    const forked = await resume('observed-live', 'fork');
    expect(forked.json().command).toBe(`echo claude --resume ${id} --fork-session`);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retirement survives a store restart without deleting records', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-retired-store-')));
  let store = createStore(join(root, 'office.sqlite'));
  try {
    const session = {
      id: 'retired-codex',
      sessionId: id,
      provider: 'codex',
      projectPath: root,
      cwd: root,
      label: 'old worker',
      prompt: 'retained task',
      model: '',
      status: 'idle',
      activity: 'idle',
      updatedAt: '',
      processAlive: null,
      truncated: false,
    } as const;
    store.retire(session);
    store.close();
    store = createStore(join(root, 'office.sqlite'));
    expect(store.isRetired(session.id)).toBe(true);
    expect(store.listRetired()[0]).toMatchObject({ id: session.id, prompt: 'retained task' });
    expect(store.listProjects()[0].root).toBe(root);
    store.restore(session.id);
    expect(store.listRetired()).toEqual([]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
