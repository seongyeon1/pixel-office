import { expect, test, vi } from 'vitest';
const calls = vi.hoisted(() => [] as { method: string; params: any }[]);
const queries = vi.hoisted(() => [] as any[]);
vi.mock('node:child_process', async (real) => ({
  ...((await real()) as object),
  spawn: vi.fn(() => ({})),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: any) => {
    queries.push(args);
    const stream = (async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 's' };
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
        if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'fixture' };
        if (method === 'turn/start') {
          setTimeout(() =>
            this.emit('message', {
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
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
