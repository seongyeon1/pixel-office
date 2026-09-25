import { useEffect, useState } from 'react';
import { Activity as ActivityIcon, FileCode2, Radio, Search, MessageCircle } from 'lucide-react';
import {
  activityLabels,
  type ChatMessage,
  type ObservedDetail,
  type ObservedEvent,
  type ObservedSession,
  type Provider,
} from '../../shared/contracts';
import { api } from '../api';
import { SessionOffice } from '../office/SessionOffice';
import { PixelWorker } from '../office/PixelWorker';
import { SessionChat } from './SessionChat';
import { repositoryName } from './RepositoryList';
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
}: {
  sessions: ObservedSession[];
  root: string;
  selectedProvider: Provider;
  initialSessionId?: string;
  onProviderChange: (id: Provider) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  const [detail, setDetail] = useState<ObservedDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'summary' | 'history' | 'chat'>('summary');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [reply, setReply] = useState<ChatMessage>();
  useEffect(() => {
    const initial =
      sessions.find((s) => s.id === initialSessionId) ??
      sessions.find((s) => s.status === 'active') ??
      sessions[0];
    if (initial) {
      setSelectedId(initial.id);
      onProviderChange(initial.provider);
    }
  }, []);
  const preferred =
    sessions.find((s) => s.provider === selectedProvider && s.status === 'active') ??
    sessions.find((s) => s.provider === selectedProvider) ??
    sessions[0];
  const selected =
    sessions.find((s) => s.id === selectedId && s.provider === selectedProvider) ?? preferred;
  const openChat = () => {
    setTab('chat');
    requestAnimationFrame(() =>
      document.querySelector('.observed-inspector')?.scrollIntoView({ block: 'nearest' }),
    );
  };
  const choose = (s: ObservedSession) => {
    setSelectedId(s.id);
    onProviderChange(s.provider);
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
  const current = detail?.id === selected?.id ? detail : null;
  const events = current?.events ?? [];
  const latest = events.filter((e) => e.kind !== 'result').at(-1);
  const visible = sessions.filter(
    (s) =>
      (filter === 'all' || s.status === filter) &&
      `${s.provider} ${s.sessionId} ${s.label} ${s.prompt} ${s.model}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <main className="office-page observed-page">
      <div className="main-column">
        <div className="page-heading">
          <div>
            <h1>외부 세션 오피스</h1>
            <p>{repositoryName(root)} · 동료별 작업을 확인하고 질문해보세요.</p>
          </div>
          <span className="small-tag">
            <Radio size={12} /> 실시간 기록
          </span>
        </div>
        <SessionOffice
          sessions={sessions}
          selected={selected}
          onSelect={choose}
          reply={reply}
          onChat={openChat}
        />
        {selected && (
          <section className="session-task-card">
            <div>
              <span className="section-eyebrow">선택한 동료의 최근 작업</span>
              <strong>
                {name(selected.provider)}{' '}
                <small>{selected.label || selected.sessionId.slice(0, 8)}</small>
              </strong>
            </div>
            <h2>{latest ? eventTitle(latest) : activityLabels[selected.activity]}</h2>
            <p>
              {(latest ? eventSummary(latest) : '') ||
                selected.prompt ||
                '새 작업 기록을 기다리고 있어요.'}
            </p>
            <footer>
              <span>
                {clock(selected.updatedAt)} 기준 · {observedStatus[selected.status]}
              </span>
              <button onClick={openChat}>
                <MessageCircle size={14} />이 동료에게 질문
              </button>
            </footer>
          </section>
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
        <section className="observed-sessions" aria-label="감지된 세션">
          {visible.map((s) => (
            <button
              key={s.id}
              aria-label={`세션 선택 ${name(s.provider)} ${s.sessionId}${s.label ? ` ${s.label}` : ''}`}
              aria-pressed={selected?.id === s.id}
              className={selected?.id === s.id ? 'selected' : ''}
              onClick={() => choose(s)}
            >
              <span className={`presence ${s.status === 'active' ? 'working' : ''}`} />
              <span>
                <strong>
                  {name(s.provider)} <small>{s.label || s.sessionId.slice(0, 8)}</small>
                  <em>{activityLabels[s.activity]}</em>
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
      </div>
      <aside className="inspector observed-inspector">
        <div className="inspector-heading">
          <span>동료 살펴보기</span>
          <span className="small-tag">관측 전용</span>
        </div>
        {selected ? (
          <>
            <div className="session-profile-heading">
              <PixelWorker provider={selected.provider} identity={selected.sessionId} />
              <div>
                <h2>{name(selected.provider)}</h2>
                <span>{selected.label || selected.sessionId.slice(0, 8)}</span>
                <p>
                  <span className={`presence ${selected.status === 'active' ? 'working' : ''}`} />
                  {observedStatus[selected.status]}
                </p>
              </div>
            </div>
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
                      const next = tabs[(tabs.indexOf(id) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
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
              <p className="observed-note">
                상태는 최근 기록을 기준으로 표시합니다. 명령·승인·중단은 원래 터미널이나 앱에서
                진행해주세요.
              </p>
              <button className="session-ask" onClick={openChat}>
                <MessageCircle size={16} />
                작업에 대해 질문하기
              </button>
            </section>
            <section
              role="tabpanel"
              id="session-panel-history"
              aria-labelledby="session-tab-history"
              hidden={tab !== 'history'}
              className="observed-events"
            >
              <p className="observed-note">
                최근 기록부터 표시해요. 도구 사용은 실행 시도이며 성공 여부를 의미하지 않습니다.
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
                      {e.kind === 'tool' ? <FileCode2 size={15} /> : <ActivityIcon size={15} />}
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
                <p className="observed-note">표시할 메시지와 도구 기록을 기다리고 있어요.</p>
              )}
            </section>
            <section
              role="tabpanel"
              id="session-panel-chat"
              aria-labelledby="session-tab-chat"
              hidden={tab !== 'chat'}
            >
              <SessionChat key={selected.id} session={selected} onReply={setReply} />
            </section>
          </>
        ) : (
          <div className="empty-activity">
            <p>확인할 세션을 선택해주세요.</p>
          </div>
        )}
      </aside>
    </main>
  );
}
