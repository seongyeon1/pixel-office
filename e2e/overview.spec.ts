import { expect, test } from '@playwright/test';
import { readFile, mkdtemp, mkdir, realpath, writeFile, appendFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('whole map monitors multiple projects, preserves view, and opens the exact coworker', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const fixtures = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pixel-campus-')));
  const roots = [
    join(parent, 'alpha', 'shared'),
    join(parent, 'beta', 'shared'),
    join(parent, 'notes'),
  ];
  const files: string[] = [];
  const line = (data: unknown) => JSON.stringify(data) + '\n';
  try {
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
      await writeFile(join(root, 'README.md'), 'campus fixture');
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
      execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'seed'],
        { cwd: root, stdio: 'pipe' },
      );
    }
    await page.goto('/#token=e2e-token');
    await expect(page.getByRole('button', { name: '전체 맵', exact: true })).toBeVisible();
    for (const root of roots) {
      const response = await page.request.post('/api/projects/inspect', {
        headers: { origin: 'http://127.0.0.1:4318' },
        data: { path: root },
      });
      expect(response.ok()).toBe(true);
    }
    for (const [i, id] of [
      'campus-a0',
      'campus-a1',
      'campus-a2',
      'campus-a3',
      'campus-a4',
      'campus-b',
    ].entries()) {
      const path = join(dirname(fixtures.codex), `${id}.jsonl`);
      files.push(path);
      const timestamp = new Date().toISOString();
      await writeFile(
        path,
        line({
          timestamp,
          type: 'session_meta',
          payload: { id, cwd: i === 5 ? roots[1] : roots[0] },
        }) +
          line({
            timestamp,
            type: 'event_msg',
            payload: { type: 'user_message', message: `${id} 프로젝트 작업` },
          }) +
          line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }) +
          line({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'exec_command',
              arguments: '{"cmd":"npm test"}',
            },
          }) +
          (i === 4
            ? line({
                timestamp,
                type: 'event_msg',
                payload: { type: 'task_complete', last_agent_message: '완료' },
              })
            : ''),
      );
    }
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    const a = page.getByRole('article', { name: `프로젝트 공간 ${roots[0]}`, exact: true });
    const b = page.getByRole('article', { name: `프로젝트 공간 ${roots[1]}`, exact: true });
    const empty = page.getByRole('article', { name: `프로젝트 공간 ${roots[2]}`, exact: true });
    await expect(a).toContainText('활동 4명', { timeout: 20000 });
    await expect(a).toContainText('+1명 더 보기');
    await expect(b).toContainText('활동 1명');
    await expect(empty).toContainText('지금 감지된 동료가 없어요.');
    await expect(a.locator('.project-map-worker')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `docs/images/project-map-${info.project.name}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '전체 프로젝트 맵', exact: true }),
    ).toBeVisible();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    await a
      .getByRole('button', { name: `전체 맵 동료 ${roots[0]} campus-a3`, exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '외부 세션 오피스' })).toBeVisible();
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      roots[0],
    );
    await expect(
      page.getByRole('button', { name: '캐릭터 Codex campus-a3', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '전체 맵', exact: true }).click();
    await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1)!);
    await appendFile(
      files[5],
      line({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: '다른 프로젝트 완료' },
      }),
    );
    await expect(b.locator('.project-map-worker')).toHaveAttribute('data-status', 'idle', {
      timeout: 15000,
    });
    await page.getByLabel('활동 있는 프로젝트만').check();
    await expect(a).toBeVisible();
    await expect(b).toHaveCount(0);
    await expect(empty).toHaveCount(0);
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
    await expect(room).toContainText('앱 작업 · 승인 필요');
    await room.getByRole('button', { name: `전체 맵 동료 ${root} ${run.id}`, exact: true }).click();
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
