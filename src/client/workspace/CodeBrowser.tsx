import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ArrowUp, FileCode2, Folder, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { WorkspaceFile, WorkspaceListing } from '../../shared/workspace';
import type { Change } from '../../shared/contracts';
import { isMarkdown } from '../../shared/documents';
const DocumentPreview = lazy(() => import('./DocumentPreview'));
export function CodeBrowser({
  root,
  documents = false,
  active = true,
  initialPath = '',
  openRequest = 0,
  changes = [],
  onDocument,
}: {
  root: string;
  documents?: boolean;
  active?: boolean;
  initialPath?: string;
  openRequest?: number;
  changes?: Change[];
  onDocument?: (path: string) => void;
}) {
  const [directory, setDirectory] = useState(initialPath.split('/').slice(0, -1).join('/'));
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [hash, setHash] = useState('');
  const [live, setLive] = useState(true);
  const openDocument = useCallback((next: string, anchor = '') => {
    setPath(next);
    setHash(anchor);
    setDirectory(next.split('/').slice(0, -1).join('/'));
  }, []);
  useEffect(() => {
    if (initialPath) openDocument(initialPath);
  }, [initialPath, openRequest, openDocument]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [treeError, setTreeError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setTreeError('');
    const fetchListing = () =>
      api<WorkspaceListing>(
        `/workspace/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(directory)}`,
      )
        .then((data) => {
          if (!cancelled) {
            setListing(data);
            setTreeError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setTreeError(e.message);
        });
    void fetchListing();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'hidden') await fetchListing();
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    if (documents && live && active) timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [root, directory, refresh, documents, live, active]);
  useEffect(() => {
    let cancelled = false;
    setFile((previous) => (previous?.path === path ? previous : null));
    setError('');
    if (!path) return;
    setLoading(!file || file.path !== path);
    const fetchFile = () =>
      api<WorkspaceFile>(
        `/workspace/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
      )
        .then((data) => {
          if (!cancelled) {
            setFile((previous) =>
              previous?.text === data.text && previous.path === data.path ? previous : data,
            );
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e.message);
            setFile(null);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    void fetchFile();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'hidden') await fetchFile();
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    if (documents && live && active) timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [root, path, refresh, documents, live, active]);
  return (
    <div className={`code-browser ${documents ? 'documents-browser' : ''}`}>
      <nav className="file-browser" aria-label={documents ? '문서 파일' : '레포 파일'}>
        <div className="file-browser-toolbar">
          <button
            aria-label="상위 폴더"
            disabled={!directory}
            onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
          >
            <ArrowUp size={16} />
          </button>
          <span title={directory}>{directory || '파일'}</span>
          <button
            aria-label={documents ? '문서 새로고침' : '코드 새로고침'}
            onClick={() => setRefresh((n) => n + 1)}
          >
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
              {listing.entries
                .filter(
                  (entry) => !documents || entry.kind === 'directory' || isMarkdown(entry.path),
                )
                .map((entry) => (
                  <li key={entry.path}>
                    <button
                      title={entry.path}
                      aria-label={`${entry.kind === 'directory' ? '폴더' : '파일'} ${entry.path}`}
                      aria-current={path === entry.path ? 'page' : undefined}
                      onClick={() =>
                        entry.kind === 'directory'
                          ? setDirectory(entry.path)
                          : openDocument(entry.path)
                      }
                    >
                      {entry.kind === 'directory' ? <Folder size={15} /> : <FileCode2 size={15} />}
                      {entry.name}
                    </button>
                  </li>
                ))}
            </ul>
            {!listing.entries.some(
              (entry) => !documents || entry.kind === 'directory' || isMarkdown(entry.path),
            ) && (
              <p>
                {documents ? '이 폴더에는 Markdown 문서가 없습니다.' : '표시할 파일이 없습니다.'}
              </p>
            )}
            {listing.truncated && <p>처음 500개만 표시합니다.</p>}
          </>
        )}
      </nav>
      <section className="code-viewer" aria-label={documents ? '문서 읽기' : '코드 미리보기'}>
        <header>
          <span title={path}>{path || '파일을 선택하세요'}</span>
          {documents ? (
            <label className="document-live">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              자동 갱신
            </label>
          ) : (
            <span>읽기 전용</span>
          )}
          {!documents && file && isMarkdown(path) && onDocument && (
            <button onClick={() => onDocument(path)}>문서로 보기</button>
          )}
        </header>
        {loading ? (
          <p role="status">코드를 불러오는 중…</p>
        ) : error ? (
          <p className="workspace-error" role="alert">
            {error}
          </p>
        ) : file && documents ? (
          <Suspense fallback={<p role="status">문서를 불러오는 중…</p>}>
            <DocumentPreview
              key={path}
              root={root}
              path={path}
              text={file.text}
              hash={hash}
              change={changes.find((c) => c.path === path)}
              onOpen={openDocument}
            />
          </Suspense>
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
            <p>
              {documents ? '작성한 문서를 읽고 검토하세요.' : '에이전트와 같은 코드를 살펴보세요.'}
            </p>
            <span>
              {documents
                ? '폴더에서 Markdown 문서를 선택하세요.'
                : '폴더를 열고 파일을 선택하세요.'}
            </span>
          </div>
        )}
        <footer>
          {documents
            ? 'Markdown · 읽기 전용 · 256 KB 이하 · 이미지 5 MB 이하'
            : 'UTF-8 · 256 KB 이하 · 환경변수·키 파일과 생성 폴더는 제외'}
        </footer>
      </section>
    </div>
  );
}
