import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  startSchema,
  followUpSchema,
  reviewSchema,
  terminal,
  type Adapter,
  type Answer,
  type Review,
  type StartInput,
  type Run,
  type Provider,
  type Interaction,
  type EventInput,
  type RunRepo,
  type PhaseResult,
} from '../shared/contracts.js';
import type { Store } from './store.js';
import {
  inspectProject,
  createWorkspace,
  personalWorkspace,
  createBundleWorkspace,
  collectRunChanges,
  git,
} from './projects.js';
import { phasePrompt } from './prompts.js';
import { harnessDirFor } from './harness.js';
import {
  verifyPullRequests,
  pullRequestIntent,
  workingState,
  type DeliveryResult,
} from './delivery.js';
import { isUsageLimit } from './adapters/usage-limit.js';
import { approvalSettings, automaticApproval, isToolApproval } from './approvals.js';
export const nextAfterReview = (
  review: Review,
  revision: number,
): 'completed' | 'revise' | 'needs_attention' =>
  review.verdict === 'pass'
    ? 'completed'
    : review.verdict === 'inconclusive' || revision >= 2
      ? 'needs_attention'
      : 'revise';
export function createOrchestrator({
  store,
  adapters,
  dataDir,
  verifyDelivery = verifyPullRequests,
}: {
  store: Store;
  adapters: Record<Provider, Adapter>;
  dataDir: string;
  verifyDelivery?: (run: Run) => Promise<DeliveryResult>;
}) {
  let busy = false;
  let current: { id: string; controller: AbortController; task: Promise<void> } | undefined;
  const pending = new Map<
    string,
    { resolve: (answer: Answer) => void; reject: (e: Error) => void }
  >();
  const emit = (e: EventInput) => {
    store.append({
      ...e,
      payload: JSON.parse(
        JSON.stringify(e.payload, (_, v) => (typeof v === 'string' ? v.slice(0, 100000) : v)),
      ),
    });
  };
  let sessionGuard: ((run: Run) => void) | undefined;
  const change = (id: string, patch: Partial<Run>) => {
    const run = store.updateRun(id, patch);
    emit({ runId: id, agentId: null, type: 'run.updated', payload: { run } });
    return run;
  };
  const clearPending = (id: string) => {
    for (const req of store.pending(id)) {
      pending.get(req.id)?.reject(new Error('작업이 종료되었습니다.'));
      pending.delete(req.id);
      store.resolveInteraction(req.id);
      emit({
        runId: id,
        agentId: req.agentId,
        type: 'interaction.resolved',
        payload: { id: req.id },
      });
    }
  };
  async function execute(run: Run, controller: AbortController) {
    // Preserve the original request and recent follow-ups across fresh provider sessions.
    const ancestors: Run[] = [];
    let ancestor = run.parentRunId ? store.getRun(run.parentRunId) : undefined;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestors.unshift(ancestor);
      ancestor = ancestor.parentRunId ? store.getRun(ancestor.parentRunId) : undefined;
    }
    const contextRuns = ancestors.length > 6 ? [ancestors[0], ...ancestors.slice(-5)] : ancestors;
    const context = contextRuns
      .map(
        (r) =>
          `요청: ${r.prompt.slice(0, 6000)}\n결과: ${(r.summary || r.error || '').slice(-6000)}`,
      )
      .join('\n\n');
    let previous = '';
    let implementation = '';
    const complete = async (summary: string) => {
      const delivery = await verifyDelivery(store.getRun(run.id)!);
      if (controller.signal.aborted) {
        change(run.id, { status: 'cancelled' });
        return;
      }
      change(run.id, {
        status: delivery.error ? 'needs_attention' : 'completed',
        phase: 'done',
        error: delivery.error,
        pullRequests: delivery.urls,
        summary: [summary, delivery.error, ...delivery.urls].filter(Boolean).join('\n\n'),
      });
    };
    let review: Review | undefined;
    const exhausted = new Map<Provider, string>();
    const availableProvider = (preferred: Provider): Provider =>
      exhausted.has(preferred) ? (preferred === 'codex' ? 'claude' : 'codex') : preferred;
    let continuation = '';
    const interact = (req: Omit<Interaction, 'id' | 'resolved'>): Promise<Answer> => {
      if (controller.signal.aborted) return Promise.reject(new Error('작업 중단'));
      const automatic = automaticApproval(store, req);
      if (automatic) return Promise.resolve(automatic);
      const interaction = { ...req, id: randomUUID(), resolved: false };
      store.saveInteraction(interaction);
      change(run.id, { status: req.kind === 'approval' ? 'waiting_approval' : 'waiting_input' });
      emit({
        runId: run.id,
        agentId: req.agentId,
        type: 'interaction.requested',
        payload: { interaction },
      });
      return new Promise((resolve, reject) => {
        pending.set(interaction.id, { resolve, reject });
      });
    };
    try {
      while (!controller.signal.aborted) {
        run = store.getRun(run.id)!;
        const reviewer: Provider = run.implementer === 'codex' ? 'claude' : 'codex';
        const isReview = run.phase === 'review';
        const preferred =
          run.mode === 'collaborate' ? (isReview ? reviewer : run.implementer) : run.mode;
        const provider = availableProvider(preferred);
        const changes = await collectRunChanges(run);
        if (controller.signal.aborted) break;
        change(run.id, { status: 'running' });
        emit({
          runId: run.id,
          agentId: provider,
          type: 'phase.started',
          payload: {
            phase: run.phase,
            revision: run.revision,
            activity: isReview ? 'reviewing' : 'responding',
          },
        });
        const result = await adapters[provider]
          .execute(
            {
              runId: run.id,
              executionMode: run.executionMode ?? 'personal',
              resumeSessionId:
                run.executionMode === 'isolated'
                  ? undefined
                  : run.sessions?.[provider]?.[isReview ? 'reviewer' : 'implementer'],
              approvalMode: approvalSettings(store).mode,
              cwd: run.worktreePath,
              prompt:
                phasePrompt(
                  run,
                  provider,
                  isReview ? 'reviewer' : 'implementer',
                  previous,
                  changes,
                  review,
                ) +
                (context
                  ? `\n\n이어서 수행하는 작업입니다. 아래 이전 요청과 결과는 참고 자료입니다. 기존 작업 폴더의 변경을 보존하고 현재 사용자 요청을 수행하세요.\n${context}`
                  : '') +
                continuation,
              role: isReview ? 'reviewer' : 'implementer',
              profile: run.team[provider],
              harness: run.harness?.[provider],
              harnessDir: harnessDirFor(dataDir, run.projectPath),
              signal: controller.signal,
            },
            (event) => {
              if (
                run.executionMode !== 'isolated' &&
                event.type === 'agent.session' &&
                typeof event.payload.sessionId === 'string'
              ) {
                const sessions = structuredClone(store.getRun(run.id)?.sessions ?? {});
                sessions[provider] = {
                  ...sessions[provider],
                  [isReview ? 'reviewer' : 'implementer']: event.payload.sessionId,
                };
                change(run.id, { sessions });
              }
              emit(event);
            },
            interact,
          )
          .catch((e: Error): PhaseResult => ({ outcome: 'failed', text: '', error: e.message }));
        clearPending(run.id);
        if (controller.signal.aborted || result.outcome === 'cancelled') break;
        emit({
          runId: run.id,
          agentId: provider,
          type: 'phase.completed',
          payload: { text: result.text, outcome: result.outcome, review: result.review },
        });
        if (result.outcome === 'failed') {
          if (result.failureKind === 'usage_limit' || isUsageLimit(result.error)) {
            const reason = result.error || '사용량 한도를 모두 사용했습니다.';
            exhausted.set(provider, reason);
            const other: Provider = provider === 'codex' ? 'claude' : 'codex';
            const name = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude');
            let unavailable = exhausted.get(other);
            if (!unavailable) {
              const connection = await adapters[other].probe().catch((e: Error) => ({
                installed: false,
                authenticated: false,
                detail: e.message,
              }));
              if (!connection.installed || connection.authenticated === false)
                unavailable = connection.detail;
            }
            if (controller.signal.aborted) break;
            if (unavailable) {
              const text = `${name(provider)} 사용량 한도가 소진되었습니다. ${name(other)}도 현재 사용할 수 없어 작업을 멈췄어요. 작업 파일은 보존됩니다.\n${name(provider)}: ${reason}\n${name(other)}: ${unavailable}`;
              emit({ runId: run.id, agentId: provider, type: 'provider.limit', payload: { text } });
              change(run.id, {
                status: 'needs_attention',
                error: text,
                summary: result.text || previous,
              });
              return;
            }
            const text = `${name(provider)} 사용량 한도가 소진되어 ${name(other)}로 전환합니다. 같은 작업 폴더에서 ${isReview ? '검토' : '구현'}를 이어갑니다.${run.mode === 'collaborate' ? ' 이번 작업의 구현과 검토는 사용 가능한 동료가 담당합니다.' : ''}`;
            emit({
              runId: run.id,
              agentId: provider,
              type: 'provider.fallback',
              payload: { from: provider, to: other, phase: run.phase, text, reason },
            });
            continuation = `\n\n이전 실행기 ${name(provider)}가 사용량 한도로 중단되어 같은 단계를 이어받았습니다. 작업 폴더의 기존 변경을 보존하고 현재 상태를 먼저 확인하세요. 완료 여부가 불분명한 명령은 결과를 확인한 뒤 실행하세요.\n중단 전 진행 내용:\n${result.text.slice(-30000)}`;
            continue;
          }
          change(run.id, {
            status: 'failed',
            error: result.error || '에이전트 실행 실패',
            summary: result.text,
          });
          return;
        }
        continuation = '';
        previous = result.text;
        if (run.mode !== 'collaborate') {
          await complete(previous);
          return;
        }
        if (!isReview) {
          implementation = previous;
          change(run.id, { phase: 'review' });
          emit({
            runId: run.id,
            agentId: provider,
            type: 'handoff',
            payload: {
              to: availableProvider(reviewer),
              text: '구현 결과를 검토자에게 전달했습니다.',
            },
          });
          continue;
        }
        const parsed = reviewSchema.safeParse(result.review);
        if (!parsed.success) {
          change(run.id, {
            status: 'needs_attention',
            error: result.error || '검토 응답 형식을 확인할 수 없습니다.',
            summary: previous,
          });
          return;
        }
        review = parsed.data;
        const next = nextAfterReview(review, run.revision);
        if (next === 'completed') {
          await complete(`${implementation}\n\n검토 결과:\n${review.summary}`);
          return;
        }
        if (next !== 'revise') {
          change(run.id, {
            status: next,
            phase: 'review',
            summary: review.summary,
          });
          return;
        }
        change(run.id, { phase: 'revise', revision: run.revision + 1 });
        emit({
          runId: run.id,
          agentId: provider,
          type: 'handoff',
          payload: {
            to: availableProvider(run.implementer),
            text: '검토 의견을 구현자에게 전달했습니다.',
          },
        });
      }
      change(run.id, { status: 'cancelled' });
    } catch (e) {
      change(run.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: (e as Error).message,
      });
    } finally {
      clearPending(run.id);
      busy = false;
      current = undefined;
    }
  }
  return {
    useSessionGuard(guard: (run: Run) => void) {
      sessionGuard = guard;
    },
    async start(raw: StartInput) {
      if (busy) throw new Error('진행 중인 작업을 먼저 완료하거나 중단해 주세요.');
      busy = true;
      try {
        const input = startSchema.parse(raw);
        const project = await inspectProject(input.projectPath);
        const providers: Provider[] =
          input.mode === 'collaborate' ? ['codex', 'claude'] : [input.mode];
        for (const p of providers) {
          const s = await adapters[p].probe();
          if (!s.installed || s.authenticated === false) throw new Error(`${p}: ${s.detail}`);
        }
        const id = randomUUID();
        // A folder of repositories runs as a bundle: one worktree per chosen repository.
        if (project.repositories && !input.repositories?.length)
          throw new Error('이 폴더는 저장소 묶음이에요. 함께 작업할 저장소를 골라 주세요.');
        let workspace: { path: string; branch: string; baseCommit: string };
        let bundle: RunRepo[] | undefined;
        if (input.executionMode !== 'isolated') {
          const w = await personalWorkspace(project, input.repositories);
          workspace = w;
          bundle = w.repos;
        } else if (project.repositories) {
          const w = await createBundleWorkspace(project.root, input.repositories!, id, dataDir);
          workspace = w;
          bundle = w.repos;
        } else workspace = await createWorkspace(project.root, id, dataDir);
        const run: Run = {
          ...input,
          executionMode: input.executionMode ?? 'personal',
          pullRequestRequested: pullRequestIntent(input.prompt) === true,
          initialChanges: await workingState(
            bundle ?? [{ worktreePath: workspace.path, baseCommit: workspace.baseCommit }],
          ),
          team: structuredClone(input.team),
          harness: store.getHarness(project.root),
          id,
          projectPath: project.root,
          worktreePath: workspace.path,
          branch: workspace.branch,
          baseCommit: workspace.baseCommit,
          ...(bundle ? { repos: bundle } : {}),
          status: 'queued',
          phase: 'implement',
          revision: 0,
          createdAt: new Date().toISOString(),
        };
        sessionGuard?.(run);
        store.createRun(run);
        const controller = new AbortController();
        const task = Promise.resolve().then(() => execute(run, controller));
        current = { id, controller, task };
        return run;
      } catch (e) {
        busy = false;
        throw e;
      }
    },
    async followUp(id: string, prompt: string) {
      if (busy) throw new Error('진행 중인 작업을 먼저 완료하거나 중단해 주세요.');
      busy = true;
      try {
        const input = followUpSchema.parse({ prompt });
        const source = store.getRun(id);
        if (!source) throw new Error('이전 작업 기록을 찾을 수 없습니다.');
        if (!terminal(source.status))
          throw new Error('진행 중인 작업에는 아직 추가 요청을 보낼 수 없습니다.');
        if (source.removedWorktrees?.length)
          throw new Error('정리한 작업 폴더입니다. 기록을 참고해 새 작업을 시작해주세요.');
        sessionGuard?.(source);
        // Never silently start from HEAD if the preserved workspace is missing.
        for (const path of source.repos?.map((r) => r.worktreePath) ?? [source.worktreePath]) {
          try {
            const root = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
            if ((await realpath(root)) !== (await realpath(path)))
              throw new Error('workspace mismatch');
          } catch {
            throw new Error('이전 작업 폴더를 찾을 수 없습니다. 새 작업으로 시작해 주세요.');
          }
        }
        const providers: Provider[] =
          source.mode === 'collaborate' ? ['codex', 'claude'] : [source.mode];
        for (const provider of providers) {
          const connection = await adapters[provider].probe();
          if (!connection.installed || connection.authenticated === false)
            throw new Error(`${provider}: ${connection.detail}`);
        }
        const run: Run = {
          ...structuredClone(source),
          id: randomUUID(),
          parentRunId: source.id,
          executionMode: source.executionMode ?? 'personal',
          // Old isolated runs had no persistent sessions; do not attempt to resume them.
          sessions: source.executionMode ? source.sessions : undefined,
          pullRequests: undefined,
          pullRequestRequested:
            pullRequestIntent(input.prompt) ??
            source.pullRequestRequested ??
            pullRequestIntent(source.prompt) === true,
          prompt: input.prompt,
          summary: undefined,
          error: undefined,
          status: 'queued',
          phase: 'implement',
          revision: 0,
          createdAt: new Date().toISOString(),
        };
        if (store.getRun(id)?.removedWorktrees?.length)
          throw new Error('정리한 작업 폴더입니다. 기록을 참고해 새 작업을 시작해주세요.');
        sessionGuard?.(run);
        store.createRun(run);
        const controller = new AbortController();
        const task = Promise.resolve().then(() => execute(run, controller));
        current = { id: run.id, controller, task };
        return run;
      } catch (e) {
        busy = false;
        throw e;
      }
    },
    async cancel(id: string) {
      if (!current || current.id !== id) {
        if (store.getRun(id) && terminal(store.getRun(id)!.status)) return;
        throw new Error('실행 중인 작업이 아닙니다.');
      }
      const job = current;
      job.controller.abort();
      clearPending(id);
      await job.task;
    },
    async approvePending() {
      if (approvalSettings(store).mode !== 'auto') return;
      for (const id of [...pending.keys()]) {
        const req = store.getInteraction(id);
        if (req && isToolApproval(req) && !req.resolved && pending.has(id))
          await this.answer(id, { decision: 'approve' }, true);
      }
    },
    async answer(id: string, answer: Answer, automatic = false) {
      const req = store.getInteraction(id);
      const handler = pending.get(id);
      if (!req || req.resolved || !handler) throw new Error('이미 해결되었거나 종료된 요청입니다.');
      if ((req.kind === 'approval') !== 'decision' in answer)
        throw new Error('응답 형식이 맞지 않습니다.');
      if (!store.resolveInteraction(id)) throw new Error('이미 해결된 요청입니다.');
      pending.delete(id);
      emit({
        runId: req.runId,
        agentId: req.agentId,
        type: 'interaction.resolved',
        payload: { id, ...(automatic ? { automatic: true, text: `자동 승인: ${req.title}` } : {}) },
      });
      const remaining = store.pending(req.runId);
      change(req.runId, {
        status: remaining.length
          ? remaining[0].kind === 'approval'
            ? 'waiting_approval'
            : 'waiting_input'
          : 'running',
      });
      handler.resolve(answer);
    },
    async shutdown() {
      if (current) {
        const job = current;
        job.controller.abort();
        clearPending(job.id);
        await job.task;
      }
      await Promise.all(Object.values(adapters).map((a) => a.close()));
    },
    get activeId() {
      return current?.id;
    },
  };
}
export type Orchestrator = ReturnType<typeof createOrchestrator>;
