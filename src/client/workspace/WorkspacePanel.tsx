import { lazy, Suspense, useState } from 'react';
import { Code2, Terminal, X, Maximize2, Minimize2 } from 'lucide-react';
import { CodeBrowser } from './CodeBrowser';
import type { Run } from '../../shared/contracts';
const TerminalPane = lazy(() =>
  import('./TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
export default function WorkspacePanel({
  root,
  run,
  onClose,
}: {
  root: string;
  run: Run | null;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(root);
  const [tab, setTab] = useState<'code' | 'terminal'>('code');
  const [expanded, setExpanded] = useState(false);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const activeFolder = folder === root || folder === run?.worktreePath ? folder : root;
  return (
    <section className={`workspace-dock ${expanded ? 'expanded' : ''}`} aria-label="코드와 터미널">
      <header className="workspace-dock-header">
        <div
          role="tablist"
          aria-label="작업 공간 보기"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 'code'
                : event.key === 'End'
                  ? 'terminal'
                  : tab === 'code'
                    ? 'terminal'
                    : 'code';
            setTab(next);
            if (next === 'terminal') setTerminalOpened(true);
            event.currentTarget.querySelector<HTMLButtonElement>(`#workspace-${next}-tab`)?.focus();
          }}
        >
          <button
            id="workspace-code-tab"
            role="tab"
            aria-controls="workspace-code-panel"
            aria-selected={tab === 'code'}
            tabIndex={tab === 'code' ? 0 : -1}
            onClick={() => setTab('code')}
          >
            <Code2 size={17} />
            코드
          </button>
          <button
            id="workspace-terminal-tab"
            role="tab"
            aria-controls="workspace-terminal-panel"
            aria-selected={tab === 'terminal'}
            tabIndex={tab === 'terminal' ? 0 : -1}
            onClick={() => {
              setTab('terminal');
              setTerminalOpened(true);
            }}
          >
            <Terminal size={17} />
            터미널
          </button>
        </div>
        <label className="workspace-root">
          작업 폴더
          <select
            aria-label="코드·터미널 작업 폴더"
            value={activeFolder}
            onChange={(e) => setFolder(e.target.value)}
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
        <CodeBrowser key={activeFolder} root={activeFolder} />
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
