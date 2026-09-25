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

test('existing sessions are discovered by repo and show live tools without execution controls', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { writeFile, appendFile, rm } = await import('node:fs/promises');
  const f = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const timestamp = new Date().toISOString();
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  try {
    await writeFile(
      f.codex,
      line({ timestamp, type: 'session_meta', payload: { id: 'external-codex', cwd: f.project } }) +
        line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }) +
        line({
          timestamp,
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' },
        }),
    );
    await writeFile(
      f.claude,
      line({
        timestamp,
        type: 'user',
        sessionId: 'external-claude',
        cwd: f.project,
        message: { content: '외부 Claude 작업' },
      }) +
        line({
          timestamp,
          type: 'assistant',
          message: {
            model: 'claude-external',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }],
          },
        }),
    );
    await page.goto('/#token=e2e-token');
    await expect(page.getByRole('button', { name: /외부 세션 2/ })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: /외부 세션 2/ }).click();
    await expect(page.getByRole('heading', { name: '외부 세션 오피스' })).toBeVisible();
    await page.getByRole('button', { name: '세션 선택 Codex external-codex' }).click();
    await expect(
      page.getByRole('button', { name: '캐릭터 Codex external-codex', exact: true }),
    ).toBeVisible();
    const movingAgent = page.getByRole('button', {
      name: '캐릭터 Codex external-codex',
      exact: true,
    });
    // Coworkers keep their desk; only meetings and breaks take them away for a while.
    const deskBox = async () => {
      await expect(movingAgent).toHaveAttribute('data-place', 'desk', { timeout: 40000 });
      await expect(movingAgent).not.toHaveClass(/walking/, { timeout: 30000 });
      const [me, floor] = await Promise.all([
        movingAgent.boundingBox(),
        page.getByLabel('에이전트 이동 맵', { exact: true }).boundingBox(),
      ]);
      return { x: Math.round(me!.x - floor!.x), y: Math.round(me!.y - floor!.y) };
    };
    await expect(movingAgent).toHaveAttribute('data-activity', 'executing');
    const desk = await deskBox();
    await expect(movingAgent.locator('.floor-caption')).toHaveText('명령 실행');
    await page.getByRole('tab', { name: '작업 내역', exact: true }).click();
    await expect(page.locator('.observed-inspector')).toContainText('npm test');
    await expect(page.locator('.observed-inspector')).toContainText('기록 · 이어가기');
    await expect(page.getByRole('button', { name: '작업 중단', exact: true })).toHaveCount(0);
    await appendFile(
      f.codex,
      line({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: '외부 세션 작업 완료' },
      }),
    );
    await expect(page.locator('.observed-inspector')).toContainText('외부 세션 작업 완료', {
      timeout: 10000,
    });
    // Finishing a turn changes what the bubble says, not where the desk is.
    await expect(movingAgent).toHaveAttribute('data-status', 'idle');
    expect(await deskBox()).toEqual(desk);
    await expect(movingAgent.locator('.floor-caption')).toHaveText('응답 완료 · 대기');
    await movingAgent.click();
    await expect(movingAgent).toHaveAttribute('aria-pressed', 'true');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(movingAgent).toHaveCSS('transition-duration', '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: '세션 선택 Claude external-claude' }).click();
    await expect(page.locator('.observed-inspector')).toContainText('README.md');
    await expect(page.locator('.observed-inspector')).not.toContainText('npm test');
    await page.getByRole('tab', { name: '대화', exact: true }).click();
    await page.getByLabel('에이전트에게 질문').fill('어떤 파일을 봤어?');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(page.locator('.session-chat')).toContainText('README.md를 확인했어요.');
    await expect(page.locator('.agent-speech')).toContainText('README.md를 확인했어요.');
    await page.getByRole('button', { name: '세션 선택 Codex external-codex', exact: true }).click();
    await expect(page.locator('.session-chat')).not.toContainText('README.md를 확인했어요.');
    await expect(page.locator('.session-chat')).toContainText('작업 기록 기반 답변');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page
      .getByRole('button', { name: '세션 선택 Claude external-claude', exact: true })
      .click();
    await expect(page.locator('.session-chat')).toContainText('README.md를 확인했어요.');
    await page.reload();
    await expect(page.getByRole('heading', { name: '외부 세션 오피스' })).toBeVisible();
    await page
      .getByRole('button', { name: '세션 선택 Claude external-claude', exact: true })
      .click();
    await page.getByRole('tab', { name: '대화', exact: true }).click();
    await expect(page.locator('.session-chat')).toContainText('README.md를 확인했어요.');
    await expect(page.locator('.session-chat').getByRole('status')).toHaveCount(0);
    await expect(page.locator('.agent-speech')).toContainText('README.md를 확인했어요.');
    await page.screenshot({
      path: `docs/images/session-chat-${info.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await rm(f.codex, { force: true });
    await rm(f.claude, { force: true });
    await expect
      .poll(
        async () => {
          const r = await page.request.get('/api/observed');
          return r.ok() ? (await r.json()).sessions.length : -1;
        },
        { timeout: 10000 },
      )
      .toBe(0);
  }
});

test('separate Codex characters keep independent chats and expose failure and cancellation', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const { writeFile, rm } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const f = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const files = ['a', 'b'].map((id) =>
    join(dirname(f.codex), `chat-${info.project.name}-${id}.jsonl`),
  );
  const timestamp = new Date().toISOString();
  try {
    for (const [i, file] of files.entries())
      await writeFile(
        file,
        [
          { timestamp, type: 'session_meta', payload: { id: `chat-codex-${i}`, cwd: f.project } },
          {
            timestamp,
            type: 'event_msg',
            payload: { type: 'user_message', message: `독립 작업 ${i}` },
          },
          { timestamp, type: 'event_msg', payload: { type: 'task_started' } },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n',
      );
    await page.goto('/#token=e2e-token');
    await expect(page.getByRole('button', { name: /외부 세션 2/ })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: /외부 세션 2/ }).click();
    await expect(
      page.getByRole('button', { name: '캐릭터 Codex chat-codex-0', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '캐릭터 Codex chat-codex-1', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '세션 선택 Codex chat-codex-0', exact: true }).click();
    await page.getByRole('tab', { name: '대화', exact: true }).click();
    await page.getByLabel('에이전트에게 질문').fill('느린 답변 테스트');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(page.locator('.session-chat').getByRole('status')).toContainText('답변 작성 중');
    await page.getByRole('button', { name: '세션 선택 Codex chat-codex-1', exact: true }).click();
    await expect(page.locator('.session-chat')).toContainText('이 동료의 작업이 궁금한가요?');
    await expect(page.locator('.session-chat')).not.toContainText('느린 답변 테스트');
    await page.getByRole('button', { name: '세션 선택 Codex chat-codex-0', exact: true }).click();
    await page.getByRole('button', { name: '답변 중단', exact: true }).click();
    await expect(page.locator('.session-chat')).toContainText('답변 생성을 중단했어요.');
    await page.getByLabel('에이전트에게 질문').fill('오류 테스트');
    await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(page.locator('.session-chat').getByRole('alert')).toContainText(
      '샘플 공급자 연결 실패',
    );
    await expect(page.locator('.agent-speech')).toHaveCount(0);
    await page.getByLabel('세션 검색').fill('독립 작업 1');
    await expect(page.getByRole('region', { name: '감지된 세션' }).getByRole('button')).toHaveCount(
      1,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    for (const file of files) await rm(file, { force: true });
    await expect
      .poll(
        async () => {
          const r = await page.request.get('/api/observed');
          return r.ok() ? (await r.json()).sessions.length : -1;
        },
        { timeout: 10000 },
      )
      .toBe(0);
  }
});

test('office workspace reads code and provides a real terminal with reconnect and repo isolation', async ({
  page,
}, info) => {
  const { writeFile, mkdtemp, realpath, rm } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await realpath((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  const second = await realpath(await mkdtemp(join(tmpdir(), 'pixel-second-tools-')));
  execFileSync('git', ['init'], { cwd: second, stdio: 'pipe' });
  await writeFile(join(second, 'SECOND.md'), 'second repository only');
  execFileSync('git', ['add', '.'], { cwd: second, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'seed'],
    { cwd: second, stdio: 'pipe' },
  );
  try {
    await connect(page);
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    await page.getByRole('button', { name: '파일 README.md', exact: true }).click();
    await expect(page.locator('.source-code')).toHaveText('fixture');
    await page.screenshot({
      path: `docs/images/workspace-code-${info.project.name}.png`,
      fullPage: false,
    });
    await page.getByRole('tab', { name: '터미널', exact: true }).click();
    await page.getByRole('button', { name: '터미널 시작', exact: true }).click();
    await expect(page.locator('.terminal-toolbar')).toContainText('연결됨');
    const terminal = page.getByTestId('terminal-input');
    await terminal.pressSequentially('printf \'E2E_ROOT:%s\\n\' "$PWD"');
    await terminal.press('Enter');
    await expect(page.locator('.xterm-accessibility')).toContainText(`E2E_ROOT:${root}`);
    await terminal.pressSequentially('sleep 30');
    await terminal.press('Enter');
    await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
    await terminal.pressSequentially("printf '%s%s\\n' RESUMED _OK");
    await terminal.press('Enter');
    await expect(page.locator('.xterm-accessibility')).toContainText('RESUMED_OK');
    await page.screenshot({
      path: `docs/images/workspace-terminal-${info.project.name}.png`,
      fullPage: false,
    });
    await page.getByRole('button', { name: '작업 공간 닫기' }).click();
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    await page.getByRole('tab', { name: '터미널', exact: true }).click();
    await expect(page.locator('.terminal-toolbar')).toContainText('연결됨');
    await expect(page.locator('.xterm-accessibility')).toContainText('RESUMED_OK');
    await page.getByRole('button', { name: '작업 공간 닫기' }).click();
    await page.getByRole('button', { name: '레포 전환', exact: true }).click();
    await page.getByLabel('프로젝트 경로', { exact: true }).fill(second);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '프로젝트 연결', exact: true })
      .click();
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    await page.getByRole('button', { name: '파일 SECOND.md', exact: true }).click();
    await expect(page.locator('.source-code')).toHaveText('second repository only');
    await expect(page.getByRole('button', { name: '파일 README.md', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: '터미널', exact: true }).click();
    await expect(page.getByRole('button', { name: '터미널 시작', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '작업 공간 닫기' }).click();
    await page.getByRole('button', { name: '레포 전환', exact: true }).click();
    await page.getByRole('button', { name: `레포 선택 ${root}`, exact: true }).click();
    await page.getByRole('button', { name: '코드 · 터미널', exact: true }).click();
    await page.getByRole('tab', { name: '터미널', exact: true }).click();
    await expect(page.locator('.terminal-toolbar')).toContainText('연결됨');
    await expect(page.locator('.xterm-accessibility')).toContainText('RESUMED_OK');
    await page.getByRole('button', { name: '터미널 종료', exact: true }).click();
    await expect(page.getByRole('button', { name: '터미널 시작', exact: true })).toBeVisible();
  } finally {
    await rm(second, { recursive: true, force: true });
  }
});
