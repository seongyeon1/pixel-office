import {
  activityLabels,
  statusLabels,
  terminal,
  type ObservedSession,
  type ProjectSummary,
  type Provider,
  type Run,
} from '../../shared/contracts';
export interface ProjectWorker {
  id: string;
  provider: Provider;
  identity: string;
  label: string;
  caption: string;
  prompt: string;
  active: boolean;
  waiting: boolean;
  stale: boolean;
  session?: ObservedSession;
  run?: Run;
}
export interface ProjectRoom {
  root: string;
  pathLabel: string;
  workers: ProjectWorker[];
  activeCount: number;
  observedCount: number;
  waitingCount: number;
  staleCount: number;
  latestRun: Run | null;
}
export function projectRooms(
  projects: ProjectSummary[],
  sessions: ObservedSession[],
): ProjectRoom[] {
  const rooms = new Map<string, ProjectRoom>();
  const get = (root: string) => {
    let room = rooms.get(root);
    if (!room) {
      room = {
        root,
        pathLabel: root,
        workers: [],
        activeCount: 0,
        observedCount: 0,
        waitingCount: 0,
        staleCount: 0,
        latestRun: null,
      };
      rooms.set(root, room);
    }
    return room;
  };
  for (const project of projects) get(project.root).latestRun = project.latestRun;
  for (const s of sessions) {
    const room = get(s.projectPath);
    room.observedCount++;
    room.workers.push({
      id: `observed:${s.id}`,
      provider: s.provider,
      identity: s.sessionId,
      label: s.label || s.sessionId.slice(0, 8),
      prompt: s.prompt,
      caption:
        s.status === 'active'
          ? activityLabels[s.activity]
          : s.status === 'idle'
            ? '응답 완료 · 대기'
            : '상태 확인 필요',
      active: s.status === 'active',
      waiting: false,
      stale: s.status === 'stale',
      session: s,
    });
  }
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
      const provider =
        run.mode === 'collaborate'
          ? run.phase === 'review'
            ? run.implementer === 'codex'
              ? 'claude'
              : 'codex'
            : run.implementer
          : run.mode;
      const waiting = run.status === 'waiting_approval' || run.status === 'waiting_input';
      room.workers.push({
        id: `run:${run.id}`,
        identity: provider,
        provider,
        label: '앱 작업',
        prompt: run.prompt,
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
        stale: false,
        run,
      });
    }
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
