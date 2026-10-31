import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  const action = (pattern: string) => rules.find((r) => r.pattern === pattern)?.action;
  expect(action('mcp__*atlassian*__create*Confluence*')).toBe('auto');
  expect(action('mcp__*atlassian*__update*Confluence*')).toBe('auto');
  expect(action('mcp__*atlassian*__create*Jira*')).toBe('ask');
  expect(action('mcp__*__*create*')).toBe('ask');
  // Destination toggles lead, ahead of the generic verbs.
  const at = (pattern: string) => rules.findIndex((r) => r.pattern === pattern);
  expect(at('mcp__*atlassian*__create*Confluence*')).toBe(0);
  expect(at('mcp__*slack*__*update*')).toBeLessThan(at('mcp__*__*create*'));

  const slack = page.getByRole('region', { name: 'Slack 설정' });
  await slack.getByLabel('Bot 토큰').fill('not-a-token');
  await slack.getByLabel('App 토큰').fill('xapp-1-test');
  await slack.getByLabel('내 Slack member ID').fill('U0123ABCD');
  await slack.getByRole('button', { name: '연결 테스트 후 저장' }).click();
  await expect(slack.getByRole('alert')).toContainText('Bot 토큰은 xoxb-로 시작해야 해요.');
  await expect(slack.getByRole('alert')).not.toContainText('not-a-token');

  // Toggle-owned patterns lead the saved rules; a mixed group renders as mixed.
  const rule = (pattern: string, action: string) => ({ pattern, action });
  await page.evaluate(
    async ([folder, rules]) => {
      const r = await fetch('/api/coworkers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'mixed-friend',
          name: '혼합 동료',
          folder,
          engine: 'claude',
          role: '',
          mode: 'solo',
          bindings: [],
          createdBy: 'user',
          rules,
        }),
      });
      if (!r.ok) throw new Error('save failed');
    },
    [
      dirname(project),
      [
        rule('mcp__github__*', 'ask'),
        rule('mcp__*__*delete*', 'ask'),
        rule('mcp__*__*post*', 'auto'),
        rule('mcp__*__*publish*', 'auto'),
        rule('mcp__*__*publish*', 'ask'),
      ],
    ] as const,
  );
  await page.reload();
  await page.getByRole('button', { name: '팀 구성', exact: true }).click();
  await coworkers
    .getByRole('listitem')
    .filter({ hasText: '혼합 동료' })
    .getByRole('button', { name: '수정' })
    .click();
  const group = coworkers.getByLabel('그 외 외부 쓰기');
  expect(await group.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
  await expect(coworkers).toContainText('토글과 같은 패턴의 규칙 1개를 토글 설정으로 합쳤어요.');
  await coworkers.getByRole('button', { name: '저장', exact: true }).click();
  await expect(coworkers.getByRole('status').last()).toContainText('저장했어요');
  const after = await page.evaluate(async () => {
    const r = await fetch('/api/coworkers');
    return (await r.json()) as { id: string; rules: { pattern: string; action: string }[] }[];
  });
  const mixed = after.find((c) => c.id === 'mixed-friend')!.rules;
  expect(mixed.at(-1)).toEqual(rule('mcp__github__*', 'ask'));
  expect(mixed.findIndex((r) => r.pattern === 'mcp__*__*publish*')).toBeLessThan(mixed.length - 1);
  expect(mixed.filter((r) => r.pattern === 'mcp__*__*publish*')).toEqual([
    rule('mcp__*__*publish*', 'auto'),
  ]);
});
