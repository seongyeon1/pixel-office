import { statusLabels, type Interaction, type Run } from '../../shared/contracts.js';
import type { CoworkerDraft } from '../../shared/coworkers.js';
import type { Job } from '../store.js';
import type { Block } from './port.js';

// Slack caps a section at 3000 characters and a button label at 75.
const SECTION = 3000;
const LABEL = 75;

// Cuts by code point so an emoji is never split; `clipped` tells the caller to attach the full text.
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return { text: `${out}…`, clipped: true };
}
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const section = (text: string): Block => ({
  type: 'section',
  text: { type: 'mrkdwn', text: clip(text, SECTION).text },
});
const context = (text: string): Block => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: clip(text, SECTION).text }],
});
const button = (text: string, actionId: string, value: object, style?: 'primary' | 'danger') => ({
  type: 'button',
  text: { type: 'plain_text', text: clip(text, LABEL).text },
  action_id: actionId,
  value: JSON.stringify(value),
  ...(style ? { style } : {}),
});

export type Question = {
  id?: string;
  question?: string;
  header?: string;
  options?: { label: string }[];
};
export const questionsOf = (interaction: Interaction): Question[] =>
  Array.isArray(interaction.details.questions) ? (interaction.details.questions as Question[]) : [];
// Same key the office's answer form uses, so both reach the agent the same way.
export const questionKey = (q: Question, i: number) => q.id ?? q.question ?? String(i);
// Buttons only fit a single question with choices; anything else is answered by a thread reply.
export const buttonQuestion = (interaction: Interaction) => {
  const questions = questionsOf(interaction);
  return questions.length === 1 && questions[0].options?.length ? questions[0] : undefined;
};

export const planBlocks = (text: string): Block[] => [section(esc(text))];

export function statusBlocks(
  job: Job,
  runs: Run[],
  positions: Record<string, number>,
  notes: string[] = [],
  names: Record<string, string> = {},
): Block[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const lines = job.assignments.map((a) => {
    const run = a.runId ? byId.get(a.runId) : undefined;
    const position = (a.runId && positions[a.runId]) || 0;
    const state = !run
      ? '대기 중'
      : run.status === 'queued' && position > 0
        ? position > 1
          ? `대기 중 · 앞에 ${position - 1}개`
          : '대기 중 · 곧 시작'
        : statusLabels[run.status];
    return `• *${esc(names[a.coworkerId] ?? a.coworkerId)}* — ${state}\n   ${esc(clip(a.task, 150).text)}`;
  });
  return [
    section(lines.length ? lines.join('\n') : '배정을 준비하고 있어요.'),
    ...(notes.length ? [context(notes.slice(-5).map(esc).join('\n'))] : []),
  ];
}

const detailsOf = (interaction: Interaction) => {
  const { tool, command, ...rest } = interaction.details as Record<string, unknown>;
  const body = typeof command === 'string' ? command : JSON.stringify(rest, null, 2);
  return `${tool ? `${esc(String(tool))}\n` : ''}\`\`\`${esc(clip(body, 1500).text)}\`\`\``;
};

export const approvalBlocks = (interaction: Interaction): Block[] => [
  section(`*승인 필요* · ${esc(interaction.title)}`),
  section(detailsOf(interaction)),
  {
    type: 'actions',
    elements: [
      button('승인', 'pixel:approve', { interactionId: interaction.id }, 'primary'),
      button('거절', 'pixel:deny', { interactionId: interaction.id }, 'danger'),
    ],
  },
];

export function questionBlocks(interaction: Interaction): Block[] {
  const questions = questionsOf(interaction);
  const text = questions.map((q) => `• ${esc(q.question ?? q.header ?? '')}`).join('\n');
  const single = buttonQuestion(interaction);
  return [
    section(`*질문* · ${esc(interaction.title)}${text ? `\n${text}` : ''}`),
    single
      ? {
          type: 'actions',
          elements: single
            .options!.slice(0, 25)
            .map((o) =>
              button(o.label, 'pixel:answer', { interactionId: interaction.id, option: o.label }),
            ),
        }
      : context('이 스레드에 답글로 답해 주세요.'),
  ];
}

export const proposalBlocks = (
  jobId: string,
  proposalId: string,
  draft: CoworkerDraft,
): Block[] => [
  section(
    `*새 동료 제안* · ${esc(draft.name)}\n폴더: \`${esc(draft.folder)}\` · ${draft.engine === 'codex' ? 'Codex' : 'Claude'}${draft.role ? `\n${esc(clip(draft.role, 1000).text)}` : ''}`,
  ),
  {
    type: 'actions',
    elements: [
      button('만들기', 'pixel:propose-create', { jobId, proposalId }, 'primary'),
      button('취소', 'pixel:propose-cancel', { jobId, proposalId }),
    ],
  },
];

export const resolvedBlocks = (text: string, title?: string): Block[] => [
  section(title ? `${esc(title)}\n_${esc(text)}_` : `_${esc(text)}_`),
];

export const reportBlocks = (summary: string, links: string[]): Block[] => [
  section(esc(summary)),
  ...(links.length ? [section(links.map((l) => `<${l}>`).join('\n'))] : []),
];
