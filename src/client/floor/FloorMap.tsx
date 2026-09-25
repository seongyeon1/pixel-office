import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Coffee, DoorOpen, Users } from 'lucide-react';
import { repositoryName } from '../components/RepositoryList';
import type { ProjectRoom, ProjectWorker } from '../overview/projects';
import { FloorWorker } from './FloorWorker';
import { hash, placements } from './choreography';
import { FEET, SEAT_W, floorLayout, type Cell, type Loc } from './layout';
import './floor.css';
interface Departure {
  worker: ProjectWorker;
  from: Loc;
}
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
function RoomCell({
  cell,
  room,
  hidden,
  onOpenRoom,
}: {
  cell: Cell;
  room: ProjectRoom;
  hidden: number;
  onOpenRoom?: (root: string) => void;
}) {
  return (
    <article
      className={`floor-cell floor-room ${cell.upper ? 'upper' : 'lower'} ${room.activeCount ? 'busy' : ''}`}
      style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h } as CSSProperties}
      aria-label={`프로젝트 공간 ${room.root}`}
    >
      <header>
        {onOpenRoom ? (
          <button
            className="floor-room-name"
            aria-label={`프로젝트 열기 ${room.root}`}
            title={room.root}
            onClick={() => onOpenRoom(room.root)}
          >
            <strong>{repositoryName(room.root)}</strong>
            <ArrowUpRight size={14} />
          </button>
        ) : (
          <span className="floor-room-name" title={room.root}>
            <strong>{repositoryName(room.root)}</strong>
          </span>
        )}
        <span
          className={`floor-presence ${room.waitingCount ? 'waiting' : room.reportCount ? 'report' : ''}`}
        >
          {room.waitingCount
            ? `응답 필요 ${room.waitingCount}`
            : room.reportCount
              ? `보고 ${room.reportCount}`
              : room.workers.length
                ? `근무 ${room.workers.length}명`
                : '비어 있음'}
        </span>
        <small>{room.pathLabel}</small>
      </header>
      {!room.workers.length && <p className="floor-room-empty">지금 근무 중인 동료가 없어요.</p>}
      {hidden > 0 && onOpenRoom && (
        <button
          className="floor-room-more"
          aria-label={`프로젝트 동료 모두 보기 ${room.root}`}
          onClick={() => onOpenRoom(room.root)}
        >
          +{hidden}명 더 보기
        </button>
      )}
      <span className="floor-door" aria-hidden="true" />
    </article>
  );
}
// The repository takes half the floor, the meeting room and lounge sit beside it.
const OFFICE = { maxRows: Infinity, roomsFirst: true, minCell: 160, roomSpan: 2, facilityRows: 1 };
const mapName = (w: ProjectWorker) =>
  `전체 맵 동료 ${w.root} ${w.visiting ? `${w.run!.id} 구현` : (w.session?.sessionId ?? w.run!.id)}`;
export function FloorMap({
  rooms,
  roster,
  ready,
  clock,
  onOpen,
  onOpenRoom,
  office = false,
  selectedId,
  label = '프로젝트 통합 맵',
  nameOf = mapName,
}: {
  rooms: ProjectRoom[];
  // Everyone on duty, including rooms the search hides: arriving means joining this list.
  roster: string[];
  // False until the first observation lands, so opening the page is not a parade.
  ready: boolean;
  clock: number;
  onOpen: (root: string, worker: ProjectWorker) => void;
  onOpenRoom?: (root: string) => void;
  // One repository's office: every desk row shown, the room first, captions always on.
  office?: boolean;
  selectedId?: string;
  label?: string;
  nameOf?: (w: ProjectWorker) => string;
}) {
  const [box, width] = useWidth();
  // The floor border sits outside the layout.
  const layout = useMemo(
    () => floorLayout(rooms, width - 6, office ? OFFICE : undefined),
    [rooms, width, office],
  );
  const workers = useMemo(() => rooms.flatMap((r) => r.lanes.flatMap((l) => l.workers)), [rooms]);
  const places = useMemo(() => placements(workers, layout, clock), [workers, layout, clock]);
  const visible = workers.filter((w) => places.has(w.id));
  // People who join the duty roster after the first observation walk in through the entrance.
  const onDuty = useRef<Set<string> | null>(null);
  const arrivals = useRef(new Map<string, Loc | undefined>());
  for (const w of visible)
    if (!arrivals.current.has(w.id))
      arrivals.current.set(
        w.id,
        onDuty.current && !onDuty.current.has(w.id) ? layout.entrance : undefined,
      );
  useLayoutEffect(() => {
    if (ready) onDuty.current = new Set(roster);
  }, [ready, roster.join()]);
  // People who go off duty walk out from wherever they last were.
  const last = useRef(new Map<string, { worker: ProjectWorker; at: Loc }>());
  const [departures, setDepartures] = useState<Record<string, Departure>>({});
  useLayoutEffect(() => {
    const present = new Set(visible.map((w) => w.id));
    const inRooms = new Set(rooms.flatMap((r) => r.workers.map((w) => w.id)));
    const shownRooms = new Set(rooms.map((r) => r.root));
    const leaving: Record<string, Departure> = {};
    for (const [id, seen] of last.current)
      if (!present.has(id)) {
        last.current.delete(id);
        arrivals.current.delete(id);
        // Filtering a room away or overflowing a room is not going home.
        if (!inRooms.has(id) && shownRooms.has(seen.worker.root))
          leaving[id] = { worker: seen.worker, from: seen.at };
      }
    for (const w of visible) last.current.set(w.id, { worker: w, at: places.get(w.id)! });
    if (Object.keys(leaving).length) setDepartures((d) => ({ ...d, ...leaving }));
  }, [visible.map((w) => w.id).join(), places]);
  const byRoot = new Map(rooms.map((r) => [r.root, r]));
  // Who is sitting at each desk right now: a working screen lights up, an empty chair stays dark.
  const seated = new Map<string, ProjectWorker>();
  for (const w of visible) {
    const place = places.get(w.id)!;
    if (place.kind === 'desk') seated.set(`${place.x}:${place.y}`, w);
  }
  const seatState = (x: number, y: number, s: number) => {
    const w = seated.get(`${x + s * SEAT_W + SEAT_W / 2}:${y + FEET}`);
    return !w ? 'empty' : w.active ? 'working' : 'idle';
  };
  return (
    <div className="floor-viewport" ref={box}>
      <section
        className={`floor ${office ? 'office' : ''}`}
        aria-label={label}
        style={{ width: layout.width, height: layout.height }}
      >
        <div className="floor-spine" style={{ width: layout.spineX * 2 }} aria-hidden="true" />
        {layout.corridors.map((c) => (
          <div
            key={c.band}
            className="floor-corridor"
            style={{ top: c.top, left: layout.spineX * 2 - 4 }}
            aria-hidden="true"
          />
        ))}
        <div
          className="floor-entrance"
          style={{ top: layout.entrance.y - 34, width: layout.spineX * 2 }}
          aria-label="입구"
        >
          <DoorOpen size={16} aria-hidden="true" />
          입구
        </div>
        {layout.cells.map((cell) =>
          cell.kind === 'room' ? (
            <RoomCell
              key={cell.key}
              cell={cell}
              room={byRoot.get(cell.key)!}
              hidden={layout.hidden.get(cell.key) ?? 0}
              onOpenRoom={onOpenRoom}
            />
          ) : (
            <div
              key={cell.key}
              className={`floor-cell floor-${cell.kind} ${cell.upper ? 'upper' : 'lower'}`}
              style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h }}
              aria-label={cell.kind === 'meeting' ? '회의실' : '탕비실'}
            >
              <header>
                {cell.kind === 'meeting' ? <Users size={14} /> : <Coffee size={14} />}
                <strong>{cell.kind === 'meeting' ? '회의실' : '탕비실'}</strong>
              </header>
              <i className="floor-furniture a" aria-hidden="true" />
              <i className="floor-furniture b" aria-hidden="true" />
              <span className="floor-door" aria-hidden="true" />
            </div>
          ),
        )}
        {layout.rows.map((row, i) => (
          <div
            key={`back-${row.cell}-${i}`}
            className="floor-desks back"
            style={{ left: row.x, top: row.y }}
            aria-hidden="true"
          >
            {Array.from({ length: row.seats }, (_, s) => (
              <i key={s} data-seat={seatState(row.x, row.y, s)} />
            ))}
          </div>
        ))}
        {layout.rows.map((row, i) => (
          <div
            key={`front-${row.cell}-${i}`}
            className="floor-desks front"
            // In front of whoever sits in this row, behind anyone walking below it.
            style={{ left: row.x, top: row.y, zIndex: Math.round(row.y + FEET) + 1 }}
            aria-hidden="true"
          >
            {row.tag && (
              <span className={`floor-lane-tag ${row.tag.main ? 'main' : ''}`}>
                {row.tag.branch || '정리된 워크트리'}
              </span>
            )}
            {Array.from({ length: row.seats }, (_, s) => (
              <i key={s} data-seat={seatState(row.x, row.y, s)} />
            ))}
          </div>
        ))}
        {visible.map((w) => {
          const place = places.get(w.id)!;
          return (
            <FloorWorker
              key={w.id}
              worker={w}
              target={place}
              kind={place.kind}
              start={arrivals.current.get(w.id)}
              delay={arrivals.current.get(w.id) ? hash(w.id) % 1600 : 0}
              layout={layout}
              name={nameOf(w)}
              selected={selectedId === undefined ? undefined : selectedId === w.id}
              onOpen={() => onOpen(w.root, w)}
            />
          );
        })}
        {Object.entries(departures).map(([id, d]) => (
          <FloorWorker
            key={`leaving:${id}`}
            worker={d.worker}
            target={layout.entrance}
            kind="desk"
            start={d.from}
            layout={layout}
            name={`${nameOf(d.worker)} 퇴근 중`}
            leaving
            onArrive={() => setDepartures(({ [id]: _gone, ...rest }) => rest)}
            onOpen={() => undefined}
          />
        ))}
      </section>
    </div>
  );
}
