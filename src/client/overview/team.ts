import {
  terminal,
  type Interaction,
  type ObservedSession,
  type ProjectSummary,
  type Run,
} from '../../shared/contracts';
import { COORDINATOR_ID, coworkerForPath, type Coworker } from '../../shared/coworkers';
import type { Seen } from '../floor/roster';
import {
  emptyRoom,
  laneOrder,
  projectRooms,
  runWorkers,
  tally,
  type ProjectLane,
  type ProjectRoom,
  type ProjectWorker,
} from './projects';

// One piece of work on the "지금 진행 중" board: an app run with its sessions, or a terminal session.
export interface BoardRow {
  id: string;
  workerId: string;
  // The room the work sits in on the map.
  root: string;
  task: string;
  source: 'slack' | 'office' | 'terminal';
  owner: string;
  action: string;
  waiting: boolean;
  interaction?: Interaction;
}

const firstLine = (text: string) => text.trim().split('\n')[0].trim();
// A run owns the title and the source; its session, when there is one, says what is happening now.
function describe(w: ProjectWorker) {
  w.task = firstLine(w.run ? w.run.prompt : w.session?.prompt || w.label) || '(제목 없음)';
  w.source = w.run ? (w.run.origin?.kind === 'slack' ? 'slack' : 'office') : 'terminal';
  w.action = w.waiting ? w.caption : (w.session?.action ?? w.caption);
}

// Repository rooms regrouped by coworker: each registered coworker gets a room (in roster order),
// every repository nobody owns stays as a temporary room of its own.
export function teamRooms({
  projects,
  sessions,
  runs,
  coworkers,
  now,
  seen,
}: {
  projects: ProjectSummary[];
  sessions: ObservedSession[];
  runs: Run[];
  coworkers: Coworker[];
  now: number;
  seen: Seen;
}): ProjectRoom[] {
  const base = projectRooms(projects, sessions, { now, seen });
  const owners = coworkers.filter((c) => c.id !== COORDINATOR_ID);
  const team = new Map<string, ProjectRoom>(
    owners.map((c) => [c.id, { ...emptyRoom(c.folder), connected: true, coworker: c }]),
  );
  const temporary = new Map<string, ProjectRoom>();
  const known = new Map<string, Run>();
  for (const p of projects) if (p.latestRun) known.set(p.latestRun.id, p.latestRun);
  for (const r of runs) known.set(r.id, r);

  const byFolder = (path: string) => {
    const c = coworkerForPath(owners, path);
    return c && team.get(c.id);
  };
  // Assigned work goes to its coworker first: a Slack run may work in a worktree outside the folder.
  const runRoom = (run: Run) =>
    (run.coworkerId ? team.get(run.coworkerId) : undefined) ?? byFolder(run.projectPath);
  const home = new Map<ProjectRoom, ProjectRoom>();
  for (const room of base) {
    let target = byFolder(room.root);
    if (!target) {
      target = {
        ...room,
        workers: [],
        lanes: [],
        offDuty: [],
        automations: [],
        temporary: true,
      };
      temporary.set(room.root, target);
    } else if (
      room.latestRun &&
      (!target.latestRun || room.latestRun.createdAt > target.latestRun.createdAt)
    )
      target.latestRun = room.latestRun;
    home.set(room, target);
  }

  const lanesOf = new Map<ProjectRoom, Map<string, ProjectLane>>();
  const placed = new Set<string>();
  const seat = (room: ProjectRoom, w: ProjectWorker, lane: Omit<ProjectLane, 'workers'>) => {
    if (placed.has(w.id)) return;
    placed.add(w.id);
    room.workers.push(w);
    let byKey = lanesOf.get(room);
    if (!byKey) lanesOf.set(room, (byKey = new Map()));
    let desk = byKey.get(lane.key);
    if (!desk) byKey.set(lane.key, (desk = { ...lane, workers: [] }));
    desk.workers.push(w);
  };
  for (const room of base) {
    for (const w of [...room.workers, ...room.offDuty])
      if (!w.run && w.session?.managed) {
        w.run = known.get(w.session.managed.runId);
        if (w.run) w.label = `앱 작업 · ${w.label}`;
      }
    const target = (w: ProjectWorker) => (w.run && runRoom(w.run)) ?? home.get(room)!;
    // Subagents and visiting implementers stay beside the coworker they follow.
    const lead = (w: ProjectWorker) => w.parentId ?? w.visiting;
    const to = new Map<string, ProjectRoom>();
    for (const w of room.workers) if (!lead(w)) to.set(w.id, target(w));
    for (const w of room.workers) if (lead(w)) to.set(w.id, to.get(lead(w)!) ?? target(w));
    for (const lane of room.lanes) for (const w of lane.workers) seat(to.get(w.id)!, w, lane);
    for (const w of room.offDuty) {
      const dest = target(w);
      if (!dest.offDuty.some((o) => o.id === w.id)) dest.offDuty.push(w);
    }
    home.get(room)!.automations.push(...room.automations);
  }

  // Unfinished runs beyond each repository's latest one, e.g. a coworker's second Slack request in
  // the same folder; runWorkers adds only the desks no session of that run already takes.
  const latest = new Set(base.map((room) => room.latestRun?.id));
  for (const run of known.values()) {
    if (terminal(run.status) || latest.has(run.id)) continue;
    let room = runRoom(run) ?? temporary.get(run.projectPath);
    if (!room) {
      room = { ...emptyRoom(run.projectPath), temporary: true };
      temporary.set(run.projectPath, room);
    }
    for (const w of runWorkers(run, run.projectPath, sessions))
      seat(room, w, { key: run.worktreePath, branch: run.branch, main: false });
  }

  const rooms = [
    ...team.values(),
    ...[...temporary.values()].sort((a, b) => a.root.localeCompare(b.root)),
  ];
  for (const room of rooms) {
    room.lanes = [...(lanesOf.get(room)?.values() ?? [])].sort(laneOrder);
    for (const w of [...room.workers, ...room.offDuty, ...room.automations]) describe(w);
    tally(room);
  }
  return rooms;
}

// One row per piece of work at a desk: a run's sessions share its row, subagents fold into theirs.
export function boardRows(rooms: ProjectRoom[], interactions: Interaction[]): BoardRow[] {
  const rows = new Map<string, { row: BoardRow; worker: ProjectWorker }>();
  // Of several desks on one run, the one waiting or busy right now speaks for it.
  const ahead = (a: ProjectWorker, b: ProjectWorker) =>
    Number(a.waiting) - Number(b.waiting) ||
    Number(a.active) - Number(b.active) ||
    a.updatedAt.localeCompare(b.updatedAt);
  const rowOf = new Map<string, string>();
  for (const room of rooms)
    for (const w of room.workers) {
      if (w.parentId || w.visiting) continue;
      rowOf.set(w.id, w.run ? `run:${w.run.id}` : w.id);
      const id = w.run ? `run:${w.run.id}` : w.id;
      const current = rows.get(id)?.worker;
      if (current && ahead(w, current) <= 0) continue;
      const runId = w.run?.id;
      rows.set(id, {
        worker: w,
        row: {
          id,
          workerId: w.id,
          root: room.root,
          task: w.task ?? w.label,
          source: w.source ?? 'terminal',
          owner:
            room.coworker?.name ||
            room.repoName ||
            room.root.split(/[\\/]/).filter(Boolean).at(-1) ||
            room.root,
          action: w.action ?? w.caption,
          waiting: w.waiting,
          interaction: runId
            ? interactions.find((i) => i.runId === runId && !i.resolved)
            : undefined,
        },
      });
    }
  // A subagent blocked on a prompt makes the work it belongs to wait.
  for (const room of rooms)
    for (const w of room.workers) {
      const folded = w.parentId && rows.get(rowOf.get(w.parentId) ?? '')?.row;
      if (folded && w.waiting && !folded.waiting)
        Object.assign(folded, { waiting: true, action: w.action ?? w.caption });
    }
  return [...rows.values()]
    .sort(
      (a, b) =>
        Number(b.row.waiting) - Number(a.row.waiting) ||
        b.worker.updatedAt.localeCompare(a.worker.updatedAt),
    )
    .map(({ row }) => row);
}
