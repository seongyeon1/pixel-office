import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  reviewSchema,
  reviewJsonSchema,
  type Adapter,
  type PhaseResult,
  emptyHarness,
} from '../../shared/contracts.js';
import { RpcClient } from './codex-rpc.js';
import { codexHarnessConfig } from '../harness.js';
import { normalizeCodex } from './normalize.js';
import { isUsageLimit } from './usage-limit.js';
const exec = promisify(execFile);
// Shown when a Codex coworker with `ask` rules is saved: what mcpLockdown turns off.
export const CODEX_LOCKDOWN_WARNING =
  'Codex는 외부 도구를 하나씩 승인받을 수 없어요. 승인 규칙이 있는 동안 Codex 실행에서는 모든 MCP 서버, 플러그인, 앱 연결(커넥터)을 끄고 실행해요.';
// `mcp list --json` through the same command, flags and folder the run will use.
export type McpLister = (command: string, args: string[], cwd: string) => Promise<string>;
const listMcp: McpLister = async (command, args, cwd) =>
  (await exec(command, args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const mcpSchema = z.array(z.object({ name: z.string(), enabled: z.boolean() }).passthrough());
// Plugin-bundled MCP servers and app connectors cannot be addressed by `-c mcp_servers.*`, so the
// features that bring them are turned off; every remaining (config) server is then disabled.
const lockdownFeatures = ['--disable', 'plugins', '--disable', 'apps'];
export async function mcpLockdown(
  command: string,
  pre: string[],
  cwd: string,
  list: McpLister = listMcp,
): Promise<string[]> {
  const read = async (flags: string[]) => {
    try {
      return mcpSchema.parse(
        JSON.parse(await list(command, [...pre, ...flags, 'mcp', 'list', '--json'], cwd)),
      );
    } catch {
      throw new Error(
        'Codex MCP 서버 목록을 확인하지 못해 외부 도구 승인 규칙을 지킬 수 없어요. 실행하지 않았어요.',
      );
    }
  };
  const servers = await read(lockdownFeatures);
  // `-c` splits its path on dots and takes no quoted segments.
  const unaddressable = servers.map((s) => s.name).filter((n) => !/^[A-Za-z0-9_-]+$/.test(n));
  if (unaddressable.length)
    throw new Error(
      `Codex MCP 서버 ${unaddressable.join(', ')}는 이름 때문에 끌 수 없어 외부 도구 승인 규칙을 지킬 수 없어요. 서버 이름을 영문·숫자·-·_로 바꿔 주세요.`,
    );
  const flags = [
    ...lockdownFeatures,
    ...servers.flatMap((s) => ['-c', `mcp_servers.${s.name}.enabled=false`]),
  ];
  const still = (await read(flags)).filter((s) => s.enabled).map((s) => s.name);
  if (still.length)
    throw new Error(
      `Codex MCP 서버 ${still.join(', ')}를 끄지 못해 외부 도구 승인 규칙을 지킬 수 없어요. 실행하지 않았어요.`,
    );
  return flags;
}
export function createCodexAdapter({ mcpList = listMcp }: { mcpList?: McpLister } = {}): Adapter {
  let active: RpcClient | undefined;
  return {
    async probe() {
      try {
        await exec('codex', ['--version'], { timeout: 5000 });
        try {
          const r = await exec('codex', ['login', 'status'], { timeout: 5000 });
          return { installed: true, authenticated: true, detail: (r.stdout || r.stderr).trim() };
        } catch {
          return {
            installed: true,
            authenticated: false,
            detail: '터미널에서 codex login을 실행해 주세요.',
          };
        }
      } catch {
        return { installed: false, authenticated: false, detail: 'Codex CLI를 설치해 주세요.' };
      }
    },
    async execute(input, emit, interact) {
      if (input.signal.aborted) return { outcome: 'cancelled', text: '' };
      const personal = input.executionMode !== 'isolated';
      const command = input.executable ?? (personal ? 'syc' : 'codex');
      // `--safe` is syc's own flag; other commands get the codex flags it expands to.
      const pre =
        personal && input.approvalMode === 'manual'
          ? command === 'syc'
            ? ['--safe']
            : ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
          : [];
      // The app server raises no approval naming an MCP tool before it runs, so an `ask` rule
      // cannot be enforced per tool: every external MCP server, plugin and app is turned off.
      let lockdown: string[] = [];
      if (input.toolRules?.some((rule) => rule.action === 'ask'))
        try {
          lockdown = await mcpLockdown(command, pre, input.cwd, mcpList);
        } catch (e) {
          return { outcome: 'failed', text: '', error: (e as Error).message };
        }
      const rpc = new RpcClient(
        spawn(command, [...pre, ...lockdown, 'app-server', '--stdio'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: input.cwd,
        }),
      );
      active = rpc;
      let threadId = '',
        turnId = '',
        text = '';
      let interruptTimer: NodeJS.Timeout | undefined;
      let finish: (r: PhaseResult) => void;
      const done = new Promise<PhaseResult>((r) => {
        finish = r;
      });
      rpc.on('failure', (e: Error) =>
        finish({ outcome: input.signal.aborted ? 'cancelled' : 'failed', text, error: e.message }),
      );
      const abort = () => {
        if (threadId && turnId)
          void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        interruptTimer = setTimeout(() => {
          void rpc.close();
        }, 3000);
      };
      input.signal.addEventListener('abort', abort, { once: true });
      rpc.on('message', (m: any) => {
        for (const e of normalizeCodex(input.runId, m)) emit(e);
        if (m.method === 'item/agentMessage/delta') text += m.params.delta ?? '';
        if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage')
          text = m.params.item.text ?? text;
        if (m.method === 'turn/started') turnId = m.params.turn.id;
        if (m.method === 'turn/completed') {
          const t = m.params.turn;
          finish({
            outcome:
              input.signal.aborted || t.status === 'interrupted'
                ? 'cancelled'
                : t.status === 'completed'
                  ? 'completed'
                  : 'failed',
            text,
            error: t.error?.message,
            failureKind: isUsageLimit(t.error) ? 'usage_limit' : undefined,
          });
        }
        if (m.id !== undefined && m.method) {
          void (async () => {
            const p = m.params ?? {};
            if (/requestUserInput$/.test(m.method)) {
              const a = await interact({
                runId: input.runId,
                agentId: 'codex',
                kind: 'question',
                title: 'Codex의 질문',
                details: p,
              });
              rpc.respond(m.id, {
                answers:
                  'answers' in a
                    ? Object.fromEntries(
                        Object.entries(a.answers).map(([k, v]) => [k, { answers: v }]),
                      )
                    : {},
              });
            } else if (/requestApproval$/.test(m.method)) {
              const a = await interact({
                runId: input.runId,
                agentId: 'codex',
                kind: 'approval',
                title: p.command ?? p.reason ?? 'Codex 작업 승인',
                details: { ...p, approvalMethod: m.method },
              });
              const allow = 'decision' in a && a.decision === 'approve';
              if (m.method.includes('/permissions/'))
                rpc.respond(m.id, {
                  permissions: allow ? (p.permissions ?? {}) : {},
                  scope: 'turn',
                });
              else rpc.respond(m.id, { decision: allow ? 'accept' : 'decline' });
            } else rpc.respond(m.id, { action: 'decline' });
          })().catch(() => {
            rpc.respond(m.id, { decision: 'cancel' });
          });
        }
      });
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'pixel_office', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        rpc.notify('initialized');
        // App runs are isolated like Claude's: only the repository's chosen plugins and skills.
        const effective = !personal
          ? await rpc.request('config/read', {
              cwd: input.cwd,
              includeLayers: false,
            })
          : undefined;
        const skills = !personal
          ? await rpc
              .request('skills/list', { cwds: [input.cwd] })
              .then((r: any) => (r.data ?? []).flatMap((e: any) => e.skills ?? []))
              .catch(() => [])
          : [];
        const t = await rpc.request(
          input.resumeSessionId
            ? input.forkSession
              ? 'thread/fork'
              : 'thread/resume'
            : 'thread/start',
          {
            ...(input.resumeSessionId ? { threadId: input.resumeSessionId } : {}),
            ...(!personal
              ? {
                  config: codexHarnessConfig(
                    input.harness ?? emptyHarness().codex,
                    Object.keys(effective?.config?.plugins ?? {}),
                    skills,
                  ),
                }
              : {}),
            cwd: input.cwd,
            model: input.profile.model || undefined,
            approvalPolicy: personal && input.approvalMode !== 'manual' ? 'never' : 'on-request',
            sandbox:
              personal && input.approvalMode !== 'manual'
                ? 'danger-full-access'
                : input.role === 'reviewer'
                  ? 'read-only'
                  : 'workspace-write',
            ...(!input.resumeSessionId ? { ephemeral: !personal } : {}),
            developerInstructions:
              'Follow the user request and personal project instructions. Preserve existing work. When the user requests a pull request, complete the necessary commit, push and PR creation, then verify and report its URL. Do not merge, deploy or force-push unless specifically requested. Respect the role instructions and report actual validation outcomes.',
          },
        );
        threadId = t.thread.id;
        emit({
          runId: input.runId,
          agentId: 'codex',
          type: 'agent.session',
          payload: { sessionId: threadId, model: t.model ?? input.profile.model ?? 'default' },
        });
        if (input.signal.aborted) return { outcome: 'cancelled', text };
        const started = await rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: input.prompt }],
          ...(input.role === 'reviewer' ? { outputSchema: reviewJsonSchema() } : {}),
        });
        turnId = started.turn.id;
        if (input.signal.aborted) abort();
        const result = await done;
        if (result.outcome === 'completed' && input.role === 'reviewer') {
          try {
            result.review = reviewSchema.parse(JSON.parse(result.text));
          } catch {
            result.error = '검토 응답 형식을 확인할 수 없습니다.';
          }
        }
        return result;
      } catch (e) {
        return {
          outcome: input.signal.aborted ? 'cancelled' : 'failed',
          text,
          error: (e as Error).message,
          failureKind: isUsageLimit((e as Error).message) ? 'usage_limit' : undefined,
        };
      } finally {
        input.signal.removeEventListener('abort', abort);
        if (interruptTimer) clearTimeout(interruptTimer);
        await rpc.close();
        if (active === rpc) active = undefined;
      }
    },
    async close() {
      await active?.close();
    },
  };
}
