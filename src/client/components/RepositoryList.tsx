import { Folder, Check, ChevronRight } from 'lucide-react';
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
          className={selected === p.root ? 'selected' : ''}
          aria-label={`레포 선택 ${p.root}`}
          aria-pressed={selected === p.root}
          onClick={() => onSelect(p.root)}
        >
          <Folder size={18} />
          <span className="repository-description">
            <strong>{repositoryName(p.root)}</strong>
            <small>{p.root}</small>
            <span className="repository-status">
              {p.latestRun && (
                <span className={`presence ${terminal(p.latestRun.status) ? '' : 'working'}`} />
              )}
              {p.observedCount
                ? `외부 세션 ${p.observedCount}개 · 활동 ${p.observedActive ?? 0}개`
                : p.latestRun
                  ? statusLabels[p.latestRun.status]
                  : '새 작업 대기'}{' '}
              · 기록 {p.runCount}개
            </span>
          </span>
          {selected === p.root ? <Check size={16} /> : <ChevronRight size={16} />}
        </button>
      ))}
    </div>
  );
}
