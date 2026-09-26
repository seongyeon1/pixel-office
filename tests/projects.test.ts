import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectProject, createWorkspace, collectChanges } from '../src/server/projects.js';
export async function sampleProject() {
  const path = await mkdtemp(join(tmpdir(), 'pixel 한글 '));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' });
  git('init');
  await writeFile(join(path, 'seed.txt'), 'original');
  git('add', '.');
  git('-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed');
  return path;
}
test('worktree preserves dirty source and includes new unicode files without following links', async () => {
  const path = await sampleProject();
  await writeFile(join(path, 'seed.txt'), 'dirty');
  const w = await createWorkspace(path, 'r1', await mkdtemp(join(tmpdir(), 'pixel-data-')));
  await writeFile(join(w.path, 'new 한글.txt'), 'hello');
  await symlink('/etc/hosts', join(w.path, 'outside'));
  const changes = await collectChanges(w.path, w.baseCommit);
  expect(changes.find((c) => c.path === 'new 한글.txt')?.diff).toContain('hello');
  expect(changes.find((c) => c.path === 'outside')?.diff).toContain('심볼릭 링크');
  expect(await readFile(join(path, 'seed.txt'), 'utf8')).toBe('dirty');
});
test('rejects a repository without an initial commit', async () => {
  const path = await mkdtemp(join(tmpdir(), 'pixel-empty-'));
  execFileSync('git', ['init'], { cwd: path, stdio: 'pipe' });
  await expect(inspectProject(path)).rejects.toThrow('커밋');
});
test('diff treats wildcard and magic-looking filenames as literal paths', async () => {
  const path = await sampleProject();
  const files = ['*.txt', ':(invalid)file.txt', 'ordinary.txt'];
  for (const name of files) await writeFile(join(path, name), 'before\n');
  execFileSync('git', ['add', '--all'], { cwd: path });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Pixel',
      '-c',
      'user.email=pixel@example.test',
      'commit',
      '-m',
      'special names',
    ],
    { cwd: path, stdio: 'pipe' },
  );
  const head = (await inspectProject(path)).head;
  for (const name of files) await writeFile(join(path, name), `after ${name}\n`);
  const result = await collectChanges(path, head);
  expect(result.find((c) => c.path === '*.txt')?.diff).not.toContain('ordinary.txt');
  expect(result.find((c) => c.path === ':(invalid)file.txt')?.diff).toContain(
    'after :(invalid)file.txt',
  );
});
test('large deleted or shrunk files produce a bounded omission instead of failing', async () => {
  const path = await sampleProject();
  const big = 'x'.repeat(10 * 1024 * 1024);
  for (const name of ['deleted.txt', 'shrunk.txt']) await writeFile(join(path, name), big);
  execFileSync('git', ['add', '.'], { cwd: path });
  execFileSync(
    'git',
    ['-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'large files'],
    { cwd: path, stdio: 'pipe' },
  );
  const head = (await inspectProject(path)).head;
  await (await import('node:fs/promises')).unlink(join(path, 'deleted.txt'));
  await writeFile(join(path, 'shrunk.txt'), 'small');
  const result = await collectChanges(path, head);
  for (const name of ['deleted.txt', 'shrunk.txt']) {
    const c = result.find((c) => c.path === name)!;
    expect(c.truncated).toBe(true);
    expect(c.diff.length).toBeLessThan(262144);
  }
  expect(result.find((c) => c.path === 'deleted.txt')?.status).toBe('deleted');
});
test('repositoryIssue explains why a folder cannot host a run, and is empty for a repository', async () => {
  const { repositoryIssue } = await import('../src/server/projects.js');
  expect(await repositoryIssue(await sampleProject())).toBeUndefined();
  // A parent folder holding several clones is not itself a repository.
  expect(await repositoryIssue(await mkdtemp(join(tmpdir(), 'pixel-plain-')))).toContain('Git');
  const empty = await mkdtemp(join(tmpdir(), 'pixel-empty-'));
  execFileSync('git', ['init'], { cwd: empty, stdio: 'pipe' });
  expect(await repositoryIssue(empty)).toContain('커밋');
  expect(await repositoryIssue('/nonexistent/pixel/folder')).toBeTruthy();
});
// A folder holding several clones: what the picker lists and what a bundle run gets.
async function bundleFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'pixel-bundle-'));
  const seed = async (rel: string, remote?: string) => {
    const path = join(folder, rel);
    await mkdir(path, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' });
    git('init', '-b', 'main');
    if (remote) git('remote', 'add', 'origin', remote);
    await writeFile(join(path, 'README.md'), rel);
    git('add', '.');
    git('-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed');
    return path;
  };
  const api = await seed('api', 'https://gitlab.example.test/team/zez-server.git');
  const web = await seed('web/web', 'git@github.com:team/doc-console.git'); // nested one level
  await mkdir(join(folder, 'notes'), { recursive: true }); // plain folder, no repository
  await mkdir(join(folder, 'node_modules', 'x'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', 'feat/x', join(folder, 'api-wt-x')], {
    cwd: api,
    stdio: 'pipe',
  });
  return { folder, api, web };
}
test('listRepositories finds clones two levels deep, labels worktrees and reads origin names', async () => {
  const { listRepositories } = await import('../src/server/projects.js');
  const { folder } = await bundleFolder();
  const repos = await listRepositories(folder);
  expect(repos.map((r) => [r.name, r.kind, r.remote, r.branch])).toEqual([
    ['api', 'clone', 'zez-server', 'main'],
    ['api-wt-x', 'worktree', 'zez-server', 'feat/x'],
    ['web/web', 'clone', 'doc-console', 'main'],
  ]);
  expect(repos.every((r) => r.head.length === 40)).toBe(true);
});
test('inspectProject describes a folder of repositories, and repositoryIssue accepts it', async () => {
  const { repositoryIssue } = await import('../src/server/projects.js');
  const { folder } = await bundleFolder();
  const project = await inspectProject(folder);
  expect(project.head).toBe('');
  expect(project.repositories?.map((r) => r.name)).toEqual(['api', 'api-wt-x', 'web/web']);
  expect(await repositoryIssue(folder)).toBeUndefined();
});
test('a bundle workspace holds one worktree per chosen repository and reports changes per repository', async () => {
  const { createBundleWorkspace, collectRunChanges } = await import('../src/server/projects.js');
  const { folder, api, web } = await bundleFolder();
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-data-'));
  const w = await createBundleWorkspace(folder, [api, web], 'r1', dataDir);
  expect(w.path).toBe(join(dataDir, 'workspaces', 'r1'));
  const { realpath } = await import('node:fs/promises');
  expect(w.repos.map((r) => [r.name, r.root])).toEqual([
    ['api', await realpath(api)],
    ['web', await realpath(web)],
  ]);
  for (const r of w.repos) expect(r.worktreePath).toBe(join(w.path, r.name));
  await writeFile(join(w.path, 'api', 'new.txt'), 'hello');
  await writeFile(join(w.path, 'web', 'README.md'), 'changed');
  const changes = await collectRunChanges({ worktreePath: w.path, baseCommit: '', repos: w.repos });
  expect(changes.map((c) => [c.path, c.status])).toEqual([
    ['api/new.txt', 'added'],
    ['web/README.md', 'modified'],
  ]);
  // A repository outside the folder is refused.
  await expect(createBundleWorkspace(folder, [dataDir], 'r2', dataDir)).rejects.toThrow('안의');
});
