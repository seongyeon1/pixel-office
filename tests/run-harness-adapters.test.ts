import { expect, test, vi } from 'vitest';
const calls = vi.hoisted(() => [] as { method: string; params: any }[]);
const failure = vi.hoisted(() => ({ message: '', code: '' }));
const queries = vi.hoisted(() => [] as any[]);
vi.mock('node:child_process', async (real) => ({
  ...((await real()) as object),
  spawn: vi.fn(() => ({})),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: any) => {
    queries.push(args);
    const stream = (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: !!failure.message,
        result: failure.message || 'done',
        session_id: 's',
      };
    })();
    return Object.assign(stream, { close() {}, interrupt: async () => {} });
  },
}));
vi.mock('../src/server/adapters/codex-rpc.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    RpcClient: class extends EventEmitter {
      async request(method: string, params: any) {
        calls.push({ method, params });
        if (method === 'config/read')
          return { config: { plugins: { 'linear@curated': {}, 'braincrew@local': {} } } };
        if (method === 'skills/list')
          return {
            data: [
              {
                skills: [
                  { name: 'bc-ship', pluginId: null },
                  { name: 'bc-arxiv', pluginId: null },
                  { name: 'plan', pluginId: 'braincrew@local' },
                ],
              },
            ],
          };
        if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork')
          return { thread: { id: 'thread' }, model: 'fixture' };
        if (method === 'turn/start') {
          setTimeout(() =>
            this.emit('message', {
              method: 'turn/completed',
              params: {
                turn: {
                  status: failure.code ? 'failed' : 'completed',
                  error: failure.code
                    ? { message: 'Provider unavailable', codexErrorInfo: failure.code }
                    : undefined,
                },
              },
            }),
          );
          return { turn: { id: 'turn' } };
        }
        return {};
      }
      notify() {}
      respond() {}
      async close() {}
    },
  };
});
import { createCodexAdapter } from '../src/server/adapters/codex.js';
import { createClaudeAdapter } from '../src/server/adapters/claude.js';
import { defaultTeam } from '../src/shared/contracts.js';
const base = (cwd: string) => ({
  runId: 'r1',
  cwd,
  prompt: 'task',
  role: 'implementer' as const,
  executionMode: 'isolated' as const,
  profile: defaultTeam().codex,
  signal: new AbortController().signal,
});
test('a Codex app run starts its thread with only the chosen plugins and skills', async () => {
  await createCodexAdapter().execute(
    {
      ...base('/repo'),
      harness: { plugins: ['linear@curated'], skills: ['bc-ship'], projectDoc: true },
    },
    () => {},
    async () => ({ decision: 'deny' }) as any,
  );
  const config = calls.find((c) => c.method === 'thread/start')!.params.config;
  expect(config.plugins).toEqual({
    'linear@curated': { enabled: true },
    'braincrew@local': { enabled: false },
  });
  expect(config.skills.config).toEqual([{ name: 'bc-arxiv', enabled: false }]);
  expect(config['features.hooks']).toBe(false);
  expect(config).not.toHaveProperty('project_doc_max_bytes');
  // No harness saved: everything off, including AGENTS.md.
  calls.length = 0;
  await createCodexAdapter().execute(
    base('/repo'),
    () => {},
    async () => ({ decision: 'deny' }) as any,
  );
  const isolated = calls.find((c) => c.method === 'thread/start')!.params.config;
  expect(Object.values(isolated.plugins)).toEqual([{ enabled: false }, { enabled: false }]);
  expect(isolated.skills.config.map((s: any) => s.name)).toEqual(['bc-ship', 'bc-arxiv']);
  expect(isolated.project_doc_max_bytes).toBe(0);
});
test('a Claude app run gets the project instructions and no plugins unless chosen', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'pixel-claude-run-'));
  await writeFile(join(cwd, 'CLAUDE.md'), 'Use pnpm.');
  const claudeHome = await mkdtemp(join(tmpdir(), 'pixel-claude-home-'));
  const adapter = createClaudeAdapter({ claudeHome });
  await adapter.execute(
    {
      ...base(cwd),
      harness: { plugins: [], skills: [], projectDoc: true },
      harnessDir: join(cwd, '.h'),
    },
    () => {},
    async () => ({ decision: 'deny' }) as any,
  );
  await adapter.execute(
    base(cwd),
    () => {},
    async () => ({ decision: 'deny' }) as any,
  );
  expect(queries[0].prompt).toMatch(
    /^Project instructions from CLAUDE\.md:[\s\S]*Use pnpm\.[\s\S]*task$/,
  );
  expect(queries[0].options).toMatchObject({ settingSources: [], plugins: [] });
  expect(queries[1].prompt).toBe('task');
  expect(queries[1].options.plugins).toEqual([]);
});

test('Claude preserves the session-limit result as a classified failure instead of a generic error', async () => {
  failure.message = "You've hit your session limit · resets 5:20pm (Asia/Seoul)";
  try {
    const result = await createClaudeAdapter().execute(
      base('/repo'),
      () => {},
      async () => ({ decision: 'deny' }),
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      error: failure.message,
      failureKind: 'usage_limit',
    });
  } finally {
    failure.message = '';
  }
});

test('Codex recognizes a structured usage-limit error even without an English error message', async () => {
  failure.code = 'usageLimitExceeded';
  try {
    const result = await createCodexAdapter().execute(
      base('/repo'),
      () => {},
      async () => ({ decision: 'deny' }),
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      error: 'Provider unavailable',
      failureKind: 'usage_limit',
    });
  } finally {
    failure.code = '';
  }
});

test('personal Codex uses syc, keeps personal configuration and resumes a durable thread', async () => {
  calls.length = 0;
  const { spawn } = await import('node:child_process');
  await createCodexAdapter().execute(
    {
      ...base('/repo'),
      executionMode: 'personal',
      resumeSessionId: 'saved-thread',
      approvalMode: 'auto',
    },
    () => {},
    async () => ({ decision: 'approve' }),
  );
  expect(spawn).toHaveBeenLastCalledWith(
    'syc',
    ['app-server', '--stdio'],
    expect.objectContaining({ cwd: '/repo' }),
  );
  const resumed = calls.find((c) => c.method === 'thread/resume')!.params;
  expect(resumed.threadId).toBe('saved-thread');
  expect(resumed).not.toHaveProperty('config');
  expect(resumed).not.toHaveProperty('ephemeral', true);
  expect(resumed.sandbox).toBe('danger-full-access');
  expect(resumed.developerInstructions).not.toMatch(/Do not push/);
});
test('personal Claude uses sy with user settings, full tools and a persistent session', async () => {
  queries.length = 0;
  await createClaudeAdapter().execute(
    {
      ...base('/repo'),
      executionMode: 'personal',
      resumeSessionId: 'saved-session',
      approvalMode: 'auto',
    },
    () => {},
    async () => ({ decision: 'approve' }),
  );
  const options = queries[0].options;
  expect(options.pathToClaudeCodeExecutable).toBe('sy');
  expect(options.settingSources).toEqual(['user', 'project', 'local']);
  expect(options.resume).toBe('saved-session');
  expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
  expect(options.tools).toBeUndefined();
  expect(options.maxTurns).toBeUndefined();
  expect(options.plugins).toBeUndefined();
  expect(options.permissionMode).toBe('bypassPermissions');
});

test('personal Claude questions still wait for user input when permissions are bypassed', async () => {
  queries.length = 0;
  const interact = vi.fn(async () => ({ answers: { Choose: ['A'] } }));
  await createClaudeAdapter().execute(
    { ...base('/repo'), executionMode: 'personal', approvalMode: 'auto' },
    () => {},
    interact,
  );
  const hook = queries[0].options.hooks.PreToolUse[0].hooks[0];
  const result = await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [] },
  });
  expect(interact).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question' }));
  expect(result.hookSpecificOutput.updatedInput.answers).toEqual({ Choose: 'A' });
});

test('manual personal Claude denies a tool before sy can bypass permission callbacks', async () => {
  queries.length = 0;
  const interact = vi.fn(async () => ({ decision: 'deny' as const }));
  await createClaudeAdapter().execute(
    { ...base('/repo'), executionMode: 'personal', approvalMode: 'manual' },
    () => {},
    interact,
  );
  const hook = queries[0].options.hooks.PreToolUse[0].hooks[0];
  const result = await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/a.txt', content: 'x' },
  });
  expect(interact).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval' }));
  expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
});

test('individual conversations resume and fork through the same personal Codex runtime', async () => {
  const { createNativeDirectResponder } = await import('../src/server/adapters/direct.js');
  const responder = createNativeDirectResponder({ getApprovalMode: () => 'auto' });
  const session = {
    id: 'app-codex-thread',
    sessionId: 'saved-thread',
    provider: 'codex',
    cwd: '/repo',
    projectPath: '/repo',
    model: '',
    prompt: 'previous work',
    events: [],
    managed: { resumable: true },
  } as any;
  const input = {
    session,
    text: 'continue privately',
    fork: false,
    signal: new AbortController().signal,
    interact: async () => ({ decision: 'approve' as const }),
  };
  calls.length = 0;
  await responder(input, () => {});
  expect(calls.find((c) => c.method === 'thread/resume')?.params).toMatchObject({
    threadId: 'saved-thread',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  });
  expect(calls.some((c) => c.method === 'config/read')).toBe(false);
  calls.length = 0;
  await responder({ ...input, fork: true }, () => {});
  expect(calls.find((c) => c.method === 'thread/fork')?.params.threadId).toBe('saved-thread');
  expect(calls.some((c) => c.method === 'thread/resume')).toBe(false);
  calls.length = 0;
  await responder({ ...input, session: { ...session, managed: { resumable: false } } }, () => {});
  expect(calls.find((c) => c.method === 'thread/start')?.params.ephemeral).toBe(false);
  expect(calls.find((c) => c.method === 'turn/start')?.params.input[0].text).toContain(
    'previous work',
  );
});

test('a Claude coworker with a synthetic error model resumes using personal model settings', async () => {
  const { createNativeDirectResponder } = await import('../src/server/adapters/direct.js');
  queries.length = 0;
  await createNativeDirectResponder({ getApprovalMode: () => 'auto' })(
    {
      session: {
        id: 'claude-coworker',
        sessionId: 'saved-claude',
        provider: 'claude',
        cwd: '/repo',
        projectPath: '/repo',
        model: '<synthetic>',
        events: [],
      } as any,
      text: 'continue',
      fork: false,
      signal: new AbortController().signal,
      interact: async () => ({ decision: 'approve' }),
    },
    () => {},
  );
  expect(queries[0].options.resume).toBe('saved-claude');
  expect(queries[0].options.model).toBeUndefined();
});
