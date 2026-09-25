import { z } from 'zod';
export type Provider = 'codex' | 'claude';
export type Seniority = 'senior' | 'junior' | 'intern';
export type Activity = 'idle' | 'responding' | 'reading' | 'editing' | 'executing' | 'reviewing';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'needs_attention';
export type Mode = 'collaborate' | Provider;
export interface AgentProfile {
  seniority: Seniority;
  model?: string;
  personaVersion: '1';
}
export type TeamConfig = Record<Provider, AgentProfile>;
export const defaultTeam = (): TeamConfig => ({
  codex: { seniority: 'junior', personaVersion: '1' },
  claude: { seniority: 'senior', personaVersion: '1' },
});
export interface Run {
  id: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  prompt: string;
  mode: Mode;
  implementer: Provider;
  status: RunStatus;
  phase: 'implement' | 'review' | 'revise' | 'done';
  revision: number;
  createdAt: string;
  team: TeamConfig;
  summary?: string;
  error?: string;
}
export interface OfficeEvent {
  eventId: string;
  sequence: number;
  runId: string;
  agentId: Provider | null;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}
export type EventInput = Omit<OfficeEvent, 'eventId' | 'sequence' | 'timestamp'>;
export interface Interaction {
  id: string;
  runId: string;
  agentId: Provider;
  kind: 'approval' | 'question';
  title: string;
  details: Record<string, unknown>;
  resolved: boolean;
}
export type Answer = { decision: 'approve' | 'deny' } | { answers: Record<string, string[]> };
export const reviewSchema = z.object({
  verdict: z.enum(['pass', 'changes_requested', 'inconclusive']),
  summary: z.string(),
  findings: z.array(
    z.object({ path: z.string(), message: z.string(), severity: z.enum(['error', 'warning']) }),
  ),
});
export type Review = z.infer<typeof reviewSchema>;
export const reviewJsonSchema = () => z.toJSONSchema(reviewSchema, { target: 'draft-7' });
export interface PhaseInput {
  runId: string;
  cwd: string;
  prompt: string;
  role: 'implementer' | 'reviewer';
  profile: AgentProfile;
  signal: AbortSignal;
}
export interface PhaseResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  text: string;
  review?: Review;
  error?: string;
}
export interface Connection {
  installed: boolean;
  authenticated: boolean | null;
  detail: string;
}
export interface Adapter {
  probe(): Promise<Connection>;
  execute(
    input: PhaseInput,
    emit: (event: EventInput) => void,
    interact: (request: Omit<Interaction, 'id' | 'resolved'>) => Promise<Answer>,
  ): Promise<PhaseResult>;
  close(): Promise<void>;
}
export interface Change {
  path: string;
  status: string;
  diff: string;
  truncated: boolean;
}
const profileSchema = z.object({
  seniority: z.enum(['senior', 'junior', 'intern']),
  model: z.string().trim().max(150).optional(),
  personaVersion: z.literal('1'),
});
export const startSchema = z.object({
  projectPath: z.string().min(1),
  prompt: z.string().trim().min(1).max(20000),
  mode: z.enum(['collaborate', 'codex', 'claude']),
  implementer: z.enum(['codex', 'claude']),
  team: z.object({ codex: profileSchema, claude: profileSchema }),
});
export type StartInput = z.infer<typeof startSchema>;
export const answerSchema = z.union([
  z.object({ decision: z.enum(['approve', 'deny']) }),
  z.object({ answers: z.record(z.string(), z.array(z.string().max(10000))) }),
]);
export const terminal = (status: RunStatus) =>
  ['completed', 'failed', 'cancelled', 'interrupted', 'needs_attention'].includes(status);
export const statusLabels: Record<RunStatus, string> = {
  queued: '준비 중',
  running: '작업 중',
  waiting_approval: '승인 필요',
  waiting_input: '답변 필요',
  completed: '완료',
  failed: '실패',
  cancelled: '중단됨',
  interrupted: '연결 종료',
  needs_attention: '확인 필요',
};
export const seniorityLabels: Record<Seniority, string> = {
  senior: '시니어',
  junior: '주니어',
  intern: '신입',
};
export const activityLabels: Record<Activity, string> = {
  idle: '대기 중',
  responding: '응답 중',
  reading: '자료 확인',
  editing: '코드 작성',
  executing: '명령 실행',
  reviewing: '코드 검토',
};
