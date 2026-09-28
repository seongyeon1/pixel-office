import { expect, test } from 'vitest';
import { createStore } from '../src/server/store.js';
import { createSessionRegistry } from '../src/server/sessions.js';
import { defaultTeam, type Run, type ObservedDetail } from '../src/shared/contracts.js';
const run = (id = 'r1'): Run => ({
  id,
  projectPath: '/repo',
  worktreePath: '/repo',
  branch: 'main',
  baseCommit: 'a',
  prompt: 'build it',
  mode: 'collaborate',
  implementer: 'codex',
  status: 'completed',
  phase: 'done',
  revision: 0,
  createdAt: '2026-09-28T00:00:00Z',
  team: defaultTeam(),
  executionMode: 'personal',
  sessions: { codex: { implementer: 'native-codex' }, claude: { reviewer: 'native-claude' } },
});
test('app implementer and reviewer are individual coworkers, deduplicated against automated native logs', () => {
  const store = createStore(':memory:');
  store.createRun(run());
  const native: ObservedDetail = {
    id: 'raw',
    sessionId: 'native-claude',
    provider: 'claude',
    projectPath: '/repo',
    cwd: '/repo',
    label: '',
    prompt: 'injected prompt',
    model: 'opus',
    status: 'idle',
    activity: 'idle',
    updatedAt: '2026-09-28T00:00:01Z',
    processAlive: false,
    truncated: false,
    automated: true,
    events: [],
  };
  const registry = createSessionRegistry(store, {
    list: () => ({ sessions: [native], scannedAt: null, scanning: false, warnings: [] }),
    get: (id) => (id === 'raw' ? native : undefined),
  });
  try {
    const sessions = registry.list().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => !s.automated)).toBe(true);
    const c = sessions.find((s) => s.provider === 'claude')!;
    expect(c.managed).toMatchObject({ runId: 'r1', role: 'reviewer', resumable: true });
    expect(registry.get(c.id)?.prompt).toBe('build it');
    store.createRun({ ...run('r2'), parentRunId: 'r1', prompt: 'continue' });
    expect(registry.list().sessions).toHaveLength(2);
    expect(registry.get(c.id)?.managed?.runId).toBe('r2');
  } finally {
    store.close();
  }
});
test('old ephemeral Codex sessions retain readable records and explicitly need a new conversation', () => {
  const store = createStore(':memory:');
  const old = { ...run(), executionMode: undefined, sessions: undefined };
  store.createRun(old);
  store.append({
    runId: old.id,
    agentId: 'codex',
    type: 'agent.session',
    payload: { sessionId: 'old-native' },
  });
  store.append({
    runId: old.id,
    agentId: 'codex',
    type: 'phase.completed',
    payload: { text: 'legacy implementation' },
  });
  try {
    const registry = createSessionRegistry(store);
    const c = registry.list().sessions.find((s) => s.provider === 'codex')!;
    expect(c.managed?.resumable).toBe(false);
    expect(registry.get(c.id)?.events.some((e) => e.detail === 'legacy implementation')).toBe(true);
    expect(registry.get(c.id)?.sessionId).toBe('old-native');
  } finally {
    store.close();
  }
});

test('a coworker keeps conversation and retirement identity when its native session first appears', () => {
  const store = createStore(':memory:');
  store.createRun({ ...run(), sessions: undefined, status: 'running', phase: 'implement' });
  try {
    const registry = createSessionRegistry(store);
    const first = registry.list().sessions.find((s) => s.provider === 'claude')!;
    store.saveChat({
      id: 'question',
      sessionId: first.id,
      role: 'user',
      text: 'review question',
      status: 'completed',
      createdAt: run().createdAt,
    });
    store.retire(first);
    store.updateRun('r1', { sessions: { claude: { reviewer: 'just-started' } } });
    const next = registry.list().sessions.find((s) => s.provider === 'claude')!;
    expect(next.id).toBe(first.id);
    expect(store.listChat(next.id)[0].text).toBe('review question');
    expect(store.isRetired(next.id)).toBe(true);
  } finally {
    store.close();
  }
});

test('identical Codex launch requests match only their unique launch markers, never an older coworker', () => {
  const store = createStore(':memory:');
  const launches = ['first', 'second'].map((id) => ({
    id,
    root: '/repo',
    provider: 'codex',
    harness: 'personal',
    prompt: 'same task',
    createdAt: run().createdAt,
    terminal: { id: `terminal-${id}`, root: '/repo', shell: 'sh', cols: 80, rows: 24 },
  }));
  store.setSetting('launched-agents', { agents: launches });
  const native = ['old', 'first', 'second'].map(
    (id) =>
      ({
        id: `raw-${id}`,
        sessionId: `native-${id}`,
        provider: 'codex',
        projectPath: '/repo',
        cwd: '/repo',
        label: '',
        prompt: id === 'old' ? 'same task' : `<!-- pixel-office-launch:${id} -->\nsame task`,
        model: 'astra',
        status: 'idle',
        activity: 'idle',
        updatedAt: run().createdAt,
        processAlive: null,
        truncated: false,
        events: [],
      }) as ObservedDetail,
  );
  const registry = createSessionRegistry(store, {
    list: () => ({ sessions: native, scannedAt: null, scanning: false, warnings: [] }),
    get: (id) => native.find((s) => s.id === id),
  });
  try {
    expect(registry.get('launch-first')?.sessionId).toBe('native-first');
    expect(registry.get('launch-second')?.sessionId).toBe('native-second');
    expect(
      registry
        .list()
        .sessions.map((s) => s.id)
        .sort(),
    ).toEqual(['launch-first', 'launch-second', 'raw-old']);
  } finally {
    store.close();
  }
});
