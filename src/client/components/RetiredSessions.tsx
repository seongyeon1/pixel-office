import { useState } from 'react';
import type { RetiredSession } from '../../shared/contracts';
import { repositoryName } from './RepositoryList';
import './session-resume.css';

export function RetiredSessions({
  sessions,
  onRestore,
}: {
  sessions: RetiredSession[];
  onRestore: (id: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const restore = async (id: string) => {
    setPending(id);
    setError('');
    try {
      await onRestore(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(undefined);
    }
  };
  if (!sessions.length) return null;
  const visible = sessions.filter((s) =>
    `${s.provider} ${s.sessionId} ${s.label} ${s.projectPath} ${s.prompt}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <details className="retired-sessions">
      <summary>직접 퇴근시킨 동료 {sessions.length}명</summary>
      <p>맵에서 숨긴 동료입니다. 다시 출근하면 캐릭터를 선택해 이어서 작업할 수 있어요.</p>
      <input
        aria-label="퇴근한 동료 검색"
        placeholder="이름·작업·프로젝트 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <ul>
        {visible.map((s) => (
          <li key={s.id}>
            <div>
              <strong>
                {s.provider === 'codex' ? 'Codex' : 'Claude'} · {s.label || s.sessionId.slice(0, 8)}
              </strong>
              <small title={s.projectPath}>
                {repositoryName(s.projectPath)} · {s.sessionId.slice(0, 8)}
              </small>
              <p>{s.prompt || '기록된 작업 요청 없음'}</p>
              {s.available === false && <small>현재 원본 로그를 찾을 수 없습니다.</small>}
            </div>
            <button
              disabled={!!pending || s.available === false}
              onClick={() => void restore(s.id)}
              aria-label={`다시 출근 ${s.sessionId}`}
            >
              {pending === s.id ? '출근 중…' : '다시 출근'}
            </button>
          </li>
        ))}
      </ul>
      {!visible.length && <p>조건에 맞는 동료가 없어요.</p>}
    </details>
  );
}
