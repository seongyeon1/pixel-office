import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/store.js';
import { createCoworkers } from '../src/server/coworkers.js';
import { createSlackConnection } from '../src/server/slack/connection.js';
import { writeSlackConfig } from '../src/server/slack/secrets.js';
import type { CoordinatorRun, CoordinatorTurn } from '../src/server/coordinator.js';
import type { InboundMessage, SlackPort } from '../src/server/slack/port.js';
import type { Run } from '../src/shared/contracts.js';

const OWNER = 'U0OWNER';
const config = { botToken: 'xoxb-1-secret', appToken: 'xapp-1-secret', ownerId: OWNER };
type Call = [string, ...unknown[]];

function setup(opts: { startFails?: boolean; runCoordinator?: CoordinatorRun } = {}) {
  const store = createStore(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-wiring-'));
  const coworkers = createCoworkers(store, { dataDir });
  const calls: Call[] = [];
  const ports: { onMessage?: (m: InboundMessage) => unknown }[] = [];
  const createPort = vi.fn((): SlackPort => {
    const self: { onMessage?: (m: InboundMessage) => unknown } = {};
    ports.push(self);
    return {
      start: async (m) => {
        if (opts.startFails)
          throw Object.assign(new Error('xapp-1-secret refused'), { code: 'socket_closed' });
        self.onMessage = m;
        calls.push(['start']);
      },
      stop: async () => void calls.push(['stop']),
      react: async (...a) => void calls.push(['react', ...a]),
      post: async (...a) => (calls.push(['post', ...a]), 'p1'),
      update: async () => {},
      upload: async () => {},
      openDm: async () => 'D0',
      authTest: async () => ({ teamId: 'T1', botUserId: 'B1' }),
    };
  });
  const orchestrator = {
    startFor: vi.fn(async () => ({ id: 'r1' }) as Run),
    followUp: vi.fn(async () => ({ id: 'r2' }) as Run),
    answer: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    queuePosition: vi.fn(() => 0),
  };
  const turns: CoordinatorTurn[] = [];
  const logged: string[] = [];
  const connection = createSlackConnection({
    store,
    coworkers,
    orchestrator,
    dataDir,
    interrupted: [],
    createPort,
    runCoordinator: async (turn) => {
      turns.push(turn);
      if (opts.runCoordinator) return opts.runCoordinator(turn);
      const reply = turn.tools.find((t) => t.name === 'reply')!;
      await reply.handler({ text: '읽어볼게요.' } as never, {});
      return { sessionId: 's1' };
    },
    log: (code) => void logged.push(code),
  });
  return { store, dataDir, calls, ports, createPort, orchestrator, turns, logged, connection };
}
let current: ReturnType<typeof setup> | undefined;
afterEach(() => {
  current?.store.close();
  current = undefined;
});
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};
const dm = (ts: string): InboundMessage => ({
  eventId: `E${ts}`,
  teamId: 'T1',
  channel: 'D1',
  channelType: 'im',
  user: OWNER,
  text: 'pixel 레포 README 첫 문단 요약해줘',
  ts,
  mentionsBot: false,
});

test('an owner DM gets 👀, wakes the coordinator, and its reply reaches the thread', async () => {
  const t = (current = setup());
  await t.connection.connect(config);
  t.ports[0]!.onMessage!(dm('1.1'));
  await until(() => t.calls.some((c) => c[0] === 'post'));
  expect(t.calls).toContainEqual(['react', 'D1', '1.1', 'eyes']);
  expect(t.turns[0]!.prompt).toContain('pixel 레포 README 첫 문단 요약해줘');
  expect(t.calls.find((c) => c[0] === 'post')!.slice(1, 3)).toEqual(['D1', '1.1']);
});

test('reconnecting stops the old gateway, and interrupted runs are announced once', async () => {
  const t = (current = setup());
  const job = t.store.createJob({
    threadKey: 'T1:D1:9.9',
    channel: 'D1',
    threadTs: '9.9',
    route: { kind: 'coordinator' },
  });
  t.store.createRun({
    id: 'old',
    status: 'running',
    origin: { kind: 'slack', jobId: job.id },
  } as Run);
  t.store.updateJob(job.id, {
    assignments: [{ id: 'a1', coworkerId: 'x', runId: 'old', task: 't' }],
  });
  const connection = createSlackConnection({
    store: t.store,
    coworkers: createCoworkers(t.store, { dataDir: t.dataDir }),
    orchestrator: t.orchestrator,
    dataDir: t.dataDir,
    interrupted: t.store.interruptActive(),
    createPort: t.createPort,
  });
  await connection.connect(config);
  await connection.connect(config);
  const notices = t.calls.filter((c) => c[0] === 'post' && String(c[4]).includes('재시작'));
  expect(notices).toHaveLength(1);
  expect(t.calls.map((c) => c[0])).toEqual(['start', 'post', 'stop', 'start']);
  await connection.disconnect();
  expect(t.calls.at(-1)).toEqual(['stop']);
});

test('a failed boot connect logs only the code, records it, and never throws', async () => {
  const t = (current = setup({ startFails: true }));
  await writeSlackConfig(t.dataDir, config);
  await t.connection.boot();
  expect(t.logged).toEqual(['socket_closed']);
  expect(t.connection.error()).toBe('socket_closed');
  await t.connection.disconnect();
  expect(t.connection.error()).toBeUndefined();
});

test('boot without a saved config does nothing', async () => {
  const t = (current = setup());
  await t.connection.boot();
  expect(t.createPort).not.toHaveBeenCalled();
  expect(t.connection.error()).toBeUndefined();
});

test('reconnecting stops the old coordinator: its turn is aborted and only the new one acts', async () => {
  let release!: () => void;
  const hung = new Promise<void>((r) => (release = r));
  const t = (current = setup({
    runCoordinator: async (turn) => {
      if (t.turns.length === 1) await hung;
      const reply = turn.tools.find((x) => x.name === 'reply')!;
      const result = await reply.handler({ text: `답 ${t.turns.length}` } as never, {});
      return result.isError ? {} : { sessionId: 's1' };
    },
  }));
  await t.connection.connect(config);
  t.ports[0]!.onMessage!(dm('1.1'));
  await until(() => t.turns.length === 1);
  await t.connection.connect(config);
  expect(t.turns[0]!.abortController.signal.aborted).toBe(true);
  release();
  t.ports[1]!.onMessage!(dm('2.2'));
  await until(() => t.turns.length === 2);
  await until(() => t.calls.filter((c) => c[0] === 'post').length === 1);
  await new Promise((r) => setTimeout(r, 30));
  const posts = t.calls.filter((c) => c[0] === 'post');
  expect(posts).toHaveLength(1);
  expect(String(posts[0]![4])).toBe('답 2');
});
