import { useEffect, useState } from 'react';
import { Activity as ActivityIcon, FileCode2, Radio } from 'lucide-react';
import {
  activityLabels,
  defaultTeam,
  type ObservedDetail,
  type ObservedSession,
  type Provider,
} from '../../shared/contracts';
import { api } from '../api';
import { emptyState } from '../state';
import { Office } from '../office/Office';
import { repositoryName } from './RepositoryList';
export const observedStatus = {
  active: '활동 관측',
  idle: '응답 완료·대기',
  stale: '상태 확인 필요',
};
const name = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude');
export function ObservedOffice({
  sessions,
  root,
  selectedProvider,
  onProviderChange,
}: {
  sessions: ObservedSession[];
  root: string;
  selectedProvider: Provider;
  onProviderChange: (id: Provider) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ObservedDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const initial = sessions.find((s) => s.status === 'active') ?? sessions[0];
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
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(null);
    setError('');
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
  const agents = emptyState().agents;
  for (const p of ['claude', 'codex'] as const) {
    const latest =
      (selected?.provider === p ? selected : undefined) ??
      sessions.find((s) => s.provider === p && s.status === 'active') ??
      sessions.find((s) => s.provider === p);
    if (latest) {
      agents[p].activity = latest.activity;
      agents[p].model = latest.model;
    }
  }
  const current = detail?.id === selected?.id ? detail : null;
  return (
    <main className="office-page observed-page">
      <div className="main-column">
        <div className="page-heading">
          <div>
            <h1>외부 세션 오피스</h1>
            <p>{repositoryName(root)} · 이미 실행 중인 동료들의 활동을 읽어와요.</p>
          </div>
        </div>
        <section className="office-card">
          <div className="office-toolbar">
            <span>
              <Radio size={14} /> 외부 세션 {sessions.length}개
            </span>
            <span className="small-tag">관측 전용</span>
          </div>
          <div className="office-scene">
            <Office
              agents={agents}
              selected={selected?.provider ?? selectedProvider}
              onSelect={onProviderChange}
              team={defaultTeam()}
              external
            />
          </div>
          <div className="office-footer">
            <span>캐릭터를 선택하거나 아래에서 세션을 골라주세요.</span>
          </div>
        </section>
        <section className="observed-sessions" aria-label="감지된 세션">
          {sessions.length ? (
            sessions.map((s) => (
              <button
                key={s.id}
                aria-label={`세션 선택 ${name(s.provider)} ${s.sessionId}${s.label ? ` ${s.label}` : ''}`}
                aria-pressed={selected?.id === s.id}
                className={selected?.id === s.id ? 'selected' : ''}
                onClick={() => {
                  setSelectedId(s.id);
                  onProviderChange(s.provider);
                }}
              >
                <span className={`presence ${s.status === 'active' ? 'working' : ''}`} />
                <span>
                  <strong>
                    {name(s.provider)} <small>{s.label || s.sessionId.slice(0, 8)}</small>
                  </strong>
                  <span className="observed-prompt">
                    {s.prompt || '세션 활동을 관측하고 있어요'}
                  </span>
                  <small>
                    {observedStatus[s.status]} · {s.model || '모델 정보 없음'}
                  </small>
                </span>
                <span className="observed-time">
                  {s.updatedAt
                    ? new Date(s.updatedAt).toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '기록 대기'}
                </span>
              </button>
            ))
          ) : (
            <div className="empty-history">
              <Radio size={26} />
              <h2>이 레포의 외부 세션을 찾고 있어요</h2>
              <p>로그가 기록되는 Claude Code·Codex 세션이 발견되면 표시됩니다.</p>
            </div>
          )}
        </section>
      </div>
      <aside className="inspector observed-inspector">
        <div className="inspector-heading">
          <span>세션 활동</span>
          <span className="small-tag">관측 전용</span>
        </div>
        {selected ? (
          <>
            <div className="observed-profile">
              <h2>
                {name(selected.provider)}{' '}
                <small>{selected.label || selected.sessionId.slice(0, 8)}</small>
              </h2>
              <p>
                {observedStatus[selected.status]} · {activityLabels[selected.activity]}
              </p>
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
              </dl>
              <p className="observed-note">
                명령·승인·중단은 원래 실행한 터미널이나 앱에서 진행해주세요. 최근 기록을 기준으로
                상태를 표시합니다.
              </p>
            </div>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <div className="observed-events">
              {current?.truncated && (
                <p className="observed-note">큰 로그는 최근 구간만 불러왔어요.</p>
              )}
              {current?.events
                .slice()
                .reverse()
                .map((e) => (
                  <article key={e.id}>
                    <div>
                      {e.kind === 'tool' ? <FileCode2 size={14} /> : <ActivityIcon size={14} />}
                      <strong>{e.title}</strong>
                      <time>
                        {new Date(e.timestamp).toLocaleTimeString('ko-KR', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </time>
                    </div>
                    {e.detail &&
                      (e.kind === 'tool' && e.detail.length > 240 ? (
                        <details>
                          <summary>실행 내용 보기</summary>
                          <pre>{e.detail}</pre>
                        </details>
                      ) : (
                        <pre>{e.detail}</pre>
                      ))}
                  </article>
                ))}
              {!current?.events.length && (
                <p className="observed-note">표시할 메시지와 도구 기록을 기다리고 있어요.</p>
              )}
            </div>
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
