import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/server/store.js';
import { createServer } from '../src/server/transport.js';
import { createOrchestrator } from '../src/server/orchestrator.js';
import { createQuestionDesk } from '../src/server/questions.js';
import type { Adapter } from '../src/shared/contracts.js';
const question = {
  question: 'Which color do you prefer?',
  header: 'Color',
  options: [{ label: 'red' }, { label: 'blue' }],
  multiSelect: false,
};
function runHook(env: Record<string, string>) {
  const child = spawn(process.execPath, ['scripts/ask-hook.mjs'], {
    env: { ...process.env, ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(
    JSON.stringify({
      session_id: 'term-1',
      cwd: '/work/skt',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [question] },
    }),
  );
  return new Promise<{ code: number | null; out: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, out })),
  );
}
async function server() {
  const store = createStore(':memory:');
  const a: Adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: 'test' }),
    execute: async () => ({ outcome: 'completed', text: '' }),
    close: async () => {},
  };
  const port = 43000 + Math.floor(Math.random() * 2000);
  const questions = createQuestionDesk();
  const { app } = await createServer({
    store,
    adapters: { codex: a, claude: a },
    orchestrator: createOrchestrator({
      store,
      adapters: { codex: a, claude: a },
      dataDir: '/tmp/pixel-hook',
    }),
    token: 't',
    port,
    questions,
    hookToken: 'hook-secret',
  });
  await app.listen({ host: '127.0.0.1', port });
  const dir = await mkdtemp(join(tmpdir(), 'pixel-hookfile-'));
  const file = (token: string) => {
    const path = join(dir, `${token}.json`);
    return writeFile(path, JSON.stringify({ url: `http://127.0.0.1:${port}`, token })).then(
      () => path,
    );
  };
  return { app, questions, file, close: () => app.close().then(() => store.close()) };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
};
test('the hook prints the answer given in the app as AskUserQuestion answers', async () => {
  const s = await server();
  try {
    const running = runHook({ PIXEL_HOOK_FILE: await s.file('hook-secret') });
    await until(() => s.questions.list().length === 1);
    const [q] = s.questions.list();
    expect(q).toMatchObject({ sessionId: 'term-1', cwd: '/work/skt', questions: [question] });
    s.questions.answer(q.id, { 'Which color do you prefer?': ['blue'] });
    const { code, out } = await running;
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Pixel Office에서 답했어요',
      updatedInput: { questions: [question], answers: { 'Which color do you prefer?': 'blue' } },
    });
  } finally {
    await s.close();
  }
});
test('no app, a wrong token or no answer in time leaves the question to the terminal', async () => {
  const s = await server();
  try {
    const bad = await runHook({ PIXEL_HOOK_FILE: await s.file('wrong') });
    expect(bad).toEqual({ code: 0, out: '' });
    expect(s.questions.list()).toEqual([]);
    const late = runHook({
      PIXEL_HOOK_FILE: await s.file('hook-secret'),
      PIXEL_HOOK_GIVE_UP_MS: '300',
    });
    expect(await late).toEqual({ code: 0, out: '' });
    // Given back, not stranded in the app.
    expect(s.questions.list()).toEqual([]);
    const released = runHook({ PIXEL_HOOK_FILE: await s.file('hook-secret') });
    await until(() => s.questions.list().length === 1);
    s.questions.release(s.questions.list()[0].id);
    expect(await released).toEqual({ code: 0, out: '' });
  } finally {
    await s.close();
  }
  const gone = await runHook({ PIXEL_HOOK_FILE: await s.file('hook-secret') });
  expect(gone).toEqual({ code: 0, out: '' });
  expect(await runHook({ PIXEL_HOOK_FILE: '/nonexistent/hook.json' })).toEqual({
    code: 0,
    out: '',
  });
});
