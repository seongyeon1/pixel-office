import { useState } from 'react';
import { ArrowUp, History, LoaderCircle } from 'lucide-react';
import { statusLabels, type Run } from '../../shared/contracts';
import { api } from '../api';

export function RunFollowUp({
  run,
  disabled,
  onStarted,
  onHistory,
}: {
  run: Run;
  disabled: boolean;
  onStarted: (run: Run) => Promise<void>;
  onHistory: () => void;
}) {
  disabled ||= !!run.removedWorktrees?.length;
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    if (!prompt.trim() || disabled || sending) return;
    setSending(true);
    setError('');
    try {
      const next = await api<Run>(`/runs/${run.id}/follow-up`, { prompt });
      await onStarted(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="run-follow-up" aria-label="이전 작업과 추가 요청">
      <div className="follow-up-heading">
        <strong>{statusLabels[run.status]} · 작업 기록에 저장됨</strong>
        <button className="text-button" onClick={onHistory}>
          <History size={14} />이 작업의 기록 보기
        </button>
      </div>
      <p className="follow-up-request">{run.prompt}</p>
      {run.error && (
        <p className="inline-error" role="status">
          {run.error}
        </p>
      )}
      {run.pullRequests?.map((url) => (
        <p key={url}>
          <a href={url} target="_blank" rel="noreferrer">
            PR 열기
          </a>
        </p>
      ))}
      <details>
        <summary>작업 결과 보기</summary>
        <pre>{run.summary || run.error || '남은 결과 본문이 없어요.'}</pre>
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="follow-up-prompt">이 작업에 추가 요청</label>
        <textarea
          id="follow-up-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={disabled || sending}
          rows={3}
          placeholder="예: 방금 수정한 부분에 회귀 테스트도 추가해줘."
        />
        <div className="follow-up-bottom">
          <p className="hint">
            {run.removedWorktrees?.length
              ? '작업 폴더를 정리했어요. 기록을 참고해 새 작업을 시작해주세요.'
              : '기존 변경사항과 이전 요청을 이어받아 작업해요.'}
          </p>
          <button
            className="primary"
            disabled={disabled || sending || !prompt.trim()}
            type="submit"
          >
            {sending ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={15} />}
            추가 요청 보내기
          </button>
        </div>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
