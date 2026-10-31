import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { statusLabels, terminal } from '../shared/contracts.js';
import { COORDINATOR_ID, type CoworkerDraft } from '../shared/coworkers.js';
import { COORDINATOR_AGENTS } from './coordinator-agents.js';
import type { Coworkers } from './coworkers.js';
import type { Orchestrator } from './orchestrator.js';
import type { Assignment, Job, Store } from './store.js';
import type { WakeReason } from './slack/gateway.js';

export type { CoworkerDraft };
export const COORDINATOR_MODEL = 'claude-sonnet-5-5';
const SUMMARY = 4000;
const TURN_MS = 120_000;

export type CoordinatorTurn = {
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  resume?: string;
  abortController: AbortController;
  tools: SdkMcpToolDefinition<any>[];
};
// The resumed session could not be opened; the only error a fresh turn may retry.
export class ResumeFailed extends Error {
  override name = 'ResumeFailed';
}
export type CoordinatorRun = (turn: CoordinatorTurn) => Promise<{ sessionId?: string }>;

const clipText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// The real coordinator: a tool-less Claude turn whose only tools are the office's in-process MCP.
export const runQuery: CoordinatorRun = async (turn) => {
  const stream = query({
    prompt: turn.prompt,
    options: {
      cwd: turn.cwd,
      settingSources: [],
      systemPrompt: turn.systemPrompt,
      tools: [],
      mcpServers: { office: createSdkMcpServer({ name: 'office', tools: turn.tools }) },
      allowedTools: ['mcp__office__*'],
      permissionMode: 'default',
      maxTurns: 12,
      model: turn.model,
      resume: turn.resume,
      abortController: turn.abortController,
    },
  });
  let sessionId: string | undefined;
  try {
    for await (const message of stream) {
      if ('session_id' in message && message.session_id) sessionId = message.session_id;
      if (message.type === 'result' && message.subtype === 'error_during_execution')
        throw new Error('코디네이터 실행 중 오류가 났어요.');
    }
  } catch (e) {
    // A missing session fails before the session starts, or says so.
    const text = (e as Error).message ?? '';
    if (turn.resume && (!sessionId || /no conversation found/i.test(text)))
      throw new ResumeFailed(text);
    throw e;
  }
  return { sessionId };
};

const delegateShape = {
  coworkerId: z.string(),
  task: z.string().min(1),
  after: z.string().optional(),
};
const followUpShape = { assignmentId: z.string(), prompt: z.string().min(1) };
const cancelShape = { assignmentId: z.string() };
// The approval message shows the whole role, so it is capped at what it can show.
const proposeShape = {
  name: z.string().trim().min(1).max(40),
  folder: z.string().min(1),
  role: z.string().trim().max(1000),
  engine: z.enum(['claude', 'codex']),
};
const replyShape = { text: z.string().min(1).max(3000) };
// Untrusted text goes inside a fence it cannot close.
const fence = (tag: string, text: string) =>
  `<${tag}>\n${text.replaceAll(`</${tag}>`, '')}\n</${tag}>`;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

export function createCoordinator({
  store,
  coworkers,
  orchestrator,
  dataDir,
  reply,
  propose,
  run = runQuery,
  timeoutMs = TURN_MS,
}: {
  store: Store;
  coworkers: Pick<Coworkers, 'get' | 'list'>;
  orchestrator: Pick<Orchestrator, 'startFor' | 'followUp' | 'cancel' | 'queuePosition'>;
  dataDir: string;
  reply: (jobId: string, text: string) => Promise<void>;
  propose: (jobId: string, draft: CoworkerDraft) => Promise<void>;
  run?: CoordinatorRun;
  timeoutMs?: number;
}) {
  const folder = join(dataDir, 'coordinator');
  const agentsPath = join(folder, 'AGENTS.md');
  const chains = new Map<string, Promise<void>>();
  // Turns in flight, so stop() can end them; once stopped nothing runs or acts again.
  const live = new Set<{ state: { closed: boolean }; abortController: AbortController }>();
  let stopped = false;
  // A server-side notice; a Slack failure here must not stop the job's queue.
  const say = (jobId: string, text: string) => reply(jobId, text).catch(() => {});

  const readAgents = async () => {
    await mkdir(folder, { recursive: true });
    // `wx` never replaces a file the user already edited.
    await writeFile(agentsPath, COORDINATOR_AGENTS, { flag: 'wx' }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    });
    return readFile(agentsPath, 'utf8');
  };
  const model = () =>
    coworkers.get(COORDINATOR_ID)?.model ||
    store.getSetting<{ model?: string }>('coordinatorModel', {}).model ||
    COORDINATOR_MODEL;

  // Reads the job fresh and writes synchronously, so no await sits between read and write.
  const patch = (jobId: string, fn: (list: Assignment[]) => Assignment[]) => {
    const job = store.getJob(jobId)!;
    return store.updateJob(jobId, { assignments: fn(job.assignments) });
  };
  const find = (jobId: string, id: string) => {
    const found = store.getJob(jobId)?.assignments.find((a) => a.id === id);
    if (!found) throw new Error('배정을 찾을 수 없어요.');
    return found;
  };
  const stateOf = (job: Job, a: Assignment) => {
    if (!a.runId) {
      const before = job.assignments.find((x) => x.id === a.after);
      const status = before?.runId ? store.getRun(before.runId)?.status : undefined;
      return status && terminal(status) && status !== 'completed'
        ? '앞 배정이 실패해 시작하지 않음'
        : `대기 · 배정 ${a.after}이 끝나면 시작`;
    }
    const r = store.getRun(a.runId);
    if (!r) return '기록 없음';
    const position = orchestrator.queuePosition(r.id);
    return r.status === 'queued' && position > 0
      ? `대기 중 · ${position}번째`
      : statusLabels[r.status];
  };
  const describe = (job: Job) =>
    job.assignments.map((a) => {
      const r = a.runId ? store.getRun(a.runId) : undefined;
      return {
        assignmentId: a.id,
        coworkerId: a.coworkerId,
        task: clipText(a.task, 500),
        state: stateOf(job, a),
        ...(a.after ? { after: a.after } : {}),
        ...(r?.summary ? { summary: clipText(r.summary, SUMMARY) } : {}),
        ...(r?.error ? { error: clipText(r.error, 1000) } : {}),
      };
    });
  const startAssignment = async (job: Job, a: Assignment, prompt: string) => {
    const coworker = coworkers.get(a.coworkerId);
    if (!coworker) throw new Error('동료를 찾을 수 없어요.');
    const r = await orchestrator.startFor(coworker, prompt, { kind: 'slack', jobId: job.id });
    // Recorded right away: the gateway finds the assignment by run id when the run ends.
    patch(job.id, (list) => list.map((x) => (x.id === a.id ? { ...x, runId: r.id } : x)));
    return r;
  };
  const withPrevious = (runId: string, task: string) =>
    `이전 단계 결과:\n${clipText(store.getRun(runId)?.summary || '(요약 없음)', SUMMARY)}\n\n${task}`;
  // Pending assignments behind a completed one start now; behind a failed one they wait for the
  // coordinator (it sees the error and can cancel or re-plan).
  const startDependents = async (jobId: string, assignmentId: string) => {
    const done = store.getJob(jobId)?.assignments.find((a) => a.id === assignmentId);
    if (!done?.runId || store.getRun(done.runId)?.status !== 'completed') return;
    for (const a of store
      .getJob(jobId)!
      .assignments.filter((x) => x.after === assignmentId && !x.runId))
      await startAssignment(store.getJob(jobId)!, a, withPrevious(done.runId, a.task)).catch((e) =>
        say(jobId, `배정을 시작하지 못했어요. ${(e as Error).message}`),
      );
  };

  // `acted` records side effects so a failed turn is never replayed; `closed` stops a timed-out
  // turn from acting after the job has moved on.
  const toolsFor = (jobId: string, state: { acted: boolean; closed: boolean }) => {
    const ok = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    });
    const guard =
      <S extends z.ZodRawShape>(
        shape: S,
        fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
        acts = true,
      ) =>
      async (args: unknown) => {
        try {
          if (state.closed) throw new Error('이 턴은 이미 끝났어요.');
          // Validated here too, so the limits hold whatever calls the handler.
          const parsed = z.object(shape).parse(args);
          if (acts) state.acted = true;
          return ok(await fn(parsed));
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: (e as Error).message }],
            isError: true,
          };
        }
      };
    return [
      tool(
        'list_coworkers',
        '오피스 동료 명단(id, 이름, 역할, 폴더, 모드, 바쁜지)을 봐요.',
        {},
        guard(
          {},
          async () => {
            const busy = new Set(
              store
                .listRuns()
                .filter((r) => !terminal(r.status) && r.coworkerId)
                .map((r) => r.coworkerId),
            );
            return {
              coworkers: coworkers
                .list()
                .filter((c) => c.id !== COORDINATOR_ID)
                .map((c) => ({
                  id: c.id,
                  name: c.name,
                  role: c.role,
                  folder: c.folder,
                  engine: c.engine,
                  mode: c.mode,
                  busy: busy.has(c.id),
                })),
            };
          },
          false,
        ),
      ),
      tool(
        'delegate',
        '동료에게 일을 맡겨요. after에 앞 배정 id를 주면 그 배정이 끝난 뒤 결과를 붙여 시작해요.',
        delegateShape,
        guard(delegateShape, async ({ coworkerId, task, after }) => {
          const coworker = coworkers.get(coworkerId);
          if (!coworker || coworker.id === COORDINATOR_ID)
            throw new Error('동료를 찾을 수 없어요.');
          const a: Assignment = { id: randomUUID(), coworkerId, task, ...(after ? { after } : {}) };
          let prompt = task;
          if (after) {
            const previous = find(jobId, after);
            const status = previous.runId ? store.getRun(previous.runId)?.status : undefined;
            if (!status || !terminal(status)) {
              patch(jobId, (list) => [...list, a]);
              return { assignmentId: a.id, status: 'pending' };
            }
            if (status !== 'completed')
              throw new Error(`앞 배정이 ${statusLabels[status]} 상태로 끝났어요.`);
            prompt = withPrevious(previous.runId!, task);
          }
          patch(jobId, (list) => [...list, a]);
          try {
            const r = await startAssignment(store.getJob(jobId)!, a, prompt);
            return { assignmentId: a.id, status: r.status };
          } catch (e) {
            patch(jobId, (list) => list.filter((x) => x.id !== a.id));
            throw e;
          }
        }),
      ),
      tool(
        'follow_up',
        '배정에 후속 지시를 보내요. 진행 중이면 끝난 직후 이어서 해요. 새 배정 id를 돌려줘요.',
        followUpShape,
        guard(followUpShape, async ({ assignmentId, prompt }) => {
          const source = find(jobId, assignmentId);
          if (!source.runId) throw new Error('아직 시작하지 않은 배정이에요.');
          const r = await orchestrator.followUp(source.runId, prompt, { whenDone: true });
          const a: Assignment = {
            id: randomUUID(),
            coworkerId: source.coworkerId,
            runId: r.id,
            task: prompt,
          };
          // A retry takes over the steps that were waiting on the original.
          patch(jobId, (list) => [
            ...list.map((x) => (x.after === assignmentId && !x.runId ? { ...x, after: a.id } : x)),
            a,
          ]);
          return { assignmentId: a.id, status: r.status };
        }),
      ),
      tool(
        'cancel',
        '사용자가 분명히 멈추라고 했을 때, 또는 실패한 배정 뒤에 기다리는 배정을 정리할 때 써요. 그 배정을 기다리던 배정도 빠져요.',
        cancelShape,
        guard(cancelShape, async ({ assignmentId }) => {
          const a = find(jobId, assignmentId);
          // Pending assignments chained behind this one would otherwise wait forever.
          const chain = new Set([a.id]);
          for (let grew = true; grew;) {
            grew = false;
            for (const x of store.getJob(jobId)!.assignments)
              if (!x.runId && x.after && chain.has(x.after) && !chain.has(x.id)) {
                chain.add(x.id);
                grew = true;
              }
          }
          patch(jobId, (list) => list.filter((x) => x.runId || !chain.has(x.id)));
          if (a.runId) await orchestrator.cancel(a.runId);
          return { cancelled: [...chain] };
        }),
      ),
      tool(
        'job_status',
        '이 일의 배정별 상태와 요약을 봐요.',
        {},
        guard({}, async () => ({ assignments: describe(store.getJob(jobId)!) }), false),
      ),
      tool(
        'propose_coworker',
        '맞는 동료가 없을 때 새 동료를 제안해요. 사용자가 [만들기]를 눌러야 생겨요.',
        proposeShape,
        guard(proposeShape, async ({ name, folder, role, engine }) => {
          const taken = new Set(coworkers.list().map((c) => c.id));
          const base = slug(basename(folder)) || slug(name) || 'coworker';
          let id = base;
          for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
          await propose(jobId, { id, name, folder, role, engine });
          return { proposed: id, note: '사용자가 [만들기]를 누르면 다시 알려 드려요.' };
        }),
      ),
      tool(
        'reply',
        '이 일의 Slack 스레드에 답글을 달아요.',
        replyShape,
        guard(replyShape, async ({ text }) => {
          await reply(jobId, text);
          return { sent: true };
        }),
      ),
    ];
  };

  const promptFor = (job: Job, reason: WakeReason) => {
    const why =
      reason.kind === 'assignment_done'
        ? `배정 ${reason.assignmentId}이 끝났어요.`
        : reason.kind === 'new'
          ? `새 일이 들어왔어요. 요청:\n${fence('slack_message', reason.text)}`
          : `스레드에 답글이 달렸어요. 답글:\n${fence('slack_message', reason.text)}`;
    const list = describe(job);
    const body = list.length ? JSON.stringify(list, null, 2) : '(아직 없음)';
    return `${why}\n\n이 일의 배정:\n${fence('assignments', body)}`;
  };
  // One coordinator turn, capped in time; the prompt is built from the job as it is now.
  const turn = async (jobId: string, reason: WakeReason, resume: string | undefined) => {
    const state = { acted: false, closed: false };
    const abortController = new AbortController();
    const entry = { state, abortController };
    live.add(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('timeout'));
        abortController.abort();
      }, timeoutMs);
      abortController.signal.addEventListener('abort', () => reject(new Error('stopped')));
    });
    try {
      return await Promise.race([
        (async () =>
          run({
            prompt: promptFor(store.getJob(jobId)!, reason),
            systemPrompt: await readAgents(),
            model: model(),
            cwd: folder,
            resume,
            abortController,
            tools: toolsFor(jobId, state),
          }))(),
        timeout,
      ]);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { acted: state.acted });
    } finally {
      state.closed = true;
      live.delete(entry);
      clearTimeout(timer);
    }
  };
  const handle = async (jobId: string, reason: WakeReason) => {
    if (stopped) return;
    try {
      if (reason.kind === 'assignment_done') await startDependents(jobId, reason.assignmentId);
      const job = store.getJob(jobId);
      if (!job) return;
      let result: { sessionId?: string };
      try {
        result = await turn(jobId, reason, job.coordinatorSessionId);
      } catch (e) {
        // Only a session that could not be reopened, before any tool acted, runs again fresh.
        const resumeFailed = (e as Error).name === 'ResumeFailed';
        if (
          stopped ||
          !job.coordinatorSessionId ||
          !resumeFailed ||
          (e as { acted?: boolean }).acted
        )
          throw e;
        result = await turn(jobId, reason, undefined);
      }
      if (result.sessionId) store.updateJob(jobId, { coordinatorSessionId: result.sessionId });
    } catch (e) {
      if (stopped) return;
      const message = (e as Error).message;
      await say(
        jobId,
        message === 'timeout'
          ? '코디네이터가 시간 안에 답하지 못했어요. 스레드에 답글을 달면 다시 해 볼게요.'
          : `코디네이터가 일을 나누지 못했어요. ${message}`,
      );
    }
  };

  return {
    // Only enqueues: it is called from inside bus event handlers, so nothing runs synchronously.
    wake(jobId: string, reason: WakeReason) {
      if (stopped) return;
      const next = (chains.get(jobId) ?? Promise.resolve())
        .then(() => handle(jobId, reason))
        .catch(() => {});
      chains.set(jobId, next);
      void next.finally(() => chains.get(jobId) === next && chains.delete(jobId));
    },
    // For a disconnect or reconnect: ends turns in flight, refuses their later tool calls and
    // drops queued wakes, so an old coordinator never acts beside its replacement.
    stop() {
      stopped = true;
      for (const { state, abortController } of live) {
        state.closed = true;
        abortController.abort();
      }
      live.clear();
    },
    // Resolves once every queued wake has finished (tests and shutdown).
    async settled() {
      while (chains.size) await Promise.all(chains.values());
    },
  };
}
export type Coordinator = ReturnType<typeof createCoordinator>;
