import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, LoaderCircle, Plus, Settings2 } from 'lucide-react';
import {
  terminal,
  type ObservedSession,
  type Run,
  type SessionConversation,
} from '../../shared/contracts';
import { api } from '../api';
import { channelNote, DirectSettingsForm } from './SessionChat';

export type ComposerState = {
  drafts: Record<string, string>;
  choice?: { context: string; value: string };
};

export function WorkComposer({
  session,
  run,
  busy,
  disabled,
  onStart,
  onFollowUp,
  onSessionSent,
  onFocus,
  children,
  feedback,
  state,
  onStateChange,
}: {
  session?: ObservedSession;
  run: Run | null;
  busy: boolean;
  disabled: boolean;
  onStart: (text: string) => Promise<boolean>;
  onFollowUp: (text: string) => Promise<void>;
  onSessionSent: () => void;
  onFocus: () => void;
  children: ReactNode;
  feedback?: ReactNode;
  state: ComposerState;
  onStateChange: (update: (previous: ComposerState) => ComposerState) => void;
}) {
  const automatic = session ? `session:${session.id}` : run ? 'run' : 'new';
  const context = session ? automatic : run ? `run:${run.id}` : 'new';
  const { choice, drafts } = state;
  const setChoice = (next: ComposerState['choice']) =>
    onStateChange((previous) => ({ ...previous, choice: next }));
  const setDrafts = (update: (drafts: Record<string, string>) => Record<string, string>) =>
    onStateChange((previous) => ({ ...previous, drafts: update(previous.drafts) }));
  const target = choice?.context === context ? choice.value : automatic;
  const key = target === 'run' ? `run:${run?.id}` : target;
  const [sessionMode, setSessionMode] = useState<'say' | 'ask'>('say');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conversation, setConversation] = useState<{ id: string; data: SessionConversation }>();
  const input = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const revision = useRef(0);
  const alive = useRef(true);
  const draft = drafts[key] ?? '';
  const sessionTarget = target.startsWith('session:') ? session : undefined;
  const channels = conversation?.id === sessionTarget?.id ? conversation?.data : undefined;
  const modeNote =
    sessionMode === 'ask'
      ? '최근 작업 기록을 바탕으로 답해요.'
      : channels?.channels
        ? channelNote(channels.channels)
        : '전달 경로 확인 중…';
  const pending = channels?.messages.some((m) => m.status === 'pending');
  const lengthExceeded = sessionTarget && sessionMode === 'ask' && draft.length > 4000;
  const reason = lengthExceeded
    ? '기록 기반 질문은 4,000자까지 보낼 수 있어요.'
    : sessionTarget
      ? sessionMode === 'say' && sessionTarget.managed?.busy
        ? '이 앱 작업이 끝난 뒤 추가 지시할 수 있어요.'
        : !channels
          ? '세션 연결을 확인하는 중…'
          : sessionMode === 'say' && !channels.directAvailable
            ? '이 세션은 직접 지시를 지원하지 않아요.'
            : (sessionMode === 'say' ? channels.channels?.blockedReason : '') ||
              (pending ? '이전 요청을 처리하고 있어요.' : '')
      : target === 'run' && run?.removedWorktrees?.length
        ? '작업 폴더가 정리됐어요. 새 작업을 선택해주세요.'
        : busy
          ? '진행 중인 앱 작업을 마치거나 중단한 뒤 보낼 수 있어요.'
          : disabled && target === 'new'
            ? '작업할 프로젝트와 저장소를 확인해주세요.'
            : '';
  const select = (value: string) => {
    setChoice({ context, value });
    setError('');
    setNotice('');
    input.current?.focus();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setError('');
    setNotice('');
  }, [key]);
  useEffect(() => {
    if (!sessionTarget) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        const data = await api<SessionConversation>(`/observed/${sessionTarget.id}/chat`);
        if (!stopped && !locked.current && version === revision.current)
          setConversation({ id: sessionTarget.id, data });
      } catch (e) {
        if (!stopped && !locked.current && version === revision.current)
          setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionTarget?.id]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'j') {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        select('new');
      }
    };
    const newTask = () => select('new');
    addEventListener('pixel:new-task', newTask);
    addEventListener('keydown', shortcut);
    return () => {
      removeEventListener('keydown', shortcut);
      removeEventListener('pixel:new-task', newTask);
    };
  }, [context]);
  const cancel = async () => {
    if (!sessionTarget || locked.current) return;
    locked.current = true;
    revision.current++;
    setSending(true);
    setError('');
    try {
      await api(`/observed/${sessionTarget.id}/chat/cancel`, {});
      const data = await api<SessionConversation>(`/observed/${sessionTarget.id}/chat`);
      if (alive.current) setConversation({ id: sessionTarget.id, data });
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (alive.current) setSending(false);
    }
  };
  const send = async () => {
    if (!draft.trim() || reason || sending || locked.current) return;
    const sentKey = key;
    const text = draft;
    locked.current = true;
    revision.current++;
    setSending(true);
    setError('');
    setNotice('');
    try {
      if (sessionTarget) {
        const data = await api<SessionConversation>(
          `/observed/${sessionTarget.id}/${sessionMode === 'say' ? 'say' : 'chat'}`,
          sessionMode === 'say' ? { text } : { question: text },
        );
        if (alive.current) setConversation({ id: sessionTarget.id, data });
        dispatchEvent(new CustomEvent('pixel:session-sent', { detail: sessionTarget.id }));
        onSessionSent();
      } else if (target === 'run' && run && terminal(run.status)) {
        await onFollowUp(text);
      } else {
        if (!(await onStart(text))) return;
      }
      setDrafts((d) => (d[sentKey] === text ? { ...d, [sentKey]: '' } : d));
      if (alive.current) setNotice('지시를 보냈어요.');
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (alive.current) setSending(false);
    }
  };
  return (
    <section className="work-composer task-composer" aria-label="작업 지시">
      <div className="work-composer-heading">
        <label>
          지시 대상
          <select
            aria-label="지시 대상"
            value={target}
            disabled={sending}
            onChange={(e) => select(e.target.value)}
          >
            <option value="new">새 작업</option>
            {run && <option value="run">현재 앱 작업에 추가 요청</option>}
            {session && (
              <option value={`session:${session.id}`}>
                {session.provider === 'codex' ? 'Codex' : 'Claude'} ·{' '}
                {session.label || session.sessionId.slice(0, 8)}에 지시
              </option>
            )}
          </select>
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() => select('new')}
          disabled={sending}
          title="새 작업 · ⌘/Ctrl+Shift+O"
        >
          <Plus size={14} />새 작업
        </button>
      </div>
      {target === 'run' && run && (
        <p className="composer-context" title={run.prompt}>
          이어갈 작업 · {run.prompt}
        </p>
      )}
      {sessionTarget && (
        <p className="composer-context" title={sessionTarget.cwd}>
          작업 폴더 · {sessionTarget.cwd || sessionTarget.projectPath}
        </p>
      )}
      {sessionTarget && (
        <div className="session-instruction-mode">
          <label>
            전달 방식
            <select
              aria-label="지시 방식"
              value={sessionMode}
              disabled={sending}
              onChange={(e) => setSessionMode(e.target.value as 'say' | 'ask')}
            >
              <option value="say">지시 · 실제 실행</option>
              <option value="ask">질문 · 기록 기반</option>
            </select>
          </label>
          <small title={modeNote}>{modeNote}</small>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          onFocus={onFocus}
          aria-label="작업 내용"
          value={draft}
          rows={3}
          maxLength={sessionTarget && sessionMode === 'ask' ? 4000 : 20000}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
          placeholder={
            target === 'new' ? '새로 맡길 작업을 적어주세요…' : '이어서 할 일을 적어주세요…'
          }
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="work-composer-bottom">
          <span className="hint" role="status">
            {reason || notice || '⌘/Ctrl+Enter 보내기 · ⌘/Ctrl+J 입력창'}
          </span>
          {pending ? (
            <button type="button" disabled={sending} onClick={() => void cancel()}>
              기다리기 중단
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={!!reason || sending || !draft.trim()}
            >
              {sending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} />}
              {sending
                ? '보내는 중…'
                : target === 'new'
                  ? '작업 시작'
                  : target === 'run'
                    ? '추가 요청 보내기'
                    : sessionMode === 'ask'
                      ? '질문 보내기'
                      : '지시 보내기'}
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {feedback}
      <details className="work-options">
        <summary>
          <Settings2 size={14} />
          작업 옵션 · 실행 환경과 팀
        </summary>
        {sessionTarget ? <DirectSettingsForm /> : children}
      </details>
    </section>
  );
}
