import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const phase of ['구현', '검토', '모두']) {
  test(`${phase} usage limit shows a notice and continues or explains exhaustion`, async ({
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
    await page.getByLabel('작업 내용').fill(`${phase} 한도 테스트`);
    await page.getByRole('button', { name: '작업 시작', exact: true }).click();
    if (phase === '검토') {
      await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
      await page.getByRole('button', { name: '승인', exact: true }).click();
    }
    const notice = page.getByRole('status', { name: '사용량 한도 안내' });
    await expect(notice).toContainText('한도');
    if (phase === '모두') {
      await expect(notice).toContainText('현재 사용할 수 없어');
      await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
      await expect(page.locator('.run-result')).toContainText('확인 필요');
    } else {
      await expect(notice).toContainText(phase === '구현' ? 'Claude로 전환' : 'Codex로 전환');
      await expect(notice).toContainText('5:20pm');
      if (phase === '구현') {
        await page.getByRole('button', { name: 'Claude 선택', exact: true }).click();
        await page.getByRole('button', { name: '승인', exact: true }).click();
      }
      await expect(page.locator('.run-result.success')).toBeVisible();
    }
    await page.reload();
    await expect(notice).toContainText('한도');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
