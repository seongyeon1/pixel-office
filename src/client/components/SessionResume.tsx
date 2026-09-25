import { lazy, Suspense, useState } from 'react';
import { GitFork, Maximize2, Minimize2, Play, X } from 'lucide-react';
import { api, ApiError } from '../api';
import type { ObservedSession } from '../../shared/contracts';
import type { TerminalInfo } from '../../shared/workspace';
import './session-resume.css';
const TerminalPane = lazy(() =>
  import('../workspace/TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
const name = (s: ObservedSession) => (s.provider === 'codex' ? 'Codex' : 'Claude');

export function ResumeDock({
  session,
  onClose,
}: {
  session: ObservedSession;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = (mode: 'resume' | 'fork') => () =>
    api<TerminalInfo>(`/observed/${session.id}/resume`, { mode, cols: 100, rows: 30 });
  const recover = () =>
    api<TerminalInfo>(`/observed/${session.id}/terminal`).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
  // Claude reports whether the original process lives; Codex does not, so a recent log counts.
  const running = session.processAlive === true || session.status === 'active';
  return (
    <section
      className={`workspace-dock agent-dock ${expanded ? 'expanded' : ''}`}
      aria-label="세션 이어서 작업"
    >
      <header className="workspace-dock-header">
        <strong>
          {name(session)} · {session.label || session.sessionId.slice(0, 8)} 이어서 작업
        </strong>
        <button
          aria-label={expanded ? '이어서 작업 축소' : '이어서 작업 확대'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
        <button aria-label="이어서 작업 숨기기" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <Suspense fallback={<p role="status">터미널을 불러오는 중…</p>}>
        <TerminalPane
          root={session.cwd || session.projectPath}
          storageKey={`pixel.resume:${session.id}`}
          recover={recover}
          label="세션 이어서 작업 터미널"
          footer="창을 숨기거나 페이지를 떠나도 계속 실행돼요. 터미널 종료를 누르면 끝납니다."
          idle={(start, pending) => (
            <div className="terminal-empty resume-empty">
              <p>
                이 세션의 대화 기록을 그대로 불러와 앱 터미널에서 이어서 작업해요. 권한 승인과
                중단도 터미널에서 직접 할 수 있어요.
              </p>
              <code>{session.cwd || session.projectPath}</code>
              {running && (
                <p className="resume-warning">
                  {session.processAlive === true
                    ? '원래 프로세스가 아직 실행 중이에요. 같은 기록에 두 곳에서 쓰지 않도록 복제해서 이어가요.'
                    : '최근까지 기록이 쌓이고 있어요. 원래 터미널이 아직 열려 있다면 복제해서 이어가는 게 안전해요.'}
                </p>
              )}
              <div className="resume-actions">
                <button
                  className={running ? '' : 'primary'}
                  disabled={pending || running}
                  onClick={() => start(open('resume'))}
                >
                  <Play size={15} />
                  {pending ? '여는 중…' : '이어서 작업'}
                </button>
                <button
                  className={running ? 'primary' : ''}
                  disabled={pending}
                  onClick={() => start(open('fork'))}
                >
                  <GitFork size={15} />
                  복제해서 이어가기
                </button>
              </div>
              <small>
                복제하면 지금까지의 기록을 가진 새 세션이 생기고, 원래 세션은 그대로 남아요. 내
                컴퓨터에서 실행되며 실제 파일을 변경할 수 있어요.
              </small>
            </div>
          )}
        />
      </Suspense>
    </section>
  );
}
