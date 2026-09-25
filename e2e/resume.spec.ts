import { test, expect } from '@playwright/test';
import { readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} resumes its exact session, reconnects, retires and returns from the map`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    const sessionId =
      provider === 'claude'
        ? '5b0c7a2e-3d41-4f6a-9e8b-1c2d3e4f5a6b'
        : '6b0c7a2e-3d41-4f6a-9e8b-1c2d3e4f5a6b';
    const name = provider === 'claude' ? 'Claude' : 'Codex';
    const f = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
    const projectRoot = await realpath(f.project);
    const log = join(dirname(f[provider]), `resume-${sessionId}.jsonl`);
    const timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const data =
      (provider === 'claude'
        ? [
            {
              timestamp,
              type: 'user',
              sessionId,
              cwd: f.project,
              message: { content: '끊긴 터미널 작업' },
            },
          ]
        : [
            { timestamp, type: 'session_meta', payload: { id: sessionId, cwd: f.project } },
            {
              timestamp,
              type: 'event_msg',
              payload: { type: 'user_message', message: '끊긴 터미널 작업' },
            },
            { timestamp, type: 'event_msg', payload: { type: 'task_complete' } },
          ]
      )
        .map((v) => JSON.stringify(v))
        .join('\n') + '\n';
    await writeFile(log, data);
    const terminal = page.getByRole('region', { name: '세션 이어서 작업 터미널', exact: true });
    const openDock = async () => {
      await page.getByRole('button', { name: `캐릭터 ${name} ${sessionId}`, exact: true }).click();
      await page
        .locator('.session-task-card')
        .getByRole('button', { name: '이어서 작업', exact: true })
        .click();
      await expect(terminal).toBeVisible();
    };
    let observedId = '';
    try {
      await page.goto('/#token=e2e-token');
      await page.getByRole('button', { name: /외부 세션 \d+/ }).click();
      await expect(
        page.getByRole('button', { name: `캐릭터 ${name} ${sessionId}`, exact: true }),
      ).toBeVisible({ timeout: 20000 });
      await openDock();
      await terminal.getByRole('button', { name: '이어서 작업', exact: true }).click();
      const command = provider === 'claude' ? `--resume ${sessionId}` : `resume ${sessionId}`;
      await expect(terminal).toContainText(`FAKE-${provider.toUpperCase()} ${command}`);
      await terminal.getByTestId('terminal-input').pressSequentially('keep going\r');
      await expect(terminal).toContainText('GOT:keep going');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `docs/images/session-resume-${provider}-${info.project.name}.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: '이어서 작업 숨기기' }).click();
      await openDock();
      await expect(terminal).toContainText('GOT:keep going');
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await openDock();
      await expect(terminal).toContainText('GOT:keep going');
      const snapshot = await (await page.request.get('/api/observed')).json();
      observedId = snapshot.sessions.find(
        (s: { sessionId: string }) => s.sessionId === sessionId,
      ).id;
      const before = await (await page.request.get(`/api/observed/${observedId}/terminal`)).json();
      await page.getByRole('button', { name: '이어서 작업 숨기기' }).click();
      await page.getByRole('button', { name: '퇴근시키기', exact: true }).click();
      await page.getByRole('button', { name: '퇴근 확인', exact: true }).click();
      await expect(
        page.getByRole('button', { name: `캐릭터 ${name} ${sessionId}`, exact: true }),
      ).toHaveCount(0);
      expect((await page.request.get(`/api/terminals/${before.id}`)).status()).toBe(404);
      expect(await readFile(log, 'utf8')).toBe(data);
      await page.getByRole('button', { name: '전체 맵', exact: true }).click();
      await expect(
        page.getByRole('button', { name: `전체 맵 동료 ${projectRoot} ${sessionId}`, exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await page.getByText('퇴근한 동료 1명', { exact: true }).click();
      await page.getByRole('button', { name: `다시 출근 ${sessionId}`, exact: true }).click();
      await expect(
        page.getByRole('button', { name: `전체 맵 동료 ${projectRoot} ${sessionId}`, exact: true }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: `전체 맵 동료 ${projectRoot} ${sessionId}`, exact: true })
        .click();
      await openDock();
      await terminal.getByRole('button', { name: '이어서 작업', exact: true }).click();
      await expect(terminal).toContainText(`FAKE-${provider.toUpperCase()} ${command}`);
      const after = await (await page.request.get(`/api/observed/${observedId}/terminal`)).json();
      expect(after.id).not.toBe(before.id);
      await terminal.getByRole('button', { name: '터미널 종료', exact: true }).click();
      await expect(
        terminal.getByRole('button', { name: '이어서 작업', exact: true }),
      ).toBeVisible();
    } finally {
      if (observedId) {
        const r = await page.request.get(`/api/observed/${observedId}/terminal`);
        if (r.ok())
          await page.request.post(`/api/terminals/${(await r.json()).id}/close`, {
            headers: { origin: 'http://127.0.0.1:4318' },
            data: {},
          });
        await page.request.post(`/api/observed/${observedId}/restore`, {
          headers: { origin: 'http://127.0.0.1:4318' },
          data: {},
        });
      }
      await rm(log, { force: true });
      await expect
        .poll(
          async () =>
            (await (await page.request.get('/api/observed')).json()).sessions.some(
              (s: { sessionId: string }) => s.sessionId === sessionId,
            ),
          { timeout: 15000 },
        )
        .toBe(false);
    }
  });
}
