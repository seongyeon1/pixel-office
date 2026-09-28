import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('approval preference persists, releases a waiting tool and keeps questions interactive', async ({
  page,
}, info) => {
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
  const setMode = (mode: string) =>
    page.evaluate(async (mode) => {
      const result = await fetch('/api/settings/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!result.ok) throw new Error('승인 설정 저장 실패');
    }, mode);
  await setMode('manual');
  try {
    const portraits = page.locator(
      info.project.name === 'desktop'
        ? '.sidebar .colleague .pixel-worker'
        : '.mobile-agents .pixel-worker',
    );
    await expect(portraits).toHaveCount(2);
    await expect(portraits.first()).toBeVisible();
    // App coworkers use the same default identity as their office sprites.
    expect(await portraits.first().locator('rect').count()).toBeGreaterThan(20);
    await page.getByLabel('작업 내용').fill('질문 테스트: 샘플 파일을 만들고 검토해 주세요');
    await page.getByRole('button', { name: '작업 시작', exact: true }).click();
    await page.getByRole('button', { name: 'Codex 선택' }).click();
    await expect(page.getByRole('heading', { name: '승인 필요' })).toBeVisible();
    await page.getByRole('button', { name: '팀 구성', exact: true }).click();
    await expect(page.getByLabel('도구 승인 방식')).toHaveValue('manual');
    // This control remains usable even while the model/persona fields are disabled.
    await page.getByLabel('도구 승인 방식').selectOption('auto');
    await expect(page.getByRole('status')).toContainText('승인 방식을 저장했어요.');
    // Floor sprites use depth ordering, but must stay below the settings overlay.
    const hitTestStyle = await page.addStyleTag({
      content: '.floor-building * { pointer-events: auto !important; }',
    });
    expect(
      await page.getByRole('dialog').evaluate((dialog) => {
        const r = dialog.getBoundingClientRect();
        for (let y = Math.max(8, r.top + 20); y < Math.min(innerHeight - 8, r.bottom - 20); y += 20)
          for (
            let x = Math.max(8, r.left + 20);
            x < Math.min(innerWidth - 8, r.right - 20);
            x += 20
          )
            if (!dialog.contains(document.elementFromPoint(x, y))) return false;
        return true;
      }),
    ).toBe(true);
    await hitTestStyle.evaluate((style) => style.parentNode?.removeChild(style));
    await page.screenshot({ path: info.outputPath('approval-settings.png'), fullPage: true });
    await page.getByRole('button', { name: '설정 완료' }).click();
    await expect(page.getByRole('heading', { name: '승인 필요' })).toHaveCount(0);
    await expect(page.getByLabel('hello', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '팀 구성', exact: true }).click();
    await expect(page.getByLabel('도구 승인 방식')).toHaveValue('auto');
    await page.getByRole('button', { name: '설정 완료' }).click();
    await page.getByRole('button', { name: 'Codex 선택' }).click();
    await page.getByLabel('hello', { exact: true }).check();
    await page.getByRole('button', { name: '답변 보내기' }).click();
    await expect(page.locator('.run-result.success')).toContainText('검토 완료');
    await page.getByRole('button', { name: '새 작업', exact: true }).click();
    await page.getByLabel('작업 내용').fill('자동 승인 테스트: 샘플 파일을 만들고 검토해 주세요');
    await page.getByRole('button', { name: '작업 시작', exact: true }).click();
    await expect(page.locator('.run-result.success')).toContainText('검토 완료');
    await expect(page.getByRole('heading', { name: '승인 필요' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('pixel-colleagues.png'), fullPage: true });
  } finally {
    await setMode('manual');
  }
});
