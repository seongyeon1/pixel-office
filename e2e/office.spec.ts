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
test('expired server session replaces stale execution with a reconnection message', async ({
  page,
}) => {
  let socket: import('@playwright/test').WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/events*', (ws) => {
    socket = ws;
    ws.connectToServer();
  });
  await connect(page);
  await page.getByLabel('작업 내용').fill('서버 재시작 테스트');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await expect(page.getByRole('heading', { name: '승인 필요' })).toBeVisible();
  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: '연결 URL로 앱을 다시 열어 주세요.' }),
    }),
  );
  await socket!.close();
  await expect(
    page.getByText('터미널에 표시된 연결 URL로 열어주세요.', { exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const response = await page.request.get('/api/health');
  if (response.ok()) {
    const h = await response.json();
    if (h.activeId)
      await page.request.post(`/api/runs/${h.activeId}/cancel`, {
        headers: { origin: 'http://127.0.0.1:4318' },
        data: {},
      });
  }
});
test('single-agent mode shows the actual implementer instead of a reviewer role', async ({
  page,
}) => {
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { name: '오늘의 오피스.' })).toBeVisible();
  await page.getByLabel('실행 방식').selectOption('claude');
  await expect(page.getByText('구현과 테스트를 담당해요', { exact: true })).toBeVisible();
  await expect(page.getByText('Claude가 단독으로 작업해요', { exact: true })).toBeVisible();
});

test('repository switching isolates live activity and history and survives reload', async ({
  page,
}) => {
  const { mkdtemp, realpath, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pixel-repo-switch-'));
  const second = join(dir, 'sample');
  await mkdir(second);
  execFileSync('git', ['init'], { cwd: second, stdio: 'pipe' });
  await writeFile(join(second, 'README.md'), 'second repo');
  execFileSync('git', ['add', '.'], { cwd: second, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed'],
    { cwd: second, stdio: 'pipe' },
  );
  const firstRoot = await realpath((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  const secondRoot = await realpath(second);
  await connect(page);
  await page.getByLabel('작업 내용').fill('첫 레포의 승인 대기 작업');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await expect(page.getByRole('heading', { name: '승인 필요' })).toBeVisible();
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page.getByLabel('프로젝트 경로', { exact: true }).fill(second);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '프로젝트 연결', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '승인 필요' })).toHaveCount(0);
  await expect(page.locator('.current-task')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '진행 중인 레포로 이동' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
    'title',
    secondRoot,
  );
  await expect(page.locator('.current-task')).toHaveCount(0);
  await page.getByRole('button', { name: /^작업 기록/ }).click();
  await expect(page.getByRole('heading', { name: '첫 작업을 기다리고 있어요' })).toBeVisible();
  await page.getByRole('button', { name: '진행 중인 레포로 이동' }).click();
  await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
    'title',
    firstRoot,
  );
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await expect(page.getByRole('heading', { name: '승인 필요' })).toBeVisible();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.run-result.success')).toBeVisible();
  await page.getByRole('button', { name: '레포 전환', exact: true }).click();
  await page.getByRole('button', { name: `레포 선택 ${secondRoot}`, exact: true }).click();
  await page.getByLabel('작업 내용').fill('두 번째 레포의 작업');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 선택' }).click();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.run-result.success')).toBeVisible();
  await page.getByRole('button', { name: /^작업 기록/ }).click();
  await expect(page.locator('.history-list')).toContainText('두 번째 레포의 작업');
  await expect(page.locator('.history-list')).not.toContainText('첫 레포의 승인 대기 작업');
  await page.reload();
  await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
    'title',
    secondRoot,
  );
  await expect(page.locator('.current-task')).toContainText('두 번째 레포의 작업');
});
