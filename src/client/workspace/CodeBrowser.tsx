import { useEffect, useState } from 'react';
import { ArrowUp, FileCode2, Folder, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { WorkspaceFile, WorkspaceListing } from '../../shared/workspace';
export function CodeBrowser({ root }: { root: string }) {
  const [directory, setDirectory] = useState('');
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [path, setPath] = useState('');
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [treeError, setTreeError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setTreeError('');
    void api<WorkspaceListing>(
      `/workspace/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(directory)}`,
    )
      .then((data) => {
        if (!cancelled) setListing(data);
      })
      .catch((e) => {
        if (!cancelled) setTreeError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [root, directory, refresh]);
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError('');
    if (!path) return;
    setLoading(true);
    void api<WorkspaceFile>(
      `/workspace/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    )
      .then((data) => {
        if (!cancelled) setFile(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, path, refresh]);
  return (
    <div className="code-browser">
      <nav className="file-browser" aria-label="레포 파일">
        <div className="file-browser-toolbar">
          <button
            aria-label="상위 폴더"
            disabled={!directory}
            onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
          >
            <ArrowUp size={16} />
          </button>
          <span title={directory}>{directory || '파일'}</span>
          <button aria-label="코드 새로고침" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={15} />
          </button>
        </div>
        {treeError ? (
          <p role="alert" className="workspace-error">
            {treeError}
          </p>
        ) : !listing ? (
          <p role="status">파일을 불러오는 중…</p>
        ) : (
          <>
            <ul>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    title={entry.path}
                    aria-label={`${entry.kind === 'directory' ? '폴더' : '파일'} ${entry.path}`}
                    aria-current={path === entry.path ? 'page' : undefined}
                    onClick={() =>
                      entry.kind === 'directory' ? setDirectory(entry.path) : setPath(entry.path)
                    }
                  >
                    {entry.kind === 'directory' ? <Folder size={15} /> : <FileCode2 size={15} />}
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
            {!listing.entries.length && <p>표시할 파일이 없습니다.</p>}
            {listing.truncated && <p>처음 500개만 표시합니다.</p>}
          </>
        )}
      </nav>
      <section className="code-viewer" aria-label="코드 미리보기">
        <header>
          <span title={path}>{path || '파일을 선택하세요'}</span>
          <span>읽기 전용</span>
        </header>
        {loading ? (
          <p role="status">코드를 불러오는 중…</p>
        ) : error ? (
          <p className="workspace-error" role="alert">
            {error}
          </p>
        ) : file ? (
          <div className="code-scroll" tabIndex={0} aria-label={file.path}>
            <pre className="line-numbers" aria-hidden="true">
              {file.text
                .split('\n')
                .map((_, i) => i + 1)
                .join('\n')}
            </pre>
            <pre className="source-code">
              <code>{file.text || ' '}</code>
            </pre>
          </div>
        ) : (
          <div className="code-empty">
            <FileCode2 size={28} />
            <p>에이전트와 같은 코드를 살펴보세요.</p>
            <span>폴더를 열고 파일을 선택하세요.</span>
          </div>
        )}
        <footer>UTF-8 · 256 KB 이하 · 환경변수·키 파일과 생성 폴더는 제외</footer>
      </section>
    </div>
  );
}
