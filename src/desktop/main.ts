import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadServiceConfig,
  readReadyConnection,
  servicePaths,
  startService,
  type Connection,
  type ServiceConfig,
} from './service.js';
import { navigationTarget, RunNotifications, shouldStartServer } from './policy.js';

app.setName('Pixel Office');
const configArg = process.argv.indexOf('--service-config');
const paths = servicePaths();
if (configArg >= 0) paths.config = process.argv[configArg + 1];
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let config: ServiceConfig;
let connection: Connection | null = null;
let lastWindowUrl = '';
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
let cookie = '';
const notifications = new RunNotifications();

function trayImage() {
  // Same chair as the web logo; macOS supplies the menu bar's light/dark color.
  const icon = nativeImage.createFromPath(
    fileURLToPath(new URL('./assets/trayTemplate.png', import.meta.url)),
  );
  if (icon.isEmpty())
    throw new Error('메뉴바 아이콘이 없습니다. npm run build:desktop을 실행하세요.');
  icon.setTemplateImage(true);
  return icon;
}

function report(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /token=[a-f0-9]+/gi,
    'token=[redacted]',
  );
  console.error(`Pixel Office: ${message}`);
  return dialog.showMessageBox({
    type: 'error',
    title: 'Pixel Office',
    message,
    buttons: ['확인'],
  });
}
function run(action: () => Promise<unknown>) {
  void action().catch(report);
}
async function loadConnection(target: BrowserWindow, current: Connection) {
  const url = new URL(current.url);
  // Changing only the fragment is same-document navigation, so bootstrap would not run again.
  // A nonsecret query value forces a new document on reconnect; bootstrap clears it afterward.
  url.searchParams.set('desktop', randomUUID());
  await target.loadURL(url.href);
  lastWindowUrl = current.url;
}
function updateMenu() {
  tray?.setToolTip(connection ? 'Pixel Office · 실행 중' : 'Pixel Office · 연결 확인 중');
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: connection ? '서버 실행 중' : '서버 연결 확인 중', enabled: false },
      { label: 'Pixel Office 열기', click: () => run(showWindow) },
      {
        label: '서버 시작',
        enabled: !connection,
        click: () =>
          run(async () => {
            connection = await startService(config, paths);
            updateMenu();
            await showWindow();
          }),
      },
      {
        label: '브라우저에서 열기',
        click: () =>
          run(async () => {
            const current = await readReadyConnection(config);
            if (!current) throw new Error('서버가 연결되지 않았습니다. 로그를 확인하세요.');
            await shell.openExternal(current.url);
          }),
      },
      { type: 'separator' },
      {
        label: '로그 폴더 열기',
        click: () =>
          run(async () => {
            const error = await shell.openPath(paths.logs);
            if (error) throw new Error(error);
          }),
      },
      {
        label: '로그인 시 메뉴바 앱 실행',
        type: 'checkbox',
        enabled: app.isPackaged,
        checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
        },
      },
      { type: 'separator' },
      { label: '메뉴바 앱 종료 (서버 유지)', click: () => app.quit() },
    ]),
  );
}

async function showWindow() {
  if (!connection) connection = await readReadyConnection(config);
  if (!connection)
    throw new Error(`서버 연결을 기다리고 있습니다. ${paths.logs}에서 로그를 확인하세요.`);
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      width: 1440,
      height: 980,
      minWidth: 900,
      minHeight: 640,
      title: 'Pixel Office',
      backgroundColor: '#f5f3ee',
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const origin = new URL(connection.url).origin;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (navigationTarget(url, origin) === 'external') run(() => shell.openExternal(url));
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      const target = navigationTarget(url, origin);
      if (target !== 'internal') {
        event.preventDefault();
        if (target === 'external') run(() => shell.openExternal(url));
      }
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        window?.hide();
      }
    });
    window.on('closed', () => {
      window = null;
      lastWindowUrl = '';
    });
  }
  if (lastWindowUrl !== connection.url) {
    await loadConnection(window, connection);
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function poll() {
  if (polling || quitting) return;
  polling = true;
  try {
    const current = await readReadyConnection(config);
    const changed = current?.url !== connection?.url;
    connection = current;
    if (changed) {
      cookie = '';
      updateMenu();
    }
    if (!current) return;
    if (window && lastWindowUrl !== current.url) {
      await loadConnection(window, current);
    }
    const origin = new URL(current.url).origin;
    if (!cookie) {
      const auth = await fetch(`${origin}/api/session`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(1500),
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ token: new URL(current.url).hash.slice(7) }),
      });
      cookie = auth.headers.get('set-cookie')?.split(';')[0] ?? '';
    }
    if (!cookie) return;
    const result = await fetch(`${origin}/api/runs`, {
      headers: { cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    if (!result.ok) {
      cookie = '';
      return;
    }
    const messages = notifications.update(
      (await result.json()) as Array<{ id: string; status: string }>,
    );
    if (!window?.isFocused() && Notification.isSupported())
      for (const body of messages) {
        const notification = new Notification({ title: 'Pixel Office', body });
        notification.on('click', () => run(showWindow));
        notification.show();
      }
  } catch {
    // A restart or wake may temporarily interrupt requests. The next poll reconnects.
  } finally {
    polling = false;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (config) run(showWindow);
  });
  app.on('activate', () => {
    if (config) run(showWindow);
  });
  app.on('window-all-closed', () => {
    /* Menu bar app stays resident. */
  });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(timer);
  });
  void app
    .whenReady()
    .then(async () => {
      config = await loadServiceConfig(paths).catch(() => {
        throw new Error(
          '백그라운드 서비스 설치가 필요합니다. 저장소에서 npm run service:install을 실행하세요.',
        );
      });
      const loginLaunch =
        process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
      connection = await readReadyConnection(config);
      // An automatic login launch must not undo service:stop. Manual opening may start it.
      if (shouldStartServer({ connected: !!connection, loginLaunch }))
        connection = await startService(config, paths);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Pixel Office',
            submenu: [
              { label: 'Pixel Office 열기', click: () => run(showWindow) },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              {
                label: '메뉴바 앱 종료 (서버 유지)',
                accelerator: 'CmdOrCtrl+Q',
                click: () => app.quit(),
              },
            ],
          },
          { role: 'editMenu' },
          {
            label: '보기',
            submenu: [
              {
                label: '다시 연결',
                accelerator: 'CmdOrCtrl+R',
                click: () => {
                  lastWindowUrl = '';
                  run(showWindow);
                },
              },
              { role: 'togglefullscreen' },
            ],
          },
        ]),
      );
      tray = new Tray(trayImage());
      tray.on('double-click', () => run(showWindow));
      if (app.isPackaged && process.argv.includes('--enable-login'))
        app.setLoginItemSettings({ openAtLogin: true });
      updateMenu();
      if (!loginLaunch) await showWindow();
      await poll();
      timer = setInterval(() => void poll(), 3000);
    })
    .catch(async (error) => {
      await report(error);
      app.quit();
    });
}
