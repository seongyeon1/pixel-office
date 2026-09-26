import { useMemo } from 'react';
import { MessageCircle } from 'lucide-react';
import {
  type ChatMessage,
  type ObservedSession,
  type Provider,
  type Run,
  terminal,
} from '../../shared/contracts';
import { FloorMap } from '../floor/FloorMap';
import { useClock } from '../floor/clock';
import { useSeenReports } from '../floor/seen';
import { projectRooms } from '../overview/projects';
const providerName = (s: ObservedSession) => (s.provider === 'codex' ? 'Codex' : 'Claude');
// One repository as one room of the same floor the whole map uses: people keep their desks and
// only move for meetings, breaks and going home, not for every tool call.
export function SessionOffice({
  root,
  sessions,
  run,
  selected,
  selectedRunProvider,
  onSelect,
  onSelectRun,
  reply,
  onChat,
}: {
  root: string;
  sessions: ObservedSession[];
  // The app's own run in this repository; its coworkers sit on the same floor.
  run?: Run | null;
  selected?: ObservedSession;
  // Set while the inspector shows the app run's coworker of this provider.
  selectedRunProvider?: Provider;
  onSelect: (s: ObservedSession) => void;
  onSelectRun: (provider: Provider) => void;
  reply?: ChatMessage;
  onChat: () => void;
}) {
  const seen = useSeenReports();
  const clock = useClock();
  const rooms = useMemo(
    () =>
      projectRooms(
        root ? [{ root, latestRun: run ?? null, runCount: run ? 1 : 0, connected: true }] : [],
        sessions,
        { now: clock, seen },
      ).filter((r) => r.root === root),
    [root, sessions, run, clock, seen],
  );
  const live = !!run && !terminal(run.status);
  const waiting = rooms.reduce((n, r) => n + r.waitingCount, 0);
  const roster = useMemo(() => rooms.flatMap((r) => r.workers.map((w) => w.id)), [rooms]);
  const offDuty = rooms.reduce((n, r) => n + r.offDuty.length, 0);
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
          {live && <small> · 앱 작업 진행 중</small>}
        </span>
        {waiting > 0 ? (
          <span className="small-tag waiting-tag">응답 필요 {waiting}</span>
        ) : (
          <span className="small-tag">세션마다 한 명</span>
        )}
      </div>
      {speech && (
        <button className="agent-speech" onClick={onChat} aria-label="말풍선 전체 답변 보기">
          <span>{providerName(selected!)} · 작업 기록 기반 답변</span>
          <strong>{speech.length > 130 ? speech.slice(0, 130) + '…' : speech}</strong>
          <MessageCircle size={16} />
        </button>
      )}
      {rooms.length > 0 && (
        <FloorMap
          rooms={rooms}
          roster={roster}
          ready
          clock={clock}
          office
          label="에이전트 이동 맵"
          selectedId={
            selectedRunProvider
              ? rooms
                  .flatMap((r) => r.workers)
                  .find((w) => w.run && w.provider === selectedRunProvider)?.id
              : selected && `observed:${selected.id}`
          }
          nameOf={(w) =>
            w.session
              ? `캐릭터 ${providerName(w.session)} ${w.session.sessionId}`
              : `앱 동료 ${w.provider === 'codex' ? 'Codex' : 'Claude'}`
          }
          onOpen={(_root, w) => (w.session ? onSelect(w.session) : onSelectRun(w.provider))}
        />
      )}
      <div className="session-office-bottom">
        <span>
          각자 자기 책상에서 일해요. 회의·휴식·출퇴근 때만 움직이고, 동료를 누르면 대화할 수 있어요.
        </span>
        {offDuty > 0 && <span>퇴근 {offDuty}명은 아래 목록에서 볼 수 있어요.</span>}
      </div>
    </section>
  );
}
