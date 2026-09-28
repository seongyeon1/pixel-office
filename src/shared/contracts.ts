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
export type ExecutionMode = 'personal' | 'isolated';
export type RunSessions = Partial<
  Record<Provider, Partial<Record<'implementer' | 'reviewer', string>>>
>;
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
// One repository found inside a folder: what the bundle picker lists.
export interface RepositoryEntry {
  path: string;
  // Folder path relative to the chosen folder, e.g. "c-agent/c-agent".
  name: string;
  // Repository name from the origin URL, when there is one.
  remote: string | null;
  branch: string;
  kind: 'clone' | 'worktree';
  head: string;
}
// One repository's worktree inside a bundle run's workspace.
export interface RunRepo {
  root: string;
  // Folder name inside the workspace; change paths are prefixed with it.
  name: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}
export interface Run {
  id: string;
  // A follow-up is a separate history entry using the same preserved workspace.
  parentRunId?: string;
  removedWorktrees?: string[];
  executionMode?: ExecutionMode;
  sessions?: RunSessions;
  pullRequests?: string[];
  pullRequestRequested?: boolean;
  initialChanges?: Record<string, string>;
  projectPath: string;
  // The folder the coworkers work in: one repository's worktree, or, for a bundle run, the
  // folder holding one worktree per repository (then `repos` lists them and baseCommit is '').
  worktreePath: string;
  branch: string;
  baseCommit: string;
  repos?: RunRepo[];
  prompt: string;
  mode: Mode;
  implementer: Provider;
  status: RunStatus;
  phase: 'implement' | 'review' | 'revise' | 'done';
  revision: number;
  createdAt: string;
  team: TeamConfig;
  // The repository's harness when the run was created; later edits do not affect it.
  harness?: RepoHarness;
  summary?: string;
  error?: string;
}
// A department groups the rooms under one folder, e.g. every repository inside project/skt.
export interface Department {
  id: string;
  name: string;
  root: string;
}
export interface ProjectSummary {
  // Connected on purpose (or used for app runs), as opposed to only seen in session logs.
  connected?: boolean;
  // Why the app cannot start a run here (a folder that is not a Git repository, e.g. the parent
  // folder of several clones seen in session logs); absent when runs can start.
  unavailable?: string;
  // How many repositories a folder holds, when it is a bundle folder rather than a repository.
  repositoryCount?: number;
  observedCount?: number;
  observedActive?: number;
  root: string;
  runCount: number;
  latestRun: Run | null;
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
export const approvalSettingsSchema = z.object({ mode: z.enum(['manual', 'auto']) }).strict();
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;
export const reviewSchema = z.object({
  verdict: z.enum(['pass', 'changes_requested', 'inconclusive']),
  summary: z.string(),
  findings: z.array(
    z.object({ path: z.string(), message: z.string(), severity: z.enum(['error', 'warning']) }),
  ),
});
export type Review = z.infer<typeof reviewSchema>;
export const reviewJsonSchema = () => z.toJSONSchema(reviewSchema, { target: 'draft-7' });
// Plugins and skills an app run may use in one repository, per provider. Empty means isolated.
export interface HarnessChoice {
  plugins: string[];
  skills: string[];
  // CLAUDE.md for Claude, AGENTS.md for Codex.
  projectDoc: boolean;
}
export type RepoHarness = Record<Provider, HarnessChoice>;
export const emptyHarness = (): RepoHarness => ({
  claude: { plugins: [], skills: [], projectDoc: false },
  codex: { plugins: [], skills: [], projectDoc: false },
});
export interface HarnessItem {
  id: string;
  name: string;
  description: string;
}
export type HarnessCatalog = Record<
  Provider,
  { plugins: HarnessItem[]; skills: HarnessItem[]; error?: string }
>;
export interface PhaseInput {
  executionMode?: ExecutionMode;
  resumeSessionId?: string;
  forkSession?: boolean;
  approvalMode?: 'manual' | 'auto';
  runId: string;
  cwd: string;
  prompt: string;
  role: 'implementer' | 'reviewer';
  profile: AgentProfile;
  signal: AbortSignal;
  harness?: HarnessChoice;
  // Per-repository folder for files the adapter generates from the harness.
  harnessDir?: string;
}
export interface PhaseResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  text: string;
  review?: Review;
  error?: string;
  failureKind?: 'usage_limit';
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
  executionMode: z.enum(['personal', 'isolated']).optional(),
  projectPath: z.string().min(1),
  // For a folder of repositories: the repositories (absolute paths inside it) to bundle.
  repositories: z.array(z.string().min(1)).max(50).optional(),
  prompt: z.string().trim().min(1).max(20000),
  mode: z.enum(['collaborate', 'codex', 'claude']),
  implementer: z.enum(['codex', 'claude']),
  team: z.object({ codex: profileSchema, claude: profileSchema }),
});
export type StartInput = z.infer<typeof startSchema>;
export const followUpSchema = z.object({ prompt: z.string().trim().min(1).max(20000) }).strict();
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

export type ObservedStatus = 'active' | 'idle' | 'stale';
export interface ObservedWorktree {
  path: string;
  branch: string;
  main: boolean;
}
export interface ObservedAttention {
  kind: 'question' | 'approval';
  // false: inferred from a tool that has waited too long, e.g. an unlogged permission prompt.
  certain: boolean;
  since: string;
}
export interface ObservedEvent {
  id: string;
  timestamp: string;
  kind: 'request' | 'message' | 'tool' | 'result' | 'complete';
  activity: Activity;
  title: string;
  detail: string;
}
export interface ObservedSession {
  launched?: { launchId: string; terminalId: string; resumable: boolean };
  managed?: {
    runId: string;
    role: 'implementer' | 'reviewer';
    executionMode: ExecutionMode;
    resumable: boolean;
    workspaceRemoved?: boolean;
    busy: boolean;
  };
  id: string;
  sessionId: string;
  provider: Provider;
  projectPath: string;
  cwd: string;
  label: string;
  prompt: string;
  model: string;
  status: ObservedStatus;
  activity: Activity;
  updatedAt: string;
  processAlive: boolean | null;
  truncated: boolean;
  worktree?: ObservedWorktree;
  parentId?: string;
  attention?: ObservedAttention | null;
  // Started by a script or hook (e.g. a work-log summary), not by a person.
  automated?: boolean;
  // Name of the repository behind origin, e.g. langconnect-enterprise.
  repoName?: string;
}
export interface ObservationSnapshot {
  sessions: ObservedSession[];
  retired?: RetiredSession[];
  scannedAt: string | null;
  scanning: boolean;
  warnings: string[];
}
export interface RetiredSession extends ObservedSession {
  retiredAt: string;
  available?: boolean;
}
export interface ObservedDetail extends ObservedSession {
  events: ObservedEvent[];
}

// records: a separate answer read from the logs. terminal: typed into the app's resume PTY.
// direct: a turn the app runs on the session itself through the SDK or app server.
export type ChatChannel = 'records' | 'terminal' | 'direct';
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  error?: string;
  contextAt?: string;
  model?: string;
  // Missing on messages written before channels existed, which were all record answers.
  channel?: ChatChannel;
  // Provider session id the instruction actually reached when the original was forked.
  viaSessionId?: string;
}
// How the app reaches a coworker: the CLI (or wrapper script) that resume terminals run.
// Direct turns use the app's approval settings, like app runs do.
export interface DirectSettings {
  commands: Record<Provider, string>;
}
export const defaultDirectSettings = (): DirectSettings => ({
  commands: { claude: 'claude', codex: 'codex' },
});
// An executable name only: it is interpolated into a shell command.
const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.\/-]+$/, '명령은 공백 없는 실행 파일 이름만 쓸 수 있어요.');
export const directSettingsSchema = z.object({
  commands: z.object({ claude: commandSchema, codex: commandSchema }),
});
export interface ConversationChannels {
  // An app-owned resume terminal is open for this session.
  terminal: boolean;
  // The original process may still be running elsewhere, so an instruction forks the session.
  running: boolean;
  // A forked session already carries earlier instructions; later ones continue there.
  viaSessionId?: string;
  // The channel an instruction would use right now.
  next: 'terminal' | 'direct';
  // A message of some channel is in progress.
  busy?: ChatChannel;
  blockedReason?: string;
  fresh?: boolean;
}
export interface SessionConversation {
  mode: 'records';
  // Instructions reach the coworker (terminal or direct channel), not only record answers.
  directAvailable: boolean;
  messages: ChatMessage[];
  channels?: ConversationChannels;
  // Approvals and questions a direct turn is waiting on.
  interactions?: Interaction[];
}
