import { expect, test } from 'vitest';
import { deskRequests } from '../src/server/slack/desk.js';
import type { Assignment, Job } from '../src/server/store.js';
import type { Run } from '../src/shared/contracts.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const job = (
  id: string,
  minutesAgo: number,
  assignments: Assignment[] = [],
  coworker = false,
): Job => ({
  id,
  threadKey: id,
  channel: 'D1',
  threadTs: '1.1',
  route: coworker ? { kind: 'coworker', coworkerId: 'c1' } : { kind: 'coordinator' },
  assignments,
  state: 'open',
  createdAt: ago(minutesAgo),
});
const assign = (id: string, runId?: string): Assignment => ({
  id,
  coworkerId: 'c1',
  runId,
  task: 't',
});

test('desk counts planning and working coordinator requests and drops finished ones', () => {
  const statuses: Record<string, Run['status']> = {
    r1: 'completed',
    r2: 'running',
    r3: 'completed',
    r4: 'completed',
    r5: 'failed',
  };
  const runOf = (id: string) => (statuses[id] ? ({ id, status: statuses[id] } as Run) : undefined);
  const jobs = [
    job('planning', 5),
    job('working', 5, [assign('a1', 'r1'), assign('a2', 'r2')]),
    job('done', 5, [assign('a3', 'r3'), assign('a4', 'r4')]),
    job('stale', 40),
    job('waiting', 5, [assign('a5')]),
    job('chained', 60, [assign('a7', 'r2'), { ...assign('a8'), after: 'a7' }]),
    job('failed-chain', 60, [assign('a9', 'r5'), { ...assign('a10'), after: 'a9' }]),
    job('lost-run', 60, [assign('a11', 'missing')]),
    job('stuck', 60, [assign('a12')]),
    job('coworker', 5, [assign('a6', 'r2')], true),
  ];
  expect(deskRequests(jobs, runOf, now)).toEqual([
    { jobId: 'planning', phase: 'planning', tasks: 0 },
    { jobId: 'working', phase: 'working', tasks: 2 },
    { jobId: 'waiting', phase: 'working', tasks: 1 },
    { jobId: 'chained', phase: 'working', tasks: 2 },
  ]);
});
