import { expect, test } from 'vitest';
import { createQuestionDesk } from '../src/server/questions.js';
const ask = { sessionId: 's1', cwd: '/r', questions: [{ question: 'Color?' }] };
test('a waiting hook gets the answer the moment it is given, joined per question', async () => {
  const desk = createQuestionDesk();
  const q = desk.ask(ask);
  expect(desk.list().map((x) => x.id)).toEqual([q.id]);
  const waiting = desk.wait(q.id, 5000);
  desk.answer(q.id, { 'Color?': ['red', 'blue'] });
  expect(await waiting).toEqual({ status: 'answered', answers: { 'Color?': 'red, blue' } });
  expect(desk.list()).toEqual([]);
  // A later poll still learns the outcome; answering twice is refused.
  expect(await desk.wait(q.id, 10)).toMatchObject({ status: 'answered' });
  expect(() => desk.answer(q.id, {})).toThrow();
});
test('an unanswered wait comes back pending; released and expired questions go back to the terminal', async () => {
  let now = Date.now();
  const desk = createQuestionDesk({ now: () => now });
  const a = desk.ask(ask);
  expect(await desk.wait(a.id, 10)).toEqual({ status: 'pending' });
  desk.release(a.id);
  expect(await desk.wait(a.id, 10)).toEqual({ status: 'released' });
  const b = desk.ask(ask);
  now += 16 * 60000;
  expect(desk.list()).toEqual([]);
  expect(await desk.wait(b.id, 10)).toEqual({ status: 'expired' });
  expect(await desk.wait('unknown', 10)).toEqual({ status: 'expired' });
});
