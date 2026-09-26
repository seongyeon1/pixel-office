import { Folder, FolderX, Check, ChevronRight } from 'lucide-react';
import { statusLabels, terminal, type ProjectSummary } from '../../shared/contracts';
export const repositoryName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
export function RepositoryList({
  projects,
  selected,
  onSelect,
}: {
  projects: ProjectSummary[];
  selected?: string;
  onSelect: (root: string) => void;
}) {
  if (!projects.length) return null;
  return (
    <div className="repository-list" aria-label="연결된 레포">
      {projects.map((p) => (
        <button
          type="button"
          key={p.root}
          className={[selected === p.root ? 'selected' : '', p.unavailable ? 'unavailable' : '']
            .filter(Boolean)
            .join(' ')}
          aria-label={`레포 선택 ${p.root}`}
          aria-pressed={selected === p.root}
          aria-describedby={p.unavailable ? `repository-issue-${p.root}` : undefined}
          onClick={() => onSelect(p.root)}
        >
          {p.unavailable ? <FolderX size={18} /> : <Folder size={18} />}
          <span className="repository-description">
            <strong>{repositoryName(p.root)}</strong>
            <small>{p.root}</small>
            {/* Seen in session logs but not a repository (e.g. a folder holding several clones):
                sessions are still visible here, but no run can start. */}
            {p.unavailable ? (
              <span className="repository-status warning" id={`repository-issue-${p.root}`}>
                {p.unavailable} 세션만 관측된 폴더예요.
              </span>
            ) : (
              <span className="repository-status">
                {p.latestRun && (
                  <span className={`presence ${terminal(p.latestRun.status) ? '' : 'working'}`} />
                )}
                {p.repositoryCount ? `저장소 ${p.repositoryCount}개 묶음 · ` : ''}
                {p.observedCount
                  ? `외부 세션 ${p.observedCount}개 · 활동 ${p.observedActive ?? 0}개`
                  : p.latestRun
                    ? statusLabels[p.latestRun.status]
                    : '새 작업 대기'}{' '}
                · 기록 {p.runCount}개
              </span>
            )}
          </span>
          {selected === p.root ? <Check size={16} /> : <ChevronRight size={16} />}
        </button>
      ))}
    </div>
  );
}
