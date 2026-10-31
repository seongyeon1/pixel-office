import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function connect(page: import('@playwright/test').Page) {
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
}

test('one composer starts work, follows up, and preserves a separate new-task draft', async ({
  page,
}, info) => {
  await connect(page);
  const composer = page.getByRole('region', { name: '작업 지시' });
  await expect(composer).toBeVisible();
  await composer.getByLabel('지시 대상').selectOption('new');
  await expect(page.getByRole('button', { name: '사무실 펼치기' })).toBeVisible();
  await expect(page.locator('.session-office')).toBeHidden();
  await page.getByLabel('작업 내용', { exact: true }).fill('중단 테스트: 통합 입력창');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(page.locator('.run-result')).toContainText('중단됨');
  await expect(composer.getByLabel('지시 대상')).toHaveValue('run');
  await composer.getByLabel('작업 내용', { exact: true }).fill('중단 테스트: 추가 지시');
  await composer.getByLabel('지시 대상').selectOption('new');
  await composer.getByLabel('작업 내용', { exact: true }).fill('새 작업 초안');
  await composer.getByLabel('지시 대상').selectOption('run');
  await expect(composer.getByLabel('작업 내용', { exact: true })).toHaveValue(
    '중단 테스트: 추가 지시',
  );
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/follow-up') && r.request().method() === 'POST',
  );
  await composer.getByRole('button', { name: '추가 요청 보내기', exact: true }).click();
  expect((await response).ok()).toBe(true);
  await page.getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(page.locator('.run-result')).toContainText('중단됨');
  await composer.getByLabel('지시 대상').selectOption('new');
  await expect(composer.getByLabel('작업 내용', { exact: true })).toHaveValue('새 작업 초안');
  await page.getByRole('button', { name: '전체 작업 기록 열기' }).click();
  await page.getByRole('button', { name: '오피스로 돌아가기', exact: true }).click();
  await expect(composer.getByLabel('작업 내용', { exact: true })).toHaveValue('새 작업 초안');
  await page.getByRole('button', { name: '터미널 모드', exact: true }).click();
  await page
    .getByRole('navigation', { name: '주 메뉴' })
    .getByRole('button', { name: /작업 기록/ })
    .click();
  await page
    .locator('.history-document-row > button:first-child')
    .filter({ hasText: '중단 테스트: 추가 지시' })
    .first()
    .click();
  await expect(composer.getByLabel('지시 대상')).toHaveValue('run');
  await composer.getByLabel('지시 대상').selectOption('new');
  await expect(composer.getByLabel('작업 내용', { exact: true })).toHaveValue('새 작업 초안');
  await page.getByRole('button', { name: '사무실 펼치기' }).click();
  await expect(page.locator('.session-office')).toBeVisible();
  await page.getByRole('button', { name: '사무실 접기' }).click();
  await page.reload();
  await expect(page.locator('.session-office')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/workbench-${info.project.name}.png`,
    fullPage: true,
  });
});

test('session instructions, records questions, split view and terminal share the workbench', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const { writeFile, rm } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const fixture = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const paths: string[] = [];
  const ids = [`workbench-a-${info.project.name}`, `workbench-b-${info.project.name}`];
  for (const id of ids) {
    const path = join(dirname(fixture.codex), `${id}.jsonl`);
    paths.push(path);
    const timestamp = new Date(Date.now() - 600000).toISOString();
    await writeFile(
      path,
      [
        { timestamp, type: 'session_meta', payload: { id, cwd: fixture.project } },
        {
          timestamp,
          type: 'event_msg',
          payload: { type: 'user_message', message: `이전 작업 ${id}` },
        },
        { timestamp, type: 'event_msg', payload: { type: 'task_complete' } },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
  }
  try {
    await connect(page);
    const pick = async (id: string) => {
      const button = page.getByRole('button', { name: `세션 선택 Codex ${id}`, exact: true });
      if (info.project.name === 'mobile')
        await page.getByRole('button', { name: '동료 목록 열기' }).click();
      await expect(button).toBeVisible({ timeout: 20000 });
      await button.click();
    };
    await pick(ids[0]);
    const composer = page.getByRole('region', { name: '작업 지시' });
    await expect(composer.getByLabel('지시 대상')).toHaveValue(new RegExp('^session:'));
    await expect(composer.getByRole('button', { name: '지시 보내기' })).toBeDisabled();
    await composer.getByLabel('작업 내용', { exact: true }).fill('첫 번째 세션 초안');
    await page.getByRole('button', { name: '선택한 세션 분할 보기' }).click();
    await pick(ids[1]);
    await expect(page.getByRole('complementary', { name: '고정한 세션' })).toContainText(
      ids[0].slice(0, 8),
    );
    await composer.getByLabel('작업 내용', { exact: true }).fill('두 번째 세션 작업');
    await composer.getByRole('button', { name: '지시 보내기', exact: true }).click();
    const primary = page.locator('.work-primary');
    await expect(primary).toContainText('샘플 파일 수정 승인');
    await primary.getByRole('button', { name: '승인', exact: true }).click();
    await expect(primary).toContainText('지시대로 처리했어요: 두 번째 세션 작업');
    await page
      .getByRole('complementary', { name: '고정한 세션' })
      .getByRole('button', { name: '이 세션에 지시' })
      .click();
    await expect(composer.getByLabel('작업 내용', { exact: true })).toHaveValue(
      '첫 번째 세션 초안',
    );
    await page.getByRole('button', { name: '고정한 세션 닫기' }).click();
    await composer.getByLabel('지시 방식').selectOption('ask');
    await composer.getByLabel('작업 내용', { exact: true }).fill('README.md를 확인했어?');
    await composer.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(primary).toContainText('README.md를 확인했어요.');
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    await expect(page.getByRole('region', { name: '코드와 터미널' })).toBeVisible();
    const dock = page.getByRole('region', { name: '코드와 터미널' });
    const before = (await dock.boundingBox())!;
    await page.getByRole('button', { name: '작업 공간 확대', exact: true }).click();
    await expect
      .poll(async () => (await dock.boundingBox())!.height)
      .toBeGreaterThan(before.height);
    await expect(composer).toBeInViewport();
    await page.screenshot({
      path: `test-results/workbench-expanded-${info.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: '작업 공간 축소', exact: true }).click();
    await expect(composer).toBeInViewport();
    await expect(composer.getByLabel('작업 내용', { exact: true })).toBeInViewport();
    await page.getByRole('button', { name: '작업 공간 닫기' }).click();
    await expect(primary).toContainText('README.md를 확인했어요.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/workbench-session-${info.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }
});

test('toolbar and keyboard use the same input and failed sends retain the draft', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: '새 작업 작성', exact: true }).click();
  const composer = page.getByRole('region', { name: '작업 지시' });
  const input = composer.getByLabel('작업 내용', { exact: true });
  await expect(input).toBeFocused();
  await expect(page.getByRole('region', { name: '새 동료 시작', exact: true })).toHaveCount(0);
  await input.fill('중단 테스트: 단축키 요청');
  let requests = 0;
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests++;
    await route.fulfill({ status: 409, json: { error: '임시 연결 오류' } });
  });
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  expect(requests).toBe(0);
  await input.press('Control+Enter');
  await expect(composer.getByRole('alert')).toContainText('임시 연결 오류');
  await expect(input).toHaveValue('중단 테스트: 단축키 요청');
  expect(requests).toBe(1);
  await page.unroute('**/api/runs');
  await input.press('Control+Enter');
  await page.getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(page.locator('.run-result')).toContainText('중단됨');
});

test('an accepted send clears its original draft after navigating away', async ({ page }) => {
  await connect(page);
  const composer = page.getByRole('region', { name: '작업 지시' });
  await composer.getByLabel('지시 대상').selectOption('new');
  await composer.getByLabel('작업 내용', { exact: true }).fill('중단 테스트: 화면 이동 중 전송');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted!: () => void;
  const received = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    accepted();
    await gate;
    await route.fulfill({ response });
  });
  await composer.getByRole('button', { name: '작업 시작', exact: true }).click();
  await received;
  await page.getByRole('button', { name: '전체 작업 기록 열기' }).click();
  await expect(composer).toHaveCount(0);
  release();
  await page.getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(page.locator('.run-result')).toContainText('중단됨');
  await composer.getByLabel('지시 대상').selectOption('new');
  await expect(composer.getByLabel('작업 내용', { exact: true })).toHaveValue('');
});
