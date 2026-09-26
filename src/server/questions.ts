import { randomUUID } from 'node:crypto';
// Questions a terminal Claude asked through the AskUserQuestion hook, waiting for the app to answer.
// Kept in memory: a hook that finds no answer (server restarted, timed out) falls back to the terminal.
export interface TerminalQuestion {
  id: string;
  sessionId: string;
  cwd: string;
  questions: unknown[];
  createdAt: string;
}
export type QuestionOutcome =
  | { status: 'pending' }
  | { status: 'answered'; answers: Record<string, string> }
  | { status: 'released' }
  | { status: 'expired' };
const EXPIRE_MS = 15 * 60000;
export function createQuestionDesk({ now = Date.now }: { now?: () => number } = {}) {
  const open = new Map<string, TerminalQuestion>();
  const done = new Map<string, QuestionOutcome>();
  const waiters = new Map<string, Set<(o: QuestionOutcome) => void>>();
  const settle = (id: string, outcome: QuestionOutcome) => {
    if (!open.delete(id)) return false;
    done.set(id, outcome);
    for (const w of waiters.get(id) ?? []) w(outcome);
    waiters.delete(id);
    return true;
  };
  const sweep = () => {
    for (const q of open.values())
      if (now() - Date.parse(q.createdAt) > EXPIRE_MS) settle(q.id, { status: 'expired' });
  };
  return {
    // The hook may pick the id itself so it never has to trust one from a response.
    ask(input: Omit<TerminalQuestion, 'id' | 'createdAt'> & { id?: string }): TerminalQuestion {
      sweep();
      const id = input.id ?? randomUUID();
      if (open.has(id) || done.has(id)) throw new Error('이미 받은 질문이에요.');
      const q = { ...input, id, createdAt: new Date(now()).toISOString() };
      open.set(q.id, q);
      return q;
    },
    list(): TerminalQuestion[] {
      sweep();
      return [...open.values()];
    },
    // Resolves as soon as the question is settled, or with pending after waitMs.
    wait(id: string, waitMs: number): Promise<QuestionOutcome> {
      sweep();
      const finished = done.get(id);
      if (finished) return Promise.resolve(finished);
      if (!open.has(id)) return Promise.resolve({ status: 'expired' });
      return new Promise((resolve) => {
        const set = waiters.get(id) ?? new Set();
        const timer = setTimeout(() => {
          set.delete(finish);
          resolve({ status: 'pending' });
        }, waitMs);
        const finish = (o: QuestionOutcome) => {
          clearTimeout(timer);
          resolve(o);
        };
        set.add(finish);
        waiters.set(id, set);
      });
    },
    // AskUserQuestion takes one string per question; several picks are joined like the SDK path.
    answer(id: string, answers: Record<string, string[]>) {
      const joined = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.join(', ')]));
      if (!settle(id, { status: 'answered', answers: joined }))
        throw new Error('이미 답했거나 사라진 질문이에요.');
    },
    release(id: string) {
      if (!settle(id, { status: 'released' })) throw new Error('이미 답했거나 사라진 질문이에요.');
    },
  };
}
export type QuestionDesk = ReturnType<typeof createQuestionDesk>;
