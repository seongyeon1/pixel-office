import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

test('a department gathers the rooms under its folder into one band and filters the floor', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const fixtures = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pixel-dept-')));
  const skt = join(parent, 'skt');
  const roots = [join(skt, 'doc-console'), join(skt, 'zez-server'), join(parent, 'pixel')];
  const files: string[] = [];
  const line = (data: unknown) => JSON.stringify(data) + '\n';
  try {
    for (const [i, root] of roots.entries()) {
      await mkdir(root, { recursive: true });
      const path = join(dirname(fixtures.codex), `dept-${i}.jsonl`);
      files.push(path);
      const timestamp = new Date().toISOString();
      await writeFile(
        path,
        line({ timestamp, type: 'session_meta', payload: { id: `dept-${i}`, cwd: root } }) +
          line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }),
      );
    }
    await page.goto('/#token=e2e-token');
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    const room = (root: string) =>
      page.getByRole('article', { name: `프로젝트 공간 ${root}`, exact: true });
    for (const root of roots) await expect(room(root)).toBeVisible({ timeout: 20000 });
    await page.getByText('부서 관리').click();
    await page.getByLabel('부서 이름').fill('skt');
    await page.getByLabel('부서 폴더').fill(skt);
    await page.getByRole('button', { name: '추가', exact: true }).click();
    const plaque = page.locator('.floor-dept-name', { hasText: 'skt' });
    await expect(plaque).toBeVisible();
    // Both skt rooms share a band that the outside room does not.
    const band = async (root: string) => {
      const box = (await room(root).boundingBox())!;
      return Math.round(box.y);
    };
    const pixelTop = await band(roots[2]);
    expect(await band(roots[0])).toBeLessThan(pixelTop);
    await page.getByLabel('부서로 방 거르기').selectOption({ label: 'skt' });
    await expect(room(roots[0])).toBeVisible();
    await expect(room(roots[1])).toBeVisible();
    await expect(room(roots[2])).toHaveCount(0);
    await page.getByLabel('부서로 방 거르기').selectOption({ label: '기타' });
    await expect(room(roots[2])).toBeVisible();
    await expect(room(roots[0])).toHaveCount(0);
    await page.getByLabel('부서로 방 거르기').selectOption('');
    if (info.project.name === 'desktop')
      await page.locator('.floor').screenshot({ path: 'docs/images/departments-desktop.png' });
    await page.getByRole('button', { name: '부서 삭제 skt', exact: true }).click();
    await expect(plaque).toHaveCount(0);
  } finally {
    const origin = new URL(page.url()).origin;
    const list = await (await page.request.get('/api/departments')).json();
    for (const d of list)
      if (d.root.startsWith(parent))
        await page.request.delete(`/api/departments/${d.id}`, { headers: { origin } });
    for (const path of files) await rm(path, { force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
