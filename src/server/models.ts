import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { RpcClient } from './adapters/codex-rpc.js';
import type { Provider } from '../shared/contracts.js';
export interface ModelOption {
  id: string;
  label: string;
  description: string;
}
export function normalizeModels(items: any[]): ModelOption[] {
  return items
    .filter((m) => !m.hidden && (m.model || m.value))
    .map((m) => ({
      id: m.model ?? m.value,
      label: m.displayName ?? m.model ?? m.value,
      description: m.description ?? '',
    }));
}
const cache = new Map<Provider, { at: number; models: ModelOption[] }>();
export async function listModels(
  provider: Provider,
): Promise<{ models: ModelOption[]; error?: string }> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < 300000) return { models: hit.models };
  try {
    let models: ModelOption[];
    if (provider === 'codex') {
      const rpc = new RpcClient(
        spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'pixel_catalog', version: '0.1.0' },
        });
        rpc.notify('initialized');
        const result = await rpc.request('model/list', { limit: 100 });
        models = normalizeModels(result.data);
      } finally {
        await rpc.close();
      }
    } else {
      let release: () => void;
      const stopped = new Promise<void>((r) => {
        release = r;
      });
      async function* input() {
        await stopped;
      }
      const stream = query({
        prompt: input(),
        options: { settingSources: [], tools: [], permissionMode: 'default' },
      });
      let timer: NodeJS.Timeout;
      try {
        models = normalizeModels(
          await Promise.race([
            stream.supportedModels(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('모델 목록 응답 시간 초과')), 10000);
            }),
          ]),
        );
      } finally {
        clearTimeout(timer!);
        release!();
        stream.close();
      }
    }
    cache.set(provider, { at: Date.now(), models });
    return { models };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
}
