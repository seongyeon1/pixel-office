import { useState } from 'react';
import { MessageCircle, ShieldCheck } from 'lucide-react';
import type { Answer, Interaction } from '../../shared/contracts';
export function InteractionPanel({
  request,
  onAnswer,
}: {
  request: Interaction;
  onAnswer: (a: Answer) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (a: Answer) => {
    setBusy(true);
    try {
      await onAnswer(a);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const questions = (Array.isArray(request.details.questions) ? request.details.questions : []) as {
    id?: string;
    question?: string;
    header?: string;
    options?: { label: string; description?: string }[];
    isOther?: boolean;
    multiSelect?: boolean;
  }[];
  return (
    <section className="interaction">
      <h4>
        {request.kind === 'approval' ? <ShieldCheck size={17} /> : <MessageCircle size={17} />}{' '}
        {request.kind === 'approval' ? '승인 필요' : '답변을 기다리고 있어요'}
      </h4>
      <p>{request.title}</p>
      {request.kind === 'approval' ? (
        <>
          <details>
            <summary>작업 내용 확인</summary>
            <pre>{JSON.stringify(request.details, null, 2)}</pre>
          </details>
          <div className="button-row">
            <button disabled={busy} onClick={() => void send({ decision: 'deny' })}>
              거절
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void send({ decision: 'approve' })}
            >
              승인
            </button>
          </div>
        </>
      ) : (
        <>
          {questions.map((q, i) => {
            const key = q.id ?? q.question ?? String(i);
            return (
              <fieldset key={key}>
                <legend>{q.question ?? q.header}</legend>
                {q.options?.map((o) => (
                  <label className="question-option" key={o.label}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={key}
                      checked={(answers[key] ?? []).includes(o.label)}
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [key]: q.multiSelect
                            ? e.target.checked
                              ? [...(answers[key] ?? []), o.label]
                              : (answers[key] ?? []).filter((a) => a !== o.label)
                            : [o.label],
                        })
                      }
                    />
                    <span>
                      {o.label}
                      <small>{o.description}</small>
                    </span>
                  </label>
                ))}
                <input
                  aria-label={`${q.question ?? q.header ?? '질문'} 직접 답변`}
                  placeholder="직접 답변 입력"
                  onChange={(e) => setAnswers({ ...answers, [key]: [e.target.value] })}
                />
              </fieldset>
            );
          })}
          <button
            className="primary"
            disabled={
              busy ||
              questions.some(
                (q, i) => !(answers[q.id ?? q.question ?? String(i)] ?? []).some(Boolean),
              )
            }
            onClick={() => void send({ answers })}
          >
            답변 보내기
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
