import { expect, test } from 'vitest';
import {
  approvalBlocks,
  clip,
  questionBlocks,
  reportBlocks,
  resolvedBlocks,
  statusBlocks,
} from '../src/server/slack/blocks.js';
import type { Interaction, Run } from '../src/shared/contracts.js';
import type { Job } from '../src/server/store.js';

const interaction = (over: Partial<Interaction> = {}): Interaction => ({
  id: 'i1',
  runId: 'r1',
  agentId: 'claude',
  kind: 'approval',
  title: 'git push',
  details: { tool: 'Bash', command: 'git push' },
  resolved: false,
  ...over,
});
const actions = (blocks: Record<string, unknown>[]) =>
  blocks.flatMap((b) =>
    b.type === 'actions' ? (b.elements as { action_id: string; value: string }[]) : [],
  );

test('clip keeps text within the limit and says when it cut', () => {
  const long = clip('가'.repeat(5000), 3000);
  expect(long.text.length).toBeLessThanOrEqual(3000);
  expect(long.clipped).toBe(true);
  expect(clip('짧아요', 3000)).toEqual({ text: '짧아요', clipped: false });
  // Never splits a surrogate pair.
  expect(clip('😀'.repeat(10), 5).text).not.toMatch(/[\ud800-\udbff]$/);
});

test('approvalBlocks carries the interaction id in both buttons', () => {
  const buttons = actions(approvalBlocks(interaction()));
  expect(buttons.map((b) => b.action_id)).toEqual(['pixel:approve', 'pixel:deny']);
  for (const b of buttons) expect(JSON.parse(b.value)).toEqual({ interactionId: 'i1' });
});

test('questionBlocks offers option buttons for one question and asks for a reply otherwise', () => {
  const choice = questionBlocks(
    interaction({
      kind: 'question',
      details: { questions: [{ question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }] },
    }),
  );
  const buttons = actions(choice);
  expect(buttons.map((b) => b.action_id)).toEqual(['pixel:answer:0', 'pixel:answer:1']);
  expect(JSON.parse(buttons[1].value)).toEqual({ interactionId: 'i1', option: 'B' });
  const free = questionBlocks(
    interaction({ kind: 'question', details: { questions: [{ question: '이름은?' }] } }),
  );
  expect(actions(free)).toEqual([]);
  expect(JSON.stringify(free)).toContain('답글');
});

test('text from agents is escaped and long sections are clipped', () => {
  const blocks = reportBlocks('<b>&' + 'x'.repeat(4000), ['https://github.com/o/r/pull/1']);
  const json = JSON.stringify(blocks);
  expect(json).toContain('&lt;b&gt;&amp;');
  expect(json).toContain('<https://github.com/o/r/pull/1>');
  for (const b of blocks as { text?: { text: string } }[])
    if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  expect(JSON.stringify(resolvedBlocks('승인됨', 'git push'))).toContain('승인됨');
});

test('statusBlocks shows each assignment with its state and queue position', () => {
  const job = {
    id: 'j1',
    assignments: [
      { id: 'a1', coworkerId: 'meeting', runId: 'r1', task: '회의록' },
      { id: 'a2', coworkerId: 'planner', runId: 'r2', task: '계획' },
    ],
  } as Job;
  const runs = [
    { id: 'r1', status: 'running' },
    { id: 'r2', status: 'queued' },
  ] as Run[];
  const text = JSON.stringify(
    statusBlocks(job, runs, { r2: 3 }, ['자동 승인: git diff'], { meeting: '회의록 담당' }),
  );
  expect(text).toContain('회의록 담당');
  expect(text).toContain('작업 중');
  expect(text).toContain('앞에 2개');
  expect(text).toContain('자동 승인: git diff');
});
