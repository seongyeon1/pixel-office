import { expect, test } from 'vitest';
import {
  floorLayout,
  LOUNGE,
  MEETING,
  RECORDS,
  type FloorInput,
  type Loc,
} from '../src/client/floor/layout.js';
import { route } from '../src/client/floor/route.js';
import { LOUNGE_CYCLE, MEETING_CYCLE, placements } from '../src/client/floor/choreography.js';
import type { ProjectWorker } from '../src/client/overview/projects.js';
import { modelFamily } from '../src/client/models/family.js';
const lane = (key: string, ids: string[], main = true) => ({
  key,
  branch: main ? 'main' : key,
  main,
  workers: ids.map((id) => ({ id })),
});
const rooms: FloorInput[] = [
  { root: '/a', lanes: [lane('/a', ['a1', 'a2', 'a3', 'a4', 'a5'])] },
  { root: '/b', lanes: [lane('/b', ['b1']), lane('/b/wt', ['b2'], false)] },
  { root: '/c', lanes: [] },
  {
    root: '/d',
    lanes: [
      lane(
        '/d',
        Array.from({ length: 30 }, (_, i) => `d${i}`),
      ),
    ],
  },
];
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
test('rooms never overlap, fit the width, and every visible coworker has a distinct seat in their room', () => {
  for (const width of [360, 900, 1400]) {
    const L = floorLayout(rooms, width);
    expect(L.width).toBeLessThanOrEqual(Math.max(width, 356));
    for (const a of L.cells)
      for (const b of L.cells) if (a !== b) expect(overlaps(a, b)).toBe(false);
    for (const c of L.corridors)
      for (const cell of L.cells) expect(c.y > cell.y && c.y < cell.y + cell.h).toBe(false);
    const seats = [...L.seats.values()];
    expect(new Set(seats.map((s) => `${s.x}:${s.y}`)).size).toBe(seats.length);
    for (const s of seats) {
      const cell = L.cells.find((c) => c.key === s.cell)!;
      expect(cell.key).toBe(s.root);
      expect(s.x > cell.x && s.x < cell.x + cell.w && s.y > cell.y && s.y < cell.y + cell.h).toBe(
        true,
      );
    }
    // Overflow is counted, never silently dropped.
    const shown = seats.filter((s) => s.root === '/d').length;
    expect(shown + (L.hidden.get('/d') ?? 0)).toBe(30);
    expect(L.seats.has('a5')).toBe(true);
  }
});
test('worktree rows carry branch tags only when a room has more than the main checkout', () => {
  const L = floorLayout(rooms, 1400);
  expect(L.rows.filter((r) => r.cell === '/a').every((r) => !r.tag)).toBe(true);
  expect(L.rows.filter((r) => r.cell === '/b').map((r) => r.tag?.branch)).toEqual([
    'main',
    '/b/wt',
  ]);
  expect(L.rows.filter((r) => r.cell === '/c')).toHaveLength(1);
  expect(L.cells.slice(0, 2).map((c) => c.key)).toEqual([MEETING, LOUNGE]);
});
const inside = (p: { x: number; y: number }, c: { x: number; y: number; w: number; h: number }) =>
  p.x > c.x + 0.5 && p.x < c.x + c.w - 0.5 && p.y > c.y + 0.5 && p.y < c.y + c.h - 0.5;
// Every straight segment must stay in one room or in the corridors: sample along it.
function assertThroughDoors(path: Loc[], start: Loc, L: ReturnType<typeof floorLayout>) {
  let prev = start;
  for (const p of path) {
    for (let t = 0; t <= 1; t += 0.05) {
      const q = { x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t };
      const rooms = L.cells.filter((c) => inside(q, c));
      const allowed = [prev.cell, p.cell].filter(Boolean);
      for (const c of rooms) expect(allowed).toContain(c.key);
    }
    prev = p;
  }
}
test('walking between rooms, bands and the entrance only crosses walls through doors', () => {
  const L = floorLayout(rooms, 900);
  const seat = (id: string) => ({ ...L.seats.get(id)! });
  const pairs: [Loc, Loc][] = [
    [seat('a1'), seat('b1')],
    [seat('a1'), seat('d3')],
    [L.entrance, seat('d0')],
    [seat('b2'), L.entrance],
    [seat('a2'), L.meeting[0]],
    [L.lounge[1], seat('a3')],
  ];
  for (const [from, to] of pairs) {
    const path = route(from, to, L);
    expect(path.at(-1)).toEqual(to);
    assertThroughDoors(path, from, L);
  }
  expect(route(seat('a1'), seat('a2'), L)).toEqual([seat('a2')]);
});
const worker = (id: string, root: string, extra: Partial<ProjectWorker> = {}): ProjectWorker => ({
  id,
  provider: 'claude',
  identity: id,
  label: id,
  caption: '',
  prompt: '',
  active: true,
  waiting: false,
  stale: false,
  root,
  lane: root,
  mark: null,
  certain: true,
  updatedAt: '',
  session: {} as ProjectWorker['session'],
  family: modelFamily('claude', 'claude-opus-5-5'),
  ...extra,
});
test('facts decide first: a raised hand stays at the desk and a reviewer is visited', () => {
  const L = floorLayout(
    [{ root: '/r', lanes: [lane('/r', ['run', 'impl', 'q', 'r1', 'r2'])] }],
    1400,
  );
  const workers = [
    worker('run', '/r', { session: undefined }),
    worker('impl', '/r', { session: undefined, visiting: 'run' }),
    worker('q', '/r', { mark: 'question' }),
    worker('r1', '/r'),
    worker('r2', '/r'),
  ];
  for (let clock = 0; clock < MEETING_CYCLE * 6; clock += 5000) {
    const p = placements(workers, L, clock);
    expect(p.get('q')!.kind).toBe('desk');
    expect(p.get('run')!.kind).toBe('desk');
    expect(p.get('impl')).toMatchObject({ kind: 'visit', cell: '/r' });
    expect(p.get('impl')!.x).toBeGreaterThan(L.seats.get('run')!.x);
    expect(placements(workers, L, clock)).toEqual(p);
  }
});
test('several people working in one repository meet sometimes; idle coworkers take coffee breaks', () => {
  const L = floorLayout([{ root: '/r', lanes: [lane('/r', ['m1', 'm2', 'idle'])] }], 1400);
  const workers = [worker('m1', '/r'), worker('m2', '/r'), worker('idle', '/r', { active: false })];
  const kinds = new Map<string, Set<string>>();
  for (let clock = 0; clock < MEETING_CYCLE * 20; clock += 5000)
    for (const [id, p] of placements(workers, L, clock)) {
      kinds.set(id, (kinds.get(id) ?? new Set()).add(p.kind));
      if (p.kind === 'meeting') expect(p.cell).toBe(MEETING);
      if (p.kind === 'lounge') expect(p.cell).toBe(LOUNGE);
    }
  expect([...kinds.get('m1')!].sort()).toEqual(['desk', 'meeting']);
  expect([...kinds.get('idle')!].sort()).toEqual(['desk', 'lounge']);
  // A lone worker never holds a meeting, and one who is waiting never leaves the desk.
  const alone = [worker('m1', '/r'), worker('idle', '/r', { active: false, mark: 'report' })];
  for (let clock = 0; clock < LOUNGE_CYCLE * 20; clock += 5000)
    for (const p of placements(alone, L, clock).values()) expect(p.kind).toBe('desk');
});
test('a repository office puts a wide room first with small facilities beside it when there is space', () => {
  const office = {
    maxRows: Infinity,
    roomsFirst: true,
    minCell: 160,
    roomSpan: 2,
    facilityRows: 1,
    records: false,
  };
  const room = {
    root: '/r',
    lanes: [
      lane(
        '/r',
        Array.from({ length: 11 }, (_, i) => `w${i}`),
      ),
    ],
  };
  const wide = floorLayout([room], 790, office);
  expect(wide.cells.map((c) => c.key)).toEqual(['/r', MEETING, LOUNGE]);
  expect(new Set(wide.cells.map((c) => c.y)).size).toBe(1);
  expect(wide.cells[0].w).toBeGreaterThan(wide.cells[1].w * 2);
  // No overflow in an office: every coworker gets a desk.
  expect(wide.seats.size).toBe(11);
  expect(wide.hidden.size).toBe(0);
  const narrow = floorLayout([room], 340, office);
  expect(narrow.cells.every((c) => c.w === narrow.cells[0].w)).toBe(true);
  expect(narrow.seats.size).toBe(11);
});
test('the whole map has a records room where running automated work sits, never at a desk', () => {
  const L = floorLayout([{ root: '/r', lanes: [lane('/r', ['p'])] }], 1400);
  expect(L.cells.slice(0, 3).map((c) => c.key)).toEqual([MEETING, LOUNGE, RECORDS]);
  const workers = [
    worker('p', '/r'),
    worker('auto-1', '/r', { session: { automated: true } as ProjectWorker['session'] }),
    worker('auto-2', '/r', { session: { automated: true } as ProjectWorker['session'] }),
  ];
  const p = placements(workers, L, 0);
  expect(p.get('auto-1')).toMatchObject({ kind: 'records', cell: RECORDS });
  expect(p.get('auto-2')).toMatchObject({ kind: 'records', cell: RECORDS });
  expect(p.get('auto-1')!.x).not.toBe(p.get('auto-2')!.x);
  expect(p.get('p')!.kind).not.toBe('records');
});
