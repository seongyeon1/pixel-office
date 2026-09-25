import { expect, test } from '@playwright/test';
import { readFile, mkdtemp, mkdir, realpath, writeFile, appendFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('whole map is one office floor: worktree desks, raised hands, reports and going home', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const fixtures = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pixel-campus-')));
  const roots = [
    join(parent, 'alpha', 'shared'),
    join(parent, 'beta', 'shared'),
    join(parent, 'notes'),
  ];
  const worktree = join(parent, 'alpha', 'shared-floor');
  const claudeHome = dirname(dirname(fixtures.claude));
  const registry = join(claudeHome, 'sessions', '999999.json');
  const files: string[] = [];
  const line = (data: unknown) => JSON.stringify(data) + '\n';
  const codex = async (
    id: string,
    cwd: string,
    done = false,
    at = new Date(),
    model = 'gpt-6-sol',
  ) => {
    const path = join(dirname(fixtures.codex), `${id}.jsonl`);
    files.push(path);
    const timestamp = at.toISOString();
    await writeFile(
      path,
      line({ timestamp, type: 'session_meta', payload: { id, cwd } }) +
        line({ timestamp, type: 'turn_context', payload: { model, cwd } }) +
        line({
          timestamp,
          type: 'event_msg',
          payload: { type: 'user_message', message: `${id} 프로젝트 작업` },
        }) +
        line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }) +
        line({
          timestamp,
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' },
        }) +
        (done
          ? line({
              timestamp,
              type: 'event_msg',
              payload: { type: 'task_complete', last_agent_message: '완료' },
            })
          : ''),
    );
    return path;
  };
  const claude = async (id: string, cwd: string, tool: string) => {
    const path = join(dirname(fixtures.claude), `${id}.jsonl`);
    files.push(path);
    await writeFile(
      path,
      line({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        sessionId: id,
        cwd,
        message: {
          model: 'claude-fable-5-1',
          content: [{ type: 'tool_use', name: tool, id: `${id}-tool`, input: {} }],
        },
      }),
    );
  };
  // A hook-started session: one still writing, one finished with its work log.
  const automated = async (id: string, cwd: string, finished: boolean) => {
    const path = join(dirname(fixtures.claude), `${id}.jsonl`);
    files.push(path);
    const timestamp = new Date().toISOString();
    await writeFile(
      path,
      line({
        timestamp,
        type: 'user',
        sessionId: id,
        cwd,
        entrypoint: 'sdk-cli',
        message: {
          content: '다음 에이전트 세션 transcript을 한국어 업무일지 형식으로 요약해주세요.',
        },
      }) +
        (finished
          ? line({
              timestamp,
              type: 'assistant',
              sessionId: id,
              cwd,
              entrypoint: 'sdk-cli',
              message: {
                model: 'claude-opus-5-5',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: '### 맵을 층 평면도로 개편\n- 방·복도·입구 추가' }],
              },
            })
          : ''),
    );
  };
  const worker = (root: string, id: string) =>
    page.getByRole('button', { name: `전체 맵 동료 ${root} ${id}`, exact: true });
  try {
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
      await writeFile(join(root, 'README.md'), 'campus fixture');
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
      execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'seed'],
        { cwd: root, stdio: 'pipe' },
      );
    }
    execFileSync('git', ['worktree', 'add', '-b', 'feat/floor', worktree], {
      cwd: roots[0],
      stdio: 'pipe',
    });
    await page.goto('/#token=e2e-token');
    await expect(page.getByRole('button', { name: '전체 맵', exact: true })).toBeVisible();
    for (const root of roots) {
      const response = await page.request.post('/api/projects/inspect', {
        headers: { origin: 'http://127.0.0.1:4318' },
        data: { path: root },
      });
      expect(response.ok()).toBe(true);
    }
    for (let i = 0; i < 5; i++)
      await codex(
        `campus-a${i}`,
        roots[0],
        i === 4,
        new Date(),
        i === 4 ? 'gpt-6-astra' : 'gpt-6-sol',
      );
    await codex('campus-wt', worktree);
    const beta = await codex('campus-b', roots[1], false, new Date(), 'gpt-6-luna');
    // Finished 45 minutes ago: already went home.
    await codex('campus-old', roots[2], true, new Date(Date.now() - 45 * 60000));
    await claude('campus-ask', roots[2], 'AskUserQuestion');
    await claude('campus-leave', roots[2], 'Read');
    await automated('campus-journal-live', roots[0], false);
    await automated('campus-journal-done', roots[0], true);
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    const a = page.getByRole('article', { name: `프로젝트 공간 ${roots[0]}`, exact: true });
    const b = page.getByRole('article', { name: `프로젝트 공간 ${roots[1]}`, exact: true });
    const notes = page.getByRole('article', { name: `프로젝트 공간 ${roots[2]}`, exact: true });
    await expect(worker(roots[0], 'campus-wt')).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel('회의실', { exact: true })).toBeVisible();
    await expect(page.getByLabel('입구', { exact: true })).toBeVisible();
    await expect(a).toContainText('보고 1');
    await expect(page.locator('.floor-lane-tag', { hasText: 'feat/floor' })).toBeVisible();
    await expect(page.locator('.floor-lane-tag', { hasText: 'main' }).first()).toBeVisible();
    await expect(worker(roots[0], 'campus-a4')).toHaveAttribute('data-mark', 'report');
    await expect(worker(roots[0], 'campus-a0')).not.toHaveAttribute('data-mark', /.+/);
    await expect(notes).toContainText('응답 필요 1', { timeout: 20000 });
    await expect(worker(roots[2], 'campus-ask')).toHaveAttribute('data-mark', 'question');
    await expect(worker(roots[2], 'campus-old')).toHaveCount(0);
    // Hook-started work never takes a desk or raises a report; running work sits in the records room.
    await expect(page.getByLabel('기록실', { exact: true })).toContainText('작성 중 1');
    await expect(worker(roots[0], 'campus-journal-live')).toHaveAttribute('data-place', 'records');
    await expect(worker(roots[0], 'campus-journal-done')).toHaveCount(0);
    // Model families: a badge per coworker and a filter that keeps only matching rooms.
    await expect(worker(roots[0], 'campus-a4').locator('.floor-family')).toHaveText('Astra');
    await expect(worker(roots[0], 'campus-a0').locator('.floor-family')).toHaveText('Sol');
    await expect(worker(roots[2], 'campus-ask').locator('.floor-family')).toHaveText('Fable');
    const models = page.getByLabel('모델로 동료 거르기');
    await models.selectOption({ label: 'Codex · Luna (1)' });
    await expect(b).toBeVisible();
    await expect(a).toHaveCount(0);
    await expect(notes).toHaveCount(0);
    await models.selectOption('');
    await expect(a).toBeVisible();
    await expect(page.getByText('최근 퇴근 1명', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Everyone who arrived has walked in from the entrance and sat down.
    // Office life keeps someone walking at almost any moment; wait for arrivals only.
    await expect(page.locator('.floor-worker[data-arriving]')).toHaveCount(0, { timeout: 30000 });
    // A full-page capture renders beyond the viewport and catches the floor mid-reflow;
    // grow the viewport to the page instead and take an ordinary capture.
    const viewport = page.viewportSize()!;
    await page.setViewportSize({
      width: viewport.width,
      height: await page.evaluate(() => document.documentElement.scrollHeight),
    });
    await expect(page.locator('.floor-worker[data-arriving]')).toHaveCount(0);
    await page.screenshot({ path: `docs/images/project-map-${info.project.name}.png` });
    await page.setViewportSize(viewport);
    // Showing a room again after a search is not an arrival: its people are at their desks.
    await page.getByLabel('전체 맵 프로젝트 검색').fill(`${parent.split('/').at(-1)!}/beta`);
    await expect(a).toHaveCount(0);
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    await expect(worker(roots[0], 'campus-a4')).toBeVisible();
    await page.waitForTimeout(300);
    const room = (await a.boundingBox())!;
    const seat = (await worker(roots[0], 'campus-a4').boundingBox())!;
    const cx = seat.x + seat.width / 2,
      cy = seat.y + seat.height / 2;
    expect(
      cx > room.x && cx < room.x + room.width && cy > room.y && cy < room.y + room.height,
    ).toBe(true);
    // Closing the terminal sends the coworker home through the entrance.
    await mkdir(dirname(registry), { recursive: true });
    await writeFile(registry, JSON.stringify({ pid: 999999, sessionId: 'campus-leave' }));
    await expect(page.locator('.floor-worker[data-place="leaving"]')).toHaveCount(1, {
      timeout: 15000,
    });
    await expect(page.locator('.floor-worker[data-place="leaving"]')).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(worker(roots[2], 'campus-leave')).toHaveCount(0);
    await expect(page.getByText('최근 퇴근 2명', { exact: true })).toBeVisible();
    // Their results are collected on the records page instead.
    await page.getByRole('button', { name: /^자동 기록/ }).click();
    await expect(page.getByRole('heading', { name: '자동 기록', exact: true })).toBeVisible();
    await page.getByLabel('자동 기록 레포 검색').fill(parent.split('/').at(-1)!);
    const done = page.getByRole('button', {
      name: `자동 기록 업무일지 shared campus-journal-done`,
      exact: true,
    });
    await done.click();
    await expect(page.locator('.record.open pre').first()).toContainText('맵을 층 평면도로 개편');
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    // Opening a coworker reads the report.
    await worker(roots[0], 'campus-a4').click();
    await expect(page.getByRole('heading', { name: '외부 세션 오피스' })).toBeVisible();
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      roots[0],
    );
    await expect(
      page.getByRole('button', { name: '캐릭터 Codex campus-a4', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    await expect(worker(roots[0], 'campus-a4')).toBeVisible();
    await expect(worker(roots[0], 'campus-a4')).not.toHaveAttribute('data-mark', /.+/);
    await expect(a).not.toContainText('보고');
    await appendFile(
      beta,
      line({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: '다른 프로젝트 완료' },
      }),
    );
    await expect(worker(roots[1], 'campus-b')).toHaveAttribute('data-mark', 'report', {
      timeout: 15000,
    });
    await page.getByText('최근 퇴근 2명', { exact: true }).click();
    await page
      .getByRole('button', { name: `퇴근한 동료 ${roots[2]} campus-old`, exact: true })
      .click();
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      roots[2],
    );
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    await page.getByLabel('활동 있는 프로젝트만').check();
    await expect(a).toBeVisible();
    await expect(notes).toBeVisible();
    await expect(b).toHaveCount(0);
    await page.getByLabel('전체 맵 프로젝트 검색').fill('does-not-exist');
    await expect(
      page.getByRole('heading', { name: '조건에 맞는 프로젝트가 없어요' }),
    ).toBeVisible();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    await page.getByLabel('활동 있는 프로젝트만').uncheck();
    await b.getByRole('button', { name: `프로젝트 열기 ${roots[1]}`, exact: true }).click();
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      roots[1],
    );
  } finally {
    for (const path of files) await rm(path, { force: true });
    await rm(registry, { force: true });
    await rm(parent, { recursive: true, force: true });
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/observed');
          return response.ok()
            ? (await response.json()).sessions.filter((s: { sessionId: string }) =>
                s.sessionId.startsWith('campus-'),
              ).length
            : -1;
        },
        { timeout: 15000 },
      )
      .toBe(0);
  }
});

test('whole map shows app approvals and opens the managed task without mixing external sessions', async ({
  page,
}) => {
  const { defaultTeam } = await import('../src/shared/contracts');
  const root = await realpath((await readFile('.pixel/e2e-project.txt', 'utf8')).trim());
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('button', { name: '전체 맵', exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const connected = await page.request.post('/api/projects/inspect', {
    headers: { origin },
    data: { path: root },
  });
  expect(connected.ok()).toBe(true);
  const response = await page.request.post('/api/runs', {
    headers: { origin },
    data: {
      projectPath: root,
      prompt: '전체 맵 승인 테스트',
      mode: 'codex',
      implementer: 'codex',
      team: defaultTeam(),
    },
  });
  expect(response.ok()).toBe(true);
  const run = await response.json();
  try {
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    const room = page.getByRole('article', { name: `프로젝트 공간 ${root}`, exact: true });
    await expect(room).toContainText('응답 필요 1');
    const manager = page.getByRole('button', {
      name: `전체 맵 동료 ${root} ${run.id}`,
      exact: true,
    });
    await expect(manager).toHaveAttribute('data-mark', 'approval');
    await expect(manager).toHaveAttribute('title', /앱 작업 · 승인 필요/);
    await manager.click();
    await expect(page.getByRole('heading', { name: '승인 필요', exact: true })).toBeVisible();
    await expect(page.locator('.current-task')).toContainText('전체 맵 승인 테스트');
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      root,
    );
  } finally {
    await page.request.post(`/api/runs/${run.id}/cancel`, { headers: { origin }, data: {} });
  }
});
