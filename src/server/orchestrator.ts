import { randomUUID } from 'node:crypto';
import {
  startSchema,
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
} from '../shared/contracts.js';
import type { Store } from './store.js';
import { inspectProject, createWorkspace, collectChanges } from './projects.js';
import { phasePrompt } from './prompts.js';
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
}: {
  store: Store;
  adapters: Record<Provider, Adapter>;
  dataDir: string;
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
    let previous = '';
    let review: Review | undefined;
    const interact = (req: Omit<Interaction, 'id' | 'resolved'>): Promise<Answer> => {
      if (controller.signal.aborted) return Promise.reject(new Error('작업 중단'));
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
        const provider =
          run.mode === 'collaborate' ? (isReview ? reviewer : run.implementer) : run.mode;
        const changes = await collectChanges(run.worktreePath, run.baseCommit);
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
        const result = await adapters[provider].execute(
          {
            runId: run.id,
            cwd: run.worktreePath,
            prompt: phasePrompt(
              run,
              provider,
              isReview ? 'reviewer' : 'implementer',
              previous,
              changes,
              review,
            ),
            role: isReview ? 'reviewer' : 'implementer',
            profile: run.team[provider],
            signal: controller.signal,
          },
          emit,
          interact,
        );
        clearPending(run.id);
        if (controller.signal.aborted || result.outcome === 'cancelled') break;
        emit({
          runId: run.id,
          agentId: provider,
          type: 'phase.completed',
          payload: { text: result.text, outcome: result.outcome, review: result.review },
        });
        if (result.outcome === 'failed') {
          change(run.id, {
            status: 'failed',
            error: result.error || '에이전트 실행 실패',
            summary: result.text,
          });
          return;
        }
        previous = result.text;
        if (run.mode !== 'collaborate') {
          change(run.id, { status: 'completed', phase: 'done', summary: previous });
          return;
        }
        if (!isReview) {
          change(run.id, { phase: 'review' });
          emit({
            runId: run.id,
            agentId: provider,
            type: 'handoff',
            payload: { to: reviewer, text: '구현 결과를 검토자에게 전달했습니다.' },
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
        if (next !== 'revise') {
          change(run.id, {
            status: next,
            phase: next === 'completed' ? 'done' : 'review',
            summary: review.summary,
          });
          return;
        }
        change(run.id, { phase: 'revise', revision: run.revision + 1 });
        emit({
          runId: run.id,
          agentId: provider,
          type: 'handoff',
          payload: { to: run.implementer, text: '검토 의견을 구현자에게 전달했습니다.' },
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
        const workspace = await createWorkspace(project.root, id, dataDir);
        const run: Run = {
          ...input,
          team: structuredClone(input.team),
          id,
          projectPath: project.root,
          worktreePath: workspace.path,
          branch: workspace.branch,
          baseCommit: workspace.baseCommit,
          status: 'queued',
          phase: 'implement',
          revision: 0,
          createdAt: new Date().toISOString(),
        };
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
    async answer(id: string, answer: Answer) {
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
        payload: { id },
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
