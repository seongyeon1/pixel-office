import { test, expect } from '@playwright/test';
import { readFile, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // Any wrapper around the same CLI can be registered, picked, and removed again.
  const harness = launcher.getByRole('combobox', { name: '실행 하네스', exact: true });
  await launcher.getByText('하네스 추가 · 삭제', { exact: true }).click();
  await launcher.getByLabel('추가할 하네스 명령', { exact: true }).fill('no-such-dots');
  await launcher.getByRole('button', { name: '추가', exact: true }).click();
  await expect(harness).toHaveValue('no-such-dots');
  await expect(harness).toContainText('no-such-dots · 설치 안 됨');
  await launcher.getByRole('button', { name: '하네스 no-such-dots 삭제', exact: true }).click();
  await expect(harness).toHaveValue('syc');
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'pixel-launch-choice-')));
  await launcher.getByLabel('작업 폴더', { exact: true }).fill(folder);
  await launcher.getByLabel('모델', { exact: true }).fill('gpt-6-astra');
  const prompt = `launcher ${test.info().project.name} 'quoted' task`;
  await launcher.getByLabel('처음 맡길 일').fill(prompt);
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/agents') && r.request().method() === 'POST',
  );
  await launcher.getByRole('button', { name: '동료 시작', exact: true }).click();
  const agent = await (await created).json();
  expect(agent.root).toBe(folder);
  expect(agent.model).toBe('gpt-6-astra');
  await expect(launcher).toHaveCount(0);
  await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
    'title',
    folder,
  );
  await expect(page.locator('.observed-sessions')).toContainText(prompt);
  await page.getByRole('button', { name: '터미널에서 이어서 작업', exact: true }).click();
  const terminal = page.getByRole('region', { name: '세션 이어서 작업 터미널', exact: true });
  await expect(terminal).toContainText('FAKE-SYC');
  await expect(terminal).toContainText('gpt-6-astra');
  await expect(terminal).toContainText(prompt);
  await page.getByRole('button', { name: '이어서 작업 숨기기' }).click();
  await page.reload();
  await page.locator('.observed-sessions button').filter({ hasText: prompt }).click();
  await page.getByRole('button', { name: '터미널에서 이어서 작업', exact: true }).click();
  await expect(terminal).toContainText(prompt);
  const info = await page.evaluate(
    async (id) => await (await fetch(`/api/observed/launch-${id}/terminal`)).json(),
    agent.id,
  );
  expect(info.id).toBe(agent.terminal.id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await terminal.getByRole('button', { name: '터미널 종료', exact: true }).click();
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
