import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ storageState: { cookies: [], origins: [] } });

test('native CLI sessions accept input, split, survive tab switches and reload without relaunching', async ({
  page,
}) => {
  await page.goto('/#token=e2e-token');
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page
    .getByLabel('프로젝트 경로', { exact: true })
    .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const work = page.getByRole('main', { name: '터미널 작업 공간' });
  await expect(work).toBeVisible();
  await expect(work.getByRole('button', { name: 'Codex 열기', exact: true })).toBeEnabled();
  await page.screenshot({ path: `docs/images/terminal-start-${test.info().project.name}.png` });
  const launches: unknown[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/agents') && r.method() === 'POST') launches.push(r.postDataJSON());
  });
  await work.getByRole('button', { name: 'Codex 열기', exact: true }).click();
  const first = work.getByRole('region', { name: 'Codex 터미널' }).first();
  await expect(first).toContainText('FAKE-SYC');
  await expect(first.getByTestId('terminal-input')).toBeFocused();
  await page.keyboard.type('native-first');
  await page.keyboard.press('Enter');
  await expect(first).toContainText('native-first');
  await page.keyboard.press('Control+Shift+O');
  await work.getByRole('button', { name: 'Claude 열기', exact: true }).click();
  const second = work.getByRole('region', { name: 'Claude 터미널' }).first();
  await expect(second).toContainText('FAKE-SY');
  await work.getByRole('button', { name: '터미널 분할', exact: true }).click();
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await second.getByTestId('terminal-input').focus();
  await page.keyboard.type('native-second');
  await page.keyboard.press('Enter');
  await expect(second).toContainText('native-second');
  await expect(first).not.toContainText('native-second');
  expect(launches).toHaveLength(2);
  expect(launches[0]).toMatchObject({ prompt: '', provider: 'codex' });
  await page.screenshot({ path: `docs/images/terminal-workbench-${test.info().project.name}.png` });
  await page.reload();
  await expect(first).toContainText('native-first');
  await expect(second).toContainText('native-second');
  expect(launches).toHaveLength(2);
  await expect(page.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Hiding a tab must not terminate its process; it can be reopened from the session list.
  await work.getByRole('button', { name: 'Claude 탭 닫기', exact: true }).click();
  await expect(second).toBeHidden();
  const listToggle = work.getByRole('button', { name: '세션 목록 열기', exact: true });
  if (await listToggle.isVisible()) await listToggle.click();
  await work.getByRole('button', { name: 'Claude 세션 열기', exact: true }).click();
  await expect(second).toContainText('native-second');
  expect(launches).toHaveLength(2);
  await second.getByRole('button', { name: '터미널 종료', exact: true }).click();
  await work.getByRole('tab', { name: 'Codex', exact: true }).click();
  await first.getByRole('button', { name: '터미널 종료', exact: true }).click();
  await page.getByRole('button', { name: '팀 작업 모드', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '작업 내용', exact: true })).toBeVisible();
});

test('a delayed list response and a lost launch response do not lose or duplicate the new session', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/agents?*', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  let launchedId = '';
  let lost = false;
  await page.route('**/api/agents', async (route) => {
    const response = await route.fetch();
    const agent = await response.json();
    if (!lost) {
      lost = true;
      launchedId = agent.id;
      await route.fulfill({ status: 503, json: { error: '응답 연결 끊김' } });
    } else {
      expect(agent.id).toBe(launchedId);
      await route.fulfill({ response });
    }
  });
  await page.goto('/#token=e2e-token');
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page
    .getByLabel('프로젝트 경로', { exact: true })
    .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  const work = page.getByRole('main', { name: '터미널 작업 공간' });
  await work.getByRole('button', { name: 'Codex 열기', exact: true }).click();
  await expect(work.getByRole('alert')).toContainText('응답 연결 끊김');
  await work.getByRole('button', { name: 'Codex 열기', exact: true }).click();
  const terminal = work.getByRole('region', { name: 'Codex 터미널', exact: true });
  await expect(terminal).toContainText('FAKE-SYC');
  release();
  await expect(work.getByRole('tab', { name: 'Codex', exact: true })).toHaveCount(1);
  // Flush both captured GET responses before asserting the post-launch UI remains usable.
  await page.unroute('**/api/agents?*');
  await expect(terminal.getByTestId('terminal-input')).toBeFocused();
  await page.keyboard.type('after-retry');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('after-retry');
  await terminal.getByRole('button', { name: '터미널 종료', exact: true }).click();
});

test('focusing either side of a split preserves the visible pair when three sessions are open', async ({
  page,
}) => {
  await page.goto('/#token=e2e-token');
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page
    .getByLabel('프로젝트 경로', { exact: true })
    .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  const work = page.getByRole('main', { name: '터미널 작업 공간' });
  for (let n = 0; n < 3; n++) {
    if (n) await page.keyboard.press('Control+Shift+O');
    await work.getByRole('button', { name: 'Codex 열기', exact: true }).click();
    await expect(work.locator('.native-pane').nth(n)).toContainText('FAKE-SYC');
  }
  await work.getByRole('button', { name: '터미널 분할', exact: true }).click();
  const panes = work.locator('.native-pane');
  await expect(panes.nth(0)).toBeVisible();
  await expect(panes.nth(2)).toBeVisible();
  await panes.nth(0).locator('.terminal-screen').click();
  await expect(panes.nth(0).getByTestId('terminal-input')).toBeFocused();
  await expect(panes.nth(2)).toBeVisible();
  await expect(panes.nth(1)).toBeHidden();
  for (let n = 0; n < 3; n++) {
    await work.getByRole('tab', { name: 'Codex', exact: true }).nth(n).click();
    await panes.nth(n).getByRole('button', { name: '터미널 종료', exact: true }).click();
  }
});

for (const leaveMode of [false, true])
  test(`finishing a launch preserves a newly selected workspace (leave mode: ${leaveMode})`, async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let terminalId = '';
    await page.route('**/api/agents', async (route) => {
      const response = await route.fetch();
      terminalId = (await response.json()).terminal.id;
      accept();
      await gate;
      await route.fulfill({ response });
    });
    await page.goto('/#token=e2e-token');
    await page.getByRole('button', { name: '레포 전환', exact: true }).click();
    await page
      .getByLabel('프로젝트 경로', { exact: true })
      .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '프로젝트 연결', exact: true })
      .click();
    await page.getByRole('button', { name: 'Claude 열기', exact: true }).click();
    await accepted;
    if (leaveMode) await page.getByRole('button', { name: '팀 작업 모드', exact: true }).click();
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    const workspace = page.getByRole('region', { name: '코드와 터미널', exact: true });
    await expect(workspace).toBeVisible();
    const completed = page.waitForResponse(
      (r) => r.url().endsWith('/api/agents') && r.request().method() === 'POST',
    );
    release();
    await completed;
    await expect(workspace).toBeVisible();
    await expect(page.getByRole('button', { name: '코드 · 터미널', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // End only the disposable CLI process requested by this journey.
    await page.evaluate(async (id) => {
      await fetch(`/api/terminals/${id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }, terminalId);
  });
