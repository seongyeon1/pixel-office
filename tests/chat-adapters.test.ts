import { expect, test, vi } from 'vitest';
const calls = vi.hoisted(() => [] as { method: string; params: any }[]);
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({})) }));
vi.mock('../src/server/adapters/codex-rpc.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    RpcClient: class extends EventEmitter {
      async request(method: string, params: any) {
        calls.push({ method, params });
        if (method === 'config/read')
          return {
            config: {
              mcp_servers: { 'server.with.dot': {} },
              apps: { 'an.app': { enabled: true } },
              plugins: { 'external.plugin': { enabled: true } },
            },
          };
        if (method === 'thread/start')
          return { thread: { id: 'separate-thread' }, model: 'fixture' };
        if (method === 'turn/start') {
          this.emit('message', {
            method: 'item/agentMessage/delta',
            params: { delta: '기록 답변' },
          });
          this.emit('message', {
            method: 'turn/completed',
            params: { turn: { status: 'completed' } },
          });
          return { turn: { id: 'turn' } };
        }
        return {};
      }
      notify() {}
      async close() {}
    },
  };
});
import { createNativeChatResponder } from '../src/server/adapters/chat.js';
test('record QA disables local image/browser/hook access as well as shell and external integrations', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pixel-chat-adapter-'));
  try {
    let answer = '';
    await createNativeChatResponder(dir)(
      { provider: 'codex', prompt: 'record question', signal: new AbortController().signal },
      (text) => {
        answer = text;
      },
    );
    expect(answer).toBe('기록 답변');
    const params = calls.find((c) => c.method === 'thread/start')!.params;
    expect(params.sandbox).toBe('read-only');
    expect(params.ephemeral).toBe(true);
    for (const feature of [
      'view_image',
      'browser_use',
      'browser_use_external',
      'computer_use',
      'in_app_browser',
      'in_app_local_automation',
      'hooks',
      'plugins',
      'remote_plugin',
      'skill_search',
      'skill_mcp_dependency_install',
      'shell_tool',
      'unified_exec',
      'apps',
      'multi_agent',
      'image_generation',
      'memories',
      'workspace_dependencies',
    ])
      expect(params.config[`features.${feature}`], feature).toBe(false);
    expect(params.config['features.skip_host_skill_discovery']).toBe(true);
    expect(params.config.mcp_servers['server.with.dot'].enabled).toBe(false);
    expect(params.config.apps['an.app'].enabled).toBe(false);
    expect(params.config.plugins['external.plugin'].enabled).toBe(false);
    expect(calls.some((c) => /resume|steer|fork/.test(c.method))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
