import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/store.js';
import { createCoworkers } from '../src/server/coworkers.js';
import { createSlackGateway, type WakeReason } from '../src/server/slack/gateway.js';
import type { InboundAction, InboundMessage, SlackPort } from '../src/server/slack/port.js';
import type { Interaction, Run } from '../src/shared/contracts.js';

const OWNER = 'U0OWNER';
type Call = [string, ...unknown[]];

function setup(opts: { port?: Partial<SlackPort>; onError?: (code: string) => void } = {}) {
  const store = createStore(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-gw-'));
  const coworkers = createCoworkers(store, { dataDir });
  const calls: Call[] = [];
  let onMessage!: (m: InboundMessage) => unknown;
  let onAction!: (a: InboundAction) => unknown;
  let n = 0;
  const port: SlackPort = {
    start: async (m, a) => {
      onMessage = m;
      onAction = a;
    },
    stop: async () => {},
    react: async (...args) => void calls.push(['react', ...args]),
    post: async (...args) => {
      calls.push(['post', ...args]);
      return `p${++n}`;
    },
    update: async (...args) => void calls.push(['update', ...args]),
    upload: async (...args) => void calls.push(['upload', ...args]),
    openDm: async () => 'D0',
    authTest: async () => ({ teamId: 'T1', botUserId: 'B1' }),
    ...opts.port,
  };
  let runs = 0;
  const answered = new Set<string>();
  const orchestrator = {
    startFor: vi.fn(async (coworker: { id: string }, prompt: string, origin?: Run['origin']) => {
      calls.push(['startFor', coworker.id, prompt, origin]);
      const run = { id: `run${++runs}`, status: 'queued', coworkerId: coworker.id, origin } as Run;
      store.createRun(run);
      return run;
    }),
    followUp: vi.fn(async (id: string, prompt: string, opts: { whenDone?: boolean }) => {
      calls.push(['followUp', id, prompt, opts]);
      const source = store.getRun(id)!;
      const run = { ...source, id: `run${++runs}`, parentRunId: id, status: 'queued' } as Run;
      store.createRun(run);
      return run;
    }),
    // Mirrors the real answer(): resolves once and emits interaction.resolved synchronously.
    answer: vi.fn(async (id: string, answer: unknown) => {
      calls.push(['answer', id, answer]);
      if (answered.has(id)) throw new Error('이미 해결되었거나 종료된 요청입니다.');
      answered.add(id);
      store.resolveInteraction(id);
      const req = store.getInteraction(id)!;
      store.append({
        runId: req.runId,
        agentId: req.agentId,
        type: 'interaction.resolved',
        payload: { id },
      });
    }),
    queuePosition: vi.fn((_id: string) => 0),
  };
  const coordinator = {
    wake: vi.fn((jobId: string, reason: WakeReason) => void calls.push(['wake', jobId, reason])),
  };
  const gateway = createSlackGateway({
    store,
    port,
    coworkers,
    orchestrator,
    coordinator,
    ownerId: OWNER,
    debounceMs: 1000,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
    eventId: `Ev${Math.random()}`,
    teamId: 'T1',
    channel: 'D1',
    channelType: 'im',
    user: OWNER,
    text: '회의록 정리해줘',
    ts: '100.1',
    mentionsBot: false,
    ...over,
  });
  const send = async (over: Partial<InboundMessage> = {}) => {
    await onMessage(message(over));
  };
  const click = async (over: Partial<InboundAction>) => {
    const responses: unknown[][] = [];
    await onAction({
      userId: OWNER,
      channel: 'D1',
      messageTs: 'p1',
      actionId: 'pixel:approve',
      value: '{}',
      respond: async (...args) => void responses.push(args),
      ...over,
    });
    return responses;
  };
  const bind = (channel: string) =>
    coworkers.save({
      id: 'meeting',
      name: '회의록 담당',
      folder: dataDir,
      engine: 'claude',
      role: '',
      mode: 'solo',
      bindings: [channel],
      createdBy: 'user',
    });
  const runFor = (jobId: string, over: Partial<Run> = {}) => {
    const run = {
      id: `r-${Math.random()}`,
      status: 'running',
      coworkerId: 'meeting',
      origin: { kind: 'slack', jobId },
      ...over,
    } as Run;
    store.createRun(run);
    return run;
  };
  const updated = (run: Run) =>
    store.append({ runId: run.id, agentId: null, type: 'run.updated', payload: { run } });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    store,
    dataDir,
    coworkers,
    calls,
    gateway,
    orchestrator,
    coordinator,
    send,
    click,
    bind,
    runFor,
    updated,
    settle,
    names: () => calls.map((c) => c[0]),
  };
}
let current: ReturnType<typeof setup> | undefined;
const start = async (opts?: Parameters<typeof setup>[0]) => {
  current = setup(opts);
  await current.gateway.start();
  return current;
};
afterEach(async () => {
  vi.useRealTimers();
  await current?.gateway.stop();
  current?.store.close();
  current = undefined;
});

test('the same message delivered twice makes one job', async () => {
  const t = await start();
  await t.send({ eventId: 'Ev1' });
  await t.send({ eventId: 'Ev1' });
  // Bolt delivers a channel mention as both `message` and `app_mention` with different ids.
  await t.send({
    eventId: 'Ev2',
    channel: 'C9',
    channelType: 'channel',
    ts: '7.7',
    mentionsBot: true,
  });
  await t.send({
    eventId: 'Ev3',
    channel: 'C9',
    channelType: 'channel',
    ts: '7.7',
    mentionsBot: true,
  });
  expect(t.coordinator.wake).toHaveBeenCalledTimes(2);
  expect(t.store.getJobByThread('T1:D1:100.1')).toBeDefined();
  expect(t.store.getJobByThread('T1:C9:7.7')).toBeDefined();
});

test('ignores other users, bots, subtypes and unbound channels without a mention', async () => {
  const t = await start();
  await t.send({ user: 'U0OTHER' });
  await t.send({ ts: '2', botId: 'B9' });
  await t.send({ ts: '3', subtype: 'message_changed' });
  await t.send({ ts: '4', channel: 'C1', channelType: 'channel' });
  await t.send({ ts: '5', user: undefined });
  expect(t.calls).toEqual([]);
});

test('a DM gets the eyes reaction before the coordinator wakes', async () => {
  const t = await start();
  await t.send();
  expect(t.names()).toEqual(['react', 'wake']);
  expect(t.calls[0]).toEqual(['react', 'D1', '100.1', 'eyes']);
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  expect(job).toMatchObject({ channel: 'D1', threadTs: '100.1', route: { kind: 'coordinator' } });
  expect(t.calls[1]).toEqual(['wake', job.id, { kind: 'new', text: '회의록 정리해줘' }]);
});

test('a channel mention starts a coordinator job without the mention token', async () => {
  const t = await start();
  await t.send({
    channel: 'C1',
    channelType: 'channel',
    mentionsBot: true,
    text: '<@B1> 계획 세워줘',
  });
  expect(t.calls.at(-1)?.[2]).toEqual({ kind: 'new', text: '계획 세워줘' });
});

test('a reply in a job thread wakes the coordinator with the reply', async () => {
  const t = await start();
  await t.send();
  await t.send({ ts: '100.2', threadTs: '100.1', text: '그리고 요약도' });
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  expect(t.calls.at(-1)).toEqual(['wake', job.id, { kind: 'reply', text: '그리고 요약도' }]);
  expect(t.names().filter((n) => n === 'react')).toHaveLength(1);
});

test('a reply in a channel job thread needs no mention', async () => {
  const t = await start();
  await t.send({ channel: 'C1', channelType: 'channel', mentionsBot: true, ts: '1.1' });
  await t.send({ channel: 'C1', channelType: 'channel', ts: '1.2', threadTs: '1.1', text: '더' });
  expect(t.calls.at(-1)?.[2]).toEqual({ kind: 'reply', text: '더' });
});

test('a bound channel goes straight to its coworker and replies follow up when done', async () => {
  const t = await start();
  t.bind('C1');
  await t.send({ channel: 'C1', channelType: 'channel', ts: '1.1' });
  const job = t.store.getJobByThread('T1:C1:1.1')!;
  expect(job.route).toEqual({ kind: 'coworker', coworkerId: 'meeting' });
  expect(t.names()).toEqual(['react', 'startFor']);
  expect(t.calls[1]).toEqual([
    'startFor',
    'meeting',
    '회의록 정리해줘',
    { kind: 'slack', jobId: job.id },
  ]);
  expect(t.store.getJob(job.id)!.assignments).toMatchObject([
    { coworkerId: 'meeting', runId: 'run1', task: '회의록 정리해줘' },
  ]);
  expect(t.store.jobForRun('run1')?.id).toBe(job.id);
  await t.send({ channel: 'C1', channelType: 'channel', ts: '1.2', threadTs: '1.1', text: '표로' });
  expect(t.calls.at(-1)).toEqual(['followUp', 'run1', '표로', { whenDone: true }]);
  await t.send({ channel: 'C1', channelType: 'channel', ts: '1.3', threadTs: '1.1', text: '굵게' });
  // Each follow-up continues the latest assignment.
  expect(t.calls.at(-1)).toEqual(['followUp', 'run2', '굵게', { whenDone: true }]);
  expect(t.coordinator.wake).not.toHaveBeenCalled();
});

test('a failed start is told in the thread', async () => {
  const t = await start();
  t.bind('C1');
  t.orchestrator.startFor.mockRejectedValueOnce(new Error('claude: 로그인이 필요해요.'));
  await t.send({ channel: 'C1', channelType: 'channel', ts: '1.1' });
  const post = t.calls.find((c) => c[0] === 'post')!;
  expect(post.slice(1, 3)).toEqual(['C1', '1.1']);
  expect(post[4]).toContain('로그인이 필요해요');
});

test('run updates for a job are batched into one status message edit per second', async () => {
  const t = await start();
  vi.useFakeTimers();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const run = t.runFor(job.id);
  t.store.updateJob(job.id, {
    assignments: [{ id: 'a1', coworkerId: 'meeting', runId: run.id, task: '회의록' }],
  });
  t.updated(run);
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.names().filter((n) => n === 'post')).toHaveLength(1);
  expect(t.store.getJob(job.id)!.statusTs).toBe('p1');
  for (let i = 0; i < 3; i++) {
    t.updated(run);
    await vi.advanceTimersByTimeAsync(150);
  }
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.names().filter((n) => n === 'update')).toHaveLength(1);
  expect(t.calls.find((c) => c[0] === 'update')!.slice(1, 3)).toEqual(['D1', 'p1']);
  // Runs that did not come from Slack are not mirrored.
  const local = { id: 'local', status: 'running' } as Run;
  t.store.createRun(local);
  t.updated(local);
  await vi.advanceTimersByTimeAsync(2000);
  expect(t.names().filter((n) => n === 'update' || n === 'post')).toHaveLength(2);
});

const approval = (runId: string, over: Partial<Interaction> = {}): Interaction => ({
  id: `i-${Math.random()}`,
  runId,
  agentId: 'claude',
  kind: 'approval',
  title: 'git push',
  details: { tool: 'Bash', command: 'git push' },
  resolved: false,
  ...over,
});
const request = (t: ReturnType<typeof setup>, interaction: Interaction) => {
  t.store.saveInteraction(interaction);
  t.store.append({
    runId: interaction.runId,
    agentId: interaction.agentId,
    type: 'interaction.requested',
    payload: { interaction },
  });
};

test('approval requests become buttons that only the owner can press', async () => {
  const t = await start();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const run = t.runFor(job.id);
  const req = approval(run.id);
  request(t, req);
  await t.settle();
  const post = t.calls.find((c) => c[0] === 'post')!;
  expect(post.slice(1, 3)).toEqual(['D1', '100.1']);
  const value = JSON.stringify({ interactionId: req.id });
  expect(JSON.stringify(post[3])).toContain('pixel:approve');

  const stranger = await t.click({ userId: 'U0OTHER', value });
  expect(stranger).toHaveLength(1);
  // Only the clicker sees the refusal; the buttons stay for the owner.
  expect(stranger[0].slice(1)).toEqual(['이 작업은 소유자만 처리할 수 있어요.', false]);
  expect(t.orchestrator.answer).not.toHaveBeenCalled();

  const responses = await t.click({ value });
  expect(responses).toEqual([]);
  expect(t.orchestrator.answer).toHaveBeenCalledWith(req.id, { decision: 'approve' });
  await t.settle();
  const edit = t.calls.find((c) => c[0] === 'update')!;
  expect(edit.slice(1, 3)).toEqual(['D1', 'p1']);
  expect(JSON.stringify(edit[3])).toContain('승인됨');

  const again = await t.click({ value, actionId: 'pixel:deny' });
  expect(JSON.stringify(again[0][0])).toContain('이미 처리됨');
});

test('an approval handled in the office marks the Slack reply', async () => {
  const t = await start();
  await t.send();
  const run = t.runFor(t.store.getJobByThread('T1:D1:100.1')!.id);
  const req = approval(run.id);
  request(t, req);
  await t.settle();
  t.store.append({
    runId: run.id,
    agentId: 'claude',
    type: 'interaction.resolved',
    payload: { id: req.id },
  });
  await t.settle();
  expect(JSON.stringify(t.calls.find((c) => c[0] === 'update')![3])).toContain('오피스에서 처리됨');
});

test('an automatic approval without a reply adds a line to the status message', async () => {
  const t = await start();
  vi.useFakeTimers();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const run = t.runFor(job.id);
  t.store.updateJob(job.id, {
    statusTs: 's1',
    assignments: [{ id: 'a1', coworkerId: 'meeting', runId: run.id, task: '회의록' }],
  });
  t.store.append({
    runId: run.id,
    agentId: 'claude',
    type: 'interaction.resolved',
    payload: { id: 'gone', automatic: true, text: '자동 승인: git diff' },
  });
  await vi.advanceTimersByTimeAsync(1000);
  const edit = t.calls.find((c) => c[0] === 'update')!;
  expect(edit[2]).toBe('s1');
  expect(JSON.stringify(edit[3])).toContain('자동 승인: git diff');
});

test('question options are buttons; a free-form question takes the next thread reply', async () => {
  const t = await start();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const run = t.runFor(job.id);
  const choice = approval(run.id, {
    kind: 'question',
    details: {
      questions: [{ id: 'q1', question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }],
    },
  });
  request(t, choice);
  await t.settle();
  await t.click({
    actionId: 'pixel:answer',
    value: JSON.stringify({ interactionId: choice.id, option: 'B' }),
  });
  expect(t.orchestrator.answer).toHaveBeenLastCalledWith(choice.id, { answers: { q1: ['B'] } });

  const free = approval(run.id, {
    kind: 'question',
    details: { questions: [{ question: '이름은?' }] },
  });
  request(t, free);
  await t.settle();
  t.coordinator.wake.mockClear();
  await t.send({ ts: '100.5', threadTs: '100.1', text: 'pixel' });
  expect(t.orchestrator.answer).toHaveBeenLastCalledWith(free.id, {
    answers: { '이름은?': ['pixel'] },
  });
  expect(t.coordinator.wake).not.toHaveBeenCalled();
  // Answered, so the next reply is a normal follow-up again.
  await t.send({ ts: '100.6', threadTs: '100.1', text: '고마워' });
  expect(t.coordinator.wake).toHaveBeenCalledWith(job.id, { kind: 'reply', text: '고마워' });
});

test('a finished coordinator assignment wakes the coordinator once', async () => {
  const t = await start();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const run = t.runFor(job.id, { status: 'completed' });
  t.store.updateJob(job.id, {
    assignments: [{ id: 'a1', coworkerId: 'meeting', runId: run.id, task: '회의록' }],
  });
  t.updated(run);
  t.updated(run);
  await t.settle();
  expect(t.coordinator.wake).toHaveBeenLastCalledWith(job.id, {
    kind: 'assignment_done',
    assignmentId: 'a1',
  });
  expect(t.coordinator.wake).toHaveBeenCalledTimes(2);
});

test('slack_seen forgets keys after a day and jobs are found by run', () => {
  const store = createStore(':memory:');
  expect(store.markSlackSeen('C1:1.1', 0)).toBe(true);
  expect(store.markSlackSeen('C1:1.1', 1000)).toBe(false);
  expect(store.markSlackSeen('C1:1.1', 24 * 3600_000 + 1)).toBe(true);
  const job = store.createJob({
    threadKey: 'T:C:1',
    channel: 'C',
    threadTs: '1',
    route: { kind: 'coordinator' },
  });
  expect(store.getJob(job.id)).toMatchObject({ state: 'open', assignments: [] });
  store.updateJob(job.id, { assignments: [{ id: 'a', coworkerId: 'x', runId: 'r9', task: 't' }] });
  expect(store.jobForRun('r9')?.id).toBe(job.id);
  store.createRun({ id: 'r10', origin: { kind: 'slack', jobId: job.id } } as Run);
  expect(store.jobForRun('r10')?.id).toBe(job.id);
  expect(store.jobForRun('nope')).toBeUndefined();
  store.close();
});

test('a failed start can be retried without doubling the event listener', async () => {
  let attempts = 0;
  const t = setup({
    port: {
      start: async () => {
        if (++attempts === 1) throw new Error('socket');
      },
    },
  });
  current = t;
  await expect(t.gateway.start()).rejects.toThrow('socket');
  expect(t.store.bus.listenerCount('event')).toBe(0);
  await t.gateway.start();
  expect(t.store.bus.listenerCount('event')).toBe(1);
});

test('a throwing onError never becomes an unhandled rejection', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const t = await start({
      port: { react: async () => Promise.reject(new Error('ratelimited')) },
      onError: () => {
        throw new Error('logger down');
      },
    });
    await t.send();
    await t.settle();
    await t.settle();
    expect(t.coordinator.wake).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('a failed answer that left the request open goes to the error path, not "이미 처리됨"', async () => {
  const errors: string[] = [];
  const t = await start({ onError: (code) => void errors.push(code) });
  await t.send();
  const run = t.runFor(t.store.getJobByThread('T1:D1:100.1')!.id);
  const req = approval(run.id);
  request(t, req);
  await t.settle();
  t.orchestrator.answer.mockRejectedValueOnce(new Error('응답 형식이 맞지 않습니다.'));
  const responses = await t.click({ value: JSON.stringify({ interactionId: req.id }) });
  expect(responses).toEqual([]);
  expect(errors).toHaveLength(1);
});

test('a request closed because its run ended says so', async () => {
  const t = await start();
  await t.send();
  const run = t.runFor(t.store.getJobByThread('T1:D1:100.1')!.id);
  const req = approval(run.id);
  request(t, req);
  await t.settle();
  t.store.append({
    runId: run.id,
    agentId: 'claude',
    type: 'interaction.resolved',
    payload: { id: req.id, closed: true },
  });
  await t.settle();
  expect(JSON.stringify(t.calls.find((c) => c[0] === 'update')![3])).toContain(
    '작업이 끝나 닫혔어요',
  );
});

test('the coordinator replies in the job thread', async () => {
  const t = await start();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  await t.gateway.reply(job.id, '회의록 동료에게 맡길게요.');
  const post = t.calls.at(-1)!;
  expect(post.slice(1, 3)).toEqual(['D1', '100.1']);
  expect(post[4]).toBe('회의록 동료에게 맡길게요.');
});

test('a proposed coworker is created only when the owner presses 만들기', async () => {
  const t = await start();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const draft = {
    id: 'skt-dev',
    name: 'SKT 개발',
    folder: t.dataDir,
    role: 'SKT 담당',
    engine: 'codex' as const,
  };
  await t.gateway.propose(job.id, draft);
  const post = t.calls.at(-1)!;
  const blocks = JSON.stringify(post[3]);
  expect(blocks).toContain('pixel:propose-create');
  expect(blocks).toContain('pixel:propose-cancel');
  expect(blocks).toContain('SKT 개발');
  const proposalId = Object.keys(t.store.getJob(job.id)!.proposals ?? {})[0];
  const value = JSON.stringify({ jobId: job.id, proposalId });

  const stranger = await t.click({ userId: 'U0OTHER', actionId: 'pixel:propose-create', value });
  expect(stranger[0].slice(1)).toEqual(['이 작업은 소유자만 처리할 수 있어요.', false]);
  expect(t.coworkers.get('skt-dev')).toBeUndefined();

  const done = await t.click({ actionId: 'pixel:propose-create', value });
  expect(t.coworkers.get('skt-dev')).toMatchObject({
    name: 'SKT 개발',
    engine: 'codex',
    createdBy: 'coordinator',
    mode: 'solo',
    bindings: [],
  });
  expect(t.coworkers.get('skt-dev')!.rules.length).toBeGreaterThan(0);
  expect(JSON.stringify(done[0][0])).toContain('새 동료를 만들었어요: SKT 개발');
  expect(t.coordinator.wake).toHaveBeenLastCalledWith(job.id, {
    kind: 'reply',
    text: '새 동료를 만들었어요: SKT 개발',
  });
  expect(t.store.getJob(job.id)!.proposals).toEqual({});

  const again = await t.click({ actionId: 'pixel:propose-create', value });
  expect(JSON.stringify(again[0][0])).toContain('이미 처리됨');
});

test('a cancelled proposal creates nothing; a bad folder is told', async () => {
  const t = await start();
  await t.send();
  const job = t.store.getJobByThread('T1:D1:100.1')!;
  const base = { name: '없는 폴더', role: '', engine: 'claude' as const };
  await t.gateway.propose(job.id, { ...base, id: 'a', folder: t.dataDir });
  await t.gateway.propose(job.id, { ...base, id: 'b', folder: '/nope/missing' });
  const [first, second] = Object.keys(t.store.getJob(job.id)!.proposals!);
  const cancelled = await t.click({
    actionId: 'pixel:propose-cancel',
    value: JSON.stringify({ jobId: job.id, proposalId: first }),
  });
  expect(JSON.stringify(cancelled[0][0])).toContain('제안을 취소했어요');
  expect(t.coworkers.get('a')).toBeUndefined();
  const failed = await t.click({
    actionId: 'pixel:propose-create',
    value: JSON.stringify({ jobId: job.id, proposalId: second }),
  });
  expect(failed[0][1]).toContain('폴더를 찾을 수 없어요');
  expect(t.coworkers.get('b')).toBeUndefined();
  expect(t.coordinator.wake).toHaveBeenCalledTimes(1);
});
