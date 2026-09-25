import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('a room merged into another moves its coworkers there and splits back', async ({ page }) => {
  test.setTimeout(60000);
  const fixtures = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pixel-rooms-')));
  const parentFolder = join(parent, 'langconnect');
  const repo = join(parentFolder, 'repo-access-request');
  const files: string[] = [];
  const line = (data: unknown) => JSON.stringify(data) + '\n';
  const codex = async (id: string, cwd: string) => {
    const path = join(dirname(fixtures.codex), `${id}.jsonl`);
    files.push(path);
    const timestamp = new Date().toISOString();
    await writeFile(
      path,
      line({ timestamp, type: 'session_meta', payload: { id, cwd } }) +
        line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }),
    );
  };
  try {
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
    await writeFile(join(repo, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-m', 'seed'],
      { cwd: repo, stdio: 'pipe' },
    );
    // One session in the plain parent folder, one inside the repository.
    await codex('rooms-parent', parentFolder);
    await codex('rooms-repo', repo);
    await page.goto('/#token=e2e-token');
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    const room = (root: string) =>
      page.getByRole('article', { name: `프로젝트 공간 ${root}`, exact: true });
    const worker = (root: string, id: string) =>
      page.getByRole('button', { name: `전체 맵 동료 ${root} ${id}`, exact: true });
    await expect(worker(parentFolder, 'rooms-parent')).toBeVisible({ timeout: 20000 });
    await expect(worker(repo, 'rooms-repo')).toBeVisible({ timeout: 20000 });
    await room(parentFolder)
      .getByRole('button', { name: `방 합치기 ${parentFolder}` })
      .click();
    await room(parentFolder).getByLabel('합칠 대상 방').selectOption(repo);
    await room(parentFolder).getByRole('button', { name: '합치기', exact: true }).click();
    await expect(room(parentFolder)).toHaveCount(0, { timeout: 15000 });
    await expect(worker(repo, 'rooms-parent')).toBeVisible();
    await expect(room(repo).locator('.floor-merged')).toContainText('langconnect');
    await room(repo)
      .getByRole('button', { name: `방 분리 ${parentFolder}` })
      .click();
    await expect(worker(parentFolder, 'rooms-parent')).toBeVisible({ timeout: 15000 });
    await expect(room(repo).locator('.floor-merged')).toHaveCount(0);
  } finally {
    const origin = new URL(page.url()).origin;
    await page.request.post('/api/rooms/split', {
      headers: { origin },
      data: { source: parentFolder },
    });
    for (const path of files) await rm(path, { force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
