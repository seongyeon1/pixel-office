import { useEffect, useState } from 'react';
import { PixelWorker } from './PixelWorker';
import { activityLabels, type ObservedSession } from '../../shared/contracts';
import { zoneLabels, type OfficeZone } from './movement';
import type { WorkerMark } from '../overview/projects';
export function WalkingWorker({
  session: s,
  target,
  selected,
  mark = null,
  onSelect,
}: {
  session: ObservedSession;
  mark?: WorkerMark;
  target: { x: number; y: number; zone: OfficeZone };
  selected: boolean;
  onSelect: () => void;
}) {
  const [position, setPosition] = useState(target);
  const [walking, setWalking] = useState(false);
  const [left, setLeft] = useState(false);
  useEffect(() => {
    if (position.x === target.x && position.y === target.y) return;
    setLeft(target.x < position.x);
    setPosition(target);
    setWalking(!matchMedia('(prefers-reduced-motion: reduce)').matches);
    const timer = setTimeout(() => setWalking(false), 1850);
    return () => clearTimeout(timer);
  }, [target.x, target.y]);
  const name = s.provider === 'codex' ? 'Codex' : 'Claude';
  const activity =
    s.status === 'active'
      ? activityLabels[s.activity]
      : s.status === 'idle'
        ? '응답 완료'
        : '상태 확인 필요';
  return (
    <button
      className={`map-worker session-desk ${s.status} ${selected ? 'selected' : ''} ${walking ? 'walking' : ''}`}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      data-zone={target.zone}
      data-moving={walking}
      data-mark={mark ?? undefined}
      aria-label={`캐릭터 ${name} ${s.sessionId}`}
      aria-pressed={selected}
      title={`${name} · ${s.label || s.sessionId} · ${activity} · ${zoneLabels[target.zone]}`}
      onClick={onSelect}
    >
      <span className={`worker-bubble ${s.status}`} aria-hidden="true">
        {activity}
        {s.status === 'active' && <i className="bubble-dots" />}
      </span>
      {mark && (
        <span
          className={`worker-mark ${mark} ${s.attention && !s.attention.certain ? 'guess' : ''}`}
          aria-hidden="true"
        >
          {mark === 'report' ? '!' : '?'}
        </span>
      )}
      <strong className="worker-name">
        {name}
        <small>{s.label || s.sessionId.slice(0, 8)}</small>
      </strong>
      <span className={`map-worker-art ${walking && left ? 'faces-left' : ''}`}>
        <PixelWorker provider={s.provider} identity={s.sessionId} />
      </span>
    </button>
  );
}
