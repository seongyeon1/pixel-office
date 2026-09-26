import { useCallback, useEffect, useState } from 'react';
import { MessageCircle, TerminalSquare } from 'lucide-react';
import type { Answer } from '../../shared/contracts';
import { api } from '../api';
import { InteractionPanel } from './InteractionPanel';
// A question a Claude terminal handed over through the AskUserQuestion hook.
export interface TerminalQuestion {
  id: string;
  sessionId: string;
  cwd: string;
  questions: unknown[];
  createdAt: string;
}
export type HookStatus = { available: false } | { available: true; installed: boolean };
export function useTerminalQuestions() {
  const [questions, setQuestions] = useState<TerminalQuestion[]>([]);
  const refresh = useCallback(async () => {
    try {
      setQuestions(await api<TerminalQuestion[]>('/questions'));
    } catch {
      // Keep the last list; the next poll tries again.
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { questions, refresh };
}
export function useTerminalHook() {
  const [status, setStatus] = useState<HookStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<HookStatus>('/terminal-hook').then(setStatus, (e: Error) => setError(e.message));
  }, []);
  const change = async (action: 'install' | 'uninstall') => {
    setBusy(true);
    setError('');
    try {
      const next = await api<{ installed: boolean }>(`/terminal-hook/${action}`, {});
      setStatus({ available: true, installed: next.installed });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { status, error, busy, change };
}
export function TerminalQuestionCard({
  question,
  onDone,
}: {
  question: TerminalQuestion;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const answer = async (a: Answer) => {
    if (!('answers' in a)) return;
    await api(`/questions/${question.id}/answer`, { answers: a.answers });
    await onDone();
  };
  const release = async () => {
    try {
      await api(`/questions/${question.id}/release`, {});
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="terminal-question">
      <InteractionPanel
        request={{
          id: question.id,
          runId: '',
          agentId: 'claude',
          kind: 'question',
          title: '터미널의 Claude가 물어보고 있어요. 여기서 답하면 터미널로 전달돼요.',
          details: { questions: question.questions },
          resolved: false,
        }}
        onAnswer={answer}
      />
      <button className="subtle-button" onClick={() => void release()}>
        <TerminalSquare size={14} />
        터미널에서 답할게요
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
// Shown when a coworker is waiting on a question the app cannot see yet.
export function TerminalHookHint({ hook }: { hook: ReturnType<typeof useTerminalHook> }) {
  if (!hook.status?.available || hook.status.installed) return null;
  return (
    <section className="terminal-hook-hint">
      <p>
        <MessageCircle size={14} />이 동료는 터미널에서 답을 기다리고 있어요. 질문 연결을 켜면 다음
        질문부터 여기서 답할 수 있어요.
      </p>
      <button disabled={hook.busy} onClick={() => void hook.change('install')}>
        질문 연결 켜기
      </button>
      {hook.error && <p role="alert">{hook.error}</p>}
    </section>
  );
}
export function TerminalHookSettings() {
  const hook = useTerminalHook();
  if (!hook.status) return hook.error ? <p role="alert">{hook.error}</p> : null;
  if (!hook.status.available) return null;
  return (
    <section className="team-setting terminal-hook-settings">
      <h3>터미널 질문 연결</h3>
      <p className="hint">
        터미널에서 실행 중인 Claude가 선택지 질문(AskUserQuestion)을 하면 오피스에서 답할 수 있어요.
        켜면 <code>~/.claude/settings.json</code>에 훅 하나를 추가하고, 바꾸기 전에 원래 파일을
        백업해요. 앱이 꺼져 있거나 10분 안에 답하지 않으면 터미널에서 평소처럼 물어봐요. 이미 열려
        있던 터미널은 다시 시작해야 적용될 수 있어요.
      </p>
      <p>
        상태: <strong>{hook.status.installed ? '켜짐' : '꺼짐'}</strong>
      </p>
      <button
        disabled={hook.busy}
        onClick={() =>
          void hook.change(
            hook.status?.available && hook.status.installed ? 'uninstall' : 'install',
          )
        }
      >
        {hook.status.installed ? '질문 연결 끄기' : '질문 연결 켜기'}
      </button>
      {hook.error && <p role="alert">{hook.error}</p>}
    </section>
  );
}
