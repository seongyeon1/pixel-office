import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, MessageCircle } from 'lucide-react';
import { activityLabels, type ChatMessage, type ObservedSession } from '../../shared/contracts';
const providerName = (s: ObservedSession) => (s.provider === 'codex' ? 'Codex' : 'Claude');
export function PixelWorker({ provider }: { provider: ObservedSession['provider'] }) {
  return (
    <svg
      viewBox="0 0 80 86"
      aria-hidden="true"
      className={`pixel-worker ${provider}`}
      shapeRendering="crispEdges"
    >
      <ellipse cx="40" cy="78" rx="23" ry="5" fill="#58644a" opacity=".16" />
      <path
        d="M25 10h30v5h5v24h-5v8H25v-8h-5V15h5z"
        fill={provider === 'claude' ? '#624a36' : '#384a50'}
      />
      <path d="M25 22h30v19h-5v7H30v-7h-5z" fill="#f0c59c" />
      <path d="M29 29h5v5h-5zm17 0h5v5h-5z" fill="#333e3f" />
      <path d="M36 39h8v3h-8z" fill="#b87967" />
      <path d="M25 48h30v7h6v17H19V55h6z" fill={provider === 'claude' ? '#c67753' : '#537e80'} />
      <path d="M35 48h10v10H35z" fill="#f4ecdc" />
      <path d="M19 59h7v11h-7zm35 0h7v11h-7z" fill="#edbe98" />
      <path d="M27 71h11v9H24v-5h3zm15 0h11v4h3v5H42z" fill="#3f4948" />
    </svg>
  );
}
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
  const [page, setPage] = useState(0);
  const index = sessions.findIndex((s) => s.id === selected?.id);
  useEffect(() => {
    if (index >= 0) setPage(Math.floor(index / 8));
  }, [selected?.id]);
  const pages = Math.max(1, Math.ceil(sessions.length / 8));
  const safePage = Math.min(page, pages - 1);
  const shown = sessions.slice(safePage * 8, safePage * 8 + 8);
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
        <div className="session-desks">
          {shown.map((s) => (
            <button
              key={s.id}
              className={`session-desk ${s.status} ${s.id === selected?.id ? 'selected' : ''}`}
              aria-label={`캐릭터 ${providerName(s)} ${s.sessionId}`}
              aria-pressed={s.id === selected?.id}
              onClick={() => onSelect(s)}
            >
              <span className="desk-activity">
                {s.status === 'active'
                  ? activityLabels[s.activity]
                  : s.status === 'idle'
                    ? '응답 완료'
                    : '최근 활동 확인'}
              </span>
              <div className="desk-art">
                <PixelWorker provider={s.provider} />
                <span className="pixel-monitor">
                  <i />
                </span>
                <span className="pixel-table" />
              </div>
              <strong>
                {providerName(s)} <small>{s.label || s.sessionId.slice(0, 8)}</small>
              </strong>
            </button>
          ))}
          {!shown.length && (
            <p className="observed-note">이 레포에서 발견한 세션이 책상에 표시됩니다.</p>
          )}
        </div>
      </div>
      <div className="session-office-bottom">
        <span>동료를 선택해 작업과 대화를 확인하세요.</span>
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
