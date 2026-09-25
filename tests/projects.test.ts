import { expect, test } from 'vitest';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
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
