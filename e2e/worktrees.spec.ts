import { test, expect } from '@playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { defaultTeam } from '../src/shared/contracts';

test('worktree cleanup protects active work and requires explicit file discard while keeping history', async ({
  page,
}, info) => {
  const root = await realpath((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page.addInitScript((r) => {
    localStorage.setItem('pixel.project', r);
    localStorage.setItem('pixel.overview', 'false');
  }, root);
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { level: 1, name: /오피스$/ })).toBeVisible();
  const headers = { origin: new URL(page.url()).origin };
  const post = (url: string, data: unknown) => page.request.post(url, { headers, data });
  await post('/api/settings/approvals', { mode: 'manual' });
  const prompt = `정리할 임시 작업 ${info.project.name}`;
  const response = await post('/api/runs', {
    projectPath: root,
    prompt,
    mode: 'codex',
    implementer: 'codex',
    executionMode: 'isolated',
    team: defaultTeam(),
  });
  expect(response.ok()).toBe(true);
  const run = await response.json();
  try {
    expect(
      (
        await post('/api/worktrees/remove', { path: run.worktreePath, discardChanges: true })
      ).status(),
    ).toBe(409);
    await page.reload();
    await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
    await page.getByRole('button', { name: '승인', exact: true }).click();
    await expect(page.locator('.run-result.success')).toBeVisible();
    // The code/terminal panel also protects the worktree while its shell is open.
    const shell = await (await post('/api/terminals', { root: run.worktreePath })).json();
    const blocked = await post('/api/worktrees/remove', {
      path: run.worktreePath,
      discardChanges: true,
    });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).error).toContain('터미널');
    await post(`/api/terminals/${shell.id}/close`, {});
    expect((await post('/api/worktrees/remove', { path: run.worktreePath })).status()).toBe(409);
    await page.getByRole('button', { name: /^작업 기록/ }).click();
    await page.getByRole('button', { name: '작업 폴더 정리', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '작업 폴더 정리' });
    const card = dialog.locator('li').filter({ hasText: run.worktreePath });
    await expect(card).toContainText('hello.txt');
    await card.getByRole('button', { name: '정리하기', exact: true }).click();
    const remove = card.getByRole('button', { name: '작업 폴더 삭제', exact: true });
    await expect(remove).toBeDisabled();
    await card.getByRole('checkbox').check();
    await page.screenshot({ path: info.outputPath('worktree-confirm.png') });
    await remove.click();
    await expect(card).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText('브랜치와 작업 기록은 보존');
    const snapshot = await (await page.request.get(`/api/runs/${run.id}`)).json();
    expect(snapshot.run.removedWorktrees).toContain(run.worktreePath);
    expect(snapshot.run.prompt).toBe(prompt);
    expect((await post(`/api/runs/${run.id}/follow-up`, { prompt: 'continue' })).status()).toBe(
      409,
    );
    await dialog.getByRole('button', { name: '작업 폴더 정리 닫기' }).click();
    await expect(page.locator('.history-list')).toContainText(prompt);
    expect(await readFile(root + '/README.md', 'utf8')).toBe('fixture');
  } finally {
    await post(`/api/runs/${run.id}/cancel`, {});
    await post('/api/settings/approvals', { mode: 'manual' });
  }
});
