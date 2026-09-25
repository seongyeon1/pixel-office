import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { WalkingWorker } from './WalkingWorker';
import { sessionPositions, sessionLayout, zoneLabels, type OfficeZone } from './movement';
import { ChevronLeft, ChevronRight, MessageCircle } from 'lucide-react';
import { type ChatMessage, type ObservedSession } from '../../shared/contracts';
const providerName = (s: ObservedSession) => (s.provider === 'codex' ? 'Codex' : 'Claude');
export function SessionOffice({
  sessions,
  selected,
  onSelect,
  reply,
  onChat,
}: {
  sessions: ObservedSession[];
  selected?: ObservedSession;
  onSelect: (s: ObservedSession) => void;
  reply?: ChatMessage;
  onChat: () => void;
}) {
  const mapScroll = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const index = sessions.findIndex((s) => s.id === selected?.id);
  useEffect(() => {
    if (index >= 0) setPage(Math.floor(index / 8));
  }, [selected?.id]);
  const pages = Math.max(1, Math.ceil(sessions.length / 8));
  const safePage = Math.min(page, pages - 1);
  const shown = sessions.slice(safePage * 8, safePage * 8 + 8);
  const positions = sessionPositions(shown);
  const layout = sessionLayout(shown);
  const selectedX = selected ? positions.get(selected.id)?.x : undefined;
  useEffect(() => {
    const viewport = mapScroll.current;
    if (viewport && selectedX !== undefined)
      viewport.scrollTo({ left: Math.max(0, selectedX - viewport.clientWidth / 2 + 38) });
  }, [selected?.id, selectedX]);
  const speech =
    reply &&
    reply.sessionId === selected?.id &&
    (reply.status === 'completed' || reply.status === 'pending')
      ? reply.text || '기록을 읽고 답변을 준비하고 있어요…'
      : '';
  return (
    <section className="session-office" aria-label="세션별 픽셀 오피스">
      <div className="session-office-top">
        <span>
          <span className="presence working" />{' '}
          {sessions.filter((s) => s.status === 'active').length}명 활동 관측{' '}
          <small>· 전체 {sessions.length}명</small>
        </span>
        <span className="small-tag">세션마다 한 명</span>
      </div>
      {speech && (
        <button className="agent-speech" onClick={onChat} aria-label="말풍선 전체 답변 보기">
          <span>{providerName(selected!)} · 작업 기록 기반 답변</span>
          <strong>{speech.length > 130 ? speech.slice(0, 130) + '…' : speech}</strong>
          <MessageCircle size={16} />
        </button>
      )}
      <div className="session-room">
        <div className="room-windows" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>PIXEL OFFICE</span>
        </div>
        <div
          ref={mapScroll}
          className="session-map-scroll"
          tabIndex={0}
          aria-label="에이전트 이동 맵. 좁은 화면에서는 좌우로 스크롤하세요."
        >
          <div
            className="session-map"
            style={
              {
                height: layout.height,
                '--map-top-height': `${layout.topHeight}px`,
                '--map-bottom-height': `${layout.bottomHeight}px`,
                '--map-lower-top': `${layout.lowerTop}px`,
              } as CSSProperties
            }
          >
            {(['desk', 'library', 'test', 'lounge'] as OfficeZone[]).map((zone) => (
              <div key={zone} className={`map-zone ${zone}`} aria-hidden="true">
                <span>{zoneLabels[zone]}</span>
                <div className="map-furniture">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            ))}
            <div className="map-hallway" aria-hidden="true">
              PIXEL OFFICE
            </div>
            {shown.map((s) => (
              <WalkingWorker
                key={s.id}
                session={s}
                target={positions.get(s.id)!}
                selected={s.id === selected?.id}
                onSelect={() => onSelect(s)}
              />
            ))}
            {!shown.length && (
              <p className="map-empty">이 레포에서 발견한 동료가 이곳에 나타납니다.</p>
            )}
          </div>
        </div>
      </div>
      <div className="session-office-bottom">
        <span>관측된 활동에 따라 이동해요. 동료를 눌러 대화하세요.</span>
        {pages > 1 && (
          <nav aria-label="오피스 페이지">
            <button
              aria-label="이전 동료"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {safePage + 1} / {pages}
            </span>
            <button
              aria-label="다음 동료"
              disabled={safePage === pages - 1}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
