import { expect, test } from 'vitest';
import { officeStations, sessionPositions } from '../src/client/office/movement.js';
import type { ObservedSession } from '../src/shared/contracts.js';
const session = (
  id: string,
  activity: ObservedSession['activity'],
  status: ObservedSession['status'] = 'active',
) => ({ id, activity, status }) as ObservedSession;
test('observed activity moves agents between rooms and completion returns them to the lounge', () => {
  expect(sessionPositions([session('a', 'editing')]).get('a')?.zone).toBe('desk');
  expect(sessionPositions([session('a', 'executing')]).get('a')?.zone).toBe('test');
  expect(sessionPositions([session('a', 'reading')]).get('a')?.zone).toBe('library');
  expect(sessionPositions([session('a', 'executing', 'idle')]).get('a')?.zone).toBe('lounge');
  expect(sessionPositions([session('a', 'editing', 'stale')]).get('a')?.zone).toBe('lounge');
});
test('eight coworkers in one room have distinct slots and polling order does not move them', () => {
  const sessions = Array.from({ length: 8 }, (_, i) => session(`session-${i}`, 'executing'));
  const positions = sessionPositions(sessions);
  expect(new Set([...positions.values()].map((p) => `${p.x}:${p.y}`)).size).toBe(8);
  expect(sessionPositions([...sessions].reverse())).toEqual(positions);
});
test('every zone keeps a full row of stations and each worker sits on one', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => session(`s-${i}`, 'editing'));
  const stations = officeStations(sessions);
  const desks = stations.filter((s) => s.zone === 'desk');
  expect(desks).toHaveLength(8);
  expect(stations.filter((s) => s.zone === 'library')).toHaveLength(8);
  expect(stations.filter((s) => s.zone === 'lounge')).toHaveLength(4);
  const seats = new Set(desks.map((d) => `${d.x}:${d.y}`));
  for (const p of sessionPositions(sessions).values()) expect(seats.has(`${p.x}:${p.y}`)).toBe(true);
});
