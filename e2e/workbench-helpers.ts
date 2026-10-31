import { expect, type Page } from '@playwright/test';

export async function newWork(page: Page) {
  await page
    .getByRole('region', { name: '작업 지시' })
    .getByRole('button', { name: '새 작업', exact: true })
    .click();
  const options = page.locator('.work-options');
  if (!(await options.evaluate((el) => (el as HTMLDetailsElement).open)))
    await options.locator('summary').click();
}
export async function showOffice(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: /오피스$/ })).toBeVisible();
  const toggle = page.getByRole('button', { name: /^사무실 펼치기/ });
  if (await toggle.count()) await toggle.click();
}
export async function showSessions(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: /오피스$/ })).toBeVisible();
  const toggle = page.getByRole('button', { name: '동료 목록 열기', exact: true });
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click();
}
export async function selectSession(page: Page, name: string) {
  await showSessions(page);
  const button = page.getByRole('button', { name, exact: true });
  await expect(button).toBeVisible({ timeout: 20000 });
  await button.click();
}
