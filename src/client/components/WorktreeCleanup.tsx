import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, X } from 'lucide-react';
import type { WorktreeCleanupEntry } from '../../shared/worktrees';
import { api } from '../api';
import './worktree-cleanup.css';

export function WorktreeCleanup({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<WorktreeCleanupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setItems(await api('/worktrees'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [onClose, pending]);
  async function remove(item: WorktreeCleanupEntry) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await api('/worktrees/remove', { path: item.path, discardChanges: discard });
      setSelected(undefined);
      setDiscard(false);
      setNotice('작업 폴더를 정리했어요. 브랜치와 작업 기록은 보존했습니다.');
      await refresh();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal worktree-cleanup"
        role="dialog"
        aria-modal="true"
        aria-label="작업 폴더 정리"
      >
        <header>
          <h2>작업 폴더 정리</h2>
          <button aria-label="작업 폴더 정리 닫기" disabled={pending} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p>
          앱이 만든 워크트리를 정리합니다. 원본 저장소·브랜치·작업 기록은 보존되며, 정리한
          폴더에서는 대화를 이어갈 수 없어요.
        </p>
        <button
          className="text-button"
          disabled={loading || pending}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} /> 상태 새로고침
        </button>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">작업 폴더를 확인하는 중…</p>
        ) : !items.length ? (
          <p>정리할 앱 작업 폴더가 없어요. 내 환경 작업은 원본 폴더를 사용합니다.</p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.path}>
                <strong>{item.prompt}</strong>
                <code>{item.path}</code>
                <small>
                  브랜치 {item.branch} · 작업 기록 {item.runIds.length}개
                </small>
                {item.blockedReason ? (
                  <p>{item.blockedReason}</p>
                ) : (
                  <p>
                    {item.changedFiles
                      ? `미커밋·추가 파일 ${item.changedFiles}건 (무시된 파일 포함)`
                      : '미커밋·추가 파일 없음'}
                  </p>
                )}
                {!!item.changedFiles && (
                  <details>
                    <summary>삭제될 변경 확인</summary>
                    <pre>
                      {item.changes.join('\n')}
                      {item.changedFiles > 40 ? '\n… 전체 상태는 해당 폴더에서 확인해주세요.' : ''}
                    </pre>
                  </details>
                )}
                {selected === item.path ? (
                  <div className="cleanup-confirm">
                    <p>
                      위 경로의 작업 폴더를 삭제할까요? 삭제한 파일은 앱에서 복구할 수 없습니다.
                    </p>
                    {!!item.changedFiles && (
                      <label>
                        <input
                          type="checkbox"
                          checked={discard}
                          disabled={pending}
                          onChange={(e) => setDiscard(e.target.checked)}
                        />
                        커밋하지 않은 변경과 추가 파일도 삭제합니다.
                      </label>
                    )}
                    <div>
                      <button
                        disabled={pending}
                        onClick={() => {
                          setSelected(undefined);
                          setDiscard(false);
                        }}
                      >
                        취소
                      </button>
                      <button
                        className="danger"
                        disabled={pending || (!!item.changedFiles && !discard)}
                        onClick={() => void remove(item)}
                      >
                        {pending ? '정리 중…' : '작업 폴더 삭제'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    disabled={pending || !!item.blockedReason}
                    onClick={() => {
                      setSelected(item.path);
                      setDiscard(false);
                      setError('');
                    }}
                  >
                    <Trash2 size={14} /> 정리하기
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
