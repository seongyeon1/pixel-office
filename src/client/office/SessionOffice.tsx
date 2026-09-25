import { useEffect, useState } from 'react';
import { PixelWorker } from './PixelWorker';
import { ChevronLeft, ChevronRight, MessageCircle } from 'lucide-react';
import { activityLabels, type ChatMessage, type ObservedSession } from '../../shared/contracts';
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
                <PixelWorker provider={s.provider} identity={s.sessionId} />
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
