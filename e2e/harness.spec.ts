import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('each repository keeps its own harness of plugins and skills', async ({ page }, info) => {
  const root = await realpath((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  const other = await realpath(await mkdtemp(join(tmpdir(), 'pixel-harness-other-')));
  try {
    execFileSync('git', ['init'], { cwd: other, stdio: 'pipe' });
    await writeFile(join(other, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: other, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-m', 'seed'],
      { cwd: other, stdio: 'pipe' },
    );
    await page.addInitScript((r) => {
      localStorage.setItem('pixel.project', r);
      localStorage.setItem('pixel.overview', 'false');
    }, root);
    await page.goto('/#token=e2e-token');
    const origin = new URL(page.url()).origin;
    // Start from a clean slate for this repository.
    const empty = { plugins: [], skills: [], projectDoc: false };
    await page.request.post('/api/harness', {
      headers: { origin },
      data: { root, harness: { claude: empty, codex: empty } },
    });
    await page.getByRole('button', { name: '하네스', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '레포 하네스' });
    await expect(dialog.getByText('Core workflow skills')).toBeVisible();
    await dialog.getByRole('checkbox', { name: /superpowers/ }).check();
    await dialog.getByRole('checkbox', { name: /bc-ship/ }).check();
    await dialog.getByLabel('플러그인·스킬 검색').fill('observer');
    await expect(dialog.getByRole('checkbox', { name: /bc-ship/ })).toHaveCount(0);
    await dialog.getByLabel('플러그인·스킬 검색').fill('');
    await dialog.getByRole('tab', { name: /Codex/ }).click();
    await dialog.getByRole('checkbox', { name: /linear/ }).check();
    await dialog.getByRole('checkbox', { name: /AGENTS\.md/ }).check();
    await expect(dialog.getByRole('tab', { name: /Claude/ })).toContainText('2');
    if (info.project.name === 'desktop')
      await dialog.screenshot({ path: 'docs/images/harness-desktop.png' });
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('저장했어요. 다음 앱 작업부터 적용돼요.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Reloaded and reopened, the choice is still there.
    await page.reload();
    await page.getByRole('button', { name: '하네스', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /superpowers/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /task-observer/ })).not.toBeChecked();
    await dialog.getByRole('tab', { name: /Codex/ }).click();
    await expect(dialog.getByRole('checkbox', { name: /linear/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /AGENTS\.md/ })).toBeChecked();
    // Another repository is untouched.
    const response = await page.request.get(`/api/harness?root=${encodeURIComponent(other)}`);
    expect(await response.json()).toEqual({ claude: empty, codex: empty });
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});
