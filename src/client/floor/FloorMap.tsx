import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowUpRight,
  Coffee,
  DoorOpen,
  Merge,
  ScrollText,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { Provider } from '../../shared/contracts';
import { repositoryName } from '../components/RepositoryList';
import { PixelWorker } from '../office/PixelWorker';
import type { ProjectRoom, ProjectWorker } from '../overview/projects';
import type { BoardRow } from '../overview/team';
import { FloorWorker } from './FloorWorker';
import { hash, placements } from './choreography';
import { describeModel, useModelCatalog } from '../models/catalog';
import { FEET, MAX_SIGNS, SEAT_W, floorLayout, type Cell, type Loc } from './layout';
import './floor.css';
const facilityName: Record<string, string> = {
  meeting: '회의실',
  lounge: '탕비실',
  records: '기록실',
};
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
export interface RoomMerging {
  // Every room a folder could be merged into, and which folders were merged into which room.
  roots: string[];
  aliases: { source: string; target: string }[];
  onMerge: (source: string, target: string) => Promise<void>;
  onSplit: (source: string) => Promise<void>;
}
function MergeControls({ room, merging }: { room: ProjectRoom; merging: RoomMerging }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const merged = merging.aliases.filter((a) => a.target === room.root).map((a) => a.source);
  const targets = merging.roots.filter((r) => r !== room.root);
  const run = async (action: () => Promise<void>) => {
    setError('');
    try {
      await action();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="floor-room-merge">
      {merged.map((source) => (
        <span key={source} className="floor-merged" title={source}>
          + {repositoryName(source)}
          <button
            aria-label={`방 분리 ${source}`}
            title="원래 방으로 분리"
            onClick={() => void run(() => merging.onSplit(source))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {targets.length > 0 && (
        <button
          className="floor-merge-open"
          aria-label={`방 합치기 ${room.root}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Merge size={11} />
          합치기
        </button>
      )}
      {open && (
        <div
          className="floor-merge-popover"
          role="group"
          aria-label={`${repositoryName(room.root)} 합칠 방`}
        >
          <p>이 방의 동료를 다른 방으로 옮겨 한 방처럼 보여요. 파일과 작업 폴더는 그대로예요.</p>
          <select
            aria-label="합칠 대상 방"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">방 선택</option>
            {targets.map((r) => (
              <option key={r} value={r}>
                {repositoryName(r)} — {r}
              </option>
            ))}
          </select>
          <button
            disabled={!target}
            onClick={() => void run(() => merging.onMerge(room.root, target))}
          >
            합치기
          </button>
          {error && <small role="alert">{error}</small>}
        </div>
      )}
    </div>
  );
}
// The door signs: what each piece of work in the room is and what it is doing right now.
function RoomSigns({
  room,
  signs,
  selectedId,
  onOpen,
  onHover,
}: {
  room: ProjectRoom;
  signs: BoardRow[];
  selectedId?: string;
  onOpen: (root: string, worker: ProjectWorker) => void;
  onHover?: (workerId?: string) => void;
}) {
  const more = signs.length - MAX_SIGNS;
  return (
    <ul
      className="floor-signs"
      aria-label={`${room.coworker?.name ?? repositoryName(room.root)} 맡은 일`}
    >
      {signs.slice(0, MAX_SIGNS).map((row) => (
        <li key={row.id}>
          <button
            className={`floor-sign ${row.waiting ? 'waiting' : ''} ${row.workerId === selectedId ? 'highlight' : ''}`}
            data-worker-id={row.workerId}
            title={`${row.task}\n${row.action}`}
            onClick={() => {
              const w = room.workers.find((x) => x.id === row.workerId);
              if (w) onOpen(w.root, w);
            }}
            onMouseEnter={() => onHover?.(row.workerId)}
            onMouseLeave={() => onHover?.(undefined)}
            onFocus={() => onHover?.(row.workerId)}
            onBlur={() => onHover?.(undefined)}
          >
            <strong>{row.task}</strong>
            <span>{row.action}</span>
          </button>
        </li>
      ))}
      {more > 0 && <li className="floor-sign-more">+{more}건 더 · 보드에서 볼 수 있어요</li>}
    </ul>
  );
}
function RoomCell({
  cell,
  room,
  hidden,
  onOpenRoom,
  merging,
  signs,
  selectedId,
  onOpen,
  onHover,
  onRegister,
}: {
  cell: Cell;
  room: ProjectRoom;
  hidden: number;
  onOpenRoom?: (root: string) => void;
  merging?: RoomMerging;
  signs: BoardRow[];
  selectedId?: string;
  onOpen: (root: string, worker: ProjectWorker) => void;
  onHover?: (workerId?: string) => void;
  onRegister?: (folder: string) => void;
}) {
  const name = room.coworker?.name ?? repositoryName(room.root);
  // A coworker with nothing to do rests in a dark room; repositories nobody owns stay faint.
  const resting = !!room.coworker && !room.workers.length;
  const highlight = !!selectedId && room.workers.some((w) => w.id === selectedId);
  return (
    <article
      className={`floor-cell floor-room ${cell.upper ? 'upper' : 'lower'} ${room.activeCount ? 'busy' : ''} ${room.temporary ? 'temporary' : ''} ${resting ? 'resting' : ''} ${highlight ? 'highlight' : ''}`}
      style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h } as CSSProperties}
      aria-label={room.coworker ? `동료 방 ${room.coworker.name}` : `프로젝트 공간 ${room.root}`}
    >
      <header>
        {onOpenRoom ? (
          <button
            className="floor-room-name"
            aria-label={`프로젝트 열기 ${room.root}`}
            title={room.root}
            onClick={() => onOpenRoom(room.root)}
          >
            <strong>{name}</strong>
            {room.repoName && <em className="floor-repo-name">{room.repoName}</em>}
            <ArrowUpRight size={14} />
          </button>
        ) : (
          <span className="floor-room-name" title={room.root}>
            <strong>{name}</strong>
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
                : resting
                  ? '쉬는 중'
                  : '비어 있음'}
        </span>
        <small>{room.temporary ? `임시 방 · ${room.pathLabel}` : room.pathLabel}</small>
      </header>
      {signs.length > 0 && (
        <RoomSigns
          room={room}
          signs={signs}
          selectedId={selectedId}
          onOpen={onOpen}
          onHover={onHover}
        />
      )}
      {!room.workers.length && (
        <p className="floor-room-empty">
          {resting ? '맡은 일이 없어 쉬는 중이에요.' : '지금 근무 중인 동료가 없어요.'}
        </p>
      )}
      <div className="floor-room-actions">
        {hidden > 0 && onOpenRoom && (
          <button
            className="floor-room-more"
            aria-label={`프로젝트 동료 모두 보기 ${room.root}`}
            onClick={() => onOpenRoom(room.root)}
          >
            +{hidden}명 더 보기
          </button>
        )}
        {room.temporary && onRegister && (
          <button
            className="floor-register"
            title={`${room.root} 폴더를 맡을 동료 만들기`}
            onClick={() => onRegister(room.root)}
          >
            <UserPlus size={11} aria-hidden="true" />
            동료로 등록
          </button>
        )}
      </div>
      {/* Merging regroups repositories, so a coworker's room does not offer it. */}
      {merging && !room.coworker && <MergeControls room={room} merging={merging} />}
      <span className="floor-door" aria-hidden="true" />
    </article>
  );
}
// The repository takes half the floor, the meeting room and lounge sit beside it.
const OFFICE = {
  maxRows: Infinity,
  roomsFirst: true,
  minCell: 160,
  roomSpan: 2,
  facilityRows: 1,
  records: false,
};
// Viewport padding, the two side walls and the building's drop shadow, in CSS pixels.
const FRAME = 4 + 18 + 16;
// The coordinator at the reception desk and what the desk says right now.
export interface Reception {
  name: string;
  provider: Provider;
  summary: string;
  busy: boolean;
}
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
  departmentOf,
  merging,
  selectedId,
  label = '프로젝트 통합 맵',
  nameOf = mapName,
  signs,
  onHover,
  onRegister,
  reception,
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
  // Department id and name for a room; rooms of one department share bands.
  departmentOf?: (root: string) => { id: string; name: string };
  merging?: RoomMerging;
  selectedId?: string;
  label?: string;
  nameOf?: (w: ProjectWorker) => string;
  // Board rows, shown as door signs in the room their worker sits in.
  signs?: BoardRow[];
  onHover?: (workerId?: string) => void;
  // Temporary rooms offer to make a coworker for their folder.
  onRegister?: (folder: string) => void;
  reception?: Reception;
}) {
  const [box, width] = useWidth();
  const catalog = useModelCatalog();
  // A room signs only for work seated in it, so the model filter hides those signs too.
  const signsOf = useMemo(
    () =>
      new Map(
        rooms.map((r) => [
          r.root,
          (signs ?? []).filter(
            (s) => s.root === r.root && r.workers.some((w) => w.id === s.workerId),
          ),
        ]),
      ),
    [rooms, signs],
  );
  // The walls and the building's shadow sit outside the layout.
  const layout = useMemo(
    () =>
      floorLayout(
        rooms.map((r) => ({
          ...r,
          group: departmentOf?.(r.root).id,
          signs: signsOf.get(r.root)!.length,
        })),
        width - FRAME,
        office ? OFFICE : reception ? { reception: true } : undefined,
      ),
    [rooms, width, office, departmentOf, signsOf, !!reception],
  );
  const workers = useMemo(
    () =>
      rooms.flatMap((r) => [
        ...r.lanes.flatMap((l) => l.workers),
        ...(office ? [] : r.automations),
      ]),
    [rooms, office],
  );
  const writing = office ? 0 : rooms.reduce((n, r) => n + r.automations.length, 0);
  const places = useMemo(() => placements(workers, layout, clock), [workers, layout, clock]);
  const visible = workers.filter((w) => places.has(w.id));
  // People who join the duty roster after the first observation walk in through the entrance.
  const onDuty = useRef<Set<string> | null>(null);
  const arrivals = useRef(new Map<string, Loc | undefined>());
  for (const w of visible)
    if (!arrivals.current.has(w.id))
      arrivals.current.set(
        w.id,
        // Automated work pops into the records room instead of walking in every few minutes.
        onDuty.current && !onDuty.current.has(w.id) && !w.session?.automated
          ? layout.entrance
          : undefined,
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
        if (!inRooms.has(id) && shownRooms.has(seen.worker.root) && !seen.worker.session?.automated)
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
      <div className="floor-building">
        {/* The back wall with its windows, noticeboard and framed motto. */}
        <div className="floor-wall" aria-hidden="true">
          <i className="floor-board" />
          <span className="floor-frame">좋은 일은 함께.</span>
        </div>
        <section
          className={`floor ${office ? 'office' : ''}`}
          aria-label={label}
          style={{ width: layout.width, height: layout.height }}
        >
          {departmentOf &&
            layout.bands
              .filter((b) => b.group)
              .map((b, i, all) => {
                const name = departmentOf(
                  layout.cells.find((c) => c.band === b.band && c.kind === 'room')!.key,
                ).name;
                // The plaque only on the first band of a department.
                const first = i === 0 || all[i - 1].group !== b.group;
                return (
                  <div
                    key={`dept-${b.band}`}
                    className="floor-dept"
                    data-dept={b.group}
                    style={{
                      top: b.top - 26,
                      height: b.bottom - b.top + 34,
                      left: layout.spineX * 2,
                    }}
                  >
                    {first && (
                      <span className="floor-dept-name" role="heading" aria-level={2}>
                        {name}
                      </span>
                    )}
                  </div>
                );
              })}
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
            style={{ top: layout.entrance.y - 34, width: layout.spineX * 2 - 16 }}
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
                merging={merging}
                signs={signsOf.get(cell.key)!}
                // Only the board-backed map lights rooms up; an office's selection stays on the mat.
                selectedId={signs ? selectedId : undefined}
                onOpen={onOpen}
                onHover={onHover}
                onRegister={onRegister}
              />
            ) : (
              <div
                key={cell.key}
                className={`floor-cell floor-${cell.kind} ${cell.upper ? 'upper' : 'lower'}`}
                style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h }}
                aria-label={facilityName[cell.kind]}
              >
                <header>
                  {cell.kind === 'meeting' ? (
                    <Users size={14} />
                  ) : cell.kind === 'records' ? (
                    <ScrollText size={14} />
                  ) : (
                    <Coffee size={14} />
                  )}
                  <strong>{facilityName[cell.kind]}</strong>
                  {cell.kind === 'records' && (
                    <span className="floor-presence">
                      {writing ? `작성 중 ${writing}` : '조용함'}
                    </span>
                  )}
                </header>
                <i className="floor-furniture a" aria-hidden="true" />
                <i className="floor-furniture b" aria-hidden="true" />
                <i className="floor-furniture c" aria-hidden="true" />
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
                modelNote={describeModel(
                  catalog,
                  w.provider,
                  w.session?.model ?? w.run?.team[w.provider].model ?? '',
                )}
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
          {layout.reception && reception && (
            <section
              className={`floor-reception ${reception.busy ? 'busy' : ''}`}
              style={{
                left: layout.reception.x,
                top: layout.reception.y,
                width: layout.reception.w,
                height: layout.reception.h,
              }}
              aria-label={`안내 데스크 ${reception.name}`}
            >
              <span className="floor-sprite" aria-hidden="true">
                <PixelWorker provider={reception.provider} identity="coordinator" />
              </span>
              <span className="floor-reception-text">
                <strong>안내 데스크 · {reception.name}</strong>
                <span>{reception.summary}</span>
              </span>
            </section>
          )}
          <i className="floor-plant corner" aria-hidden="true" />
          {!layout.reception && <i className="floor-plant lobby" aria-hidden="true" />}
        </section>
        {/* The front wall, with the doorway at the foot of the spine. */}
        <div className="floor-base" aria-hidden="true">
          <i style={{ left: 0, width: layout.spineX * 2 }} />
        </div>
      </div>
    </div>
  );
}
