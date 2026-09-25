import type { Activity, ObservedSession } from '../../shared/contracts';
export type OfficeZone = 'desk' | 'library' | 'test' | 'lounge';
export const zoneLabels: Record<OfficeZone, string> = {
  desk: '코드 작업',
  library: '자료 · 협업',
  test: '실행 · 테스트',
  lounge: '휴식 · 대기',
};
export function activityZone(activity: Activity): OfficeZone {
  if (activity === 'executing') return 'test';
  if (['reading', 'reviewing', 'responding'].includes(activity)) return 'library';
  if (activity === 'idle') return 'lounge';
  return 'desk';
}
const zoneOf = (s: ObservedSession): OfficeZone =>
  s.status === 'active' ? activityZone(s.activity) : 'lounge';
const PER_ROW = 4;
export function sessionLayout(sessions: ObservedSession[]) {
  const counts: Record<OfficeZone, number> = { desk: 0, library: 0, test: 0, lounge: 0 };
  for (const s of sessions) counts[zoneOf(s)]++;
  const topRows = Math.max(1, Math.ceil(Math.max(counts.desk, counts.library) / PER_ROW));
  const bottomRows = Math.max(1, Math.ceil(Math.max(counts.test, counts.lounge) / PER_ROW));
  const topHeight = 184 + (topRows - 1) * 114;
  const bottomHeight = 184 + (bottomRows - 1) * 114;
  const lowerTop = topHeight + 46;
  return {
    topHeight,
    bottomHeight,
    lowerTop,
    topRows,
    bottomRows,
    height: lowerTop + bottomHeight + 28,
  };
}
type Layout = ReturnType<typeof sessionLayout>;
// Seats are fixed furniture: a worker assigned to slot N of a zone sits at station N.
function seat(zone: OfficeZone, slot: number, layout: Layout) {
  const x = (zone === 'library' || zone === 'lounge' ? 386 : 30) + (slot % PER_ROW) * 78;
  const y =
    (zone === 'test' || zone === 'lounge' ? layout.lowerTop + 44 : 56) +
    Math.floor(slot / PER_ROW) * 114;
  return { zone, slot, x, y };
}
export function officeStations(sessions: ObservedSession[]) {
  const layout = sessionLayout(sessions);
  return (['desk', 'library', 'test', 'lounge'] as OfficeZone[]).flatMap((zone) => {
    const rows = zone === 'desk' || zone === 'library' ? layout.topRows : layout.bottomRows;
    return Array.from({ length: rows * PER_ROW }, (_, slot) => seat(zone, slot, layout));
  });
}
export function sessionPositions(sessions: ObservedSession[]) {
  const counters: Record<OfficeZone, number> = { desk: 0, library: 0, test: 0, lounge: 0 };
  const layout = sessionLayout(sessions);
  return new Map(
    [...sessions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => {
        const zone = zoneOf(s);
        const { x, y } = seat(zone, counters[zone]++, layout);
        return [s.id, { zone, x, y }];
      }),
  );
}
