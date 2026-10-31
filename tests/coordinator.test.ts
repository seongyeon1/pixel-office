import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/store.js';
import { createCoworkers } from '../src/server/coworkers.js';
import {
  createCoordinator,
  type CoordinatorTurn,
  type CoworkerDraft,
} from '../src/server/coordinator.js';
import { COORDINATOR_AGENTS } from '../src/server/coordinator-agents.js';
import type { Run } from '../src/shared/contracts.js';

type Step = (turn: CoordinatorTurn) => Promise<void>;

function setup() {
  const store = createStore(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-coord-'));
  const coworkers = createCoworkers(store, { dataDir });
  for (const id of ['meeting', 'planner']) {
    const folder = join(dataDir, id);
    mkdirSync(folder);
    coworkers.save({
      id,
      name: id === 'meeting' ? '회의록 담당' : '기획 담당',
      folder,
      engine: 'claude',
      role: `${id} 역할`,
      mode: 'solo',
      bindings: [],
      createdBy: 'user',
    });
  }
  let runs = 0;
  const orchestrator = {
    startFor: vi.fn(async (coworker: { id: string }, prompt: string, origin?: Run['origin']) => {
      const run = { id: `run${++runs}`, status: 'queued', coworkerId: coworker.id, origin } as Run;
      store.createRun(run);
      return run;
    }),
    followUp: vi.fn(async (id: string, _prompt: string, _opts: { whenDone?: boolean }) => {
      const run = { ...store.getRun(id)!, id: `run${++runs}`, parentRunId: id } as Run;
      store.createRun(run);
      return run;
    }),
    cancel: vi.fn(async (_id: string) => {}),
    queuePosition: vi.fn((_id: string) => 0),
  };
  const replies: [string, string][] = [];
  const proposals: [string, CoworkerDraft][] = [];
  const steps: Step[] = [];
  const turns: CoordinatorTurn[] = [];
  const run = vi.fn(async (turn: CoordinatorTurn): Promise<{ sessionId?: string }> => {
    turns.push(turn);
    await steps.shift()?.(turn);
    return { sessionId: `s${turns.length}` };
  });
  const coordinator = createCoordinator({
    store,
    coworkers,
    orchestrator,
    dataDir,
    reply: async (jobId, text) => void replies.push([jobId, text]),
    propose: async (jobId, draft) => void proposals.push([jobId, draft]),
    run,
  });
  const job = store.createJob({
    threadKey: 'T1:D1:1.1',
    channel: 'D1',
    threadTs: '1.1',
    route: { kind: 'coordinator' },
  });
  return {
    store,
    dataDir,
    coworkers,
    orchestrator,
    coordinator,
    job,
    steps,
    turns,
    run,
    replies,
    proposals,
  };
}
let current: ReturnType<typeof setup> | undefined;
afterEach(() => {
  current?.store.close();
  current = undefined;
});
const start = () => (current = setup());

const call = async (turn: CoordinatorTurn, name: string, args: Record<string, unknown> = {}) => {
  const tool = turn.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const result = await tool.handler(args as never, {});
  const text = (result.content[0] as { text: string }).text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
};

test('a delegate after another assignment waits, then starts with the earlier result', async () => {
  const t = start();
  let first = '';
  t.steps.push(async (turn) => {
    expect(turn.tools.map((x) => x.name).sort()).toEqual(
      [
        'cancel',
        'delegate',
        'follow_up',
        'job_status',
        'list_coworkers',
        'propose_coworker',
        'reply',
      ].sort(),
    );
    const listed = await call(turn, 'list_coworkers');
    expect((listed.coworkers as { id: string }[]).map((c) => c.id)).toEqual(['meeting', 'planner']);
    first = String(
      (await call(turn, 'delegate', { coworkerId: 'meeting', task: '회의록 정리' })).assignmentId,
    );
    const second = await call(turn, 'delegate', {
      coworkerId: 'planner',
      task: '계획 세우기',
      after: first,
    });
    expect(second.status).toBe('pending');
    await call(turn, 'reply', { text: '회의록 → 기획 순서로 할게요.' });
  });
  t.coordinator.wake(t.job.id, { kind: 'new', text: 'skt 회의록 보고 계획 세워줘' });
  await t.coordinator.settled();
  expect(t.turns[0].prompt).toContain('skt 회의록 보고 계획 세워줘');
  expect(t.orchestrator.startFor).toHaveBeenCalledTimes(1);
  expect(t.orchestrator.startFor.mock.calls[0][0].id).toBe('meeting');
  expect(t.orchestrator.startFor.mock.calls[0][2]).toEqual({ kind: 'slack', jobId: t.job.id });
  expect(t.replies).toEqual([[t.job.id, '회의록 → 기획 순서로 할게요.']]);
  const job = t.store.getJob(t.job.id)!;
  expect(job.coordinatorSessionId).toBe('s1');
  expect(job.assignments).toMatchObject([
    { id: first, coworkerId: 'meeting', runId: 'run1', task: '회의록 정리' },
    { coworkerId: 'planner', task: '계획 세우기', after: first },
  ]);
  expect(job.assignments[1].runId).toBeUndefined();

  t.store.updateRun('run1', { status: 'completed', summary: '회의 요약: 금요일 마감' });
  t.coordinator.wake(t.job.id, { kind: 'assignment_done', assignmentId: first });
  await t.coordinator.settled();
  expect(t.orchestrator.startFor).toHaveBeenCalledTimes(2);
  const [coworker, prompt] = t.orchestrator.startFor.mock.calls[1];
  expect(coworker.id).toBe('planner');
  expect(prompt).toBe('이전 단계 결과:\n회의 요약: 금요일 마감\n\n계획 세우기');
  expect(t.store.getJob(t.job.id)!.assignments[1].runId).toBe('run2');
  // The coordinator still wakes, resuming its session, and sees both assignments.
  expect(t.turns[1].resume).toBe('s1');
  expect(t.turns[1].prompt).toContain('회의 요약: 금요일 마감');
  expect(t.turns[1].prompt).toContain('계획 세우기');
});

test('a dependent of an assignment that did not complete stays pending; cancel drops it', async () => {
  const t = start();
  let first = '';
  let second = '';
  t.steps.push(async (turn) => {
    first = String(
      (await call(turn, 'delegate', { coworkerId: 'meeting', task: '회의록' })).assignmentId,
    );
    second = String(
      (await call(turn, 'delegate', { coworkerId: 'planner', task: '계획', after: first }))
        .assignmentId,
    );
  });
  t.coordinator.wake(t.job.id, { kind: 'new', text: '해줘' });
  await t.coordinator.settled();
  t.store.updateRun('run1', { status: 'failed', error: '오류' });
  t.steps.push(async (turn) => {
    expect(turn.prompt).toContain('오류');
    await call(turn, 'cancel', { assignmentId: second });
  });
  t.coordinator.wake(t.job.id, { kind: 'assignment_done', assignmentId: first });
  await t.coordinator.settled();
  expect(t.orchestrator.startFor).toHaveBeenCalledTimes(1);
  expect(t.store.getJob(t.job.id)!.assignments.map((a) => a.id)).toEqual([first]);
});

test('follow_up waits for the run and cancel stops a started assignment', async () => {
  const t = start();
  t.steps.push(async (turn) => {
    const { assignmentId } = await call(turn, 'delegate', {
      coworkerId: 'meeting',
      task: '회의록',
    });
    const next = await call(turn, 'follow_up', { assignmentId, prompt: '표로' });
    expect(next.assignmentId).not.toBe(assignmentId);
    await call(turn, 'cancel', { assignmentId: next.assignmentId });
    const status = await call(turn, 'job_status');
    expect((status.assignments as unknown[]).length).toBe(2);
    await expect(call(turn, 'delegate', { coworkerId: 'nobody', task: 'x' })).rejects.toThrow(
      '동료를 찾을 수 없어요',
    );
  });
  t.coordinator.wake(t.job.id, { kind: 'new', text: '해줘' });
  await t.coordinator.settled();
  expect(t.orchestrator.followUp).toHaveBeenCalledWith('run1', '표로', { whenDone: true });
  expect(t.orchestrator.cancel).toHaveBeenCalledWith('run2');
  expect(t.run).toHaveBeenCalledTimes(1);
});

test('wakes for one job run one at a time; different jobs overlap', async () => {
  const t = start();
  const other = t.store.createJob({
    threadKey: 'T1:D1:2.2',
    channel: 'D1',
    threadTs: '2.2',
    route: { kind: 'coordinator' },
  });
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  t.run.mockImplementation(async (turn: CoordinatorTurn) => {
    const name = turn.prompt.includes('둘') ? 'two' : turn.prompt.includes('셋') ? 'three' : 'one';
    log.push(`start ${name}`);
    await new Promise<void>((r) => gates.set(name, r));
    log.push(`end ${name}`);
    return {};
  });
  t.coordinator.wake(t.job.id, { kind: 'new', text: '하나' });
  t.coordinator.wake(t.job.id, { kind: 'reply', text: '둘' });
  t.coordinator.wake(other.id, { kind: 'new', text: '셋' });
  // wake only enqueues: nothing ran synchronously.
  expect(log).toEqual([]);
  await vi.waitFor(() => expect([...log].sort()).toEqual(['start one', 'start three']));
  gates.get('one')!();
  await vi.waitFor(() => expect(log).toContain('start two'));
  expect(log.indexOf('end one')).toBeLessThan(log.indexOf('start two'));
  expect(log).not.toContain('end three');
  gates.get('two')!();
  gates.get('three')!();
  await t.coordinator.settled();
});

test('a failed coordinator turn is told in the thread and the next wake still runs', async () => {
  const t = start();
  t.run.mockRejectedValueOnce(new Error('auth failed'));
  t.coordinator.wake(t.job.id, { kind: 'new', text: '해줘' });
  t.coordinator.wake(t.job.id, { kind: 'reply', text: '다시' });
  await t.coordinator.settled();
  expect(t.replies[0][1]).toContain('auth failed');
  expect(t.run).toHaveBeenCalledTimes(2);
});

test('propose_coworker asks the owner and does not create the coworker yet', async () => {
  const t = start();
  const save = vi.spyOn(t.coworkers, 'save');
  t.steps.push(async (turn) => {
    await call(turn, 'propose_coworker', {
      name: 'SKT 개발',
      folder: '/tmp/skt-dev',
      role: 'SKT 레포 담당',
      engine: 'codex',
    });
  });
  t.coordinator.wake(t.job.id, { kind: 'new', text: 'skt 레포 고쳐줘' });
  await t.coordinator.settled();
  expect(t.proposals).toEqual([
    [
      t.job.id,
      {
        id: 'skt-dev',
        name: 'SKT 개발',
        folder: '/tmp/skt-dev',
        role: 'SKT 레포 담당',
        engine: 'codex',
      },
    ],
  ]);
  expect(save).not.toHaveBeenCalled();
});

test('AGENTS.md is written once and the user edit becomes the next system prompt', async () => {
  const t = start();
  const path = join(t.dataDir, 'coordinator', 'AGENTS.md');
  t.coordinator.wake(t.job.id, { kind: 'new', text: '해줘' });
  await t.coordinator.settled();
  expect(readFileSync(path, 'utf8')).toBe(COORDINATOR_AGENTS);
  expect(t.turns[0].systemPrompt).toBe(COORDINATOR_AGENTS);
  expect(t.turns[0].cwd).toBe(join(t.dataDir, 'coordinator'));
  expect(t.turns[0].model).toBe('claude-sonnet-5-5');
  writeFileSync(path, '# 내 규칙\n항상 짧게.');
  t.store.setSetting('coordinatorModel', { model: 'claude-haiku-5-5' });
  t.coordinator.wake(t.job.id, { kind: 'reply', text: '또' });
  await t.coordinator.settled();
  expect(readFileSync(path, 'utf8')).toBe('# 내 규칙\n항상 짧게.');
  expect(t.turns[1].systemPrompt).toBe('# 내 규칙\n항상 짧게.');
  expect(t.turns[1].model).toBe('claude-haiku-5-5');
});

test('the template carries the operating rules', () => {
  for (const rule of [
    '가장 그럴듯한 동료로 바로 배정',
    '질문은 맞는 동료가 없을 때만',
    '첫 `reply`는 배정 계획 한두 줄',
    '모든 배정이 끝났을 때 한 번',
    '외부 게시는 직접 하지 않',
  ])
    expect(COORDINATOR_AGENTS).toContain(rule);
});
