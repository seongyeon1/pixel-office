import { useMemo, useState } from 'react';
import { FolderPlus, Map, Search } from 'lucide-react';
import type { ObservationSnapshot, ProjectSummary } from '../../shared/contracts';
import { repositoryName } from '../components/RepositoryList';
import { projectRooms, withFamily, type ProjectWorker } from './projects';
import { compareFamilies, type ModelFamily } from '../models/family';
import './project-map.css';
import { RetiredSessions } from '../components/RetiredSessions';
import { FloorMap } from '../floor/FloorMap';
import { markSeen, useSeenReports } from '../floor/seen';
import { useClock } from '../floor/clock';
const since = (iso: string, now: number) => {
  const min = Math.max(1, Math.round((now - Date.parse(iso)) / 60000));
  return min < 60
    ? `${min}분 전`
    : min < 1440
      ? `${Math.round(min / 60)}시간 전`
      : `${Math.round(min / 1440)}일 전`;
};
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
  const [family, setFamily] = useState('');
  const clock = useClock();
  const seen = useSeenReports();
  const rooms = useMemo(
    () => projectRooms(projects, observation.sessions, { now: clock, seen }),
    [projects, observation.sessions, clock, seen],
  );
  const needle = query.trim().toLocaleLowerCase();
  const families = useMemo(() => {
    const seen = new globalThis.Map<string, { family: ModelFamily; count: number }>();
    for (const w of rooms.flatMap((r) => r.workers)) {
      const hit = seen.get(w.family.key) ?? { family: w.family, count: 0 };
      hit.count++;
      seen.set(w.family.key, hit);
    }
    return [...seen.values()].sort((a, b) => compareFamilies(a.family, b.family));
  }, [rooms]);
  // A family whose last coworker went home stops filtering instead of emptying the floor.
  const activeFamily = families.some((f) => f.family.key === family) ? family : '';
  const visible = useMemo(
    () =>
      withFamily(rooms, activeFamily).filter(
        (room) =>
          (!onlyActive || room.activeCount > 0) && room.root.toLocaleLowerCase().includes(needle),
      ),
    [rooms, activeFamily, onlyActive, needle],
  );
  const roster = useMemo(() => rooms.flatMap((r) => r.workers.map((w) => w.id)), [rooms]);
  const onDuty = roster.length;
  const waiting = rooms.reduce((sum, room) => sum + room.waitingCount, 0);
  const reports = rooms.reduce((sum, room) => sum + room.reportCount, 0);
  const departed = visible
    .flatMap((room) => room.offDuty)
    .filter((w) => w.session && clock - Date.parse(w.updatedAt) < 86400000)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = (root: string, worker?: ProjectWorker) => {
    if (worker?.session) markSeen(worker.session);
    onOpen(root, worker);
  };
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
          근무 중 <strong>{onDuty}</strong>
        </span>
        <span className={waiting ? 'summary-waiting' : ''}>
          응답 필요 <strong>{waiting}</strong>
        </span>
        <span className={reports ? 'summary-report' : ''}>
          보고 <strong>{reports}</strong>
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
        <select
          className="project-map-model"
          aria-label="모델로 동료 거르기"
          value={activeFamily}
          onChange={(e) => setFamily(e.target.value)}
        >
          <option value="">모든 모델</option>
          {families.map(({ family: f, count }) => (
            <option key={f.key} value={f.key}>
              {f.provider === 'codex' ? 'Codex' : 'Claude'} · {f.label} ({count})
            </option>
          ))}
        </select>
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
        <FloorMap
          rooms={visible}
          roster={roster}
          ready={!!observation.scannedAt}
          clock={clock}
          onOpen={open}
          onOpenRoom={(root) => onOpen(root)}
        />
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
      <p className="project-map-legend">
        <span className="legend-mark question">?</span> 질문이나 승인을 기다려요
        <span className="legend-mark guess">?</span> 승인 대기로 보여요
        <span className="legend-mark report">!</span> 작업을 끝내고 보고가 있어요 · 캐릭터를 누르면
        해당 동료의 작업을 엽니다.
      </p>
      {departed.length > 0 && (
        <details className="departed-list">
          <summary>최근 퇴근 {departed.length}명</summary>
          <p>
            30분 넘게 활동이 없거나 터미널이 닫힌 동료예요. 다시 일을 시작하면 자동으로 출근해요.
          </p>
          <ul>
            {departed.slice(0, 12).map((w) => (
              <li key={w.id}>
                <button
                  aria-label={`퇴근한 동료 ${w.root} ${w.session!.sessionId}`}
                  onClick={() => open(w.root, w)}
                >
                  <strong>
                    {w.provider === 'codex' ? 'Codex' : 'Claude'} · {w.label}
                  </strong>
                  <span>{repositoryName(w.root)}</span>
                  <small>{since(w.updatedAt, clock)}</small>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <RetiredSessions sessions={observation.retired ?? []} onRestore={onRestore} />
    </main>
  );
}
