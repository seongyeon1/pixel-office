import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('app implementer and reviewer have independent conversations and native resume controls', async ({
  page,
}, info) => {
  await page.goto('/#token=e2e-token');
  await page.getByRole('heading', { level: 1, name: /오피스$/ }).waitFor();
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page
    .getByLabel('프로젝트 경로', { exact: true })
    .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  await page.evaluate(async () => {
    await fetch('/api/settings/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });
  });
  try {
    await page.getByLabel('작업 내용').fill(`개별 대화 통합 ${info.project.name}`);
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '작업 시작', exact: true }).click();
    const run = await (await response).json();
    await expect(page.locator('.run-result.success')).toBeVisible();
    await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
    await page
      .locator('.app-session-actions')
      .getByRole('button', { name: '말 걸기', exact: true })
      .click();
    await page.getByRole('tab', { name: '지시 · 실제 실행', exact: true }).click();
    await page.getByLabel('동료에게 지시').fill('이 구현 세션에만 회귀 테스트를 추가해줘');
    await page.getByRole('button', { name: '지시 보내기', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText(
      '지시대로 처리했어요: 이 구현 세션에만 회귀 테스트를 추가해줘',
    );
    await page.getByRole('button', { name: 'Claude 선택', exact: true }).click();
    await expect(page.getByRole('region', { name: '선택한 에이전트와 대화' })).not.toContainText(
      '이 구현 세션에만 회귀 테스트',
    );
    await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText(
      '이 구현 세션에만 회귀 테스트',
    );
    await page
      .locator('.app-session-actions')
      .getByRole('button', { name: '이어서 작업', exact: true })
      .click();
    const dock = page.getByRole('region', { name: '세션 이어서 작업', exact: true });
    await dock.getByRole('button', { name: '이어서 작업', exact: true }).click();
    await expect(dock).toContainText('FAKE-CODEX');
    const native = await page.evaluate(
      async (id) => (await (await fetch(`/api/runs/${id}`)).json()).run.sessions.codex.implementer,
      run.id,
    );
    await expect(dock).toContainText(native);
    await dock.getByRole('button', { name: '터미널 종료', exact: true }).click();
    await page.reload();
    await page
      .locator('.observed-sessions button')
      .filter({ hasText: '이 구현 세션에만 회귀 테스트를 추가해줘' })
      .filter({ hasText: run.id.slice(0, 8) })
      .click();
    await page.getByRole('tab', { name: '대화', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText(
      '이 구현 세션에만 회귀 테스트',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('unified-conversation.png'), fullPage: true });
  } finally {
    await page.evaluate(async () => {
      await fetch('/api/settings/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'manual' }),
      });
    });
  }
});
