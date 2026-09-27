import { lazy, Suspense, useEffect, useState } from 'react';
import { Code2, BookOpen, Terminal, X, Maximize2, Minimize2 } from 'lucide-react';
import { CodeBrowser } from './CodeBrowser';
import type { Change, Run } from '../../shared/contracts';
const TerminalPane = lazy(() =>
  import('./TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
const tabs = [
  { id: 'code', label: '코드', icon: Code2 },
  { id: 'documents', label: '문서·산출물', icon: BookOpen },
  { id: 'terminal', label: '터미널', icon: Terminal },
] as const;
type Tab = (typeof tabs)[number]['id'];
export interface DocumentTarget {
  root: string;
  path: string;
  request: number;
}
export default function WorkspacePanel({
  root,
  run,
  changes = [],
  document: target,
  onClose,
}: {
  root: string;
  run: Run | null;
  changes?: Change[];
  document?: DocumentTarget;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(root);
  const [tab, setTab] = useState<Tab>('code');
  const [expanded, setExpanded] = useState(false);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [documentsOpened, setDocumentsOpened] = useState(false);
  const [documentPath, setDocumentPath] = useState('');
  const [openRequest, setOpenRequest] = useState(0);
  const activeFolder = folder === root || folder === run?.worktreePath ? folder : root;
  const selectTab = (next: Tab) => {
    setTab(next);
    if (next === 'terminal') setTerminalOpened(true);
    if (next === 'documents') setDocumentsOpened(true);
  };
  useEffect(() => {
    if (!target || (target.root !== root && target.root !== run?.worktreePath)) return;
    setFolder(target.root);
    setDocumentPath(target.path);
    setOpenRequest((n) => n + 1);
    selectTab('documents');
  }, [target, root, run?.worktreePath]);
  const openDocument = (path: string) => {
    setDocumentPath(path);
    setOpenRequest((n) => n + 1);
    selectTab('documents');
  };
  return (
    <section className={`workspace-dock ${expanded ? 'expanded' : ''}`} aria-label="코드와 터미널">
      <header className="workspace-dock-header">
        <div
          role="tablist"
          aria-label="작업 공간 보기"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.findIndex((t) => t.id === tab);
            const next =
              tabs[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
              ].id;
            selectTab(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`#workspace-${next}-tab`)?.focus();
          }}
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`workspace-${id}-tab`}
              role="tab"
              aria-controls={`workspace-${id}-panel`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => selectTab(id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
        <label className="workspace-root">
          작업 폴더
          <select
            aria-label="코드·터미널 작업 폴더"
            value={activeFolder}
            onChange={(e) => {
              setFolder(e.target.value);
              setDocumentPath('');
            }}
          >
            <option value={root}>원본 레포 · {root.split('/').at(-1)}</option>
            {run?.worktreePath && (
              <option value={run.worktreePath}>앱 작업 폴더 · {run.branch}</option>
            )}
          </select>
        </label>
        <button
          aria-label={expanded ? '작업 공간 축소' : '작업 공간 확대'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
        <button aria-label="작업 공간 닫기" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="workspace-root-path" title={activeFolder}>
        {activeFolder}
      </div>
      <div
        id="workspace-code-panel"
        role="tabpanel"
        aria-labelledby="workspace-code-tab"
        hidden={tab !== 'code'}
      >
        <CodeBrowser key={activeFolder} root={activeFolder} onDocument={openDocument} />
      </div>
      <div
        id="workspace-documents-panel"
        role="tabpanel"
        aria-labelledby="workspace-documents-tab"
        hidden={tab !== 'documents'}
      >
        {documentsOpened && (
          <CodeBrowser
            key={activeFolder}
            root={activeFolder}
            documents
            active={tab === 'documents'}
            initialPath={documentPath}
            openRequest={openRequest}
            changes={activeFolder === run?.worktreePath ? changes : []}
          />
        )}
      </div>
      <div
        id="workspace-terminal-panel"
        role="tabpanel"
        aria-labelledby="workspace-terminal-tab"
        hidden={tab !== 'terminal'}
      >
        {terminalOpened && (
          <Suspense fallback={<p role="status">터미널을 불러오는 중…</p>}>
            <TerminalPane key={activeFolder} root={activeFolder} />
          </Suspense>
        )}
      </div>
    </section>
  );
}
