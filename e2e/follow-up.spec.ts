import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultTeam } from '../src/shared/contracts';

test('bundle history is discoverable from a member repo and follow-ups survive reload', async ({
  page,
}, info) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'pixel-history-')));
  const repos = [join(folder, 'api'), join(folder, 'web')];
  for (const repo of repos) {
    await mkdir(repo);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    await writeFile(join(repo, 'README.md'), 'fixture');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed'],
      { cwd: repo, stdio: 'pipe' },
    );
  }
  await page.goto('/#token=e2e-token');
  await expect(page.getByRole('heading', { level: 1, name: /오피스$/ })).toBeVisible();
  const post = (path: string, body: unknown) =>
    page.evaluate(
      async ({ path, body }) => {
        const r = await fetch(`/api${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      { path, body },
    );
  await post('/settings/approvals', { mode: 'auto' });
  try {
    const first = await post('/runs', {
      projectPath: folder,
      repositories: repos,
      prompt: '묶음 기록 원본 요청',
      mode: 'collaborate',
      implementer: 'codex',
      team: defaultTeam(),
    });
    expect(first.executionMode).toBe('personal');
    expect(first.worktreePath).toBe(folder);
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) => (await (await fetch(`/api/runs/${id}`)).json()).run.status,
          first.id,
        ),
      )
      .toBe('completed');
    await page.getByRole('button', { name: '레포 전환', exact: true }).click();
    await page.getByLabel('프로젝트 경로', { exact: true }).fill(repos[0]);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '프로젝트 연결', exact: true })
      .click();
    await page.getByRole('button', { name: '전체 작업 기록 열기' }).click();
    await expect(page.locator('.history-list')).toContainText('묶음 기록 원본 요청');
    await page.getByLabel('작업 기록 범위').selectOption('project');
    await expect(page.locator('.history-list')).toContainText('묶음 기록 원본 요청');
    await page
      .locator('.history-document-row > button:first-child')
      .filter({ hasText: '묶음 기록 원본 요청' })
      .filter({ hasText: folder.split('/').at(-1)! })
      .click();
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      folder,
    );
    await expect(page.getByRole('region', { name: '이전 작업과 추가 요청' })).toContainText(
      '작업 기록에 저장됨',
    );
    await page.getByLabel('이 작업에 추가 요청').fill('회귀 테스트 추가 요청');
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`/runs/${first.id}/follow-up`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '추가 요청 보내기' }).click();
    const next = await (await response).json();
    expect(next.worktreePath).toBe(first.worktreePath);
    expect(next.repos).toEqual(first.repos);
    expect(next.parentRunId).toBe(first.id);
    expect(next.executionMode).toBe('personal');
    await expect(page.getByRole('region', { name: '이전 작업과 추가 요청' })).toContainText(
      '회귀 테스트 추가 요청',
    );
    await page.reload();
    await expect(page.getByRole('region', { name: '이전 작업과 추가 요청' })).toContainText(
      '회귀 테스트 추가 요청',
    );
    await page.screenshot({ path: info.outputPath('follow-up.png'), fullPage: true });
    await page.getByRole('button', { name: '이 작업의 기록 보기', exact: true }).click();
    await expect(page.locator('.history-list')).toContainText('묶음 기록 원본 요청');
    await expect(page.locator('.history-list')).toContainText('추가 요청 · 회귀 테스트 추가 요청');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('history.png'), fullPage: true });
    // A delayed history navigation must not invalidate a newer project's snapshot.
    const other = await post('/runs', {
      projectPath: repos[0],
      prompt: '나중에 선택한 작업',
      mode: 'codex',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) => (await (await fetch(`/api/runs/${id}`)).json()).run.status,
          other.id,
        ),
      )
      .toBe('completed');
    const chooseOther = async () => {
      await page.getByRole('button', { name: '레포 전환', exact: true }).click();
      await page.getByRole('button', { name: `레포 선택 ${repos[0]}`, exact: true }).click();
    };
    await chooseOther();
    await expect(page.locator('.current-task')).toContainText('나중에 선택한 작업');
    await page.getByRole('button', { name: '전체 작업 기록 열기' }).click();
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let oldRequested!: () => void;
    let newRequested!: () => void;
    let oldResponded!: () => void;
    const oldGate = new Promise<void>((r) => {
      releaseOld = r;
    });
    const newGate = new Promise<void>((r) => {
      releaseNew = r;
    });
    const oldReady = new Promise<void>((r) => {
      oldRequested = r;
    });
    const newReady = new Promise<void>((r) => {
      newRequested = r;
    });
    const oldDone = new Promise<void>((r) => {
      oldResponded = r;
    });
    await page.route('**/api/projects/inspect', async (route) => {
      if (route.request().postDataJSON().path !== folder) return route.continue();
      const response = await route.fetch();
      oldRequested();
      await oldGate;
      await route.fulfill({ response });
      oldResponded();
    });
    await page.route(`**/api/runs/${other.id}`, async (route) => {
      const response = await route.fetch();
      newRequested();
      await newGate;
      await route.fulfill({ response });
    });
    await page
      .locator('.history-document-row > button:first-child')
      .filter({ hasText: '묶음 기록 원본 요청' })
      .filter({ hasText: folder.split('/').at(-1)! })
      .click();
    await oldReady;
    await chooseOther();
    await newReady;
    releaseOld();
    await oldDone;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    releaseNew();
    await expect(page.locator('.current-task')).toContainText('나중에 선택한 작업');
    await expect(page.getByRole('button', { name: '레포 전환', exact: true })).toHaveAttribute(
      'title',
      repos[0],
    );
  } finally {
    await post('/settings/approvals', { mode: 'manual' });
  }
});
