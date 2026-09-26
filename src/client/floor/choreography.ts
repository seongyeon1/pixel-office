import type { ProjectWorker } from '../overview/projects';
import type { FloorLayout, Loc } from './layout';
export type PlaceKind = 'desk' | 'meeting' | 'lounge' | 'visit' | 'records';
export type Placement = Loc & { kind: PlaceKind };
export const MEETING_CYCLE = 90000;
export const MEETING_LENGTH = 30000;
export const LOUNGE_CYCLE = 60000;
export const LOUNGE_LENGTH = 25000;
export function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}
// Deterministic for a given clock, so polling and re-renders never make anyone change their mind.
// Facts first: a raised hand or a report keeps you at your desk, an implementer under review
// stands beside the reviewer. Only then the office life: meetings when a repository has several
// people working at once, and coffee for coworkers with nothing to do.
export function placements(
  workers: ProjectWorker[],
  L: FloorLayout,
  clock: number,
): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const seat = (id: string) => L.seats.get(id);
  // Away coworkers are not in the building to wander; they keep their dimmed desk.
  const free = (w: ProjectWorker) =>
    !w.mark && !w.parentId && !w.visiting && !w.away && !!w.session;
  const meetingSeats = [...L.meeting];
  const byRoom = new Map<string, ProjectWorker[]>();
  for (const w of workers) byRoom.set(w.root, [...(byRoom.get(w.root) ?? []), w]);
  const meeting = new Set<string>();
  const cycle = Math.floor(clock / MEETING_CYCLE);
  if (clock % MEETING_CYCLE < MEETING_LENGTH)
    for (const [root, members] of [...byRoom].sort(([a], [b]) => a.localeCompare(b))) {
      const busy = members.filter((w) => free(w) && w.active && seat(w.id));
      if (busy.length < 2 || hash(`${root}:${cycle}`) % 2) continue;
      if (meetingSeats.length < 2) break;
      busy
        .sort((a, b) => hash(`${a.id}:${cycle}`) - hash(`${b.id}:${cycle}`))
        .slice(0, 2)
        .forEach((w) => {
          meeting.add(w.id);
          out.set(w.id, { ...meetingSeats.shift()!, kind: 'meeting' });
        });
    }
  let lounge = 0;
  let records = 0;
  for (const w of [...workers].sort((a, b) => a.id.localeCompare(b.id))) {
    // Automated work has no desk: it writes in the records room while it runs.
    if (w.session?.automated) {
      if (L.records.length)
        out.set(w.id, { ...L.records[records++ % L.records.length], kind: 'records' });
      continue;
    }
    const desk = seat(w.id);
    if (!desk || meeting.has(w.id)) continue;
    const host = w.visiting ? seat(w.visiting) : undefined;
    if (!w.mark && host) {
      out.set(w.id, {
        x: host.x + 34,
        y: host.y + 8,
        cell: host.cell,
        band: host.band,
        kind: 'visit',
      });
      continue;
    }
    // Each coworker has their own rhythm so the lounge never fills up in lockstep.
    const t = clock + (hash(w.id) % LOUNGE_CYCLE);
    if (
      free(w) &&
      !w.active &&
      L.lounge.length &&
      t % LOUNGE_CYCLE < LOUNGE_LENGTH &&
      hash(`${w.id}:${Math.floor(t / LOUNGE_CYCLE)}`) % 3 === 0
    ) {
      out.set(w.id, { ...L.lounge[lounge++ % L.lounge.length], kind: 'lounge' });
      continue;
    }
    out.set(w.id, { x: desk.x, y: desk.y, cell: desk.cell, band: desk.band, kind: 'desk' });
  }
  return out;
}
