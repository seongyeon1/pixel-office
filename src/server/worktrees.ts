import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { Store } from './store.js';
import { terminal, type Run } from '../shared/contracts.js';
import type { WorktreeCleanupEntry } from '../shared/worktrees.js';
import { git } from './projects.js';

export const containsFolder = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

// A bundle conversation runs above its member repositories. An unrelated parent repo
// (including Pixel Office itself, whose .pixel directory stores worktrees) is not that bundle.
const canonicalFolder = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
export const usesWorktree = (path: string, cwd: string, runs: Run[]) => {
  const target = canonicalFolder(path),
    current = canonicalFolder(cwd);
  return (
    containsFolder(target, current) ||
    runs.some(
      (run) =>
        run.repos?.some((repo) => canonicalFolder(repo.worktreePath) === target) &&
        containsFolder(canonicalFolder(run.worktreePath), current) &&
        containsFolder(current, target),
    )
  );
};

// Only persisted app-created linked worktrees are candidates. Never recursively rm a supplied path.
export function createWorktreeCleanup(store: Store, busy: (path: string) => string | undefined) {
  const removing = new Set<string>();
  const assertAvailable = (path: string) => {
    if ([...removing].some((p) => containsFolder(p, path) || containsFolder(path, p)))
      throw new Error('이 작업 폴더를 정리 중이에요. 정리가 끝난 뒤 새 작업을 시작해주세요.');
  };
  const candidates = () => {
    const entries = new Map<string, WorktreeCleanupEntry>();
    for (const run of store.cleanupRuns()) {
      const repos = run.repos ?? [
        { root: run.projectPath, worktreePath: run.worktreePath, branch: run.branch },
      ];
      for (const repo of repos) {
        if (
          run.removedWorktrees?.includes(repo.worktreePath) ||
          repo.root === repo.worktreePath ||
          !repo.branch.startsWith('pixel/')
        )
          continue;
        const item = entries.get(repo.worktreePath) ?? {
          path: repo.worktreePath,
          repository: repo.root,
          branch: repo.branch,
          prompt: run.prompt,
          runIds: [],
          changes: [],
          changedFiles: 0,
        };
        item.runIds.push(run.id);
        if (!terminal(run.status))
          item.blockedReason = '이 폴더를 사용하는 앱 작업이 진행 중이에요.';
        entries.set(item.path, item);
      }
    }
    return entries;
  };
  const inspect = async (item: WorktreeCleanupEntry) => {
    const path = await realpath(item.path).catch(() => null);
    if (!path) return undefined;
    const root = await realpath(item.repository);
    if (path === root || !(await lstat(`${path}/.git`)).isFile())
      throw new Error('원본 저장소는 정리할 수 없습니다.');
    const records = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
    const record = records.find((r) => r.split('\0')[0] === `worktree ${path}`);
    if (!record) throw new Error('이 저장소에 등록된 앱 작업 폴더가 아닙니다.');
    const fields = record.split('\0');
    if (fields.some((f) => f === 'detached'))
      item.blockedReason = '브랜치에 연결되지 않은 커밋이 있어요. 먼저 브랜치를 만들어주세요.';
    if (fields.some((f) => f.startsWith('locked')))
      item.blockedReason = 'Git에서 잠긴 작업 폴더입니다. 잠금을 먼저 확인해주세요.';
    item.branch =
      fields
        .find((f) => f.startsWith('branch '))
        ?.slice(7)
        .replace(/^refs\/heads\//, '') ?? item.branch;
    const changes = (
      await git(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])
    )
      .trimEnd()
      .split('\n')
      .filter(Boolean);
    item.changedFiles = changes.length;
    item.changes = changes.slice(0, 40);
    item.blockedReason ||= busy(item.path) || busy(path);
    return item;
  };
  return {
    assertAvailable,
    async list() {
      const items: WorktreeCleanupEntry[] = [];
      for (const item of candidates().values()) {
        try {
          const checked = await inspect(item);
          if (checked) items.push(checked);
        } catch {
          items.push({
            ...item,
            blockedReason: '작업 폴더 상태를 확인할 수 없어 정리할 수 없습니다.',
          });
        }
      }
      return items;
    },
    async remove(path: string, discardChanges = false) {
      assertAvailable(path);
      const candidate = candidates().get(path);
      if (!candidate) throw new Error('앱에서 만든 작업 폴더만 정리할 수 있습니다.');
      removing.add(path);
      let canonical = path;
      try {
        canonical = await realpath(path);
        removing.add(canonical);
        const item = await inspect(candidate);
        if (!item) throw new Error('이미 정리되었거나 찾을 수 없는 작업 폴더입니다.');
        if (item.blockedReason) throw new Error(item.blockedReason);
        if (item.changedFiles && !discardChanges)
          throw new Error(
            '커밋하지 않은 변경이나 추가 파일이 있어요. 삭제 여부를 직접 확인해주세요.',
          );
        // Recheck after asynchronous filesystem/Git reads, immediately before removal.
        const active = candidates().get(path)?.blockedReason || busy(path) || busy(canonical);
        if (active) throw new Error(active);
        await git(item.repository, [
          'worktree',
          'remove',
          ...(discardChanges ? ['--force'] : []),
          '--',
          path,
        ]);
        for (const run of store.cleanupRuns()) {
          const paths = run.repos?.map((r) => r.worktreePath) ?? [run.worktreePath];
          if (paths.includes(path))
            store.updateRun(run.id, {
              removedWorktrees: [...new Set([...(run.removedWorktrees ?? []), path])],
            });
        }
        return { path, branch: item.branch, removed: true };
      } finally {
        removing.delete(path);
        removing.delete(canonical);
      }
    },
  };
}
