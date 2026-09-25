import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createObservation, parseRecord } from '../src/server/observation/observer.js';
const timestamp = new Date().toISOString();
test('normalizes Codex tools, completion and metadata without exposing reasoning', () => {
  expect(
    parseRecord('codex', {
      type: 'session_meta',
      payload: { id: 'c1', cwd: '/repo', base_instructions: { text: 'private' } },
    }),
  ).toMatchObject({ sessionId: 'c1', cwd: '/repo' });
  expect(
    parseRecord('codex', {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call',
        arguments: JSON.stringify({ cmd: 'npm test' }),
      },
    }),
  ).toMatchObject({
    event: { kind: 'tool', activity: 'executing', title: 'exec_command', detail: 'npm test' },
  });
  expect(
    parseRecord('codex', {
      timestamp,
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'private thought' }] },
    }),
  ).toEqual({});
  expect(
    parseRecord('codex', {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'analysis',
        content: [{ type: 'output_text', text: 'private' }],
      },
    }),
  ).toEqual({});
  expect(
    parseRecord('codex', {
      timestamp,
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'done' },
    }),
  ).toMatchObject({ event: { kind: 'complete', detail: 'done' } });
});
test('normalizes Claude user requests and tool use; ignores thinking and large raw outputs', () => {
  expect(
    parseRecord('claude', {
      timestamp,
      cwd: '/repo',
      sessionId: 'a1',
      type: 'user',
      message: { content: '로그인 구현' },
    }),
  ).toMatchObject({ cwd: '/repo', sessionId: 'a1', prompt: '로그인 구현' });
  expect(
    parseRecord('claude', {
      timestamp,
      type: 'assistant',
      message: {
        model: 'claude-model',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            id: 't1',
            input: { file_path: '/repo/app.ts', old_string: 'secret' },
          },
        ],
      },
    }),
  ).toMatchObject({
    model: 'claude-model',
    event: { activity: 'editing', detail: '/repo/app.ts' },
  });
  const thought = parseRecord('claude', {
    timestamp,
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'private thought' }] },
  });
  expect(JSON.stringify(thought)).not.toContain('private thought');
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-observe-'));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  await writeFile(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.test', 'commit', '-m', 'seed'],
    { cwd: repo, stdio: 'pipe' },
  );
  const codexHome = join(dir, 'codex'),
    claudeHome = join(dir, 'claude');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(claudeHome, 'projects'), { recursive: true });
  return { dir, repo, codexHome, claudeHome };
}
const line = (o: unknown) => JSON.stringify(o) + '\n';
test('discovers existing logs, groups git worktrees, follows partial appends once, and ages activity', async () => {
  const f = await fixture();
  const wt = join(f.dir, 'worktree');
  execFileSync('git', ['worktree', 'add', '-b', 'feature', wt], { cwd: f.repo, stdio: 'pipe' });
  const log = join(f.codexHome, 'sessions', 'rollout.jsonl');
  await writeFile(
    log,
    line({ timestamp, type: 'session_meta', payload: { id: 'test-codex', cwd: wt } }) +
      line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }),
  );
  let now = Date.now();
  const observer = createObservation({ ...f, now: () => now });
  await observer.scan();
  const summary = observer.list();
  expect(summary.sessions).toHaveLength(1);
  const id = summary.sessions[0].id;
  expect(summary.sessions[0]).toMatchObject({
    projectPath: await import('node:fs/promises').then((m) => m.realpath(f.repo)),
    status: 'active',
  });
  const record = JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'function_call', name: 'read_file', arguments: '{"path":"a.txt"}' },
  });
  await appendFile(log, record.slice(0, 30));
  await observer.scan();
  const before = observer.get(id)!.events.length;
  await appendFile(log, record.slice(30) + '\n');
  await observer.scan();
  await observer.scan();
  expect(observer.get(id)!.events.length).toBe(before + 1);
  now += 180000;
  await observer.scan();
  expect(observer.list().sessions[0].status).toBe('stale');
  await appendFile(
    log,
    line({
      timestamp: new Date(now).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }),
  );
  await observer.scan();
  expect(observer.list().sessions[0].status).toBe('idle');
  await writeFile(
    log,
    line({ timestamp, type: 'session_meta', payload: { id: 'test-codex', cwd: wt } }),
  );
  await observer.scan();
  expect(observer.get(id)!.events).toHaveLength(0);
  observer.close();
});
test('ignores managed workspaces and malformed records; missing roots do not fail the app', async () => {
  const f = await fixture();
  const log = join(f.claudeHome, 'projects', 'a.jsonl');
  await writeFile(
    log,
    'bad json\n' +
      line({
        timestamp,
        type: 'user',
        sessionId: 'a1',
        cwd: f.repo,
        message: { content: 'request' },
      }),
  );
  const observer = createObservation({ ...f, excludeRoots: [f.repo] });
  await observer.scan();
  expect(observer.list().sessions).toHaveLength(0);
  observer.close();
  const missing = createObservation({
    codexHome: join(f.dir, 'missing'),
    claudeHome: join(f.dir, 'missing2'),
  });
  await missing.scan();
  expect(missing.list().sessions).toEqual([]);
  expect(missing.list().warnings.length).toBeGreaterThan(0);
  missing.close();
});

test('prioritizes an open Claude session over newer closed logs when the discovery cap is reached', async () => {
  const f = await fixture();
  const timestamp = new Date().toISOString();
  const active = join(f.claudeHome, 'projects', 'live-session.jsonl');
  await writeFile(
    active,
    line({
      timestamp,
      type: 'user',
      sessionId: 'live-session',
      cwd: f.repo,
      message: { content: 'open' },
    }),
  );
  const { utimes } = await import('node:fs/promises');
  await utimes(active, new Date(0), new Date(Date.now() - 8 * 86400000));
  await mkdir(join(f.claudeHome, 'sessions'));
  await writeFile(
    join(f.claudeHome, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'live-session' }),
  );
  await writeFile(
    join(f.claudeHome, 'projects', 'closed.jsonl'),
    line({
      timestamp,
      type: 'user',
      sessionId: 'closed',
      cwd: f.repo,
      message: { content: 'old task' },
    }),
  );
  const observer = createObservation({ ...f, maxSessions: 1 });
  await observer.scan();
  expect(observer.list().sessions.map((s) => s.sessionId)).toEqual(['live-session']);
  observer.close();
});
