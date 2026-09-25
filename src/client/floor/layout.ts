// One office floor: a spine corridor on the left with the entrance at its foot, and rooms laid
// out in bands of two rows that face a shared corridor. Everything is in CSS pixels.
export interface Point {
  x: number;
  y: number;
}
// Where someone stands: inside a cell, or in a corridor (band) / on the spine (both null).
export interface Loc extends Point {
  cell: string | null;
  band: number | null;
}
export type CellKind = 'room' | 'meeting' | 'lounge';
export interface Cell {
  key: string;
  kind: CellKind;
  x: number;
  y: number;
  w: number;
  h: number;
  band: number;
  upper: boolean;
  door: Point;
}
export interface DeskRow {
  cell: string;
  x: number;
  y: number;
  seats: number;
  // Branch tag shown at the start of the first row of a worktree.
  tag?: { branch: string; main: boolean };
}
export interface FloorInput {
  root: string;
  lanes: { key: string; branch: string; main: boolean; workers: { id: string }[] }[];
}
export interface FloorLayout {
  width: number;
  height: number;
  spineX: number;
  entrance: Loc;
  corridors: { band: number; y: number; top: number }[];
  cells: Cell[];
  rows: DeskRow[];
  seats: Map<string, Loc & { root: string }>;
  hidden: Map<string, number>;
  meeting: Loc[];
  lounge: Loc[];
}
export const MEETING = 'facility:meeting';
export const LOUNGE = 'facility:lounge';
const SPINE_W = 76;
const GAP = 14;
const ROOM_MIN_W = 280;
const HEAD = 60;
const ROW_H = 92;
const PAD_B = 22;
const CORRIDOR_H = 56;
const BAND_GAP = 18;
const SEAT_W = 66;
const SEAT_PAD = 26;
const MAX_ROWS = 3;
const LOBBY_H = 96;
// Feet sit a little above the desk front so the desk hides the chair, not the character.
const FEET = 62;
export function floorLayout(rooms: FloorInput[], width: number): FloorLayout {
  const usable = Math.max(ROOM_MIN_W, width - SPINE_W);
  const cols = Math.max(1, Math.floor((usable + GAP) / (ROOM_MIN_W + GAP)));
  const cellW = Math.floor((usable - (cols - 1) * GAP) / cols);
  const perRow = Math.max(2, Math.min(6, Math.floor((cellW - 2 * SEAT_PAD) / SEAT_W)));
  const entries: { key: string; kind: CellKind; rows: number; room?: FloorInput }[] = [
    { key: MEETING, kind: 'meeting', rows: 2 },
    { key: LOUNGE, kind: 'lounge', rows: 2 },
    ...rooms.map((room) => ({
      key: room.root,
      kind: 'room' as const,
      room,
      rows: Math.min(
        MAX_ROWS,
        Math.max(
          1,
          room.lanes.reduce((n, l) => n + Math.max(1, Math.ceil(l.workers.length / perRow)), 0),
        ),
      ),
    })),
  ];
  const gridRows = Math.ceil(entries.length / cols);
  const heightOf = (r: number) =>
    HEAD + Math.max(...entries.slice(r * cols, r * cols + cols).map((e) => e.rows)) * ROW_H + PAD_B;
  const cells: Cell[] = [];
  const corridors: FloorLayout['corridors'] = [];
  let y = 0;
  for (let band = 0; band * 2 < gridRows; band++) {
    for (const upper of [true, false]) {
      const r = band * 2 + (upper ? 0 : 1);
      if (!upper) {
        corridors.push({ band, top: y, y: y + CORRIDOR_H / 2 });
        y += CORRIDOR_H;
      }
      if (r >= gridRows) continue;
      const h = heightOf(r);
      entries.slice(r * cols, r * cols + cols).forEach((e, c) => {
        const x = SPINE_W + c * (cellW + GAP);
        cells.push({
          key: e.key,
          kind: e.kind,
          x,
          y,
          w: cellW,
          h,
          band,
          upper,
          door: { x: x + cellW / 2, y: upper ? y + h : y },
        });
      });
      y += h;
    }
    y += BAND_GAP;
  }
  const height = y + LOBBY_H;
  const rows: DeskRow[] = [];
  const seats: FloorLayout['seats'] = new Map();
  const hidden = new Map<string, number>();
  for (const e of entries) {
    if (!e.room) continue;
    const cell = cells.find((c) => c.key === e.key)!;
    const rowX = cell.x + (cell.w - perRow * SEAT_W) / 2;
    const tagged = e.room.lanes.length > 1 || e.room.lanes.some((l) => !l.main);
    let row = 0;
    let lost = 0;
    for (const lane of e.room.lanes) {
      const needed = Math.max(1, Math.ceil(lane.workers.length / perRow));
      for (let i = 0; i < needed; i++, row++) {
        const members = lane.workers.slice(i * perRow, i * perRow + perRow);
        if (row >= MAX_ROWS) {
          lost += members.length;
          continue;
        }
        const top = cell.y + HEAD + row * ROW_H;
        rows.push({
          cell: cell.key,
          x: rowX,
          y: top,
          seats: perRow,
          tag: tagged && i === 0 ? { branch: lane.branch, main: lane.main } : undefined,
        });
        members.forEach((w, s) =>
          seats.set(w.id, {
            x: rowX + s * SEAT_W + SEAT_W / 2,
            y: top + FEET,
            cell: cell.key,
            band: cell.band,
            root: e.room!.root,
          }),
        );
      }
    }
    if (!e.room.lanes.length)
      rows.push({ cell: cell.key, x: rowX, y: cell.y + HEAD, seats: perRow });
    if (lost) hidden.set(e.room.root, lost);
  }
  const spots = (key: string, xs: number[], ys: number[]) => {
    const cell = cells.find((c) => c.key === key)!;
    return ys.flatMap((fy) =>
      xs.map((fx) => ({
        x: cell.x + cell.w * fx,
        y: cell.y + HEAD + (cell.h - HEAD - PAD_B) * fy,
        cell: key,
        band: cell.band,
      })),
    );
  };
  return {
    width: SPINE_W + cols * cellW + (cols - 1) * GAP,
    height,
    spineX: SPINE_W / 2,
    entrance: { x: SPINE_W / 2, y: height - 26, cell: null, band: null },
    corridors,
    cells,
    rows,
    seats,
    hidden,
    // Around the meeting table, and along the lounge counter and sofa.
    meeting: spots(MEETING, [0.3, 0.5, 0.7], [0.36, 0.86]),
    lounge: spots(LOUNGE, [0.22, 0.42, 0.62, 0.82], [0.5, 0.9]),
  };
}
