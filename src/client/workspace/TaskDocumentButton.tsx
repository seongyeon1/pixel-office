import { lazy, Suspense, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { ObservedSession, Run } from '../../shared/contracts';
const TaskDocuments = lazy(() => import('./TaskDocuments'));
export type TaskDocumentSource =
  { kind: 'run'; run: Run } | { kind: 'session'; session: ObservedSession };
export function TaskDocumentButton({ source }: { source: TaskDocumentSource }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <>
      <button ref={trigger} className="task-document-button" onClick={() => setOpen(true)}>
        <BookOpen size={16} />
        작업 문서 보기
      </button>
      {open && (
        <Suspense fallback={<p role="status">문서를 여는 중…</p>}>
          <TaskDocuments source={source} onClose={close} />
        </Suspense>
      )}
    </>
  );
}
