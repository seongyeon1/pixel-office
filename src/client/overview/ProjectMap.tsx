import { useMemo, useState, type CSSProperties } from 'react';
import { ArrowUpRight, FolderPlus, Map, Search } from 'lucide-react';
import {
  type ObservationSnapshot,
  type ProjectSummary,
  statusLabels,
} from '../../shared/contracts';
import { PixelWorker } from '../office/PixelWorker';
import { repositoryName } from '../components/RepositoryList';
import { projectRooms, type ProjectWorker, type ProjectRoom } from './projects';
import './project-map.css';
import { RetiredSessions } from '../components/RetiredSessions';
const providerName = (worker: ProjectWorker) => (worker.provider === 'codex' ? 'Codex' : 'Claude');
function Room({
  room,
  onOpen,
}: {
  room: ProjectRoom;
  onOpen: (root: string, worker?: ProjectWorker) => void;
}) {
  const shown = room.workers.slice(0, 4);
  return (
    <article
      className={`project-map-room ${room.activeCount ? 'has-activity' : ''}`}
      aria-label={`프로젝트 공간 ${room.root}`}
    >
      <header>
        <button
          className="project-room-door"
          aria-label={`프로젝트 열기 ${room.root}`}
          onClick={() => onOpen(room.root)}
        >
          <strong>{repositoryName(room.root)}</strong>
          <ArrowUpRight size={17} />
        </button>
        <span className={`room-presence ${room.waitingCount ? 'waiting' : ''}`}>
          {room.waitingCount
            ? `응답 필요 ${room.waitingCount}`
            : room.activeCount
              ? `활동 ${room.activeCount}명`
              : '대기 중'}
        </span>
        <p title={room.root} aria-label={room.root}>
          {room.pathLabel}
        </p>
      </header>
      <div className="project-mini-office" aria-label={`${repositoryName(room.root)}의 동료`}>
        <div className="project-room-wall" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="project-mini-station"
            style={{ '--seat': index } as CSSProperties}
            aria-hidden="true"
          >
            <i className="project-monitor" />
            <i className="project-desk" />
            <i className="project-sofa" />
          </div>
        ))}
        {shown.map((worker, index) => (
          <button
            key={worker.id}
            className={`project-map-worker ${worker.active ? 'working' : 'resting'} ${worker.waiting ? 'waiting' : ''}`}
            data-status={worker.stale ? 'stale' : worker.active ? 'active' : 'idle'}
            style={{ '--seat': index } as CSSProperties}
            aria-label={`전체 맵 동료 ${room.root} ${worker.session?.sessionId ?? worker.run?.id}`}
            title={`${providerName(worker)} · ${worker.label} · ${worker.caption}${worker.prompt ? `\n${worker.prompt.slice(0, 240)}` : ''}`}
            onClick={() => onOpen(room.root, worker)}
          >
            <span className="project-worker-caption">{worker.caption}</span>
            <PixelWorker provider={worker.provider} identity={worker.identity} />
            <strong>{providerName(worker)}</strong>
            <small>{worker.label}</small>
          </button>
        ))}
        {!shown.length && <div className="project-room-empty">지금 감지된 동료가 없어요.</div>}
      </div>
      <footer>
        <span>
          외부 {room.observedCount}명
          {room.latestRun && <small>앱 작업 · {statusLabels[room.latestRun.status]}</small>}
          {room.staleCount > 0 && <small>상태 확인 필요 {room.staleCount}명</small>}
        </span>
        <button
          onClick={() => onOpen(room.root)}
          aria-label={`프로젝트 동료 모두 보기 ${room.root}`}
        >
          {room.workers.length > 4 ? `+${room.workers.length - 4}명 더 보기` : '오피스 들어가기'}
          <ArrowUpRight size={14} />
        </button>
      </footer>
    </article>
  );
}
export function ProjectMap({
  projects,
  observation,
  onOpen,
  onConnect,
  onRestore,
}: {
  projects: ProjectSummary[];
  observation: ObservationSnapshot;
  onOpen: (root: string, worker?: ProjectWorker) => void;
  onConnect: () => void;
  onRestore: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const rooms = useMemo(
    () => projectRooms(projects, observation.sessions),
    [projects, observation.sessions],
  );
  const visible = rooms.filter(
    (room) =>
      (!onlyActive || room.activeCount > 0) &&
      room.root.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const activeProjects = rooms.filter((room) => room.activeCount > 0).length;
  const activeWorkers = rooms.reduce((sum, room) => sum + room.activeCount, 0);
  return (
    <main className="project-map-page">
      <div className="project-map-heading">
        <div>
          <h1>전체 프로젝트 맵</h1>
          <p>여러 폴더에서 일하는 동료를 한곳에서 살펴보세요.</p>
        </div>
        <button onClick={onConnect}>
          <FolderPlus size={17} />
          프로젝트 연결
        </button>
      </div>
      <div className="project-map-summary" aria-label="전체 프로젝트 현황">
        <span>
          프로젝트 <strong>{rooms.length}</strong>
        </span>
        <span>
          활동 중인 프로젝트 <strong>{activeProjects}</strong>
        </span>
        <span>
          진행 중인 동료 <strong>{activeWorkers}</strong>
        </span>
        <small>
          {observation.scanning
            ? '세션 찾는 중…'
            : observation.scannedAt
              ? `${new Date(observation.scannedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 관측`
              : '관측 준비 중'}
        </small>
      </div>
      <div className="project-map-controls">
        <label className="project-map-search">
          <Search size={17} />
          <input
            aria-label="전체 맵 프로젝트 검색"
            placeholder="프로젝트 이름이나 경로 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="project-map-filter">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          활동 있는 프로젝트만
        </label>
        <span>{visible.length}개 공간</span>
      </div>
      {observation.warnings.length > 0 && (
        <details className="project-map-warnings">
          <summary>세션 감지 안내</summary>
          {observation.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </details>
      )}
      {visible.length ? (
        <section className="project-campus" aria-label="프로젝트 통합 맵">
          {visible.map((room) => (
            <Room key={room.root} room={room} onOpen={onOpen} />
          ))}
        </section>
      ) : (
        <section className="project-map-empty">
          <Map size={32} />
          <h2>
            {rooms.length ? '조건에 맞는 프로젝트가 없어요' : '프로젝트를 연결해 맵을 채워보세요'}
          </h2>
          <p>
            {rooms.length
              ? '검색어나 활동 필터를 바꾸면 다른 공간도 볼 수 있어요.'
              : '연결한 폴더와 자동 감지된 에이전트 세션이 여기에 모입니다.'}
          </p>
          {!rooms.length && <button onClick={onConnect}>프로젝트 연결</button>}
        </section>
      )}
      <RetiredSessions sessions={observation.retired ?? []} onRestore={onRestore} />
      <p className="project-map-note">
        캐릭터를 누르면 해당 동료의 작업을 엽니다. 각 공간에는 응답이 필요한 동료와 활동 중인
        동료부터 최대 4명을 표시합니다.
      </p>
    </main>
  );
}
