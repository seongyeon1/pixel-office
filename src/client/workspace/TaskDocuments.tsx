import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Change, ObservedDetail, OfficeEvent } from '../../shared/contracts';
import { runDocuments, sessionDocuments } from '../../shared/task-documents';
import { CodeBrowser } from './CodeBrowser';
import type { TaskDocumentSource } from './TaskDocumentButton';
export default function TaskDocuments({
  source,
  onClose,
}: {
  source: TaskDocumentSource;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [all, setAll] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<{ paths: string[]; changes: Change[] }>();
  const [error, setError] = useState('');
  const run = source.kind === 'run' ? source.run : undefined;
  const session = source.kind === 'session' ? source.session : undefined;
  const id = run?.id ?? session!.id;
  const root = run?.worktreePath ?? session!.projectPath;
  const prompt = run?.prompt ?? session!.prompt;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const events: OfficeEvent[] = [];
    setData(undefined);
    setError('');
    const poll = async () => {
      try {
        if (source.kind === 'run') {
          // Read all pages on opening, then only new events on subsequent polls.
          // Existing servers can supply these records without a service restart.
          let page: OfficeEvent[];
          do {
            page = await api<OfficeEvent[]>(
              `/runs/${id}/events?after=${events.at(-1)?.sequence ?? 0}`,
            );
            if (stopped) return;
            events.push(...page);
          } while (page.length === 200);
          const changes = await api<Change[]>(`/runs/${id}/changes`);
          if (!stopped) setData({ paths: runDocuments(source.run, events, changes), changes });
        } else {
          const detail = await api<ObservedDetail>(`/observed/${id}`);
          if (!stopped)
            setData({ paths: sessionDocuments(detail, all).map((d) => d.path), changes: [] });
        }
        if (!stopped) setError('');
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source.kind, id, all, refresh]);
  return createPortal(
    <dialog
      ref={dialog}
      className="task-documents-dialog"
      aria-labelledby="task-documents-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="task-documents-surface">
        <header className="task-documents-heading">
          <div>
            <h2 id="task-documents-title">이 작업의 문서</h2>
            <p>{prompt || '선택한 동료의 작업'}</p>
          </div>
          <button aria-label="작업 문서 닫기" onClick={onClose} autoFocus>
            <X size={20} />
          </button>
        </header>
        <div className="task-documents-context">
          {session ? (
            <label>
              작업 범위
              <select
                aria-label="문서 작업 범위"
                value={all ? 'session' : 'latest'}
                onChange={(e) => setAll(e.target.value === 'session')}
              >
                <option value="latest">최근 요청</option>
                <option value="session">이 세션 전체</option>
              </select>
            </label>
          ) : (
            <span>
              이 작업에서 변경하거나 답변에 연결한 문서 {data ? `${data.paths.length}개` : ''}
            </span>
          )}
          <button onClick={() => setRefresh((n) => n + 1)}>목록 새로고침</button>
        </div>
        {session && (
          <p className="task-documents-note">
            작성 도구 기록과 답변에 연결된 문서입니다. 현재 저장된 내용을 보여줍니다.
          </p>
        )}
        {error ? (
          <div className="document-empty" role="alert">
            {error}
          </div>
        ) : !data ? (
          <p className="document-empty" role="status">
            작업 문서를 찾는 중…
          </p>
        ) : data.paths.length ? (
          <CodeBrowser
            key={`${id}:${all}`}
            root={root}
            documents
            initialPath={data.paths[0]}
            documentPaths={data.paths}
            changes={data.changes}
          />
        ) : (
          <div className="task-documents-empty">
            <h3>아직 연결된 문서가 없어요</h3>
            <p>
              {session
                ? '최근 요청의 기록에서 Markdown 문서를 찾지 못했어요. 이전에 작성한 문서는 ‘이 세션 전체’에서 확인하세요.'
                : '이 작업에서 변경하거나 답변에 연결한 Markdown 문서가 생기면 여기에 표시됩니다.'}
            </p>
          </div>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
