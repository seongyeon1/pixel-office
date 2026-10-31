import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  Activity as ActivityIcon,
  FileCode2,
  Radio,
  Search,
  TerminalSquare,
  LogOut,
  ScrollText,
  Users,
  PanelLeftClose,
  Columns2,
  X,
  ChevronDown,
} from 'lucide-react';
import {
  activityLabels,
  type ChatMessage,
  type ObservedDetail,
  type ObservedEvent,
  type ObservedSession,
  type Provider,
  type RetiredSession,
  type Run,
  terminal,
} from '../../shared/contracts';
import { api } from '../api';
import { TaskDocumentButton } from '../workspace/TaskDocumentButton';
import { SessionOffice } from '../office/SessionOffice';
import { markSeen } from '../floor/seen';
import { compareFamilies, modelFamily, type ModelFamily } from '../models/family';
import { PixelWorker } from '../office/PixelWorker';
import { SessionChat } from './SessionChat';
import { RetiredSessions } from './RetiredSessions';
import { repositoryName } from './RepositoryList';
import {
  TerminalHookHint,
  TerminalQuestionCard,
  useTerminalHook,
  useTerminalQuestions,
} from './TerminalQuestion';
export const observedStatus = {
  active: '활동 관측',
  idle: '응답 완료·대기',
  stale: '상태 확인 필요',
};
const name = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude');
const eventTitle = (e: ObservedEvent) =>
  e.kind === 'tool' ? `${activityLabels[e.activity]} · ${e.title}` : e.title;
const eventSummary = (e: ObservedEvent) =>
  e.kind === 'tool' && (e.detail.length > 180 || e.detail.includes('\n'))
    ? '세부 실행 내용은 작업 내역에서 펼쳐볼 수 있어요.'
    : e.detail;
const clock = (value: string) =>
  value
    ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '기록 대기';
export function ObservedOffice({
  sessions,
  root,
  selectedProvider,
  initialSessionId,
  onProviderChange,
  onResume,
  onRetire,
  retired,
  onRestore,
  automatedCount = 0,
  onRecords,
  run,
  runFocus,
  onFocusRun,
  onFocusSession,
  appComposer,
  appInspector,
  appAgents,
  workspace,
  onTeam,
}: {
  run?: Run | null;
  // True while the inspector shows the app run's coworker instead of an observed session.
  runFocus: boolean;
  onFocusRun: (provider: Provider) => void;
  onFocusSession: () => void;
  appComposer: (
    session: ObservedSession | undefined,
    onSent: () => void,
    onCompose: () => void,
  ) => ReactNode;
  appInspector: ReactNode;
  appAgents: ReactNode;
  workspace?: ReactNode;
  onTeam: () => void;
  automatedCount?: number;
  onRecords?: () => void;
  sessions: ObservedSession[];
  root: string;
  selectedProvider: Provider;
  initialSessionId?: string;
  onProviderChange: (id: Provider) => void;
  onResume: (session: ObservedSession) => void;
  onRetire: (id: string) => Promise<void>;
  retired: RetiredSession[];
  onRestore: (id: string) => Promise<void>;
}) {
  const [officeOpen, setOfficeOpen] = useState(
    () => localStorage.getItem('pixel.officeOpen') === 'true',
  );
  const [pinnedId, setPinnedId] = useState<string>();
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const pinned = sessions.find((s) => s.id === pinnedId);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  const [detail, setDetail] = useState<ObservedDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'summary' | 'history' | 'chat'>('chat');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [reply, setReply] = useState<ChatMessage>();
  const [retiring, setRetiring] = useState<string>();
  const [retirePending, setRetirePending] = useState(false);
  const [retireError, setRetireError] = useState('');
  const terminalQuestions = useTerminalQuestions();
  const terminalHook = useTerminalHook();
  const retire = async (id: string) => {
    setRetirePending(true);
    setRetireError('');
    try {
      await onRetire(id);
      setRetiring(undefined);
    } catch (e) {
      setRetireError((e as Error).message);
    } finally {
      setRetirePending(false);
    }
  };
  useEffect(() => {
    const initial =
      sessions.find((s) => s.id === initialSessionId) ??
      sessions.find((s) => s.status === 'active') ??
      sessions[0];
    // A live app run takes the inspector first, unless a specific session was asked for.
    if (run && !initialSessionId) onFocusRun(selectedProvider);
    else if (initial) {
      setSelectedId(initial.id);
      onProviderChange(initial.provider);
    }
  }, []);
  useEffect(() => {
    const target = sessions.find((s) => s.id === initialSessionId);
    if (target) {
      setSelectedId(target.id);
      onProviderChange(target.provider);
      onFocusSession();
    }
  }, [initialSessionId, sessions.some((s) => s.id === initialSessionId)]);
  const preferred =
    sessions.find((s) => s.provider === selectedProvider && s.status === 'active') ??
    sessions.find((s) => s.provider === selectedProvider) ??
    sessions[0];
  const selected =
    sessions.find((s) => s.id === selectedId && s.provider === selectedProvider) ?? preferred;
  // Only a coworker the person picked counts as read; the automatic fallback does not.
  const picked = !runFocus && selected?.id === selectedId ? selected : undefined;
  useEffect(() => {
    if (picked) markSeen(picked);
  }, [picked?.id, picked?.updatedAt]);
  const openChat = () => {
    setTab('chat');
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.work-composer textarea')?.focus(),
    );
  };
  const choose = (s: ObservedSession) => {
    setSelectedId(s.id);
    onProviderChange(s.provider);
    onFocusSession();
    setNavigatorOpen(false);
    setTab('chat');
  };
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(null);
    setError('');
    setReply(undefined);
    if (!selected) return;
    const poll = async () => {
      try {
        const next = await api<ObservedDetail>(`/observed/${selected.id}`);
        if (!stopped) {
          setDetail(next);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected?.id]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (
        e.isComposing ||
        !(e.metaKey || e.ctrlKey) ||
        !e.altKey ||
        !['ArrowUp', 'ArrowDown'].includes(e.key)
      )
        return;
      if (!sessions.length) return;
      e.preventDefault();
      const index = sessions.findIndex((s) => s.id === selected?.id);
      choose(
        sessions[(index + (e.key === 'ArrowDown' ? 1 : -1) + sessions.length) % sessions.length],
      );
    };
    addEventListener('keydown', shortcut);
    return () => removeEventListener('keydown', shortcut);
  }, [sessions, selected?.id]);
  const current = detail?.id === selected?.id ? detail : null;
  const events = current?.events ?? [];
  const latest = events.filter((e) => e.kind !== 'result').at(-1);
  const visible = sessions.filter(
    (s) =>
      (filter === 'all' || s.status === filter) &&
      `${s.provider} ${s.sessionId} ${s.label} ${s.prompt} ${s.model} ${modelFamily(s.provider, s.model).label}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  // Grouped by model family in the stated display order; within a family, newest first as before.
  const groups = Object.values(
    visible.reduce<Record<string, { family: ModelFamily; items: ObservedSession[] }>>((acc, s) => {
      const family = modelFamily(s.provider, s.model);
      (acc[family.key] ??= { family, items: [] }).items.push(s);
      return acc;
    }, {}),
  ).sort((a, b) => compareFamilies(a.family, b.family));
  return (
    <main
      className={`office-page observed-page workbench ${navigatorOpen ? 'navigator-open' : ''}`}
    >
      <aside className="work-navigator" aria-label="작업 세션 목록">
        <div className="work-navigator-heading">
          <strong>작업 세션</strong>
          <small title="⌘/Ctrl+Alt+↑↓ 세션 전환">⌥ ↑ ↓</small>
        </div>
        {run && (
          <button
            className={`run-session-item ${runFocus ? 'selected' : ''}`}
            onClick={() => onFocusRun(selectedProvider)}
          >
            <span className={`presence ${terminal(run.status) ? 'online' : 'working'}`} />
            <span>
              <strong>앱 작업</strong>
              <span>{run.prompt}</span>
            </span>
          </button>
        )}
        <div className="session-list-heading">
          <h2>
            동료 <small>{sessions.length}</small>
          </h2>
          <select
            aria-label="세션 상태 필터"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">모든 상태</option>
            <option value="active">활동 관측</option>
            <option value="idle">응답 완료·대기</option>
            <option value="stale">상태 확인 필요</option>
          </select>
        </div>
        <label className="session-search">
          <Search size={16} />
          <input
            aria-label="세션 검색"
            placeholder="이름, 작업, 모델로 동료 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {automatedCount > 0 && onRecords && (
          <button className="automated-note" onClick={onRecords}>
            <ScrollText size={14} />이 레포의 자동 기록(업무일지·세션 요약 등) {automatedCount}건은
            자동 기록에서 볼 수 있어요
          </button>
        )}
        <section className="observed-sessions" aria-label="감지된 세션">
          {groups.map(({ family, items }) => (
            <Fragment key={family.key}>
              <h3 className="family-heading" data-provider={family.provider}>
                {name(family.provider)} · {family.label}
                {family.version && <span>{family.version}</span>}
                <small>{items.length}</small>
              </h3>
              {items.map((s) => (
                <button
                  key={s.id}
                  aria-label={`세션 선택 ${name(s.provider)} ${s.sessionId}${s.label ? ` ${s.label}` : ''}`}
                  aria-pressed={!runFocus && selected?.id === s.id}
                  className={!runFocus && selected?.id === s.id ? 'selected' : ''}
                  onClick={() => choose(s)}
                >
                  <span
                    className={`presence ${s.attention ? 'waiting' : s.status === 'active' ? 'working' : ''}`}
                  />
                  <span>
                    <strong>
                      {name(s.provider)} <small>{s.label || s.sessionId.slice(0, 8)}</small>
                      <em>
                        {s.attention
                          ? s.attention.kind === 'approval'
                            ? '승인 필요'
                            : '답변 필요'
                          : activityLabels[s.activity]}
                      </em>
                    </strong>
                    <span className="observed-prompt">
                      {s.prompt || '작업 요청이 기록되지 않은 세션'}
                    </span>
                    <small>
                      {observedStatus[s.status]} · {s.model || '모델 정보 없음'}
                    </small>
                  </span>
                  <span className="observed-time">{clock(s.updatedAt)}</span>
                </button>
              ))}
            </Fragment>
          ))}
          {!visible.length && (
            <div className="empty-history">
              <Radio size={26} />
              <h2>
                {sessions.length
                  ? '조건에 맞는 동료가 없어요'
                  : '이 레포의 외부 세션을 찾고 있어요'}
              </h2>
              <p>
                {sessions.length
                  ? '검색어나 상태 필터를 바꿔주세요.'
                  : 'Claude Code·Codex 세션의 로그가 기록되면 표시됩니다.'}
              </p>
            </div>
          )}
        </section>
        <RetiredSessions sessions={retired} onRestore={onRestore} />
      </aside>
      <section className="work-area">
        <div className="page-heading">
          <div>
            <h1>{root ? `${repositoryName(root)} 오피스` : '우리 팀 오피스'}</h1>
          </div>
          <div className="work-view-tools">
            <button
              aria-label="동료 목록 열기"
              className="navigator-toggle"
              aria-expanded={navigatorOpen}
              onClick={() => setNavigatorOpen((v) => !v)}
            >
              <PanelLeftClose size={16} />
              동료
            </button>
            {selected && !runFocus && (
              <button
                aria-label={pinnedId ? '분할 보기 닫기' : '선택한 세션 분할 보기'}
                aria-pressed={!!pinnedId}
                onClick={() => setPinnedId(pinnedId ? undefined : selected.id)}
              >
                <Columns2 size={16} />
                분할 보기
              </button>
            )}
            <button className="subtle-button" onClick={onTeam}>
              <Users size={16} />팀 구성
            </button>
          </div>
        </div>

        <div className="compact-office">
          <button
            className="office-toggle"
            aria-expanded={officeOpen}
            onClick={() => {
              setOfficeOpen((v) => {
                localStorage.setItem('pixel.officeOpen', String(!v));
                return !v;
              });
            }}
          >
            <ChevronDown size={14} />
            {officeOpen ? '사무실 접기' : '사무실 펼치기'}
            <small>
              {sessions.length}명 · {sessions.filter((s) => s.status === 'active').length}명 활동 중
            </small>
          </button>
          <div hidden={!officeOpen}>
            <SessionOffice
              root={root}
              sessions={sessions}
              run={run}
              selected={runFocus ? undefined : selected}
              selectedRunProvider={runFocus ? selectedProvider : undefined}
              onSelect={choose}
              onSelectRun={onFocusRun}
              reply={reply}
              onChat={openChat}
            />
          </div>
        </div>
        {appAgents}
        {workspace && <div className="work-dock-frame">{workspace}</div>}
        <div hidden={!!workspace} className={`work-panels ${pinned ? 'is-split' : ''}`}>
          <div className="work-primary">
            {selected && !runFocus && (
              <section className="session-task-card">
                <div className="session-identity">
                  <PixelWorker provider={selected.provider} identity={selected.sessionId} />
                  <div>
                    <strong>
                      {name(selected.provider)}{' '}
                      <small>{selected.label || selected.sessionId.slice(0, 8)}</small>
                    </strong>
                    <span>
                      <span
                        className={`presence ${selected.status === 'active' ? 'working' : ''}`}
                      />
                      {observedStatus[selected.status]} · {clock(selected.updatedAt)}
                    </span>
                  </div>
                  <span className="small-tag">
                    {selected.managed ? '앱 작업 · 세션' : '기록 · 이어가기'}
                  </span>
                </div>
                <footer>
                  <TaskDocumentButton
                    key={selected.id}
                    source={{ kind: 'session', session: selected }}
                  />
                  <div className="session-actions">
                    <button
                      className="primary"
                      disabled={selected.managed?.busy}
                      onClick={() => onResume(selected)}
                    >
                      <TerminalSquare size={14} />
                      이어서 작업
                    </button>
                    <button
                      onClick={() => {
                        setRetiring(selected.id);
                        setRetireError('');
                      }}
                    >
                      <LogOut size={14} />
                      퇴근시키기
                    </button>
                  </div>
                </footer>
                {retiring === selected.id && (
                  <div className="retire-confirm" role="group" aria-label="동료 퇴근 확인">
                    <p>
                      이 동료를 맵에서 숨기고, 앱에서 연 이어가기 터미널을 종료합니다. 기록과 작업
                      파일은 보관됩니다. 다른 터미널에서 실행 중인 원래 프로세스는 계속 동작합니다.
                    </p>
                    <button disabled={retirePending} onClick={() => void retire(selected.id)}>
                      {retirePending ? '퇴근 중…' : '퇴근 확인'}
                    </button>
                    <button disabled={retirePending} onClick={() => setRetiring(undefined)}>
                      취소
                    </button>
                    {retireError && <p role="alert">{retireError}</p>}
                  </div>
                )}
              </section>
            )}
            {runFocus || !selected ? (
              appInspector
            ) : (
              <aside className="inspector observed-inspector" aria-label="동료 살펴보기">
                {selected ? (
                  <>
                    {run && selected.managed?.runId === run.id && (
                      <button className="session-ask" onClick={() => onFocusRun(selected.provider)}>
                        앱 작업의 승인·결과 보기
                      </button>
                    )}
                    {(() => {
                      const asked = terminalQuestions.questions.find(
                        (q) => selected.provider === 'claude' && q.sessionId === selected.sessionId,
                      );
                      if (asked)
                        return (
                          <TerminalQuestionCard
                            key={asked.id}
                            question={asked}
                            onDone={terminalQuestions.refresh}
                          />
                        );
                      return selected.provider === 'claude' &&
                        selected.attention?.kind === 'question' ? (
                        <TerminalHookHint hook={terminalHook} />
                      ) : null;
                    })()}
                    <div className="session-tabs" role="tablist" aria-label="동료 상세 보기">
                      {(
                        [
                          ['summary', '요약'],
                          ['history', '작업 내역'],
                          ['chat', '대화'],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          role="tab"
                          id={`session-tab-${id}`}
                          aria-controls={`session-panel-${id}`}
                          aria-selected={tab === id}
                          onClick={() => setTab(id)}
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                              e.preventDefault();
                              const tabs = ['summary', 'history', 'chat'] as const;
                              const next =
                                tabs[(tabs.indexOf(id) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
                              setTab(next);
                              document.getElementById(`session-tab-${next}`)?.focus();
                            }
                          }}
                          tabIndex={tab === id ? 0 : -1}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {error && (
                      <p role="alert" className="inline-error">
                        {error}
                      </p>
                    )}
                    <section
                      role="tabpanel"
                      id="session-panel-summary"
                      aria-labelledby="session-tab-summary"
                      hidden={tab !== 'summary'}
                      className="observed-profile"
                    >
                      <h3>작업 요청</h3>
                      <p className="session-request">
                        {selected.prompt || '이 세션의 작업 요청을 아직 확인하지 못했어요.'}
                      </p>
                      <h3>최근 활동</h3>
                      <p>{latest ? eventTitle(latest) : '기록을 불러오고 있어요.'}</p>
                      <p className="session-latest-text">{latest ? eventSummary(latest) : ''}</p>
                      <dl>
                        <dt>모델</dt>
                        <dd>{selected.model || '로그에서 확인되지 않음'}</dd>
                        <dt>작업 폴더</dt>
                        <dd>{selected.cwd}</dd>
                        <dt>프로세스</dt>
                        <dd>
                          {selected.processAlive === true
                            ? '실행 확인'
                            : selected.processAlive === false
                              ? '종료 확인'
                              : '로그 기반 관측'}
                        </dd>
                        <dt>마지막 활동</dt>
                        <dd>
                          {selected.updatedAt
                            ? new Date(selected.updatedAt).toLocaleString('ko-KR')
                            : '기록 없음'}
                        </dd>
                        <dt>최근 기록</dt>
                        <dd>
                          {events.length}개{current?.truncated ? ' · 일부 구간만 불러옴' : ''}
                        </dd>
                      </dl>
                    </section>
                    <section
                      role="tabpanel"
                      id="session-panel-history"
                      aria-labelledby="session-tab-history"
                      hidden={tab !== 'history'}
                      className="observed-events"
                    >
                      <p className="observed-note">
                        최근 기록부터 표시해요. 도구 사용은 실행 시도이며 성공 여부를 의미하지
                        않습니다.
                      </p>
                      {current?.truncated && (
                        <p className="observed-note">큰 로그는 최근 구간만 불러왔어요.</p>
                      )}
                      {events
                        .slice()
                        .reverse()
                        .map((e) => (
                          <article key={e.id}>
                            <div>
                              {e.kind === 'tool' ? (
                                <FileCode2 size={15} />
                              ) : (
                                <ActivityIcon size={15} />
                              )}
                              <strong>{eventTitle(e)}</strong>
                              <time>{clock(e.timestamp)}</time>
                            </div>
                            {e.detail &&
                              (e.kind === 'tool' ? (
                                <>
                                  <p className="tool-preview">
                                    {eventSummary(e).slice(0, 140)}
                                    {eventSummary(e).length > 140 ? '…' : ''}
                                  </p>
                                  <details>
                                    <summary>실행 내용 보기</summary>
                                    <pre>{e.detail}</pre>
                                  </details>
                                </>
                              ) : e.detail.length > 450 ? (
                                <details>
                                  <summary>{e.detail.slice(0, 180)}…</summary>
                                  <pre>{e.detail}</pre>
                                </details>
                              ) : (
                                <p className="timeline-message">{e.detail}</p>
                              ))}
                          </article>
                        ))}
                      {!events.length && (
                        <p className="observed-note">
                          표시할 메시지와 도구 기록을 기다리고 있어요.
                        </p>
                      )}
                    </section>
                    <section
                      role="tabpanel"
                      id="session-panel-chat"
                      aria-labelledby="session-tab-chat"
                      hidden={tab !== 'chat'}
                    >
                      <SessionChat
                        key={selected.id}
                        session={selected}
                        onReply={setReply}
                        hideComposer
                      />
                    </section>
                  </>
                ) : (
                  <div className="empty-activity">
                    <p>확인할 세션을 선택해주세요.</p>
                  </div>
                )}
              </aside>
            )}
          </div>
          {pinned && (
            <aside className="work-pinned" aria-label="고정한 세션">
              <header>
                <strong>
                  {name(pinned.provider)} · {pinned.label || pinned.sessionId.slice(0, 8)}
                </strong>
                <button onClick={() => choose(pinned)}>이 세션에 지시</button>
                <button aria-label="고정한 세션 닫기" onClick={() => setPinnedId(undefined)}>
                  <X size={15} />
                </button>
              </header>
              <p className="pinned-request">{pinned.prompt}</p>
              <SessionChat key={pinned.id} session={pinned} onReply={() => {}} hideComposer />
            </aside>
          )}
        </div>
        <div className="work-input">
          {appComposer(
            runFocus ? undefined : selected,
            () => setTab('chat'),
            () => setNavigatorOpen(false),
          )}
        </div>
      </section>
    </main>
  );
}
