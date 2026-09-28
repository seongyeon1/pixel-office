import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Settings2, Square, TerminalSquare } from 'lucide-react';
import type {
  Answer,
  ChatMessage,
  DirectSettings,
  ObservedSession,
  SessionConversation,
} from '../../shared/contracts';
import { api } from '../api';
import { InteractionPanel } from './InteractionPanel';
import './session-chat.css';
type Mode = 'ask' | 'say';
const providerName = (s: ObservedSession) => (s.provider === 'codex' ? 'Codex' : 'Claude');
// What an instruction would do right now, in one sentence.
function channelNote(c: NonNullable<SessionConversation['channels']>) {
  if (c.blockedReason) return c.blockedReason;
  if (c.fresh)
    return '원본 세션이 남아 있지 않아, 보관된 작업 기록과 같은 폴더에서 새 대화를 시작해요.';
  if (c.terminal) return '이어가기 터미널로 전달돼요. 답변은 터미널과 작업 내역에 남아요.';
  if (c.viaSessionId)
    return `이전 지시가 연결된 세션 ${c.viaSessionId.slice(0, 8)}에서 이어져요. 새 지시도 거기로 가요.`;
  if (c.next === 'direct')
    return c.running
      ? '원래 터미널이 아직 살아 있어서, 복제한 세션을 앱이 이어받아 실행해요. 작업 상태와 질문은 여기서 확인해요.'
      : '앱이 이 세션을 이어받아 실행해요. 작업 상태와 질문은 여기서 확인해요.';
  return c.running
    ? '원래 터미널이 아직 살아 있어서, 복제한 세션의 이어가기 터미널을 열고 전달해요.'
    : '이어가기 터미널을 열고 전달해요.';
}
function DirectSettingsForm() {
  const [settings, setSettings] = useState<DirectSettings>();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<DirectSettings>('/settings/direct').then(setSettings, (e: Error) => setError(e.message));
  }, []);
  if (!settings) return error ? <p className="inline-error">{error}</p> : null;
  const change = (provider: 'claude' | 'codex', value: string) => {
    setSaved(false);
    setSettings({ ...settings, commands: { ...settings.commands, [provider]: value } });
  };
  const save = async () => {
    setError('');
    try {
      setSettings(await api<DirectSettings>('/settings/direct', settings));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form
      className="chat-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p>
        이어가기 터미널이 띄울 명령이에요. 평소 쓰는 래퍼 스크립트(예: <code>sy</code>,{' '}
        <code>syc</code>)를 적으면 그 설정 그대로 이어가요. 공백 없는 실행 파일 이름만 돼요.
      </p>
      <label>
        Claude 명령
        <input
          value={settings.commands.claude}
          onChange={(e) => change('claude', e.target.value)}
          maxLength={80}
        />
      </label>
      <label>
        Codex 명령
        <input
          value={settings.commands.codex}
          onChange={(e) => change('codex', e.target.value)}
          maxLength={80}
        />
      </label>
      <div>
        <button type="submit">명령 저장</button>
        {saved && <small role="status">저장했어요.</small>}
        {error && (
          <small className="inline-error" role="alert">
            {error}
          </small>
        )}
      </div>
    </form>
  );
}
export function SessionChat({
  session,
  onReply,
}: {
  session: ObservedSession;
  onReply: (message: ChatMessage | undefined) => void;
}) {
  const [data, setData] = useState<SessionConversation>();
  const [mode, setMode] = useState<Mode>('ask');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const alive = useRef(true),
    revision = useRef(0),
    mutating = useRef(false);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const messages = data?.messages ?? [];
  const loaded = !!data;
  const pending = messages.some((m) => m.status === 'pending');
  const interactions = data?.interactions ?? [];
  const accept = (next: SessionConversation) => {
    setData(next);
    onReplyRef.current(next.messages.filter((m) => m.role === 'assistant').at(-1));
  };
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        const next = await api<SessionConversation>(`/observed/${session.id}/chat`);
        if (!stopped && !mutating.current && version === revision.current) {
          accept(next);
          setError('');
        }
      } catch (e) {
        if (!stopped && version === revision.current) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [session.id]);
  useEffect(() => {
    if (follow.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);
  const mutate = async (action: () => Promise<SessionConversation>) => {
    mutating.current = true;
    revision.current++;
    setSending(true);
    setError('');
    try {
      const next = await action();
      if (alive.current) accept(next);
      return true;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
      return false;
    } finally {
      mutating.current = false;
      if (alive.current) setSending(false);
    }
  };
  const send = async (text = draft) => {
    if (mode === 'say' && data?.channels?.blockedReason) return;
    if (!text.trim() || pending || mutating.current || !loaded) return;
    follow.current = true;
    const ok = await mutate(() =>
      mode === 'ask'
        ? api<SessionConversation>(`/observed/${session.id}/chat`, { question: text })
        : api<SessionConversation>(`/observed/${session.id}/say`, { text }),
    );
    if (ok) setDraft('');
  };
  const cancel = () =>
    mutate(async () => {
      await api(`/observed/${session.id}/chat/cancel`, {});
      return api<SessionConversation>(`/observed/${session.id}/chat`);
    });
  const answer = (interactionId: string) => (a: Answer) =>
    mutate(() =>
      api<SessionConversation>(`/observed/${session.id}/chat/answer`, { interactionId, answer: a }),
    ).then(() => undefined);
  const name = providerName(session);
  const who = (m: ChatMessage) => {
    const channel = m.channel ?? 'records';
    if (m.role === 'user')
      return channel === 'terminal'
        ? '나 · 터미널 지시'
        : channel === 'direct'
          ? '나 · 직접 지시'
          : '나';
    return channel === 'records' ? `${name} · 기록 답변` : `${name} · 답변`;
  };
  return (
    <section className="session-chat" aria-label="선택한 에이전트와 대화">
      <div className="chat-mode" role="tablist" aria-label="대화 방식">
        <button
          role="tab"
          aria-selected={mode === 'ask'}
          onClick={() => setMode('ask')}
          disabled={sending}
        >
          <MessageCircle size={14} />
          질문 · 기록 기반
        </button>
        <button
          role="tab"
          aria-selected={mode === 'say'}
          onClick={() => setMode('say')}
          disabled={sending || !data?.directAvailable}
        >
          <TerminalSquare size={14} />
          지시 · 실제 실행
        </button>
      </div>
      {mode === 'ask' ? (
        <div className="chat-context">
          <MessageCircle size={16} />
          <div>
            <strong>작업 기록 기반 답변</strong>
            <p>
              선택한 세션의 최근 기록으로 {name}가 답해요. 원래 작업에 명령을 전달하지 않습니다.
            </p>
            <small>질문할 때 로그인된 계정의 모델 사용량이 발생합니다.</small>
          </div>
        </div>
      ) : (
        <div className="chat-context chat-context-say">
          <TerminalSquare size={16} />
          <div>
            <strong>{name}에게 지시하기</strong>
            <p>{data?.channels ? channelNote(data.channels) : '전달 방법을 확인하고 있어요.'}</p>
            <small>내 컴퓨터에서 실행되며 실제 파일을 변경할 수 있어요.</small>
            <details>
              <summary>
                <Settings2 size={13} />
                이어가기 명령 설정
              </summary>
              <DirectSettingsForm />
            </details>
          </div>
        </div>
      )}
      <div
        ref={listRef}
        className="chat-messages"
        onScroll={() => {
          const el = listRef.current;
          if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
        }}
      >
        {loaded && !messages.length && (
          <div className="chat-empty">
            <MessageCircle size={28} />
            <h3>
              {mode === 'ask' ? '이 동료의 작업이 궁금한가요?' : '이 동료에게 할 일을 맡겨보세요'}
            </h3>
            <p>
              {mode === 'ask'
                ? '어떤 일을 했는지, 어디까지 확인했는지 물어보세요.'
                : '터미널에서 치던 말을 그대로 적으면 돼요.'}
            </p>
          </div>
        )}
        {!loaded && !error && <p className="observed-note">대화를 불러오고 있어요…</p>}
        {messages.map((m) => (
          <article key={m.id} className={`chat-message ${m.role} ${m.channel ?? 'records'}`}>
            <div className="chat-message-meta">
              <strong>{who(m)}</strong>
              <time>
                {new Date(m.createdAt).toLocaleTimeString('ko-KR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
            {m.text && <p>{m.text}</p>}
            {m.status === 'pending' && (
              <span className="chat-writing" role="status">
                {m.channel === 'terminal'
                  ? '터미널에서 작업 중'
                  : m.channel === 'direct'
                    ? '지시를 처리하는 중'
                    : '답변 작성 중'}
                <span>···</span>
              </span>
            )}
            {m.status === 'failed' && (
              <p className="inline-error" role="alert">
                {m.error || '답변을 생성하지 못했습니다.'}
              </p>
            )}
            {m.status === 'cancelled' && <small>답변 생성을 중단했어요.</small>}
            {m.role === 'assistant' && m.viaSessionId && (
              <small>연결된 세션 {m.viaSessionId.slice(0, 8)}에서 실행됐어요.</small>
            )}
            {m.role === 'assistant' &&
              (m.channel ?? 'records') === 'records' &&
              m.status !== 'pending' && (
                <details className="chat-evidence">
                  <summary>답변 기준</summary>
                  <span>
                    기록 시각:{' '}
                    {m.contextAt ? new Date(m.contextAt).toLocaleString('ko-KR') : '확인되지 않음'}
                    <br />
                    답변 모델: {m.model || '공급자 기본 모델'} · 최근 최대 24개 이벤트
                  </span>
                </details>
              )}
          </article>
        ))}
      </div>
      {interactions.length > 0 && (
        <div className="chat-interactions" aria-label="지시 중 승인 요청">
          {interactions.map((i) => (
            <InteractionPanel key={i.id} request={i} onAnswer={answer(i.id)} />
          ))}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {mode === 'ask' && (
        <div className="quick-questions">
          {[
            '지금 무슨 작업을 하고 있어?',
            '최근에 어떤 파일을 봤어?',
            '확인된 결과와 남은 일은?',
          ].map((q) => (
            <button key={q} disabled={!loaded || pending || sending} onClick={() => void send(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label={mode === 'ask' ? '에이전트에게 질문' : '동료에게 지시'}
          placeholder={
            mode === 'ask' ? '이 동료의 작업에 대해 물어보세요…' : '이 동료가 할 일을 적어주세요…'
          }
          maxLength={mode === 'ask' ? 4000 : 20000}
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div>
          <small>
            {mode === 'ask'
              ? `최근 기록 기준 · ${draft.length}/4,000`
              : `실제 실행 · ${draft.length}/20,000`}
          </small>
          {pending ? (
            <button type="button" disabled={sending} onClick={() => void cancel()}>
              <Square size={13} />
              {mode === 'ask' ? '답변 중단' : '기다리기 중단'}
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                !loaded ||
                sending ||
                !draft.trim() ||
                (mode === 'say' && !!data?.channels?.blockedReason)
              }
            >
              <Send size={14} />
              {sending ? '보내는 중' : mode === 'ask' ? '질문 보내기' : '지시 보내기'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
