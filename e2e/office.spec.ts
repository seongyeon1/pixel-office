import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
async function connect(page: import('@playwright/test').Page) {
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { name: '오늘의 오피스.' })).toBeVisible();
  await page.getByRole('button', { name: '프로젝트 연결', exact: true }).click();
  await page
    .getByLabel('프로젝트 경로', { exact: true })
    .fill((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
test('office fits the viewport and supports model/persona selection', async ({ page }, info) => {
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { name: '오늘의 오피스.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (info.project.name === 'desktop') {
    await mkdir('docs/images', { recursive: true });
    await page.screenshot({ path: 'docs/images/office.png', fullPage: true });
  }
  await page.getByRole('button', { name: '팀 구성', exact: true }).click();
  await page.getByLabel('codex 직급').selectOption('intern');
  await page.getByLabel('codex 모델').fill('custom-model');
  await page.getByRole('button', { name: '설정 완료' }).click();
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await expect(page.getByRole('heading', { name: 'Codex 신입' })).toBeVisible();
  await expect(page.getByText('custom-model', { exact: true })).toBeVisible();
});
test('approval survives reload, question is answered, handoff yields a file diff', async ({
  page,
}) => {
  await connect(page);
  await page.getByLabel('작업 내용').fill('질문 테스트: 샘플 파일을 만들고 검토해 주세요');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await expect(page.getByRole('heading', { name: '승인 필요' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await expect(page.getByRole('heading', { name: '승인 필요' })).toBeVisible();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await page.getByLabel('hello', { exact: true }).check();
  await page.getByRole('button', { name: '답변 보내기' }).click();
  await page.getByRole('button', { name: 'Claude 선택' }).click();
  await expect(page.locator('.run-result.success')).toContainText('검토 완료');
  await page.getByRole('button', { name: '변경 파일', exact: true }).click();
  await page.getByText('hello.txt', { exact: true }).click();
  await expect(page.getByText('+hello from the team', { exact: false })).toBeVisible();
});
test('running work can be stopped without starting a reviewer', async ({ page }) => {
  await connect(page);
  await page.getByLabel('작업 내용').fill('중단 테스트');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(page.locator('.run-result')).toContainText('중단됨');
});
