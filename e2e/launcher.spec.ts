import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('a new personal-harness agent starts and remains reachable after hiding and reloading', async ({
  page,
}) => {
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { level: 1, name: /오피스$/ })).toBeVisible();
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page
    .getByLabel('프로젝트 경로', { exact: true })
    .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '새 동료', exact: true }).click();
  const launcher = page.getByRole('region', { name: '새 동료 시작', exact: true });
  await launcher.getByRole('combobox', { name: '동료', exact: true }).selectOption('codex');
  await expect(launcher.getByRole('combobox', { name: '실행 하네스', exact: true })).toContainText(
    'syc',
  );
  const prompt = `launcher ${test.info().project.name} 'quoted' task`;
  await launcher.getByLabel('처음 맡길 일').fill(prompt);
  await launcher.getByRole('button', { name: '동료 시작', exact: true }).click();
  const terminal = page.getByRole('region', { name: '새 동료 터미널', exact: true });
  await expect(terminal).toContainText('FAKE-SYC');
  await expect(terminal).toContainText(prompt);
  await page.getByRole('button', { name: '새 동료 창 숨기기' }).click();
  await page.reload();
  await page.getByRole('button', { name: '새 동료', exact: true }).click();
  await launcher
    .getByRole('button', { name: `Codex · ${prompt.slice(0, 25)}`, exact: true })
    .click();
  await expect(terminal).toContainText(prompt);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await terminal.getByRole('button', { name: '터미널 종료', exact: true }).click();
  await expect(terminal).toContainText('종료된 동료');
});

test('new agent launch stays hidden while an older server is still running', async ({ page }) => {
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    delete health.features;
    await route.fulfill({ response, json: health });
  });
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { level: 1, name: /오피스$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '새 동료', exact: true })).toHaveCount(0);
});
