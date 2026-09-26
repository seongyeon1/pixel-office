import {
  activityLabels,
  statusLabels,
  terminal,
  type ObservedSession,
  type ProjectSummary,
  type Provider,
  type Run,
} from '../../shared/contracts';
import { hasReport, isAway, onDuty, type Seen } from '../floor/roster';
import { modelFamily, type ModelFamily } from '../models/family';
export type WorkerMark = 'question' | 'approval' | 'report' | null;
export interface ProjectWorker {
  id: string;
  provider: Provider;
  identity: string;
  label: string;
  caption: string;
  prompt: string;
  active: boolean;
  // Terminal still open but quiet for a while: stays at the desk, dimmed.
  away?: boolean;
  waiting: boolean;
  stale: boolean;
  root: string;
  lane: string;
  mark: WorkerMark;
  // false when the mark is inferred, e.g. a tool silent long enough to be a permission prompt.
  certain: boolean;
  parentId?: string;
  // Standing beside another worker, e.g. an implementer waiting on a review.
  visiting?: string;
  updatedAt: string;
  family: ModelFamily;
  session?: ObservedSession;
  run?: Run;
}
export interface ProjectLane {
  key: string;
  branch: string;
  main: boolean;
  workers: ProjectWorker[];
}
export interface ProjectRoom {
  root: string;
  // Connected on purpose or used for app runs; such rooms stay on the floor even when empty.
  connected: boolean;
  pathLabel: string;
  // Repository name behind origin when it differs from the folder name.
  repoName: string;
  workers: ProjectWorker[];
  lanes: ProjectLane[];
  offDuty: ProjectWorker[];
  // Script- or hook-started sessions (work logs, summaries) that are running right now.
  automations: ProjectWorker[];
  activeCount: number;
  observedCount: number;
  waitingCount: number;
  reportCount: number;
  staleCount: number;
  latestRun: Run | null;
}
const markCaption: Record<Exclude<WorkerMark, null>, string> = {
  question: '질문 있어요',
  approval: '승인 기다려요',
  report: '보고할 게 있어요',
};
// When an away coworker was last active: today's time, 어제, or the date.
function lastSeen(iso: string, now: number) {
  const at = new Date(iso);
  const day = (d: Date) => d.toDateString();
  const time = at.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (day(at) === day(new Date(now))) return time;
  if (day(at) === day(new Date(now - 86400000))) return `어제 ${time}`;
  return `${at.getMonth() + 1}/${at.getDate()}`;
}
function observedWorker(s: ObservedSession, seen: Seen, now: number): ProjectWorker {
  const away = isAway(s, now);
  // An old unread turn on an idle open terminal is not news; the dimmed desk says enough.
  const mark: WorkerMark = s.attention?.kind ?? (!away && hasReport(s, seen) ? 'report' : null);
  return {
    id: `observed:${s.id}`,
    provider: s.provider,
    identity: s.sessionId,
    label: s.label || s.sessionId.slice(0, 8),
    prompt: s.prompt,
    caption: mark
      ? s.attention && !s.attention.certain
        ? '승인 대기 중일 수 있어요'
        : markCaption[mark]
      : away
        ? `자리 비움 · ${lastSeen(s.updatedAt, now)}`
        : s.status === 'active'
          ? activityLabels[s.activity]
          : s.status === 'idle'
            ? '응답 완료 · 대기'
            : '상태 확인 필요',
    active: s.status === 'active',
    away,
    waiting: mark === 'question' || mark === 'approval',
    stale: s.status === 'stale',
    root: s.projectPath,
    lane: s.worktree?.path ?? s.projectPath,
    mark,
    certain: s.attention?.certain ?? true,
    parentId: s.parentId && `observed:${s.parentId}`,
    updatedAt: s.updatedAt,
    family: modelFamily(s.provider, s.model),
    session: s,
  };
}
export function projectRooms(
  projects: ProjectSummary[],
  sessions: ObservedSession[],
  { now = Date.now(), seen = {} }: { now?: number; seen?: Seen } = {},
): ProjectRoom[] {
  const rooms = new Map<string, ProjectRoom>();
  const get = (root: string) => {
    let room = rooms.get(root);
    if (!room) {
      room = {
        root,
        pathLabel: root,
        repoName: '',
        connected: false,
        workers: [],
        lanes: [],
        offDuty: [],
        automations: [],
        activeCount: 0,
        observedCount: 0,
        waitingCount: 0,
        reportCount: 0,
        staleCount: 0,
        latestRun: null,
      };
      rooms.set(root, room);
    }
    return room;
  };
  for (const project of projects) {
    const room = get(project.root);
    room.latestRun = project.latestRun;
    room.connected = !!project.connected || project.runCount > 0;
  }
  for (const s of sessions) {
    if (s.automated) continue;
    const room = get(s.projectPath);
    if (onDuty(s, now)) room.workers.push(observedWorker(s, seen, now));
    else room.offDuty.push(observedWorker(s, seen, now));
  }
  // Automated sessions never take a desk or open a room of their own (e.g. smoke-test repos);
  // running ones are listed with a room that people or a connection already opened.
  for (const s of sessions)
    if (s.automated && s.status === 'active' && s.processAlive !== false)
      rooms.get(s.projectPath)?.automations.push(observedWorker(s, seen, now));
  for (const room of rooms.values()) {
    const parts = room.root.split(/[\\/]/).filter(Boolean);
    let length = Math.min(3, parts.length);
    while (
      length < parts.length &&
      [...rooms.keys()].some(
        (root) =>
          root !== room.root &&
          root.split(/[\\/]/).filter(Boolean).slice(-length).join('/') ===
            parts.slice(-length).join('/'),
      )
    )
      length++;
    room.pathLabel = length < parts.length ? '…/' + parts.slice(-length).join('/') : room.root;
    const run = room.latestRun;
    if (run && !terminal(run.status)) {
      const reviewing = run.mode === 'collaborate' && run.phase === 'review';
      const provider = reviewing
        ? run.implementer === 'codex'
          ? 'claude'
          : 'codex'
        : run.mode === 'collaborate'
          ? run.implementer
          : run.mode;
      const waiting = run.status === 'waiting_approval' || run.status === 'waiting_input';
      const base = {
        label: '앱 작업',
        prompt: run.prompt,
        stale: false,
        root: room.root,
        lane: run.worktreePath,
        certain: true,
        updatedAt: run.createdAt,
        run,
      };
      room.workers.push({
        ...base,
        id: `run:${run.id}`,
        identity: provider,
        provider,
        family: modelFamily(provider, run.team[provider].model || 'default'),
        caption:
          waiting || run.status === 'queued'
            ? statusLabels[run.status]
            : run.phase === 'review'
              ? '코드 검토'
              : run.phase === 'revise'
                ? '수정 작업'
                : '구현 작업',
        active: true,
        waiting,
        mark: run.status === 'waiting_input' ? 'question' : waiting ? 'approval' : null,
      });
      // The implementer brings the work over and stands by while it is reviewed.
      if (reviewing)
        room.workers.push({
          ...base,
          id: `run:${run.id}:implementer`,
          identity: run.implementer,
          provider: run.implementer,
          family: modelFamily(run.implementer, run.team[run.implementer].model || 'default'),
          caption: '리뷰 받는 중',
          active: true,
          waiting: false,
          mark: null,
          visiting: `run:${run.id}`,
        });
    }
    room.lanes = lanes(room);
    const named = room.workers.find((w) => w.session?.repoName)?.session?.repoName ?? '';
    room.repoName = named && named !== parts.at(-1) ? named : '';
    room.observedCount = room.workers.filter((w) => w.session).length;
    room.reportCount = room.workers.filter((w) => w.mark === 'report').length;
    room.offDuty.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    room.workers.sort(
      (a, b) =>
        Number(b.waiting) - Number(a.waiting) ||
        Number(b.active) - Number(a.active) ||
        a.id.localeCompare(b.id),
    );
    room.activeCount = room.workers.filter((w) => w.active).length;
    room.waitingCount = room.workers.filter((w) => w.waiting).length;
    room.staleCount = room.workers.filter((w) => w.stale).length;
  }
  // Stable rooms: polling must not reshuffle the map while someone is clicking.
  return [...rooms.values()].sort((a, b) => a.root.localeCompare(b.root));
}

// Desks are grouped by worktree; subagents sit right after the coworker who spawned them.
function lanes(room: ProjectRoom): ProjectLane[] {
  const byKey = new Map<string, ProjectLane>();
  const present = new Set(room.workers.map((w) => w.id));
  for (const w of room.workers) {
    let lane = byKey.get(w.lane);
    if (!lane) {
      const tree = w.session?.worktree;
      lane = {
        key: w.lane,
        branch: w.run ? w.run.branch : (tree?.branch ?? ''),
        main: w.run ? false : (tree?.main ?? w.lane === room.root),
        workers: [],
      };
      byKey.set(w.lane, lane);
    }
    lane.workers.push(w);
  }
  for (const lane of byKey.values()) {
    const leads = lane.workers
      .filter((w) => !(w.parentId && present.has(w.parentId)) && !w.visiting)
      .sort((a, b) => a.id.localeCompare(b.id));
    const follows = (lead: ProjectWorker) =>
      lane.workers
        .filter((w) => w.parentId === lead.id || w.visiting === lead.id)
        .sort((a, b) => a.id.localeCompare(b.id));
    const ordered = leads.flatMap((lead) => [lead, ...follows(lead)]);
    // Followers whose lead sits in another lane still get a desk here.
    lane.workers = [...ordered, ...lane.workers.filter((w) => !ordered.includes(w))];
  }
  return [...byKey.values()].sort(
    (a, b) =>
      Number(b.main) - Number(a.main) ||
      a.branch.localeCompare(b.branch) ||
      a.key.localeCompare(b.key),
  );
}

// Keeps only one model family on the floor; rooms without such a coworker disappear.
export function withFamily(rooms: ProjectRoom[], family: string): ProjectRoom[] {
  if (!family) return rooms;
  const keep = (w: ProjectWorker) => w.family.key === family;
  return rooms
    .map((room) => {
      const workers = room.workers.filter(keep);
      const lanes = room.lanes
        .map((lane) => ({ ...lane, workers: lane.workers.filter(keep) }))
        .filter((lane) => lane.workers.length);
      return {
        ...room,
        workers,
        lanes,
        activeCount: workers.filter((w) => w.active).length,
        waitingCount: workers.filter((w) => w.waiting).length,
        reportCount: workers.filter((w) => w.mark === 'report').length,
        staleCount: workers.filter((w) => w.stale).length,
      };
    })
    .filter((room) => room.workers.length);
}

// A folder only seen in session logs leaves the floor once nobody is at work there; connected
// projects stay even when empty.
export const shownOnFloor = (room: ProjectRoom) => room.connected || room.workers.length > 0;
