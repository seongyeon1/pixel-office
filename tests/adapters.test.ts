import { expect, test } from 'vitest';
import {
  normalizeCodex,
  normalizeClaude,
  activityForTool,
} from '../src/server/adapters/normalize.js';
import { RpcClient } from '../src/server/adapters/codex-rpc.js';
import { spawn } from 'node:child_process';
test('normalizes failed Claude results and does not invent unknown tool activity', () => {
  expect(
    normalizeClaude('r1', {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['auth failed'],
    })[0].type,
  ).toBe('agent.failed');
  expect(activityForTool('mystery')).toBe('responding');
});
test('Codex command output and file edits retain observed payload', () => {
  expect(
    normalizeCodex('r1', {
      method: 'item/started',
      params: { item: { type: 'fileChange', id: 'i1', changes: [{ path: 'a.ts' }] } },
    })[0].payload.activity,
  ).toBe('editing');
  expect(
    normalizeCodex('r1', {
      method: 'item/commandExecution/outputDelta',
      params: { delta: 'ok' },
    })[0].payload.text,
  ).toBe('ok');
});
test('RPC correlates split responses and rejects pending calls on process exit', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.stdin.once('data',d=>{const p=JSON.parse(d); const s=JSON.stringify({id:p.id,result:{ok:true}})+'\\n';process.stdout.write(s.slice(0,4));setTimeout(()=>{process.stdout.write(s.slice(4));setTimeout(()=>process.exit(0),30)},10)})`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const rpc = new RpcClient(child);
  expect(await rpc.request('test', {})).toEqual({ ok: true });
  await expect(rpc.request('never', {})).rejects.toThrow('종료');
  await rpc.close();
});
import { reviewJsonSchema } from '../src/shared/contracts.js';
test('structured review uses the draft supported by both provider validators', () => {
  expect(reviewJsonSchema().$schema).toBe('http://json-schema.org/draft-07/schema#');
});
