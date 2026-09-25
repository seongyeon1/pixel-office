import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Square } from 'lucide-react';
import type { ChatMessage, ObservedSession, SessionConversation } from '../../shared/contracts';
import { api } from '../api';
export function SessionChat({
  session,
  onReply,
}: {
  session: ObservedSession;
  onReply: (message: ChatMessage | undefined) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const alive = useRef(true),
    revision = useRef(0),
    mutating = useRef(false);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pending = messages.some((m) => m.status === 'pending');
  const accept = (data: SessionConversation) => {
    setMessages(data.messages);
    setLoaded(true);
    onReplyRef.current(data.messages.filter((m) => m.role === 'assistant').at(-1));
  };
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        const data = await api<SessionConversation>(`/observed/${session.id}/chat`);
        if (!stopped && !mutating.current && version === revision.current) {
          accept(data);
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
  const send = async (text = question) => {
    if (!text.trim() || pending || mutating.current || !loaded) return;
    mutating.current = true;
    revision.current++;
    setSending(true);
    setError('');
    follow.current = true;
    try {
      const data = await api<SessionConversation>(`/observed/${session.id}/chat`, {
        question: text,
      });
      if (alive.current) {
        accept(data);
        setQuestion('');
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      mutating.current = false;
      if (alive.current) setSending(false);
    }
  };
  const cancel = async () => {
    mutating.current = true;
    revision.current++;
    setSending(true);
    try {
      await api(`/observed/${session.id}/chat/cancel`, {});
      const data = await api<SessionConversation>(`/observed/${session.id}/chat`);
      if (alive.current) accept(data);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      mutating.current = false;
      if (alive.current) setSending(false);
    }
  };
  return (
    <section className="session-chat" aria-label="선택한 에이전트와 대화">
      <div className="chat-context">
        <MessageCircle size={16} />
        <div>
          <strong>작업 기록 기반 답변</strong>
          <p>
            선택한 세션의 최근 기록으로 {session.provider === 'codex' ? 'Codex' : 'Claude'}가
            답해요. 원래 작업에 명령을 전달하지 않습니다.
          </p>
          <small>질문할 때 로그인된 계정의 모델 사용량이 발생합니다.</small>
        </div>
      </div>
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
            <h3>이 동료의 작업이 궁금한가요?</h3>
            <p>어떤 일을 했는지, 어디까지 확인했는지 물어보세요.</p>
          </div>
        )}
        {!loaded && !error && <p className="observed-note">대화를 불러오고 있어요…</p>}
        {messages.map((m) => (
          <article key={m.id} className={`chat-message ${m.role}`}>
            <div className="chat-message-meta">
              <strong>
                {m.role === 'user'
                  ? '나'
                  : `${session.provider === 'codex' ? 'Codex' : 'Claude'} · 기록 답변`}
              </strong>
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
                답변 작성 중<span>···</span>
              </span>
            )}
            {m.status === 'failed' && (
              <p className="inline-error" role="alert">
                {m.error || '답변을 생성하지 못했습니다.'}
              </p>
            )}
            {m.status === 'cancelled' && <small>답변 생성을 중단했어요.</small>}
            {m.role === 'assistant' && m.status !== 'pending' && (
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
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
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
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="에이전트에게 질문"
          placeholder="이 동료의 작업에 대해 물어보세요…"
          maxLength={4000}
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div>
          <small>최근 기록 기준 · {question.length}/4,000</small>
          {pending ? (
            <button type="button" disabled={sending} onClick={() => void cancel()}>
              <Square size={13} />
              답변 중단
            </button>
          ) : (
            <button type="submit" disabled={!loaded || sending || !question.trim()}>
              <Send size={14} />
              {sending ? '보내는 중' : '질문 보내기'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
