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

test('reports the worktree and branch of each session and keeps deleted worktrees in their repository', async () => {
  const f = await fixture();
  const { realpath, rm } = await import('node:fs/promises');
  const repo = await realpath(f.repo);
  const wt = join(f.repo, '.claude', 'worktrees', 'resume');
  execFileSync('git', ['worktree', 'add', '-b', 'feat/resume', wt], { cwd: f.repo, stdio: 'pipe' });
  const write = (name: string, cwd: string) =>
    writeFile(
      join(f.codexHome, 'sessions', `${name}.jsonl`),
      line({ timestamp, type: 'session_meta', payload: { id: name, cwd } }) +
        line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }),
    );
  await write('main-session', f.repo);
  await write('wt-session', join(wt, 'src'));
  let now = Date.now();
  const observer = createObservation({ ...f, now: () => now });
  await observer.scan();
  const by = (id: string) => observer.list().sessions.find((s) => s.sessionId === id)!;
  expect(by('main-session')).toMatchObject({
    projectPath: repo,
    worktree: { path: repo, main: true },
  });
  expect(by('wt-session')).toMatchObject({
    projectPath: repo,
    worktree: { path: await realpath(wt), branch: 'feat/resume', main: false },
  });
  expect(by('main-session').worktree!.branch).toMatch(/^(main|master)$/);
  // A worktree removed after its session ended must not become a separate room.
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: f.repo, stdio: 'pipe' });
  await rm(wt, { recursive: true, force: true });
  now += 120000;
  await observer.scan();
  expect(by('wt-session').projectPath).toBe(repo);
  observer.close();
  // A fresh observer (e.g. after a restart) has no memory, but still finds the repository above it.
  const restarted = createObservation(f);
  await restarted.scan();
  expect(restarted.list().sessions.find((s) => s.sessionId === 'wt-session')!.projectPath).toBe(
    repo,
  );
  restarted.close();
});

test('links Claude and Codex subagents to the session that spawned them', async () => {
  const f = await fixture();
  const parentDir = join(f.claudeHome, 'projects', 'repo');
  await mkdir(join(parentDir, 'parent-1', 'subagents'), { recursive: true });
  const claude = (sessionId: string, extra: object = {}) =>
    line({
      timestamp,
      type: 'user',
      sessionId,
      cwd: f.repo,
      message: { content: 'work' },
      ...extra,
    });
  await writeFile(join(parentDir, 'parent-1.jsonl'), claude('parent-1'));
  await writeFile(
    join(parentDir, 'parent-1', 'subagents', 'agent-abc.jsonl'),
    claude('parent-1', { agentId: 'abc', isSidechain: true }),
  );
  const codex = (id: string, parent?: string) =>
    line({
      timestamp,
      type: 'session_meta',
      payload: { id, cwd: f.repo, ...(parent ? { parent_thread_id: parent } : {}) },
    }) + line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } });
  await writeFile(join(f.codexHome, 'sessions', 'rollout-lead.jsonl'), codex('lead'));
  await writeFile(join(f.codexHome, 'sessions', 'rollout-kant.jsonl'), codex('kant', 'lead'));
  const observer = createObservation(f);
  await observer.scan();
  const sessions = observer.list().sessions;
  const claudeParent = sessions.find((s) => s.provider === 'claude' && !s.parentId)!;
  const claudeChild = sessions.find((s) => s.provider === 'claude' && s.parentId)!;
  expect(claudeParent.sessionId).toBe('parent-1');
  expect(claudeChild.parentId).toBe(claudeParent.id);
  const lead = sessions.find((s) => s.sessionId === 'lead')!;
  expect(lead.parentId).toBeUndefined();
  expect(sessions.find((s) => s.sessionId === 'kant')!.parentId).toBe(lead.id);
  observer.close();
});

test('raises attention for pending questions, plan approval and long silent tools', async () => {
  const f = await fixture();
  let now = Date.now();
  const at = (offset = 0) => new Date(now + offset).toISOString();
  const dir = join(f.claudeHome, 'projects');
  const tool = (sessionId: string, name: string, id: string) =>
    line({
      timestamp: at(),
      type: 'assistant',
      sessionId,
      cwd: f.repo,
      message: { content: [{ type: 'tool_use', name, id, input: {} }] },
    });
  const result = (sessionId: string, id: string) =>
    line({
      timestamp: at(),
      type: 'user',
      sessionId,
      cwd: f.repo,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
  await writeFile(join(dir, 'ask.jsonl'), tool('ask', 'AskUserQuestion', 'q1'));
  await writeFile(join(dir, 'plan.jsonl'), tool('plan', 'ExitPlanMode', 'p1'));
  await writeFile(join(dir, 'bash.jsonl'), tool('bash', 'Bash', 'b1'));
  await writeFile(join(dir, 'agent.jsonl'), tool('agent', 'Agent', 'a1'));
  await writeFile(
    join(f.codexHome, 'sessions', 'rollout-cq.jsonl'),
    line({ timestamp: at(), type: 'session_meta', payload: { id: 'cq', cwd: f.repo } }) +
      line({
        timestamp: at(),
        type: 'response_item',
        payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'c1' },
      }),
  );
  const observer = createObservation({ ...f, now: () => now });
  await observer.scan();
  const by = (id: string) => observer.list().sessions.find((s) => s.sessionId === id)!;
  expect(by('ask').attention).toMatchObject({ kind: 'question', certain: true });
  expect(by('plan').attention).toMatchObject({ kind: 'approval', certain: true });
  expect(by('cq').attention).toMatchObject({ kind: 'question', certain: true });
  expect(by('bash').attention).toBeNull();
  now += 61000;
  await observer.scan();
  expect(by('bash').attention).toMatchObject({ kind: 'approval', certain: false });
  // Subagent runs are long by design and are never guessed to be permission prompts.
  expect(by('agent').attention).toBeNull();
  // Waiting on a person is not a stale session.
  now += 600000;
  await observer.scan();
  expect(by('ask').status).toBe('active');
  await appendFile(join(dir, 'ask.jsonl'), result('ask', 'q1'));
  await appendFile(join(dir, 'bash.jsonl'), result('bash', 'b1'));
  await observer.scan();
  expect(by('ask').attention).toBeNull();
  expect(by('bash').attention).toBeNull();
  observer.close();
});

test('a guess never revives an abandoned turn and a closed terminal cannot keep asking', async () => {
  const f = await fixture();
  let now = Date.now();
  const dir = join(f.claudeHome, 'projects');
  const tool = (sessionId: string, name: string) =>
    line({
      timestamp: new Date(now).toISOString(),
      type: 'assistant',
      sessionId,
      cwd: f.repo,
      message: { content: [{ type: 'tool_use', name, id: `${sessionId}-t`, input: {} }] },
    });
  await writeFile(join(dir, 'left.jsonl'), tool('left', 'Bash'));
  await writeFile(join(dir, 'closed.jsonl'), tool('closed', 'AskUserQuestion'));
  await mkdir(join(f.claudeHome, 'sessions'));
  // A registry entry whose process no longer exists.
  await writeFile(
    join(f.claudeHome, 'sessions', '999999.json'),
    JSON.stringify({ pid: 999999, sessionId: 'closed' }),
  );
  const observer = createObservation({ ...f, now: () => now });
  await observer.scan();
  const by = (id: string) => observer.list().sessions.find((s) => s.sessionId === id)!;
  expect(by('closed')).toMatchObject({ processAlive: false, attention: null });
  now += 5 * 60000;
  await observer.scan();
  expect(by('left')).toMatchObject({ attention: { certain: false }, status: 'stale' });
  now += 30 * 60000;
  await observer.scan();
  expect(by('left').attention).toBeNull();
  observer.close();
});

test('sessions started by scripts and hooks are marked automated', async () => {
  const f = await fixture();
  const dir = join(f.claudeHome, 'projects');
  const user = (sessionId: string, entrypoint: string, text: string) =>
    line({
      timestamp,
      type: 'user',
      sessionId,
      cwd: f.repo,
      entrypoint,
      message: { content: text },
    });
  await writeFile(join(dir, 'person.jsonl'), user('person', 'cli', '맵 고쳐줘'));
  await writeFile(
    join(dir, 'smoke.jsonl'),
    user('smoke', 'sdk-ts', '당신은 Pixel Office의 개발 에이전트입니다.'),
  );
  await writeFile(
    join(dir, 'journal.jsonl'),
    user(
      'journal',
      'sdk-cli',
      '다음 에이전트 세션 transcript을 한국어 업무일지 형식으로 요약해주세요.',
    ),
  );
  const meta = (id: string, extra: object) =>
    line({ timestamp, type: 'session_meta', payload: { id, cwd: f.repo, ...extra } }) +
    line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } });
  await writeFile(
    join(f.codexHome, 'sessions', 'rollout-tui.jsonl'),
    meta('tui', { originator: 'codex-tui', source: 'cli' }),
  );
  await writeFile(
    join(f.codexHome, 'sessions', 'rollout-exec.jsonl'),
    meta('exec', { originator: 'codex_exec', source: 'exec' }),
  );
  const observer = createObservation(f);
  await observer.scan();
  const by = (id: string) => observer.list().sessions.find((s) => s.sessionId === id)!;
  expect(by('person').automated).toBeFalsy();
  expect(by('journal').automated).toBe(true);
  expect(by('smoke').automated).toBe(true);
  expect(by('tui').automated).toBeFalsy();
  expect(by('exec').automated).toBe(true);
  observer.close();
});

test('once known, automated logs give way to people when the discovery cap is reached', async () => {
  const f = await fixture();
  const dir = join(f.claudeHome, 'projects');
  const { utimes } = await import('node:fs/promises');
  const write = async (name: string, entrypoint: string, age: number) => {
    const path = join(dir, `${name}.jsonl`);
    await writeFile(
      path,
      line({
        timestamp,
        type: 'user',
        sessionId: name,
        cwd: f.repo,
        entrypoint,
        message: { content: name },
      }),
    );
    const t = new Date(Date.now() - age);
    await utimes(path, t, t);
  };
  await write('older-person', 'cli', 60000);
  await write('newer-summary', 'sdk-cli', 1000);
  let now = Date.now();
  const observer = createObservation({ ...f, maxSessions: 1, now: () => now });
  await observer.scan();
  // First pass cannot know yet: the newest file wins the only slot.
  expect(observer.list().sessions.map((s) => s.sessionId)).toEqual(['newer-summary']);
  now += 11000;
  await observer.scan();
  expect(observer.list().sessions.map((s) => s.sessionId)).toEqual(['older-person']);
  observer.close();
});
