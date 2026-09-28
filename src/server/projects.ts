import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdir, lstat, readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, dirname, basename, sep } from 'node:path';
import type { Change, RepositoryEntry, RunRepo } from '../shared/contracts.js';
const exec = promisify(execFile);
export const git = async (cwd: string, args: string[]) =>
  (await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 20000 })).stdout;
// The repository a run can start from: its root and the commit the workspace branches off.
async function locateRepository(path: string) {
  if (!isAbsolute(path)) throw new Error('프로젝트의 절대 경로를 입력해 주세요.');
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error('폴더를 찾을 수 없습니다. 경로를 확인해 주세요.');
  }
  let root: string;
  try {
    root = (await git(canonical, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error('Git 저장소를 선택해 주세요.');
  }
  let head: string;
  try {
    head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch {
    throw new Error('최초 커밋이 필요합니다. 프로젝트에서 git add와 git commit을 실행해 주세요.');
  }
  return { root, head };
}
export interface Project {
  root: string;
  head: string;
  dirty: boolean;
  // Set when `root` is not a repository but a folder holding some: a bundle folder.
  repositories?: RepositoryEntry[];
}
const NOT_A_REPOSITORY = 'Git 저장소를 선택해 주세요.';
// A repository, or a folder holding repositories (a team's project folder with one clone per
// service): the latter has no head of its own and lists what a bundle run can pick from.
export async function inspectProject(path: string): Promise<Project> {
  let located: { root: string; head: string };
  try {
    located = await locateRepository(path);
  } catch (e) {
    if ((e as Error).message !== NOT_A_REPOSITORY) throw e;
    const root = await realpath(path);
    const repositories = await listRepositories(root);
    if (!repositories.length) throw e;
    return { root, head: '', dirty: false, repositories };
  }
  return {
    root: await realpath(located.root),
    head: located.head,
    dirty: !!(await git(located.root, ['status', '--porcelain'])).trim(),
  };
}
// Why a folder cannot host a run (neither a repository nor a folder of them, an unborn
// repository, a missing path), or undefined when it can.
export async function repositoryIssue(path: string): Promise<string | undefined> {
  try {
    await inspectProject(path);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
const SKIPPED_FOLDERS = new Set(['node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__']);
const remoteName = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop() || null;
// Repositories up to two folders deep (clones are often nested once, e.g. c-agent/c-agent).
// A found repository is not searched further; hidden and dependency folders are skipped.
export async function listRepositories(folder: string, depth = 2): Promise<RepositoryEntry[]> {
  const found: RepositoryEntry[] = [];
  const visit = async (dir: string, remaining: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_FOLDERS.has(e.name))
        .map(async (e) => {
          const path = join(dir, e.name);
          const marker = await stat(join(path, '.git')).catch(() => null);
          if (!marker) {
            if (remaining > 1) await visit(path, remaining - 1);
            return;
          }
          const entry = await describeRepository(
            path,
            relative(folder, path).split(sep).join('/'),
            marker.isDirectory() ? 'clone' : 'worktree',
          );
          if (entry) found.push(entry);
        }),
    );
  };
  await visit(folder, depth);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
async function describeRepository(path: string, name: string, kind: 'clone' | 'worktree') {
  try {
    const head = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
    const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const remote = await git(path, ['remote', 'get-url', 'origin']).then(remoteName, () => null);
    return { path, name, remote, branch, kind, head } satisfies RepositoryEntry;
  } catch {
    // An unborn repository cannot seed a worktree; leave it out.
    return undefined;
  }
}
export async function createWorkspace(projectPath: string, runId: string, dataDir: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('잘못된 실행 ID');
  const project = await locateRepository(projectPath);
  const path = join(dataDir, 'workspaces', runId);
  await mkdir(dirname(path), { recursive: true });
  const branch = `pixel/${runId}`;
  await git(project.root, ['worktree', 'add', '-b', branch, path, project.head]);
  return { path, branch, baseCommit: project.head };
}
// A bundle run's workspace: a folder with one worktree per chosen repository, so the coworkers
// see the services side by side. Every repository must live inside the chosen folder.
export async function createBundleWorkspace(
  folder: string,
  repositories: string[],
  runId: string,
  dataDir: string,
) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('잘못된 실행 ID');
  if (!repositories.length) throw new Error('묶을 저장소를 하나 이상 골라 주세요.');
  const root = await realpath(folder);
  const path = join(dataDir, 'workspaces', runId);
  const branch = `pixel/${runId}`;
  const repos: RunRepo[] = [];
  const names = new Set<string>();
  for (const repository of repositories) {
    const canonical = await realpath(repository).catch(() => {
      throw new Error(`저장소를 찾을 수 없습니다: ${repository}`);
    });
    const inside = relative(root, canonical);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new Error(`고른 폴더 안의 저장소만 묶을 수 있어요: ${repository}`);
    const located = await locateRepository(canonical);
    if ((await realpath(located.root)) !== canonical)
      throw new Error(`저장소의 최상위 폴더를 골라 주세요: ${repository}`);
    let name = basename(canonical);
    for (let i = 2; names.has(name); i++) name = `${basename(canonical)}-${i}`;
    names.add(name);
    repos.push({
      root: canonical,
      name,
      worktreePath: join(path, name),
      branch,
      baseCommit: located.head,
    });
  }
  await mkdir(path, { recursive: true });
  for (const repo of repos)
    await git(repo.root, ['worktree', 'add', '-b', branch, repo.worktreePath, repo.baseCommit]);
  return { path, branch, baseCommit: '', repos };
}
// Changes of a run: one repository's, or each bundled repository's with its folder name
// prefixed, so a reviewer can tell `api/src/x.ts` from `web/src/x.ts`.
export async function collectRunChanges(run: {
  worktreePath: string;
  baseCommit: string;
  repos?: RunRepo[];
}): Promise<Change[]> {
  if (!run.repos) return collectChanges(run.worktreePath, run.baseCommit);
  const groups = await Promise.all(
    run.repos.map(async (repo) =>
      (await collectChanges(repo.worktreePath, repo.baseCommit)).map((c) => ({
        ...c,
        path: `${repo.name}/${c.path}`,
      })),
    ),
  );
  return groups.flat();
}
export async function collectChanges(cwd: string, baseCommit: string): Promise<Change[]> {
  cwd = await realpath(cwd);
  const tracked = (await git(cwd, ['diff', '--name-only', '-z', baseCommit, '--']))
    .split('\0')
    .filter(Boolean);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  const results: Change[] = [];
  const max = 256 * 1024;
  for (const path of [...new Set([...tracked, ...untracked])].slice(0, 200)) {
    let diff = '',
      truncated = false;
    const full = join(cwd, path);
    let status = untracked.includes(path) ? 'added' : 'modified';
    let baseSize = 0;
    if (status !== 'added') {
      try {
        baseSize = Number((await git(cwd, ['cat-file', '-s', `${baseCommit}:${path}`])).trim());
      } catch {
        // A file added since the base commit has no base blob.
      }
    }
    const fileDiff = () =>
      git(cwd, [
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        baseCommit,
        '--',
        path,
      ]);
    try {
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        diff = '심볼릭 링크 (대상 파일을 읽지 않음)';
      } else if (!stat.isFile()) {
        diff = '일반 파일이 아닙니다.';
      } else if (stat.size > max || baseSize > max) {
        diff = `큰 파일 (이전 ${baseSize.toLocaleString()} / 현재 ${stat.size.toLocaleString()} bytes). 작업 폴더에서 확인해 주세요.`;
        truncated = true;
      } else if (!isWithin(cwd, await realpath(full))) {
        diff = '작업 폴더 외부 파일은 표시하지 않습니다.';
      } else {
        const data = await readFile(full);
        if (data.includes(0)) diff = '바이너리 파일';
        else if (status === 'added')
          diff = data
            .toString('utf8')
            .split('\n')
            .map((l) => '+' + l)
            .join('\n');
        else diff = await fileDiff();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        status = 'deleted';
        if (baseSize > max) {
          diff = `삭제된 큰 파일 (${baseSize.toLocaleString()} bytes). 기준 커밋에서 내용을 확인해 주세요.`;
          truncated = true;
        } else diff = await fileDiff();
      } else throw e;
    }
    if (diff.length > max) {
      diff = diff.slice(0, max);
      truncated = true;
    }
    results.push({ path, status, diff, truncated });
  }
  return results;
}
export function isWithin(root: string, target: string) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel));
}

// Personal runs use the same checkout and local environment as launching sy/syc there.
export async function personalWorkspace(project: Project, selected?: string[]) {
  if (!project.repositories)
    return {
      path: project.root,
      branch: (await git(project.root, ['branch', '--show-current'])).trim(),
      baseCommit: project.head,
      repos: undefined,
    };
  if (!selected?.length) throw new Error('함께 작업할 저장소를 골라 주세요.');
  const repos: RunRepo[] = [];
  for (const path of [...new Set(selected)]) {
    const canonical = await realpath(path);
    const entry = project.repositories.find((r) => r.path === canonical);
    if (!entry) throw new Error('고른 폴더 안의 저장소만 선택해 주세요.');
    repos.push({
      root: canonical,
      worktreePath: canonical,
      name: relative(project.root, canonical),
      baseCommit: entry.head,
      branch: entry.branch,
    });
  }
  return { path: project.root, branch: '', baseCommit: '', repos };
}
