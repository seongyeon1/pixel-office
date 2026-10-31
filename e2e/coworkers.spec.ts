import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('coworker and Slack settings', async ({ page }) => {
  const project = (await readFile('.pixel/e2e-project.txt', 'utf8')).trim();
  await page.goto('/#token=e2e-token');
  await page.getByRole('button', { name: '팀 구성', exact: true }).click();
  const coworkers = page.getByRole('region', { name: '동료 설정' });
  // The coordinator is fixed: it can be edited but never removed.
  const coordinator = coworkers.getByRole('listitem').filter({ hasText: '코디네이터' });
  await expect(coordinator).toContainText('AGENTS.md');
  await expect(coordinator.getByRole('button', { name: '삭제' })).toHaveCount(0);

  await coworkers.getByRole('button', { name: '동료 추가' }).click();
  await coworkers.getByLabel('이름', { exact: true }).fill('문서 동료');
  await coworkers.getByLabel('동료 id').fill('docs-friend');
  await coworkers.getByLabel('폴더', { exact: true }).fill(project);
  const confluence = coworkers.getByLabel('Confluence 게시');
  await expect(confluence).toBeChecked();
  await confluence.uncheck();
  await coworkers.getByRole('button', { name: '저장', exact: true }).click();
  await expect(coworkers.getByRole('status').last()).toContainText('저장했어요');
  await expect(coworkers.getByRole('listitem').filter({ hasText: '문서 동료' })).toBeVisible();

  const saved = await page.evaluate(async () => {
    const r = await fetch('/api/coworkers');
    return (await r.json()) as { id: string; rules: { pattern: string; action: string }[] }[];
  });
  const rules = saved.find((c) => c.id === 'docs-friend')!.rules;
  expect(rules.find((r) => r.pattern === 'mcp__*__*publish*')?.action).toBe('auto');
  expect(rules.find((r) => r.pattern === 'mcp__*__*create*')?.action).toBe('ask');

  const slack = page.getByRole('region', { name: 'Slack 설정' });
  await slack.getByLabel('Bot 토큰').fill('not-a-token');
  await slack.getByLabel('App 토큰').fill('xapp-1-test');
  await slack.getByLabel('내 Slack member ID').fill('U0123ABCD');
  await slack.getByRole('button', { name: '연결 테스트 후 저장' }).click();
  await expect(slack.getByRole('alert')).toBeVisible();
  await expect(slack.getByRole('alert')).not.toContainText('not-a-token');
});
