import { useState } from 'react';
import type { Answer } from '../../shared/contracts';
import type { BoardRow } from './team';

const sourceLabel: Record<BoardRow['source'], string> = {
  slack: 'Slack',
  office: '오피스',
  terminal: '터미널',
};
const opener = (row: BoardRow) =>
  row.source === 'terminal' && !row.interaction ? '터미널에서 확인' : '열어서 답하기';
function BoardItem({
  row,
  selected,
  onHover,
  onOpen,
  onAnswer,
}: {
  row: BoardRow;
  selected: boolean;
  onHover: (workerId?: string) => void;
  onOpen: (row: BoardRow) => void;
  onAnswer: (interactionId: string, answer: Answer) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const answer = async (decision: 'approve' | 'deny') => {
    setPending(true);
    setError('');
    try {
      await onAnswer(row.interaction!.id, { decision });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <li
      className={`work-board-row ${row.waiting ? 'waiting' : ''} ${selected ? 'highlight' : ''}`}
      data-worker-id={row.workerId}
      onMouseEnter={() => onHover(row.workerId)}
      onMouseLeave={() => onHover(undefined)}
      onFocus={() => onHover(row.workerId)}
      onBlur={() => onHover(undefined)}
    >
      <button className="work-board-open" title={row.task} onClick={() => onOpen(row)}>
        <span className="work-board-task">
          <strong>{row.task}</strong>
          <span className={`work-board-source ${row.source}`}>{sourceLabel[row.source]}</span>
        </span>
        <span className="work-board-now">
          {row.owner} · <span className={row.waiting ? 'wait' : 'now'}>{row.action}</span>
        </span>
      </button>
      {row.interaction?.kind === 'approval' ? (
        <div className="work-board-actions">
          <button
            className="primary"
            aria-label={`${row.task} 승인`}
            disabled={pending}
            onClick={() => void answer('approve')}
          >
            승인
          </button>
          <button
            aria-label={`${row.task} 거절`}
            disabled={pending}
            onClick={() => void answer('deny')}
          >
            거절
          </button>
        </div>
      ) : (
        row.waiting && (
          // Questions take an answer form, and the app cannot answer a prompt in someone's
          // terminal: both open the work instead.
          <div className="work-board-actions">
            <button aria-label={`${row.task} ${opener(row)}`} onClick={() => onOpen(row)}>
              {opener(row)}
            </button>
          </div>
        )
      )}
      {error && (
        <small className="inline-error" role="alert">
          {error}
        </small>
      )}
    </li>
  );
}
// The "지금 진행 중" board: work waiting on a person first, then everything else in progress.
export function WorkBoard({
  rows,
  selectedId,
  selectedRoom,
  onHover,
  onOpen,
  onAnswer,
}: {
  rows: BoardRow[];
  selectedId?: string;
  // A room picked on the map lights up every row of work in it.
  selectedRoom?: string;
  onHover: (workerId?: string) => void;
  onOpen: (row: BoardRow) => void;
  onAnswer: (interactionId: string, answer: Answer) => Promise<void>;
}) {
  const groups = [
    { title: '승인 필요', rows: rows.filter((r) => r.waiting) },
    { title: '진행 중', rows: rows.filter((r) => !r.waiting) },
  ].filter((g) => g.rows.length);
  return (
    <aside className="work-board" aria-label="지금 진행 중인 일">
      <h2>
        지금 진행 중 <strong>{rows.length}</strong>
      </h2>
      {!rows.length && <p className="work-board-empty">지금 진행 중인 일이 없어요</p>}
      {groups.map((g) => (
        <section key={g.title} className={g.rows[0].waiting ? 'waiting' : ''}>
          <h3>{g.title}</h3>
          <ul>
            {g.rows.map((row) => (
              <BoardItem
                key={row.id}
                row={row}
                // A sign inside the room is the narrower pick and wins over its room.
                selected={selectedId ? row.workerId === selectedId : row.root === selectedRoom}
                onHover={onHover}
                onOpen={onOpen}
                onAnswer={onAnswer}
              />
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
