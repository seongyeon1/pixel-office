import { useEffect, useRef, useState } from 'react';
import {
  Armchair,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Folder,
  History,
  LayoutGrid,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  Plus,
  Settings2,
  Square,
  Terminal,
  Users,
  X,
  FileCode2,
  Radio,
  AlertCircle,
  ExternalLink,
  ArrowUp,
  Link2,
} from 'lucide-react';
import {
  activityLabels,
  defaultTeam,
  seniorityLabels,
  statusLabels,
  terminal,
  type Change,
  type Connection,
  type Mode,
  type Provider,
  type Run,
  type ProjectSummary,
  type ObservationSnapshot,
  type TeamConfig,
  type OfficeEvent,
  type Interaction,
} from '../shared/contracts';
import { api, bootstrap, ApiError } from './api';
import { applyEvent, emptyState, type OfficeState } from './state';
import { Office } from './office/Office';
import { TeamPanel } from './components/TeamPanel';
import { InteractionPanel } from './components/InteractionPanel';
import { ObservedOffice } from './components/ObservedOffice';
import { RepositoryList, repositoryName } from './components/RepositoryList';
type Project = { root: string; head: string; dirty: boolean };
type Snapshot = { run: Run; events: OfficeEvent[]; interactions: Interaction[]; sequence: number };
type Health = { providers: Record<Provider, Connection>; activeId: string | null; demo: boolean };
const providerName = (id: Provider) => (id === 'claude' ? 'Claude' : 'Codex');
function Avatar({ id, small = false }: { id: Provider; small?: boolean }) {
  return (
    <span className={`avatar ${id} ${small ? 'small' : ''}`}>{id === 'claude' ? '✳' : '⌘'}</span>
  );
}
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [booted, setBooted] = useState(false);
  const [authError, setAuthError] = useState('');
  const [error, setError] = useState('');
  const [state, setState] = useState<OfficeState>(emptyState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [runs, setRuns] = useState<Run[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [observation, setObservation] = useState<ObservationSnapshot>({
    sessions: [],
    scannedAt: null,
    scanning: false,
    warnings: [],
  });
  const [officeSource, setOfficeSource] = useState<'auto' | 'app' | 'external'>('auto');
  const [loadingProject, setLoadingProject] = useState(false);
  const projectRef = useRef<string | null>(null);
  const selectionVersion = useRef(0);
  const snapshotVersion = useRef(0);
  const [selected, setSelected] = useState<Provider>('claude');
  const [tab, setTab] = useState<'activity' | 'files'>('activity');
  const [view, setView] = useState<'office' | 'history' | 'team'>('office');
  const [modal, setModal] = useState<'project' | 'team' | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [path, setPath] = useState(() => localStorage.getItem('pixel.project') ?? '');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('collaborate');
  const [team, setTeam] = useState<TeamConfig>(defaultTeam);
  const [implementer, setImplementer] = useState<Provider>('codex');
  const [pending, setPending] = useState(false);
  const [socketStatus, setSocketStatus] = useState('');
  const [changes, setChanges] = useState<Change[]>([]);
  const [inspector, setInspector] = useState(true);
  const [zoom, setZoom] = useState(1);
  const busy =
    projects.some((p) => p.latestRun && !terminal(p.latestRun.status)) ||
    (!!state.run && !terminal(state.run.status));
  const otherActive = projects.find(
    (p) => p.root !== project?.root && p.latestRun && !terminal(p.latestRun.status),
  );
  const observedSessions = observation.sessions.filter((s) => s.projectPath === project?.root);
  const observing =
    officeSource === 'external' ||
    (officeSource === 'auto' &&
      observedSessions.length > 0 &&
      !(state.run && !terminal(state.run.status)));
  const actualTeam = state.run?.team ?? team;
  const displayedMode = state.run?.mode ?? mode;
  const displayedImplementer =
    displayedMode === 'collaborate' ? (state.run?.implementer ?? implementer) : displayedMode;
  const active = state.run && !terminal(state.run.status);
  const refreshRuns = async () => {
    const root = projectRef.current;
    const version = selectionVersion.current;
    const [list, repositories, observed] = await Promise.all([
      root ? api<Run[]>(`/runs?projectPath=${encodeURIComponent(root)}`) : Promise.resolve([]),
      api<ProjectSummary[]>('/projects'),
      api<ObservationSnapshot>('/observed'),
    ]);
    if (version !== selectionVersion.current) return;
    setRuns(list);
    setProjects(repositories);
    setObservation(observed);
  };
  const selectRun = async (id: string) => {
    const version = ++snapshotVersion.current;
    try {
      const snap = await api<Snapshot>(`/runs/${id}`);
      if (version !== snapshotVersion.current || snap.run.projectPath !== projectRef.current)
        return;
      let next = emptyState();
      next.run = snap.run;
      for (const e of snap.events) next = applyEvent(next, e);
      next.run = snap.run;
      next.interactions = snap.interactions;
      next.sequence = snap.sequence;
      for (const p of ['claude', 'codex'] as const)
        next.agents[p].waiting = snap.interactions.some((i) => i.agentId === p);
      if (terminal(snap.run.status))
        for (const a of Object.values(next.agents)) a.activity = 'idle';
      stateRef.current = next;
      setState(next);
      setChanges([]);
    } catch (e) {
      if (version === snapshotVersion.current) setError((e as Error).message);
    }
  };
  const switchProject = async (root: string, inspected?: Project) => {
    const version = ++selectionVersion.current;
    snapshotVersion.current++;
    projectRef.current = root;
    setProject(inspected ?? { root, head: '', dirty: false });
    localStorage.setItem('pixel.project', root);
    setPath(root);
    const empty = emptyState();
    stateRef.current = empty;
    setState(empty);
    setRuns([]);
    setChanges([]);
    setPrompt('');
    setSocketStatus('');
    setError('');
    setModal(null);
    setView('office');
    setOfficeSource('auto');
    setLoadingProject(true);
    try {
      const [list, metadata] = await Promise.all([
        api<Run[]>(`/runs?projectPath=${encodeURIComponent(root)}`),
        inspected
          ? Promise.resolve(inspected)
          : api<Project>('/projects/inspect', { path: root }).catch(() => null),
      ]);
      if (version !== selectionVersion.current) return;
      setRuns(list);
      if (metadata) setProject(metadata);
      else setError('레포 경로를 확인할 수 없습니다. 보관된 작업 기록은 계속 볼 수 있어요.');
      if (list[0]) await selectRun(list[0].id);
    } catch (e) {
      if (version === selectionVersion.current) setError((e as Error).message);
    } finally {
      if (version === selectionVersion.current) setLoadingProject(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await bootstrap();
        const [h, repositories, observed] = await Promise.all([
          api<Health>('/health'),
          api<ProjectSummary[]>('/projects'),
          api<ObservationSnapshot>('/observed'),
        ]);
        if (cancelled) return;
        setHealth(h);
        setProjects(repositories);
        setObservation(observed);
        const root =
          localStorage.getItem('pixel.project') ??
          repositories.find((p) => p.latestRun?.id === h.activeId)?.root ??
          observed.sessions[0]?.projectPath;
        if (root) await switchProject(root);
        if (!cancelled) setBooted(true);
      } catch (e) {
        if (!cancelled) setAuthError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (booted && !projectRef.current && observation.sessions[0])
      void switchProject(observation.sessions[0].projectPath);
  }, [booted, observation.sessions]);
  useEffect(() => {
    if (!booted) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!stopped) await refreshRuns();
      } catch (e) {
        if (!stopped && e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setAuthError('서버 연결이 만료되었습니다. 새 연결 URL로 다시 열어주세요.');
          setBooted(false);
        }
      } finally {
        if (!stopped) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [booted]);
  useEffect(() => {
    if (!state.run) return;
    const id = state.run.id;
    let ws: WebSocket;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const reconnect = async () => {
      if (stopped) return;
      try {
        const currentHealth = await api<Health>('/health');
        if (stopped) return;
        setHealth(currentHealth);
        await selectRun(id);
        if (!stopped) connect();
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          stopped = true;
          setAuthError('서버 연결이 만료되었습니다. 새 연결 URL로 다시 열어주세요.');
          setBooted(false);
        } else {
          timer = setTimeout(reconnect, Math.min(1000 * 2 ** attempts++, 10000));
        }
      }
    };
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events?runId=${id}&after=${stateRef.current.sequence}`,
      );
      ws.onopen = () => {
        attempts = 0;
        setSocketStatus('실시간 연결');
      };
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data) as OfficeEvent;
        if (stopped || event.runId !== id || stateRef.current.run?.id !== id) return;
        setState((s) => {
          if (s.run?.id !== id) return s;
          const n = applyEvent(s, event);
          stateRef.current = n;
          return n;
        });
        if (event.type === 'run.updated' || event.type === 'run.status')
          void refreshRuns().catch(() => {});
      };
      ws.onclose = () => {
        if (!stopped) {
          setSocketStatus('다시 연결하는 중');
          timer = setTimeout(reconnect, Math.min(1000 * 2 ** attempts++, 10000));
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [state.run?.id]);
  useEffect(() => {
    let cancelled = false;
    setChanges([]);
    if (tab === 'files' && state.run)
      api<Change[]>(`/runs/${state.run.id}/changes`)
        .then((files) => {
          if (!cancelled) setChanges(files);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    return () => {
      cancelled = true;
    };
  }, [tab, state.run?.id, state.run?.status]);
  useEffect(() => {
    if (!modal) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [modal]);
  const connectProject = async () => {
    setPending(true);
    setError('');
    try {
      const p = await api<Project>('/projects/inspect', {
        path,
      });
      await switchProject(p.root, p);
      await refreshRuns();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const start = async () => {
    if (!project) {
      setModal('project');
      return;
    }
    if (!prompt.trim() || loadingProject || busy) return;
    setPending(true);
    setError('');
    try {
      const run = await api<Run>('/runs', {
        projectPath: project.root,
        prompt,
        mode,
        implementer,
        team,
      });
      await selectRun(run.id);
      await refreshRuns();
      setView('office');
      setOfficeSource('app');
      setInspector(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const stop = async () => {
    if (!state.run) return;
    setPending(true);
    try {
      await api(`/runs/${state.run.id}/cancel`, {});
      await selectRun(state.run.id);
      await refreshRuns();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const newTask = () => {
    if (active) return;
    snapshotVersion.current++;
    const empty = emptyState();
    stateRef.current = empty;
    setState(empty);
    setPrompt('');
    setChanges([]);
    setView('office');
  };
  if (!booted)
    return (
      <div className="connection-screen">
        <div className="brand-mark">
          <Armchair size={30} />
        </div>
        <h1>Pixel Office</h1>
        {authError ? (
          <>
            <p>{authError}</p>
            <p className="muted">터미널에 표시된 연결 URL로 열어주세요.</p>
            <button onClick={() => location.reload()}>다시 연결</button>
          </>
        ) : (
          <p>
            <LoaderCircle className="spin" size={16} /> 사무실 문을 여는 중...
          </p>
        )}
      </div>
    );
  const selectedAgent = state.agents[selected];
  const relevant = state.events
    .filter(
      (e) =>
        e.agentId === selected &&
        ['activity', 'phase.started', 'phase.completed', 'tool.completed', 'handoff'].includes(
          e.type,
        ),
    )
    .slice(-30)
    .reverse();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('office');
          }}
        >
          <span className="brand-mark">
            <Armchair size={23} />
          </span>
          <span>
            pixel<span className="brand-light">office</span>
            <small>에이전트들의 작은 사무실</small>
          </span>
        </a>
        <button className="workspace-switch" onClick={() => setModal('project')}>
          <span className="workspace-icon">
            <Folder size={17} />
          </span>
          <span>
            {project ? repositoryName(project.root) : '내 워크스페이스'}
            <small>{project ? '프로젝트 연결됨' : '프로젝트를 연결해주세요'}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <nav aria-label="주 메뉴">
          <button className={view === 'office' ? 'active' : ''} onClick={() => setView('office')}>
            <LayoutGrid size={18} />
            오피스
            <span className="nav-dot" />
          </button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            <History size={18} />
            작업 기록<span className="count">{runs.length}</span>
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => setView('team')}>
            <Users size={18} />
            우리 팀
          </button>
        </nav>
        <div className="sidebar-section">
          <div className="section-caption">
            함께 일하는 동료 <span>2</span>
          </div>
          {(['claude', 'codex'] as const).map((id) => (
            <button
              key={id}
              className={`colleague ${selected === id ? 'selected' : ''}`}
              onClick={() => {
                setSelected(id);
                setInspector(true);
                setView('office');
              }}
              aria-label={`${providerName(id)} 선택`}
            >
              <Avatar id={id} small />
              <span>
                <strong>{providerName(id)}</strong>
                <small>
                  {observing ? '외부 세션' : seniorityLabels[actualTeam[id].seniority]} ·{' '}
                  {observing
                    ? `${observedSessions.filter((s) => s.provider === id).length}개`
                    : state.agents[id].waiting
                      ? '응답 대기'
                      : activityLabels[state.agents[id].activity]}
                </small>
              </span>
              <span className={`presence ${health?.providers[id].authenticated ? 'online' : ''}`} />
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="presence online" />
            <span>
              내 컴퓨터에서 실행 중<small>파일과 작업 기록은 로컬에 보관돼요</small>
            </span>
          </div>
          <button
            className="settings-link"
            onClick={() => {
              setView('team');
            }}
          >
            <Settings2 size={17} />팀 설정
            <ChevronRight size={15} />
          </button>
          <div className="version">
            Pixel Office <span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="repository-switch"
              aria-label="레포 전환"
              title={project?.root}
              onClick={() => setModal('project')}
            >
              <Folder size={15} />
              <span>{project ? repositoryName(project.root) : '레포 선택'}</span>
              <ChevronDown size={13} />
            </button>
            <ChevronRight size={14} />
            <strong>
              {view === 'office' ? '오피스' : view === 'history' ? '작업 기록' : '우리 팀'}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="connection-pill">
              <span className="presence online" />
              {health?.demo ? '데모' : '로컬 연결'}
            </span>
            <button
              className="icon-button"
              aria-label="팀 설정 열기"
              onClick={() => setModal('team')}
            >
              <Settings2 size={18} />
            </button>
            <span className="user-avatar">나</span>
          </div>
        </header>
        {otherActive && (
          <div className="other-repository" role="status">
            <span>
              <span className="presence working" /> {repositoryName(otherActive.root)}에서{' '}
              {statusLabels[otherActive.latestRun!.status]} · 현재 한 작업씩 실행할 수 있어요.
            </span>
            <button
              onClick={() => void switchProject(otherActive.root)}
              aria-label="진행 중인 레포로 이동"
            >
              작업 보러 가기 <ArrowUpRight size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
            <button aria-label="오류 닫기" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {view === 'office' && (
          <div className="office-source" aria-label="작업 출처">
            <button
              className={observing ? 'selected' : ''}
              onClick={() => setOfficeSource('external')}
            >
              외부 세션 {observedSessions.length}
            </button>
            <button className={!observing ? 'selected' : ''} onClick={() => setOfficeSource('app')}>
              앱 작업
            </button>
            <span>
              {observation.scanning
                ? '세션 찾는 중'
                : observation.scannedAt
                  ? `자동 감지 · ${new Date(observation.scannedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                  : '세션 탐색 준비 중'}
            </span>
            {observation.warnings.length > 0 && (
              <details>
                <summary>감지 안내</summary>
                {observation.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </details>
            )}
          </div>
        )}
        {view === 'office' && observing ? (
          <ObservedOffice
            key={project?.root ?? 'none'}
            sessions={observedSessions}
            root={project?.root ?? ''}
            selectedProvider={selected}
            onProviderChange={setSelected}
          />
        ) : view === 'office' ? (
          <main className={`office-page ${inspector ? '' : 'inspector-hidden'}`}>
            <div className="main-column">
              <div className="page-heading">
                <div>
                  <div className="overline">
                    <span className="tiny-square" />
                    {project
                      ? `${repositoryName(project.root)}의 작업 공간`
                      : '우리 팀의 작업 공간'}
                  </div>
                  <h1>
                    오늘의 오피스<span className="soft-dot">.</span>
                  </h1>
                  <p>
                    {active
                      ? '각자의 자리에서, 하나의 목표를 향해 일하고 있어요.'
                      : '아이디어를 건네면, 동료들이 함께 만들어가요.'}
                  </p>
                </div>
                <button className="subtle-button" onClick={() => setModal('team')}>
                  <Users size={16} />팀 구성
                </button>
              </div>
              <section className="office-card">
                <div className="office-toolbar">
                  <span>
                    <span className={`presence ${active ? 'working' : 'online'}`} />
                    {active ? '업무 진행 중' : '업무를 시작할 준비가 됐어요'}
                  </span>
                  <div>
                    <span className="small-tag">2명의 동료</span>
                    <button
                      className="icon-button"
                      title="상세 패널 토글"
                      aria-label="상세 패널 토글"
                      onClick={() => setInspector(!inspector)}
                    >
                      <PanelRightClose size={16} />
                    </button>
                  </div>
                </div>
                <div className="office-scene">
                  <div style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}>
                    <Office
                      agents={state.agents}
                      selected={selected}
                      team={actualTeam}
                      onSelect={(id) => {
                        setSelected(id);
                        setInspector(true);
                      }}
                    />
                  </div>
                  <div className="scene-label">
                    <span className="pixel-dot" />{' '}
                    {project ? repositoryName(project.root) : 'Pixel HQ'} <span>1F</span>
                  </div>
                  <div className="zoom-controls">
                    <button
                      aria-label="축소"
                      onClick={() => setZoom((z) => Math.max(0.8, z - 0.1))}
                    >
                      −
                    </button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button
                      aria-label="확대"
                      onClick={() => setZoom((z) => Math.min(1.2, z + 0.1))}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="office-footer">
                  <span>
                    <span className="presence online" />
                    대기
                  </span>
                  <span>
                    <span className="presence working" />
                    작업 중
                  </span>
                  <span>
                    <span className="presence waiting" />
                    응답 필요
                  </span>
                  <small>캐릭터를 눌러 작업을 살펴보세요</small>
                </div>
              </section>
              <div className="mobile-agents">
                {(['claude', 'codex'] as const).map((id) => (
                  <button
                    key={id}
                    aria-label={`${providerName(id)} 선택`}
                    className={selected === id ? 'selected' : ''}
                    onClick={() => {
                      setSelected(id);
                      setInspector(true);
                    }}
                  >
                    <Avatar id={id} small />
                    <span>
                      {providerName(id)}
                      <small>
                        {seniorityLabels[actualTeam[id].seniority]} ·{' '}
                        {state.agents[id].waiting
                          ? '응답 필요'
                          : activityLabels[state.agents[id].activity]}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <section className="task-composer">
                <div className="composer-title">
                  <MessageSquare size={17} />
                  <strong>
                    {active ? '동료들이 작업하고 있어요' : '어떤 일을 함께 해볼까요?'}
                  </strong>
                  {state.run && (
                    <button className="text-button" disabled={!!active} onClick={newTask}>
                      <Plus size={14} />새 작업
                    </button>
                  )}
                </div>
                <textarea
                  aria-label="작업 내용"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={!!active}
                  placeholder="예: 로그인 화면을 만들어줘. Codex가 구현하고 Claude가 검토해줘."
                  rows={3}
                />
                <div className="composer-bottom">
                  <button className="project-chip" onClick={() => setModal('project')}>
                    <Folder size={14} />
                    {project ? repositoryName(project.root) : '프로젝트 연결'}
                    <ChevronDown size={12} />
                  </button>
                  <select
                    aria-label="실행 방식"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as Mode)}
                    disabled={!!active}
                  >
                    <option value="collaborate">함께 협업</option>
                    <option value="codex">Codex 단독</option>
                    <option value="claude">Claude 단독</option>
                  </select>
                  {active ? (
                    <button className="stop-button" disabled={pending} onClick={() => void stop()}>
                      <Square size={13} />
                      {pending ? '중단하는 중' : '작업 중단'}
                    </button>
                  ) : (
                    <button
                      className="primary start-button"
                      disabled={pending || loadingProject || busy || !prompt.trim()}
                      onClick={() => void start()}
                    >
                      {pending ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <ArrowUp size={17} />
                      )}
                      작업 시작
                    </button>
                  )}
                </div>
                {project?.dirty && (
                  <p className="hint dirty-note">
                    커밋되지 않은 변경은 포함하지 않고, 마지막 커밋에서 새 작업을 시작해요.
                  </p>
                )}
              </section>
              {displayedMode === 'collaborate' ? (
                <section className="workflow-strip">
                  <div>
                    <span
                      className={`step-dot ${state.run?.phase === 'implement' ? 'current' : ''}`}
                    >
                      1
                    </span>
                    <span>
                      구현<small>{providerName(displayedImplementer)}</small>
                    </span>
                  </div>
                  <span className="step-line" />
                  <div>
                    <span className={`step-dot ${state.run?.phase === 'review' ? 'current' : ''}`}>
                      2
                    </span>
                    <span>
                      검토
                      <small>
                        {providerName(displayedImplementer === 'codex' ? 'claude' : 'codex')}
                      </small>
                    </span>
                  </div>
                  <span className="step-line" />
                  <div>
                    <span className={`step-dot ${state.run?.phase === 'revise' ? 'current' : ''}`}>
                      3
                    </span>
                    <span>
                      수정·완료
                      <small>{state.run ? statusLabels[state.run.status] : '함께 마무리'}</small>
                    </span>
                  </div>
                  <span className="workflow-note">서로의 결과를 이어받아요</span>
                </section>
              ) : (
                <section className="workflow-strip">
                  <span className="step-dot current">1</span>
                  <span>{providerName(displayedMode)}가 단독으로 작업해요</span>
                </section>
              )}
            </div>
            {inspector && (
              <aside className="inspector">
                <div className="inspector-heading">
                  <span>동료 살펴보기</span>
                  <button
                    className="icon-button"
                    aria-label="상세 닫기"
                    onClick={() => setInspector(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="agent-profile">
                  <Avatar id={selected} />
                  <h2>
                    {providerName(selected)}
                    <span>{seniorityLabels[actualTeam[selected].seniority]}</span>
                  </h2>
                  <p>
                    {displayedImplementer === selected
                      ? '구현과 테스트를 담당해요'
                      : displayedMode === 'collaborate'
                        ? '코드 검토와 피드백을 담당해요'
                        : '이번 작업에는 참여하지 않아요'}
                  </p>
                  <div className="agent-status">
                    <span
                      className={`presence ${selectedAgent.waiting ? 'waiting' : selectedAgent.activity === 'idle' ? 'online' : 'working'}`}
                    />
                    {selectedAgent.waiting
                      ? '응답을 기다리고 있어요'
                      : activityLabels[selectedAgent.activity]}
                  </div>
                </div>
                <dl className="agent-facts">
                  <div>
                    <dt>모델</dt>
                    <dd title={selectedAgent.model || actualTeam[selected].model}>
                      {selectedAgent.model || actualTeam[selected].model || '공급자 기본 모델'}
                    </dd>
                  </div>
                  <div>
                    <dt>연결</dt>
                    <dd className={health?.providers[selected].authenticated ? 'green-text' : ''}>
                      {health?.providers[selected].authenticated ? '연결됨' : '설정 필요'}
                    </dd>
                  </div>
                  <div>
                    <dt>현재 업무</dt>
                    <dd>{selectedAgent.tool || '새 작업 기다리기'}</dd>
                  </div>
                </dl>
                {!health?.providers[selected].authenticated && (
                  <p className="connection-warning">{health?.providers[selected].detail}</p>
                )}
                <div className="inspector-tabs">
                  <button
                    className={tab === 'activity' ? 'active' : ''}
                    onClick={() => setTab('activity')}
                  >
                    <Radio size={14} />
                    활동
                  </button>
                  <button
                    className={tab === 'files' ? 'active' : ''}
                    onClick={() => setTab('files')}
                  >
                    <FileCode2 size={14} />
                    변경 파일
                  </button>
                </div>
                <div className="inspector-content">
                  {state.interactions
                    .filter((i) => i.agentId === selected)
                    .map((req) => (
                      <InteractionPanel
                        key={req.id}
                        request={req}
                        onAnswer={async (a) => {
                          await api(`/interactions/${req.id}/answer`, a);
                        }}
                      />
                    ))}
                  {tab === 'activity' ? (
                    <>
                      {state.run && (
                        <div className="current-task">
                          <span>지금 맡은 일</span>
                          <p>{state.run.prompt}</p>
                          <small>{socketStatus || statusLabels[state.run.status]}</small>
                        </div>
                      )}
                      {selectedAgent.text && (
                        <div className="agent-output">
                          <div>
                            <MessageSquare size={13} />
                            작업 메시지
                          </div>
                          <pre>{selectedAgent.text}</pre>
                        </div>
                      )}
                      {relevant.length ? (
                        <div className="activity-list">
                          {relevant.map((e) => (
                            <div className="activity-item" key={e.eventId}>
                              <span className="activity-node" />
                              <div>
                                <strong>
                                  {e.type === 'phase.started'
                                    ? '업무를 시작했어요'
                                    : e.type === 'phase.completed'
                                      ? '업무를 마쳤어요'
                                      : e.type === 'handoff'
                                        ? '결과를 전달했어요'
                                        : e.type === 'tool.completed'
                                          ? '도구 실행 완료'
                                          : String(e.payload.tool ?? '작업 중')}
                                </strong>
                                <small>
                                  {new Date(e.timestamp).toLocaleTimeString('ko-KR', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </small>
                                <details>
                                  <summary>내용 보기</summary>
                                  <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                                </details>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-activity">
                          <span className="empty-icon">
                            <Armchair size={27} />
                          </span>
                          <strong>자리를 준비했어요</strong>
                          <p>
                            작업을 맡기면 이곳에서
                            <br />
                            진행 상황을 볼 수 있어요.
                          </p>
                        </div>
                      )}
                      {state.run && terminal(state.run.status) && (
                        <div
                          className={`run-result ${state.run.status === 'completed' ? 'success' : ''}`}
                        >
                          <strong>{statusLabels[state.run.status]}</strong>
                          <p>
                            {state.run.error ||
                              state.run.summary ||
                              '작업 기록과 변경 파일을 확인해 주세요.'}
                          </p>
                          <details>
                            <summary>작업 폴더·브랜치</summary>
                            <code>
                              {state.run.worktreePath}
                              <br />
                              {state.run.branch}
                            </code>
                          </details>
                        </div>
                      )}
                    </>
                  ) : changes.length ? (
                    changes.map((c) => (
                      <details className="file-change" key={c.path}>
                        <summary>
                          <FileCode2 size={14} />
                          {c.path}
                        </summary>
                        <pre>{c.diff}</pre>
                        {c.truncated && <small>일부 내용만 표시합니다.</small>}
                      </details>
                    ))
                  ) : (
                    <div className="empty-activity">
                      <FileCode2 size={25} />
                      <strong>변경 파일이 없어요</strong>
                      <p>작업에서 수정한 파일이 여기에 표시돼요.</p>
                    </div>
                  )}
                </div>
                <div className="inspector-bottom">
                  <span className="presence online" />
                  실제 실행 상태를 보여드려요
                </div>
              </aside>
            )}
          </main>
        ) : view === 'team' ? (
          <main className="secondary-page">
            <div className="page-heading">
              <div>
                <h1>우리 팀</h1>
                <p>동료마다 잘 맞는 모델과 역할을 정해주세요.</p>
              </div>
            </div>
            <TeamPanel
              team={team}
              onChange={setTeam}
              implementer={implementer}
              onRoleChange={setImplementer}
              disabled={busy}
            />
            <button className="primary" onClick={() => setView('office')}>
              <Check size={16} />
              오피스로 돌아가기
            </button>
          </main>
        ) : (
          <main className="secondary-page">
            <div className="page-heading">
              <div>
                <h1>작업 기록</h1>
                <p>
                  {project
                    ? `${repositoryName(project.root)}의 최근 작업 ${runs.length}개를 보여드려요.`
                    : '레포를 선택하면 해당 작업 기록을 볼 수 있어요.'}
                </p>
              </div>
            </div>
            {runs.length ? (
              <div className="history-list">
                {runs.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      void selectRun(r.id);
                      setOfficeSource('app');
                      setView('office');
                      setInspector(true);
                    }}
                  >
                    <span className={`history-icon ${r.status === 'completed' ? 'done' : ''}`}>
                      {r.status === 'completed' ? <Check size={19} /> : <Code2 size={19} />}
                    </span>
                    <span>
                      <strong>{r.prompt}</strong>
                      <small>
                        {repositoryName(r.projectPath)} ·{' '}
                        {new Date(r.createdAt).toLocaleString('ko-KR')}
                      </small>
                    </span>
                    <span className="history-status">{statusLabels[r.status]}</span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-history">
                <History size={38} />
                <h2>첫 작업을 기다리고 있어요</h2>
                <p>프로젝트를 연결하고 팀에게 일을 맡겨보세요.</p>
                <button className="primary" onClick={() => setView('office')}>
                  오피스로 이동
                </button>
              </div>
            )}
          </main>
        )}
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={modal === 'project' ? '프로젝트 연결' : '팀 구성'}
            className="modal"
          >
            <div className="modal-heading">
              <h2>{modal === 'project' ? '어디에서 일할까요?' : '함께 일할 팀 구성'}</h2>
              <button
                className="icon-button"
                aria-label="대화상자 닫기"
                onClick={() => setModal(null)}
              >
                <X size={19} />
              </button>
            </div>
            {modal === 'project' ? (
              <>
                <RepositoryList
                  projects={projects}
                  selected={project?.root}
                  onSelect={(root) => void switchProject(root)}
                />
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connectProject();
                  }}
                >
                  <p className="muted">새 레포를 연결하려면 Git 프로젝트 경로를 입력해주세요.</p>
                  <label>
                    프로젝트 경로
                    <input
                      autoFocus
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="/Users/me/projects/my-app"
                    />
                  </label>
                  <p className="hint">
                    마지막 커밋을 기준으로 별도 작업 폴더를 만들어요. 기존 파일과 브랜치는 그대로
                    보관돼요.
                  </p>
                  {error && <p className="inline-error">{error}</p>}
                  <button className="primary full" disabled={pending || !path.trim()}>
                    {pending ? <LoaderCircle size={16} className="spin" /> : <Link2 size={16} />}
                    프로젝트 연결
                  </button>
                </form>
              </>
            ) : (
              <>
                <TeamPanel
                  team={team}
                  onChange={setTeam}
                  implementer={implementer}
                  onRoleChange={setImplementer}
                  disabled={busy}
                />
                <button className="primary full" onClick={() => setModal(null)}>
                  설정 완료
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
