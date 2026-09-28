import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServiceConfig } from '../src/desktop/service.js';

test('window close keeps server alive, menu reopens it, and new server credentials reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-desktop-e2e-'));
  let token = 'a'.repeat(48);
  let generation = 1;
  const server = createServer(async (req, res) => {
    if (req.url === '/api/session') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const ok = JSON.parse(body).token === token;
      res.writeHead(ok ? 200 : 401, {
        'content-type': 'application/json',
        'set-cookie': `pixel_session=${token}; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end(JSON.stringify({ ok }));
    } else if (req.url === '/api/runs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<h1>Pixel Office ${generation}</h1><script>
        fetch('/api/session', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:new URLSearchParams(location.hash.slice(1)).get('token')})})
          .then(r => { document.title = r.ok ? 'Connected' : 'Failed'; history.replaceState(null,'','/'); });
        </script>`);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const configFile = join(dir, 'service.json');
  const updateConnection = () =>
    writeFile(
      join(dir, 'connection.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/#token=${token}`, pid: process.pid }),
    );
  await writeFile(
    configFile,
    JSON.stringify(
      createServiceConfig({ root: process.cwd(), nodePath: process.execPath, dataDir: dir, port }),
    ),
  );
  await updateConnection();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({
    executablePath: process.env.PIXEL_DESKTOP_EXECUTABLE,
    args: [
      ...(process.env.PIXEL_DESKTOP_EXECUTABLE ? [] : [resolve('dist/desktop/main.js')]),
      '--service-config',
      configFile,
      `--user-data-dir=${join(dir, 'browser')}`,
    ],
    env,
  });
  try {
    const page = await desktop.firstWindow();
    await expect(page.getByRole('heading', { name: 'Pixel Office 1' })).toBeVisible();
    await expect(page).toHaveTitle('Connected');
    expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    ).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/api/runs`)).status).toBe(200);
    await desktop.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()!.items[0].submenu!.items[0];
      menu.click();
    });
    await expect
      .poll(() =>
        desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      )
      .toBe(true);
    token = 'b'.repeat(48);
    generation = 2;
    await updateConnection();
    await expect(page.getByRole('heading', { name: 'Pixel Office 2' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page).toHaveTitle('Connected');
    await page.screenshot({ path: 'test-results/desktop/connected.png' });
  } finally {
    await desktop.close();
    // Quitting Electron must not terminate the independently managed server.
    expect((await fetch(`http://127.0.0.1:${port}/api/runs`)).status).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
