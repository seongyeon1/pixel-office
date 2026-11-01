import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Columns2, List, Plus, Search, Terminal, X } from 'lucide-react';
import type { ObservedSession } from '../../shared/contracts';
import type { LaunchedAgent } from '../../shared/launcher';
import { api } from '../api';
import { AgentLauncher } from './AgentLauncher';
import { ResumeDock } from './SessionResume';

const TerminalPane = lazy(() =>
  import('../workspace/TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
type Tabs = { open: string[]; active: string; split?: string };
const empty: Tabs = { open: [], active: '' };
const providerName = (provider: string) => (provider === 'codex' ? 'Codex' : 'Claude');
function restore(key: string): Tabs {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      value &&
      Array.isArray(value.open) &&
      value.open.every((id: unknown) => typeof id === 'string') &&
      typeof value.active === 'string'
    )
      return {
        open: [...new Set<string>(value.open)].slice(0, 30),
        active: value.active,
        split: typeof value.split === 'string' ? value.split : undefined,
      };
  } catch {
    /* A stale layout must not prevent opening a terminal. */
  }
  return empty;
}

export function TerminalWorkbench({
  root,
  sessions,
  available,
  workspace,
  onConnect,
  onShowTerminal,
  initialSessionId,
}: {
  root: string;
  sessions: ObservedSession[];
  available: boolean;
  workspace?: ReactNode;
  onConnect: () => void;
  onShowTerminal: () => void;
  initialSessionId?: string;
}) {
  const storageKey = `pixel.terminal-tabs:${root}`;
  const [tabs, setTabs] = useState(() => restore(storageKey));
  const [agents, setAgents] = useState<LaunchedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [adding, setAdding] = useState(!tabs.open.length);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [query, setQuery] = useState('');
  const container = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const launchVisible = useRef(adding && !workspace);
  launchVisible.current = adding && !workspace;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const tabRef = useRef(tabs);
  tabRef.current = tabs;
  const workspaceRef = useRef(onShowTerminal);
  const initialSelection = useRef<string | undefined>(undefined);
  workspaceRef.current = onShowTerminal;
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(tabs));
  }, [storageKey, tabs]);
  useEffect(() => {
    if (!root || !available) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    api<LaunchedAgent[]>(`/agents?root=${encodeURIComponent(root)}`).then(
      (list) => {
        if (!alive) return;
        // A launch may finish while this older list request is still in flight.
        setAgents((previous) => [
          ...list,
          ...previous.filter((agent) => !list.some((item) => item.id === agent.id)),
        ]);
        setLoading(false);
      },
      (e: Error) => {
        if (alive) {
          setError(e.message);
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [root, available, retry]);
  const newSession = () => {
    workspaceRef.current();
    setAdding(true);
    setNavigatorOpen(false);
    requestAnimationFrame(() =>
      container.current?.querySelector<HTMLButtonElement>('.native-start-buttons button')?.focus(),
    );
  };
  const select = (id: string) => {
    workspaceRef.current();
    setTabs((previous) => ({
      ...previous,
      open: previous.open.includes(id) ? previous.open : [...previous.open, id],
      active: id,
      split: previous.split === id && previous.active !== id ? previous.active : previous.split,
    }));
    setAdding(false);
    setNavigatorOpen(false);
  };
  useEffect(() => {
    if (!initialSessionId || initialSelection.current === initialSessionId) return;
    const session = sessions.find((item) => item.id === initialSessionId);
    if (!session || (session.launched && loading)) return;
    initialSelection.current = initialSessionId;
    const agent = agents.find((item) => item.id === session.launched?.launchId);
    select(agent ? `agent:${agent.id}` : `observed:${session.id}`);
  }, [initialSessionId, sessions, agents, loading]);
  const close = (id: string) => {
    setTabs((previous) => {
      const open = previous.open.filter((key) => key !== id);
      const active =
        previous.active === id
          ? (open[Math.max(0, previous.open.indexOf(id) - 1)] ?? '')
          : previous.active;
      return {
        open,
        active,
        split: open.length < 2 || previous.split === id ? undefined : previous.split,
      };
    });
    if (tabs.open.length === 1) setAdding(true);
  };
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        newSession();
      } else if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        container.current
          ?.querySelector<HTMLTextAreaElement>(
            '.native-pane[data-active="true"] .xterm-helper-textarea',
          )
          ?.focus();
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const { open, active } = tabRef.current;
        if (!open.length) return;
        e.preventDefault();
        select(
          open[
            (open.indexOf(active) + (e.key === 'ArrowDown' ? 1 : open.length - 1)) % open.length
          ],
        );
      }
    };
    addEventListener('keydown', keydown);
    addEventListener('pixel:new-task', newSession);
    return () => {
      removeEventListener('keydown', keydown);
      removeEventListener('pixel:new-task', newSession);
    };
  }, []);
  const agentFor = (id: string) => agents.find((a) => `agent:${a.id}` === id);
  const sessionFor = (id: string) => sessions.find((s) => `observed:${s.id}` === id);
  const title = (id: string) => {
    const agent = agentFor(id);
    if (agent) return providerName(agent.provider);
    const session = sessionFor(id);
    return session
      ? session.label || `${providerName(session.provider)} · ${session.sessionId.slice(0, 6)}`
      : '세션';
  };
  const splitId =
    tabs.split && tabs.open.includes(tabs.split) && tabs.split !== tabs.active
      ? tabs.split
      : tabs.split
        ? tabs.open.find((id) => id !== tabs.active)
        : undefined;
  const split = () =>
    setTabs((previous) => ({
      ...previous,
      split: previous.split ? undefined : previous.open.find((id) => id !== previous.active),
    }));
  const filter = query.toLowerCase();
  const visibleAgents = agents.filter((a) =>
    `${a.provider} ${a.prompt} ${a.harness}`.toLowerCase().includes(filter),
  );
  const history = sessions.filter(
    (s) =>
      (!s.launched || !agents.some((a) => a.id === s.launched?.launchId)) &&
      `${s.provider} ${s.label ?? ''} ${s.prompt}`.toLowerCase().includes(filter),
  );
  return (
    <main
      ref={container}
      className={`native-workbench ${navigatorOpen ? 'sessions-open' : ''}`}
      aria-label="터미널 작업 공간"
    >
      <aside className="native-sessions" aria-label="터미널 세션 목록">
        <header>
          <strong>세션</strong>
          <button onClick={newSession} aria-label="새 세션 열기">
            <Plus size={16} />
          </button>
        </header>
        <label className="native-search">
          <Search size={14} />
          <input
            aria-label="터미널 세션 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="세션 검색"
          />
        </label>
        <div className="native-session-list">
          <small>이 앱에서 연 터미널</small>
          {visibleAgents.map((agent) => (
            <button
              key={agent.id}
              aria-label={`${providerName(agent.provider)} 세션 열기`}
              aria-pressed={!adding && tabs.active === `agent:${agent.id}`}
              onClick={() => select(`agent:${agent.id}`)}
            >
              <Terminal size={15} />
              <span>
                <strong>
                  {providerName(agent.provider)} <code>{agent.harness}</code>
                </strong>
                <small>{agent.prompt || '대화형 CLI 세션'}</small>
              </span>
            </button>
          ))}
          {!agents.length && !loading && <p className="native-muted">열린 터미널이 없습니다.</p>}
          {history.length > 0 && <small>이전 작업 이어가기</small>}
          {history.map((session) => (
            <button
              key={session.id}
              aria-pressed={!adding && tabs.active === `observed:${session.id}`}
              onClick={() => select(`observed:${session.id}`)}
            >
              <span className={`presence ${session.status === 'active' ? 'working' : ''}`} />
              <span>
                <strong>{session.label || providerName(session.provider)}</strong>
                <small>{session.prompt || session.sessionId.slice(0, 8)}</small>
              </span>
            </button>
          ))}
        </div>
        <footer>탭을 닫아도 세션은 계속 실행됩니다.</footer>
      </aside>
      <section className="native-main">
        <div className="native-tabbar">
          <button
            className="native-list-toggle"
            aria-label="세션 목록 열기"
            aria-expanded={navigatorOpen}
            onClick={() => setNavigatorOpen((open) => !open)}
          >
            <List size={17} />
          </button>
          <div className="native-tabs" role="tablist" aria-label="열린 터미널">
            {tabs.open.map((id) => (
              <div key={id} className="native-tab">
                <button
                  role="tab"
                  id={`tab-${id}`}
                  aria-controls={`pane-${id}`}
                  aria-selected={!adding && !workspace && tabs.active === id}
                  onClick={() => select(id)}
                >
                  <Terminal size={13} />
                  {title(id)}
                </button>
                <button
                  aria-label={`${title(id)} 탭 닫기`}
                  title="탭 숨기기 · 실행은 유지"
                  onClick={() => close(id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {adding && (
              <button role="tab" aria-selected="true" onClick={newSession}>
                새 세션
              </button>
            )}
          </div>
          <button aria-label="새 세션" title="새 세션 · ⌘/Ctrl+Shift+O" onClick={newSession}>
            <Plus size={17} />
          </button>
          <button
            aria-label={tabs.split ? '터미널 분할 해제' : '터미널 분할'}
            aria-pressed={!!tabs.split}
            disabled={tabs.open.length < 2 || adding || !!workspace}
            onClick={split}
          >
            <Columns2 size={17} />
          </button>
        </div>
        {error && (
          <p className="workspace-error" role="alert">
            {error} <button onClick={() => setRetry((n) => n + 1)}>다시 불러오기</button>
          </p>
        )}
        {workspace && <div className="native-files">{workspace}</div>}
        <div className={`native-panes ${splitId ? 'is-split' : ''}`} hidden={!!workspace || adding}>
          {tabs.open.map((id) => {
            const agent = agentFor(id);
            const session = sessionFor(id);
            const selected = tabs.active === id;
            const shown = selected || splitId === id;
            return (
              <section
                key={id}
                id={`pane-${id}`}
                role="tabpanel"
                aria-labelledby={`tab-${id}`}
                className="native-pane"
                data-active={selected}
                hidden={!shown}
                onPointerDown={() => {
                  if (!selected)
                    setTabs((previous) => ({ ...previous, active: id, split: previous.active }));
                }}
                onFocusCapture={() => {
                  if (!selected)
                    setTabs((previous) => ({ ...previous, active: id, split: previous.active }));
                }}
              >
                <Suspense fallback={<p role="status">터미널을 불러오는 중…</p>}>
                  {agent ? (
                    <TerminalPane
                      root={agent.root}
                      storageKey={`pixel.launch:${agent.id}`}
                      recover={() => api(`/terminals/${agent.terminal.id}`)}
                      active={selected && !adding && !workspace}
                      label={`${providerName(agent.provider)} 터미널`}
                      footer="Enter 지시 · Ctrl+C 중단 · ⌘/Ctrl+J 입력으로 이동"
                      idle={() => (
                        <div className="terminal-empty">
                          <p>종료된 세션입니다.</p>
                          <button onClick={newSession}>새 세션 열기</button>
                        </div>
                      )}
                    />
                  ) : session ? (
                    <ResumeDock
                      session={session}
                      active={selected && !adding && !workspace}
                      onClose={() => close(id)}
                    />
                  ) : (
                    <div className="native-unavailable">
                      <p role="status">
                        {loading
                          ? '세션을 불러오는 중…'
                          : '현재 연결할 수 없는 세션입니다. 세션 목록에서 다른 작업을 선택하세요.'}
                      </p>
                      <button onClick={() => close(id)}>탭 닫기</button>
                    </div>
                  )}
                </Suspense>
              </section>
            );
          })}
        </div>
        {adding && !workspace && (
          <div className="native-start">
            {!root ? (
              <div className="native-unavailable">
                <h1>작업할 프로젝트를 선택하세요</h1>
                <button className="primary" onClick={onConnect}>
                  프로젝트 연결
                </button>
              </div>
            ) : !available ? (
              <div className="native-unavailable">
                <p>CLI 세션을 열려면 서버를 업데이트해주세요.</p>
              </div>
            ) : (
              <AgentLauncher
                native
                root={root}
                onClose={() => {
                  if (tabs.active) setAdding(false);
                }}
                onStarted={(agent) => {
                  // The PTY keeps running after navigation; only the current workspace may react.
                  if (!mounted.current) return;
                  setAgents((previous) => [...previous.filter((a) => a.id !== agent.id), agent]);
                  const id = `agent:${agent.id}`;
                  if (launchVisible.current) select(id);
                  else
                    setTabs((previous) => ({
                      ...previous,
                      open: previous.open.includes(id) ? previous.open : [...previous.open, id],
                    }));
                }}
              />
            )}
            <div className="native-shortcuts">
              <span>⌘/Ctrl+Shift+O 새 세션</span>
              <span>⌘/Ctrl+Alt+↑↓ 세션 전환</span>
              <span>⌘/Ctrl+J 입력</span>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
