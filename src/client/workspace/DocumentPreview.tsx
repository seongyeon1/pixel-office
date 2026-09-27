import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { documentReference, isMarkdown } from '../../shared/documents';
import type { Change } from '../../shared/contracts';

let mermaidReady: Promise<(typeof import('mermaid'))['default']> | undefined;
function MermaidDiagram({ code }: { code: string }) {
  const [result, setResult] = useState<{ code: string; svg?: string; failed?: boolean }>();
  useEffect(() => {
    let cancelled = false;
    mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        suppressErrorRendering: true,
        maxTextSize: 50000,
        theme: 'neutral',
        secure: [
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'suppressErrorRendering',
          'htmlLabels',
        ],
      });
      return mermaid;
    });
    void mermaidReady
      .then((mermaid) => mermaid.render(`diagram-${crypto.randomUUID()}`, code))
      .then(({ svg }) => {
        const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        if (!cancelled) setResult({ code, svg: safe });
      })
      .catch(() => {
        if (!cancelled) setResult({ code, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (result?.code !== code) return <span role="status">다이어그램을 그리는 중…</span>;
  if (result.failed)
    return (
      <span className="diagram-error">
        <span>다이어그램을 표시할 수 없어 원문을 보여드려요.</span>
        <code>{code}</code>
      </span>
    );
  return (
    <span
      className="document-diagram"
      role="img"
      aria-label="Mermaid 다이어그램"
      dangerouslySetInnerHTML={{ __html: result.svg! }}
    />
  );
}
const headingId = (text: string) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');
function plainText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(plainText).join('');
  if (children && typeof children === 'object' && 'props' in children)
    return plainText((children.props as { children?: ReactNode }).children);
  return '';
}
export default function DocumentPreview({
  root,
  path,
  text,
  hash,
  change,
  onOpen,
}: {
  root: string;
  path: string;
  text: string;
  hash?: string;
  change?: Change;
  onOpen: (path: string, hash?: string) => void;
}) {
  const [mode, setMode] = useState<'preview' | 'source' | 'diff'>('preview');
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    if (hash && mode === 'preview')
      article.current
        ?.querySelector(`#${CSS.escape(`document-${hash}`)}`)
        ?.scrollIntoView({ block: 'start' });
  }, [hash, mode]);
  // Stable renderers preserve diagram state and reading position during live refreshes.
  const components = useMemo<import('react-markdown').Components>(() => {
    const heading =
      (tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
      ({ children }: { children?: ReactNode }) => {
        const Tag = tag;
        return <Tag id={`document-${headingId(plainText(children))}`}>{children}</Tag>;
      };
    return {
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      h5: heading('h5'),
      h6: heading('h6'),
      code({ className, children, ...props }) {
        if (className === 'language-mermaid')
          return <MermaidDiagram code={String(children).trimEnd()} />;
        const { node, ...rest } = props;
        return (
          <code {...rest} className={className}>
            {children}
          </code>
        );
      },
      a({ href, children }) {
        if (!href) return <span>{children}</span>;
        if (/^(https?:|mailto:)/i.test(href))
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        const ref = documentReference(path, href);
        if (!ref || !isMarkdown(ref.path))
          return <span title="문서 미리보기에서 열 수 없는 링크입니다.">{children}</span>;
        return (
          <a
            href={`#document-${ref.hash}`}
            onClick={(event) => {
              event.preventDefault();
              if (ref.path !== path) onOpen(ref.path, ref.hash);
              else if (ref.hash)
                article.current
                  ?.querySelector(`#${CSS.escape(`document-${ref.hash}`)}`)
                  ?.scrollIntoView({ block: 'start' });
            }}
          >
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        if (typeof src !== 'string' || !src) return <span>{alt}</span>;
        const ref = documentReference(path, src);
        const url = ref
          ? `/api/workspace/image?root=${encodeURIComponent(root)}&path=${encodeURIComponent(ref.path)}`
          : /^https?:\/\//i.test(src)
            ? src
            : undefined;
        return url ? (
          <img src={url} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span>{alt}</span>
        );
      },
    };
  }, [root, path, onOpen]);
  return (
    <div className="document-reader">
      <div className="document-modes" role="group" aria-label="문서 표시 방식">
        {(
          [
            ['preview', '미리보기'],
            ['source', '원문'],
            ['diff', '변경 비교'],
          ] as const
        ).map(([value, label]) => (
          <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'preview' ? (
        <article ref={article} className="document-prose" aria-label="문서 미리보기" tabIndex={0}>
          <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
            {text || '*빈 문서입니다.*'}
          </Markdown>
        </article>
      ) : mode === 'source' ? (
        <pre className="document-source" tabIndex={0}>
          {text || ' '}
        </pre>
      ) : change ? (
        <div className="document-diff" tabIndex={0}>
          <pre>{change.diff}</pre>
          {change.truncated && <p>변경 내용 일부만 표시합니다.</p>}
        </div>
      ) : (
        <p className="document-empty">
          이 문서의 앱 작업 변경 내역이 없습니다. 원본은 원문 탭에서 볼 수 있어요.
        </p>
      )}
    </div>
  );
}
