import { randomUUID } from 'node:crypto';
import {
  terminal,
  type Answer,
  type Interaction,
  type OfficeEvent,
  type Run,
} from '../../shared/contracts.js';
import { DEFAULT_RULES, type Coworker, type CoworkerDraft } from '../../shared/coworkers.js';
import type { Coworkers } from '../coworkers.js';
import type { Orchestrator } from '../orchestrator.js';
import type { Job, Store } from '../store.js';
import {
  approvalBlocks,
  buttonQuestion,
  clip,
  planBlocks,
  proposalBlocks,
  questionBlocks,
  questionKey,
  questionsOf,
  resolvedBlocks,
  statusBlocks,
} from './blocks.js';
import { slackErrorCode } from './errors.js';
import type { InboundAction, InboundMessage, SlackPort } from './port.js';

export type WakeReason =
  { kind: 'new' | 'reply'; text: string } | { kind: 'assignment_done'; assignmentId: string };
export interface Coordinator {
  wake(jobId: string, reason: WakeReason): void;
}
const OWNER_ONLY = '이 작업은 소유자만 처리할 수 있어요.';

export function createSlackGateway({
  store,
  port,
  coworkers,
  orchestrator,
  coordinator,
  ownerId,
  debounceMs = 1000,
  onError = () => {},
}: {
  store: Store;
  port: SlackPort;
  coworkers: Pick<Coworkers, 'get' | 'list' | 'forChannel' | 'save'>;
  orchestrator: Pick<Orchestrator, 'startFor' | 'followUp' | 'answer' | 'queuePosition'>;
  coordinator: Coordinator;
  ownerId: string;
  debounceMs?: number;
  // Receives only a Slack error code, never a raw error that could carry a token.
  onError?: (code: string) => void;
}) {
  // A throwing onError must not turn into an unhandled rejection.
  const fail = (e: unknown) => {
    try {
      onError(slackErrorCode(e));
    } catch {
      // ignored
    }
  };
  // Kept in memory: a restart interrupts every run, so no request outlives the process.
  const replies = new Map<string, { channel: string; ts: string; title: string }>();
  const posting = new Map<string, Promise<void>>();
  const labels = new Map<string, string>();
  const freeForm = new Map<string, string[]>();
  const notes = new Map<string, string[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const chains = new Map<string, Promise<void>>();
  const finished = new Set<string>();
  // One thing at a time per key: two replies in one thread never race to create the same job.
  const serial = (key: string, fn: () => Promise<void>) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(fn).catch(fail);
    chains.set(key, next);
    void next.finally(() => chains.get(key) === next && chains.delete(key));
    return next;
  };
  const say = (job: Job, text: string) =>
    port.post(job.channel, job.threadTs, planBlocks(text), text).catch(fail);

  const assign = async (job: Job, coworker: Coworker, text: string, after?: string) => {
    try {
      const run = after
        ? await orchestrator.followUp(after, text, { whenDone: true })
        : await orchestrator.startFor(coworker, text, { kind: 'slack', jobId: job.id });
      store.updateJob(job.id, {
        assignments: [
          ...store.getJob(job.id)!.assignments,
          { id: randomUUID(), coworkerId: coworker.id, runId: run.id, task: text },
        ],
      });
    } catch (e) {
      await say(job, `작업을 시작하지 못했어요. ${(e as Error).message}`);
    }
  };
  // A free-form question waiting on this job takes the reply as its answer.
  const answerQuestion = async (job: Job, text: string) => {
    const queue = freeForm.get(job.id) ?? [];
    while (queue.length) {
      const id = queue.shift()!;
      const req = store.getInteraction(id);
      if (!req || req.resolved) continue;
      const questions = questionsOf(req);
      const answers = questions.length
        ? Object.fromEntries(questions.map((q, i) => [questionKey(q, i), [text]]))
        : { '0': [text] };
      labels.set(id, `답변: ${clip(text, 200).text}`);
      try {
        await orchestrator.answer(id, { answers });
        return true;
      } catch {
        labels.delete(id);
      }
    }
    freeForm.delete(job.id);
    return false;
  };
  const continueJob = async (job: Job, text: string) => {
    if (await answerQuestion(job, text)) return;
    if (job.route.kind === 'coordinator') return coordinator.wake(job.id, { kind: 'reply', text });
    const { coworkerId } = job.route;
    const coworker = coworkers.get(coworkerId);
    if (!coworker) return void (await say(job, '이 스레드를 맡은 동료를 찾을 수 없어요.'));
    const last = job.assignments.filter((a) => a.coworkerId === coworkerId).at(-1);
    await assign(job, coworker, text, last?.runId);
  };
  const onMessage = (m: InboundMessage) => {
    // Bolt sends a channel mention as both `message` and `app_mention`; channel + ts is the message.
    try {
      if (!store.markSlackSeen(`${m.channel}:${m.ts}`)) return;
    } catch (e) {
      return fail(e);
    }
    if (m.user !== ownerId || m.botId || m.subtype) return;
    const threadKey = `${m.teamId}:${m.channel}:${m.threadTs ?? m.ts}`;
    return serial(threadKey, async () => {
      const text = m.text.replace(/^(\s*<@[A-Z0-9]+>)+\s*/, '').trim();
      const job = store.getJobByThread(threadKey);
      const bound = m.channelType === 'im' ? undefined : coworkers.forChannel(m.channel);
      // In a channel, a reply in a job's thread needs no mention; a new message does.
      if (job) return continueJob(job, text);
      if (m.channelType !== 'im' && !m.mentionsBot && !bound) return;
      await port.react(m.channel, m.ts, 'eyes').catch(fail);
      const created = store.createJob({
        threadKey,
        channel: m.channel,
        threadTs: m.threadTs ?? m.ts,
        route: bound ? { kind: 'coworker', coworkerId: bound.id } : { kind: 'coordinator' },
      });
      if (bound) await assign(created, bound, text);
      else coordinator.wake(created.id, { kind: 'new', text });
    });
  };

  const render = async (jobId: string) => {
    const job = store.getJob(jobId);
    if (!job) return;
    const runs = job.assignments.flatMap((a) => (a.runId && store.getRun(a.runId)) || []);
    const positions = Object.fromEntries(runs.map((r) => [r.id, orchestrator.queuePosition(r.id)]));
    const names = Object.fromEntries(coworkers.list().map((c) => [c.id, c.name]));
    const blocks = statusBlocks(job, runs, positions, notes.get(jobId), names);
    const text = '진행 상황';
    if (job.statusTs) await port.update(job.channel, job.statusTs, blocks, text);
    else
      store.updateJob(job.id, {
        statusTs: await port.post(job.channel, job.threadTs, blocks, text),
      });
  };
  // At most one status edit per job per debounce window.
  const schedule = (jobId: string) => {
    if (timers.has(jobId)) return;
    timers.set(
      jobId,
      setTimeout(() => {
        timers.delete(jobId);
        void serial(`status:${jobId}`, () => render(jobId));
      }, debounceMs),
    );
  };
  const slackJob = (runId: string) => {
    const run = store.getRun(runId);
    return run?.origin?.kind === 'slack' ? store.jobForRun(runId) : undefined;
  };
  const runUpdated = (run: Run) => {
    if (run.origin?.kind !== 'slack') return;
    const job = store.jobForRun(run.id);
    if (!job) return;
    schedule(job.id);
    const assignment = job.assignments.find((a) => a.runId === run.id);
    if (
      job.route.kind === 'coordinator' &&
      assignment &&
      terminal(run.status) &&
      !finished.has(run.id)
    ) {
      finished.add(run.id);
      coordinator.wake(job.id, { kind: 'assignment_done', assignmentId: assignment.id });
    }
  };
  const requested = (interaction: Interaction) => {
    const job = slackJob(interaction.runId);
    if (!job) return;
    const question = interaction.kind === 'question';
    if (question && !buttonQuestion(interaction))
      freeForm.set(job.id, [...(freeForm.get(job.id) ?? []), interaction.id]);
    const blocks = question ? questionBlocks(interaction) : approvalBlocks(interaction);
    const task = port
      .post(job.channel, job.threadTs, blocks, interaction.title)
      .then(
        (ts) =>
          void replies.set(interaction.id, { channel: job.channel, ts, title: interaction.title }),
      )
      .catch(fail)
      .finally(() => posting.delete(interaction.id));
    posting.set(interaction.id, task);
  };
  const resolved = async (event: OfficeEvent) => {
    const id = String(event.payload.id);
    const automatic = event.payload.automatic === true;
    await posting.get(id);
    for (const [jobId, queue] of freeForm)
      if (queue.includes(id))
        freeForm.set(
          jobId,
          queue.filter((q) => q !== id),
        );
    const reply = replies.get(id);
    if (reply) {
      replies.delete(id);
      const label =
        labels.get(id) ??
        (automatic
          ? '자동 승인됨'
          : event.payload.closed === true
            ? '작업이 끝나 닫혔어요'
            : '오피스에서 처리됨');
      labels.delete(id);
      await port.update(reply.channel, reply.ts, resolvedBlocks(label, reply.title), label);
      return;
    }
    const job = automatic && typeof event.payload.text === 'string' && slackJob(event.runId);
    if (!job) return;
    notes.set(job.id, [...(notes.get(job.id) ?? []), String(event.payload.text)].slice(-5));
    schedule(job.id);
  };
  // Runs inside the orchestrator's emit: nothing here may throw back into it.
  const onEvent = (event: OfficeEvent) => {
    try {
      if (event.type === 'run.updated') runUpdated(event.payload.run as Run);
      else if (event.type === 'interaction.requested')
        requested(event.payload.interaction as Interaction);
      else if (event.type === 'interaction.resolved') void resolved(event).catch(fail);
    } catch (e) {
      fail(e);
    }
  };

  const decideProposal = async (a: InboundAction, jobId: string, proposalId: string) => {
    const job = store.getJob(jobId);
    const draft = job?.proposals?.[proposalId];
    if (!job || !draft) return a.respond(resolvedBlocks('이미 처리됨'), '이미 처리됨');
    const drop = () => {
      const { [proposalId]: _, ...rest } = store.getJob(jobId)!.proposals ?? {};
      store.updateJob(jobId, { proposals: rest });
    };
    if (a.actionId === 'pixel:propose-cancel') {
      drop();
      return a.respond(resolvedBlocks('제안을 취소했어요.', draft.name), '제안을 취소했어요.');
    }
    try {
      coworkers.save({
        ...draft,
        createdBy: 'coordinator',
        mode: 'solo',
        bindings: [],
        rules: DEFAULT_RULES,
      });
    } catch (e) {
      const text = `동료를 만들지 못했어요. ${(e as Error).message}`;
      return a.respond([], text, false);
    }
    drop();
    const text = `새 동료를 만들었어요: ${draft.name}`;
    await a.respond(resolvedBlocks(text), text);
    coordinator.wake(jobId, { kind: 'reply', text });
  };

  const onAction = async (a: InboundAction) => {
    if (!a.actionId.startsWith('pixel:')) return;
    try {
      if (a.userId !== ownerId) return await a.respond([], OWNER_ONLY, false);
      let value: {
        interactionId?: unknown;
        option?: unknown;
        jobId?: unknown;
        proposalId?: unknown;
      };
      try {
        value = JSON.parse(a.value);
      } catch {
        return;
      }
      if (a.actionId === 'pixel:propose-create' || a.actionId === 'pixel:propose-cancel')
        return await decideProposal(a, String(value.jobId ?? ''), String(value.proposalId ?? ''));
      const id = String(value.interactionId ?? '');
      const option = typeof value.option === 'string' ? value.option : '';
      let answer: Answer;
      let label: string;
      if (a.actionId === 'pixel:approve' || a.actionId === 'pixel:deny') {
        const approve = a.actionId === 'pixel:approve';
        answer = { decision: approve ? 'approve' : 'deny' };
        label = approve ? '승인됨' : '거절됨';
      } else if (a.actionId === 'pixel:answer') {
        const req = store.getInteraction(id);
        const questions = req ? questionsOf(req) : [];
        const index = questions.findIndex((q) => q.options?.some((o) => o.label === option));
        answer = { answers: index < 0 ? {} : { [questionKey(questions[index], index)]: [option] } };
        label = `답변: ${option}`;
      } else return;
      labels.set(id, label);
      try {
        await orchestrator.answer(id, answer);
      } catch (e) {
        labels.delete(id);
        if (!store.getInteraction(id)?.resolved) return fail(e);
        await a.respond(resolvedBlocks('이미 처리됨'), '이미 처리됨');
      }
    } catch (e) {
      fail(e);
    }
  };

  return {
    async start() {
      await port.start(onMessage, onAction);
      // Only after a successful start, and never twice, so a retried start keeps one listener.
      store.bus.off('event', onEvent);
      store.bus.on('event', onEvent);
    },
    // The coordinator's voice in the job thread. Throws only a Slack error code.
    async reply(jobId: string, text: string) {
      const job = store.getJob(jobId);
      if (!job) throw new Error('일을 찾을 수 없어요.');
      await port.post(job.channel, job.threadTs, planBlocks(text), text).catch((e) => {
        throw new Error(slackErrorCode(e));
      });
    },
    // A coworker the coordinator suggests; it is created only when the owner presses [만들기].
    async propose(jobId: string, draft: CoworkerDraft) {
      const job = store.getJob(jobId);
      if (!job) throw new Error('일을 찾을 수 없어요.');
      const proposalId = randomUUID();
      store.updateJob(jobId, { proposals: { ...job.proposals, [proposalId]: draft } });
      const text = `새 동료 제안: ${draft.name}`;
      await port
        .post(job.channel, job.threadTs, proposalBlocks(jobId, proposalId, draft), text)
        .catch((e) => {
          throw new Error(slackErrorCode(e));
        });
    },
    async stop() {
      store.bus.off('event', onEvent);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await port.stop();
    },
  };
}
export type SlackGateway = ReturnType<typeof createSlackGateway>;
