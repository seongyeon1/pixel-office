import { useEffect, useRef, useState } from 'react';
import { PixelWorker } from '../office/PixelWorker';
import type { ProjectWorker } from '../overview/projects';
import type { FloorLayout, Loc } from './layout';
import type { PlaceKind } from './choreography';
import { route } from './route';
// Pixels per second; a room-to-room walk takes a few seconds.
const SPEED = 120;
const markSymbol = { question: '?', approval: '?', report: '!' } as const;
const placeLabel: Record<PlaceKind, string> = {
  desk: '',
  meeting: '회의 중',
  lounge: '커피 타임',
  visit: '리뷰 받는 중',
};
export function FloorWorker({
  worker: w,
  target,
  kind,
  start,
  delay = 0,
  layout,
  leaving = false,
  name,
  selected,
  onArrive,
  onOpen,
}: {
  worker: ProjectWorker;
  target: Loc;
  kind: PlaceKind;
  // Where the walk starts on first mount: the entrance for someone arriving for work.
  start?: Loc;
  // Arrivals are staggered so people walking in together do not overlap.
  delay?: number;
  layout: FloorLayout;
  leaving?: boolean;
  // Accessible name; each screen keeps its own naming scheme.
  name: string;
  // Defined only where coworkers can be selected.
  selected?: boolean;
  onArrive?: () => void;
  onOpen: () => void;
}) {
  const at = useRef<Loc>(start ?? target);
  const firstDelay = useRef(delay);
  const [pos, setPos] = useState<Loc>(at.current);
  const [duration, setDuration] = useState(0);
  // Someone waiting at the entrance to walk in is already on their way.
  const [walking, setWalking] = useState(!!start && (start.x !== target.x || start.y !== target.y));
  const [left, setLeft] = useState(false);
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  const size = `${layout.width}x${layout.height}`;
  const lastSize = useRef(size);
  useEffect(() => {
    const resized = lastSize.current !== size;
    lastSize.current = size;
    // Resizing moves the building, not the people: jump instead of walking across it.
    if (resized || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      at.current = target;
      setDuration(0);
      setPos(target);
      setWalking(false);
      if (leaving) arrive.current?.();
      return;
    }
    const path = route(at.current, target, layout);
    let step = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (step >= path.length) {
        setWalking(false);
        arrive.current?.();
        return;
      }
      const to = path[step++];
      const ms = (Math.hypot(to.x - at.current.x, to.y - at.current.y) / SPEED) * 1000;
      if (to.x !== at.current.x) setLeft(to.x < at.current.x);
      at.current = to;
      setDuration(ms);
      setPos(to);
      setWalking(ms > 0);
      timer = setTimeout(next, ms);
    };
    // Start on the next frame so a freshly mounted worker renders at its start point first.
    // The arrival delay is spent once, by the walk that actually starts.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(next, firstDelay.current);
      firstDelay.current = 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [target.x, target.y, target.cell, size, leaving]);
  const provider = w.provider === 'codex' ? 'Codex' : 'Claude';
  const doing = leaving ? '퇴근 중' : placeLabel[kind] || w.caption;
  return (
    <button
      className={`floor-worker ${w.active ? 'working' : 'resting'} ${walking ? 'walking' : ''} ${w.mark ? `marked ${w.mark}` : ''} ${w.certain ? '' : 'guess'} ${selected ? 'selected' : ''}`}
      style={{
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        transitionDuration: `${duration}ms`,
        zIndex: Math.round(pos.y),
      }}
      data-place={leaving ? 'leaving' : kind}
      data-status={w.stale ? 'stale' : w.active ? 'active' : 'idle'}
      data-mark={w.mark ?? undefined}
      data-activity={w.session?.status === 'active' ? w.session.activity : undefined}
      aria-label={name}
      aria-pressed={selected}
      title={`${provider} · ${w.label} · ${doing}${w.lane !== w.root ? `\n${w.lane}` : ''}${w.prompt ? `\n${w.prompt.slice(0, 240)}` : ''}`}
      disabled={leaving}
      onClick={onOpen}
    >
      {w.mark && (
        <span className="floor-mark" aria-hidden="true">
          {markSymbol[w.mark]}
        </span>
      )}
      <span className="floor-caption" aria-hidden="true">
        {doing}
      </span>
      <span className={`floor-sprite ${left ? 'faces-left' : ''}`}>
        <PixelWorker provider={w.provider} identity={w.identity} />
      </span>
      <small className="floor-name">{w.label}</small>
    </button>
  );
}
