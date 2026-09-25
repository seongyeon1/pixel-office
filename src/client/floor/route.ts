import type { FloorLayout, Loc } from './layout';
// Walls are only crossed through doors: seat → door → corridor → (spine) → corridor → door → seat.
export function route(from: Loc, to: Loc, L: FloorLayout): Loc[] {
  if (from.cell && from.cell === to.cell) return [to];
  const corridor = (band: number) => L.corridors.find((c) => c.band === band)!.y;
  const cellOf = (key: string) => L.cells.find((c) => c.key === key);
  const path: Loc[] = [];
  let band = from.band;
  let x = from.x;
  const source = from.cell ? cellOf(from.cell) : undefined;
  if (source) {
    path.push({ ...source.door, cell: null, band: source.band });
    path.push({ x: source.door.x, y: corridor(source.band), cell: null, band: source.band });
    x = source.door.x;
  } else if (band !== null) {
    // Mid-corridor: step onto the corridor line first.
    path.push({ x, y: corridor(band), cell: null, band });
  }
  const target = to.cell ? cellOf(to.cell) : undefined;
  const targetBand = target ? target.band : null;
  if (band === null || band !== targetBand) {
    if (band !== null) path.push({ x: L.spineX, y: corridor(band), cell: null, band: null });
    else if (x !== L.spineX) path.push({ x: L.spineX, y: from.y, cell: null, band: null });
    band = null;
  }
  if (target) {
    if (band === null) path.push({ x: L.spineX, y: corridor(target.band), cell: null, band: null });
    path.push({ x: target.door.x, y: corridor(target.band), cell: null, band: target.band });
    path.push({ ...target.door, cell: null, band: target.band });
  }
  path.push(to);
  // Drop zero-length steps so walking time is spent moving.
  return path.filter((p, i) => {
    const prev = i ? path[i - 1] : from;
    return i === path.length - 1 || p.x !== prev.x || p.y !== prev.y;
  });
}
