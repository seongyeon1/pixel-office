import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile, appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
async function connect(page: Page) {
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
}

test('documents render tables, images and diagrams, navigate locally and refresh without executing HTML', async ({
  page,
}) => {
  const root = (await readFile('.pixel/e2e-project.txt', 'utf8')).trim();
  const folder = `viewer-${test.info().project.name}`;
  await mkdir(join(root, folder), { recursive: true });
  const path = join(root, folder, 'guide.md');
  const markdown =
    '# 설계 문서\n\n| 기능 | 상태 |\n| --- | --- |\n| 문서 보기 | 완료 |\n\n- [x] 검증 완료\n\n![구조 그림](./image.png)\n\n[다음 문서](next.md)\n\n```mermaid\nflowchart LR\n  A[요청] --> B[문서]\n```\n\n<script>window.__docInjected = true</script>\n\n[위험 링크](javascript:alert(1))';
  await writeFile(path, markdown);
  await writeFile(join(root, folder, 'next.md'), '# 다음 단계\n\n[돌아가기](guide.md)');
  await writeFile(
    join(root, folder, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6WQAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  try {
    await connect(page);
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    await page.getByRole('tab', { name: '문서·산출물', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '문서·산출물', exact: true });
    await panel.getByRole('button', { name: `폴더 ${folder}`, exact: true }).click();
    await panel.getByRole('button', { name: `파일 ${folder}/guide.md`, exact: true }).click();
    await expect(panel.getByRole('heading', { name: '설계 문서', exact: true })).toBeVisible();
    await expect(panel.getByRole('cell', { name: '문서 보기', exact: true })).toBeVisible();
    await expect(panel.locator('article').getByRole('checkbox')).toBeChecked();
    await expect
      .poll(() =>
        panel
          .getByRole('img', { name: '구조 그림', exact: true })
          .evaluate((el: HTMLImageElement) => el.naturalWidth),
      )
      .toBe(1);
    await expect(
      panel.getByRole('img', { name: 'Mermaid 다이어그램', exact: true }).locator('svg'),
    ).toBeVisible();
    await panel.locator('article').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: `/tmp/pixel-documents-preview-${test.info().project.name}.png` });
    expect(await page.evaluate(() => (window as any).__docInjected)).toBeUndefined();
    expect(await panel.locator('a[href^="javascript:"]').count()).toBe(0);
    await panel.getByRole('button', { name: '원문', exact: true }).click();
    await expect(panel.locator('.document-source')).toContainText('```mermaid');
    await panel.getByRole('button', { name: '미리보기', exact: true }).click();
    await panel.getByRole('link', { name: '다음 문서', exact: true }).click();
    await expect(panel.getByRole('heading', { name: '다음 단계', exact: true })).toBeVisible();
    await panel.getByRole('link', { name: '돌아가기', exact: true }).click();
    await writeFile(path, '# 갱신된 문서\n\n```mermaid\nnot a valid diagram\n```');
    await expect(panel.getByRole('heading', { name: '갱신된 문서' })).toBeVisible({
      timeout: 12000,
    });
    await expect(panel.getByText('다이어그램을 표시할 수 없어 원문을 보여드려요.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/pixel-documents-${test.info().project.name}.png` });
  } finally {
    await rm(join(root, folder), { recursive: true, force: true });
  }
});

test('a completed run opens its Markdown artifact in the worktree and shows its diff', async ({
  page,
}) => {
  await connect(page);
  await page.getByLabel('실행 환경', { exact: true }).selectOption('isolated');
  await page.getByLabel('작업 내용').fill('문서 산출물 테스트');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.run-result.success')).toBeVisible();
  await page
    .locator('.run-result')
    .getByRole('button', { name: '문서 열기 REPORT.md', exact: true })
    .click();
  const panel = page.getByRole('tabpanel', { name: '문서·산출물', exact: true });
  await expect(panel.getByRole('heading', { name: '작업 결과 보고서' })).toBeVisible();
  await expect(page.getByLabel('코드·터미널 작업 폴더').locator('option:checked')).toContainText(
    '앱 작업 폴더',
  );
  await panel.getByRole('button', { name: '변경 비교', exact: true }).click();
  await expect(panel.locator('.document-diff')).toContainText('+# 작업 결과 보고서');
  await panel.getByRole('button', { name: '파일 README.md', exact: true }).click();
  await expect(panel.locator('article')).toHaveText('fixture');
  if (test.info().project.name === 'mobile')
    await page.getByRole('button', { name: '작업 공간 닫기' }).click();
  await page
    .locator('.run-result')
    .getByRole('button', { name: '문서 열기 REPORT.md', exact: true })
    .click();
  await expect(panel.getByRole('heading', { name: '작업 결과 보고서' })).toBeVisible();
  await page.getByLabel('코드·터미널 작업 폴더').selectOption({
    label: (await page
      .getByLabel('코드·터미널 작업 폴더')
      .locator('option')
      .first()
      .textContent())!,
  });
  await expect(panel.getByRole('button', { name: '파일 REPORT.md', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: '작업 결과 보고서' })).toHaveCount(0);
});

test('task documents open directly from history and show only this run files', async ({ page }) => {
  await connect(page);
  await page.getByLabel('실행 환경', { exact: true }).selectOption('isolated');
  await page.getByLabel('작업 내용').fill('문서 산출물 테스트');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.run-result.success')).toBeVisible();
  await page
    .locator('.inspector')
    .getByRole('button', { name: '작업 문서 보기', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '이 작업의 문서' });
  await expect(dialog.getByRole('heading', { name: '작업 결과 보고서' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '파일 README.md' })).toHaveCount(0);
  await expect(
    dialog.getByRole('navigation', { name: '작업 문서' }).getByRole('button'),
  ).toHaveCount(1);
  await dialog.getByRole('button', { name: '변경 비교' }).click();
  await expect(dialog.locator('.document-diff')).toContainText('+# 작업 결과 보고서');
  await page.screenshot({ path: `/tmp/pixel-task-documents-${test.info().project.name}.png` });
  await dialog.getByRole('button', { name: '작업 문서 닫기' }).click();
  await page.getByRole('button', { name: /^작업 기록/ }).click();
  await page
    .locator('.history-document-row')
    .first()
    .getByRole('button', { name: '작업 문서 보기' })
    .click();
  await expect(dialog.getByRole('heading', { name: '작업 결과 보고서' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator('.history-document-row').first().getByRole('button', { name: '작업 문서 보기' }),
  ).toBeFocused();
});

test('an ignored report linked in the answer opens from the task and its history', async ({
  page,
}) => {
  await connect(page);
  await page.getByLabel('실행 환경', { exact: true }).selectOption('isolated');
  await page.getByLabel('실행 방식', { exact: true }).selectOption('codex');
  await page.getByLabel('작업 내용').fill('Git 제외 보고서 테스트');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택', exact: true }).click();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.run-result.success')).toBeVisible();
  await page
    .locator('.inspector')
    .getByRole('button', { name: '작업 문서 보기', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '이 작업의 문서' });
  await expect(dialog.getByRole('heading', { name: '아티팩트 결과 보고서' })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '파일 reports/private/result-summary.md', exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: '파일 reports/private/earlier.md', exact: true })
    .click();
  await expect(dialog.getByRole('heading', { name: '앞서 작성한 보고서' })).toBeVisible();
  await dialog.getByRole('button', { name: '작업 문서 닫기' }).click();
  await page.getByRole('button', { name: /^작업 기록/ }).click();
  await page
    .locator('.history-document-row')
    .first()
    .getByRole('button', { name: '작업 문서 보기' })
    .click();
  await expect(dialog.getByRole('heading', { name: '아티팩트 결과 보고서' })).toBeVisible();
  await page.screenshot({ path: `/tmp/pixel-ignored-report-${test.info().project.name}.png` });
});

test('a coworker document is opened from its task, with earlier requests kept separate', async ({
  page,
}) => {
  const f = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const timestamp = new Date().toISOString();
  const folder = `task-docs-${test.info().project.name}`;
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  await mkdir(join(f.project, folder), { recursive: true });
  await writeFile(
    join(f.project, folder, 'latest.md'),
    '# 이번 설계 보고서\n\n작업에서 바로 열립니다.',
  );
  await writeFile(join(f.project, folder, 'older.md'), '# 이전 작업');
  try {
    await writeFile(
      f.claude,
      line({
        timestamp,
        type: 'user',
        sessionId: 'document-writer',
        cwd: f.project,
        message: { content: '이전 작업' },
      }) +
        line({
          timestamp,
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: `${folder}/older.md` } },
            ],
          },
        }) +
        line({ timestamp, type: 'user', message: { content: '이번 설계 문서 작성' } }) +
        line({
          timestamp,
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: `${folder}/latest.md` } },
            ],
          },
        }),
    );
    await connect(page);
    await page
      .getByRole('button', { name: '세션 선택 Claude document-writer', exact: true })
      .click({ timeout: 20000 });
    await page
      .locator('.session-task-card')
      .getByRole('button', { name: '작업 문서 보기' })
      .click();
    const dialog = page.getByRole('dialog', { name: '이 작업의 문서' });
    await expect(dialog.getByRole('heading', { name: '이번 설계 보고서' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: `파일 ${folder}/older.md` })).toHaveCount(0);
    await dialog.getByLabel('문서 작업 범위').selectOption('session');
    await dialog.getByRole('button', { name: `파일 ${folder}/older.md` }).click();
    await expect(dialog.getByRole('heading', { name: '이전 작업', exact: true })).toBeVisible();
    await dialog.getByLabel('문서 작업 범위').selectOption('latest');
    await expect(dialog.getByRole('heading', { name: '이번 설계 보고서' })).toBeVisible();
    await page.screenshot({ path: `/tmp/pixel-session-documents-${test.info().project.name}.png` });
    await appendFile(
      f.claude,
      line({
        timestamp: new Date().toISOString(),
        type: 'user',
        message: { content: '아직 문서가 없는 새 요청' },
      }),
    );
    await expect(dialog.getByRole('heading', { name: '아직 연결된 문서가 없어요' })).toBeVisible({
      timeout: 15000,
    });
    await expect(dialog.getByRole('heading', { name: '이번 설계 보고서' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await rm(f.claude, { force: true });
    await rm(join(f.project, folder), { recursive: true, force: true });
  }
});
