import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ScrollText, Search } from 'lucide-react';
import { api } from '../api';
import type { ObservedDetail, ObservedSession } from '../../shared/contracts';
import { repositoryName } from '../components/RepositoryList';
import { automationKind, automationKinds } from './kinds';
import './records.css';
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
// The last thing the automated session said is its product: the work log, the summary, the note.
function resultOf(detail: ObservedDetail): string {
  const said = detail.events.filter(
    (e) => (e.kind === 'complete' || e.kind === 'message') && e.detail,
  );
  return said.at(-1)?.detail ?? '';
}
function Record({ session: s }: { session: ObservedSession }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ObservedDetail>();
  const [error, setError] = useState('');
  const toggle = () => {
    setOpen((o) => !o);
    if (!detail && !error)
      api<ObservedDetail>(`/observed/${s.id}`)
        .then(setDetail)
        .catch((e) => setError((e as Error).message));
  };
  const kind = automationKind(s.prompt);
  const result = detail ? resultOf(detail) : '';
  return (
    <li className={`record ${open ? 'open' : ''}`} data-kind={kind.key}>
      <button
        aria-expanded={open}
        aria-label={`자동 기록 ${kind.label} ${repositoryName(s.projectPath)} ${s.sessionId}`}
        onClick={toggle}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span className="record-kind">{kind.label}</span>
        <strong>{repositoryName(s.projectPath)}</strong>
        <small>
          {s.status === 'active' ? '작성 중' : time(s.updatedAt)} · {s.model || '모델 정보 없음'}
        </small>
      </button>
      {open && (
        <div className="record-body">
          {error ? (
            <p role="alert">{error}</p>
          ) : !detail ? (
            <p className="muted">기록을 읽고 있어요…</p>
          ) : result ? (
            <pre>{result}</pre>
          ) : (
            <p className="muted">
              {s.status === 'active' ? '아직 작성 중이에요.' : '남은 결과 본문이 없어요.'}
            </p>
          )}
          <details>
            <summary>요청 내용</summary>
            <pre>{s.prompt}</pre>
          </details>
        </div>
      )}
    </li>
  );
}
export function RecordsPage({ sessions }: { sessions: ObservedSession[] }) {
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const automated = useMemo(
    () =>
      sessions
        .filter((s) => s.automated && s.updatedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions],
  );
  const needle = query.trim().toLowerCase();
  const shown = automated.filter(
    (s) =>
      (!kind || automationKind(s.prompt).key === kind) &&
      s.projectPath.toLowerCase().includes(needle),
  );
  const days = new Map<string, ObservedSession[]>();
  for (const s of shown) days.set(day(s.updatedAt), [...(days.get(day(s.updatedAt)) ?? []), s]);
  const counts = new Map<string, number>();
  for (const s of automated) {
    const k = automationKind(s.prompt).key;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    <main className="records-page">
      <div className="records-heading">
        <h1>자동 기록</h1>
        <p>
          훅과 스크립트가 백그라운드에서 만든 업무일지·세션 요약·메모리 정리예요. 맵과 보고에는
          섞이지 않고 여기에 모여요.
        </p>
      </div>
      <div className="records-controls">
        <label className="records-search">
          <Search size={16} />
          <input
            aria-label="자동 기록 레포 검색"
            placeholder="레포 이름이나 경로"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="records-kinds" role="group" aria-label="자동 기록 종류">
          <button className={!kind ? 'active' : ''} onClick={() => setKind('')}>
            전체 <small>{automated.length}</small>
          </button>
          {automationKinds
            .filter((k) => counts.get(k.key))
            .map((k) => (
              <button
                key={k.key}
                className={kind === k.key ? 'active' : ''}
                onClick={() => setKind(kind === k.key ? '' : k.key)}
              >
                {k.label} <small>{counts.get(k.key)}</small>
              </button>
            ))}
        </div>
      </div>
      {shown.length ? (
        [...days].map(([label, items]) => (
          <section key={label} className="records-day" aria-label={`${label} 자동 기록`}>
            <h2>
              {label} <small>{items.length}건</small>
            </h2>
            <ul>
              {items.map((s) => (
                <Record key={s.id} session={s} />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <section className="records-empty">
          <ScrollText size={30} />
          <h2>{automated.length ? '조건에 맞는 자동 기록이 없어요' : '아직 자동 기록이 없어요'}</h2>
          <p>`claude -p`나 `codex exec`처럼 스크립트가 띄운 세션이 관측되면 여기에 모여요.</p>
        </section>
      )}
    </main>
  );
}
