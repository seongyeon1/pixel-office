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
export function sessionLayout(sessions: ObservedSession[]) {
  const counts: Record<OfficeZone, number> = { desk: 0, library: 0, test: 0, lounge: 0 };
  for (const s of sessions) counts[s.status === 'active' ? activityZone(s.activity) : 'lounge']++;
  const topHeight =
    174 + Math.max(0, Math.ceil(Math.max(counts.desk, counts.library) / 4) - 1) * 114;
  const bottomHeight =
    174 + Math.max(0, Math.ceil(Math.max(counts.test, counts.lounge) / 4) - 1) * 114;
  const lowerTop = topHeight + 46;
  return { topHeight, bottomHeight, lowerTop, height: lowerTop + bottomHeight + 28 };
}
export function sessionPositions(sessions: ObservedSession[]) {
  const counters: Record<OfficeZone, number> = { desk: 0, library: 0, test: 0, lounge: 0 };
  const layout = sessionLayout(sessions);
  return new Map(
    [...sessions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => {
        const zone = s.status === 'active' ? activityZone(s.activity) : 'lounge';
        const slot = counters[zone]++;
        const x = (zone === 'library' || zone === 'lounge' ? 386 : 30) + (slot % 4) * 78;
        const y =
          (zone === 'test' || zone === 'lounge' ? layout.lowerTop + 34 : 46) +
          Math.floor(slot / 4) * 114;
        return [s.id, { zone, x, y }];
      }),
  );
}
