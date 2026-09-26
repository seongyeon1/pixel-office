#!/usr/bin/env node
// PreToolUse hook for AskUserQuestion: hands the question to Pixel Office and waits for an answer.
// Anything unexpected (app not running, no answer in time, "answer in the terminal") ends quietly
// with no output, so Claude shows its own question in the terminal as usual.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const GIVE_UP_MS = Number(process.env.PIXEL_HOOK_GIVE_UP_MS ?? 570_000);
const quietly = () => process.exit(0);
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input.tool_name && input.tool_name !== 'AskUserQuestion') quietly();
  const file = process.env.PIXEL_HOOK_FILE ?? new URL('../.pixel/hook.json', import.meta.url);
  const { url, token } = JSON.parse(await readFile(file, 'utf8'));
  const headers = { 'content-type': 'application/json', 'x-pixel-hook': token };
  // The hook names the question, so nothing from a response ends up in a URL.
  const id = randomUUID();
  const question = `${url}/api/hook/questions/${id}`;
  const opened = await fetch(`${url}/api/hook/questions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id,
      sessionId: input.session_id ?? '',
      cwd: input.cwd ?? '',
      questions: input.tool_input?.questions ?? [],
    }),
  });
  if (!opened.ok) quietly();
  const deadline = Date.now() + GIVE_UP_MS;
  while (Date.now() < deadline) {
    const wait = Math.min(25_000, Math.max(1, deadline - Date.now()));
    const res = await fetch(`${question}?wait=${wait}`, { headers });
    if (!res.ok) quietly();
    const outcome = await res.json();
    if (outcome.status === 'answered') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Pixel Office에서 답했어요',
            updatedInput: { ...input.tool_input, answers: outcome.answers },
          },
        }),
      );
      process.exit(0);
    }
    if (outcome.status !== 'pending') quietly();
  }
  // Give the question back to the terminal rather than leaving it stranded in the app.
  await fetch(`${question}/release`, { method: 'POST', headers, body: '{}' }).catch(() => {});
  quietly();
} catch {
  quietly();
}
