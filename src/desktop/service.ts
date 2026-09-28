import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const serviceLabel = 'io.pixeloffice.server';
export interface ServiceConfig {
  version: 1;
  root: string;
  nodePath: string;
  dataDir: string;
  port: number;
  env: Record<string, string>;
}
export interface Connection {
  url: string;
  pid: number;
}
export function servicePaths(home = homedir()) {
  const support = join(home, 'Library', 'Application Support', 'Pixel Office');
  return {
    support,
    config: join(support, 'service.json'),
    plist: join(home, 'Library', 'LaunchAgents', `${serviceLabel}.plist`),
    logs: join(home, 'Library', 'Logs', 'Pixel Office'),
  };
}
export type ServicePaths = ReturnType<typeof servicePaths>;

export function createServiceConfig({
  root,
  nodePath,
  dataDir,
  port = 4317,
  env = process.env,
}: {
  root: string;
  nodePath: string;
  dataDir?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
}): ServiceConfig {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('포트는 1~65535 정수여야 합니다.');
  if (!isAbsolute(root) || !isAbsolute(nodePath))
    throw new Error('저장소와 Node 경로는 절대 경로여야 합니다.');
  const selected: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    if (env[key]) selected[key] = env[key]!;
  }
  const searchPaths = [
    dirname(nodePath),
    ...(selected.PATH ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  // npm prepends transient, repeated node_modules/.bin entries for each nested script.
  selected.PATH = [
    ...new Set(
      searchPaths.filter(
        (path) =>
          isAbsolute(path) &&
          !path.endsWith('/node_modules/.bin') &&
          !path.endsWith('/node-gyp-bin'),
      ),
    ),
  ].join(':');
  return {
    version: 1,
    root: resolve(root),
    nodePath,
    dataDir: resolve(root, dataDir ?? '.pixel'),
    port,
    env: selected,
  };
}

export function launchAgentPlist(config: ServiceConfig, paths: ServicePaths): string {
  const xml = (s: string) =>
    s.replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
  const string = (s: string) => `<string>${xml(s)}</string>`;
  const env = {
    ...config.env,
    NODE_ENV: 'production',
    PIXEL_BACKGROUND: '1',
    PORT: String(config.port),
    PIXEL_DATA_DIR: config.dataDir,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(serviceLabel)}
<key>ProgramArguments</key><array>${string(config.nodePath)}${string(join(config.root, 'dist/server/server/index.js'))}</array>
<key>WorkingDirectory</key>${string(config.root)}
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key>${string(v)}`)
    .join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key>${string(join(paths.logs, 'server.log'))}
<key>StandardErrorPath</key>${string(join(paths.logs, 'server-error.log'))}
</dict></plist>
`;
}

export function parseConnection(value: unknown, port: number): Connection | null {
  if (!value || typeof value !== 'object') return null;
  const { url, pid } = value as Connection;
  if (typeof url !== 'string' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== `http://127.0.0.1:${port}` ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      !/^#token=[a-f0-9]{48}$/.test(parsed.hash)
    )
      return null;
    return { url, pid };
  } catch {
    return null;
  }
}

export async function readReadyConnection(config: ServiceConfig): Promise<Connection | null> {
  try {
    const connection = parseConnection(
      JSON.parse(await readFile(join(config.dataDir, 'connection.json'), 'utf8')),
      config.port,
    );
    if (!connection) return null;
    const url = new URL(connection.url);
    const response = await fetch(`${url.origin}/api/session`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
      headers: { 'content-type': 'application/json', origin: url.origin },
      body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }),
    });
    return response.ok && ((await response.json()) as { ok?: boolean }).ok === true
      ? connection
      : null;
  } catch {
    return null;
  }
}

export async function assertPortAvailable(port: number) {
  const occupied = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNREFUSED' ? resolve(false) : reject(error),
    );
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error('포트 상태를 확인하지 못했습니다.'));
    });
  });
  if (occupied)
    throw new Error(
      `${port} 포트를 다른 서버가 사용 중입니다. 해당 서버를 직접 종료한 뒤 다시 실행하세요.`,
    );
}

function domain() {
  if (process.platform !== 'darwin')
    throw new Error('백그라운드 서비스는 현재 macOS에서 지원합니다.');
  return `gui/${process.getuid!()}`;
}
export async function isServiceLoaded() {
  try {
    await exec('/bin/launchctl', ['print', `${domain()}/${serviceLabel}`]);
    return true;
  } catch {
    return false;
  }
}
export async function loadServiceConfig(paths = servicePaths()): Promise<ServiceConfig> {
  const raw = JSON.parse(await readFile(paths.config, 'utf8')) as ServiceConfig;
  if (
    raw.version !== 1 ||
    !isAbsolute(raw.root) ||
    !isAbsolute(raw.nodePath) ||
    !isAbsolute(raw.dataDir) ||
    !Number.isInteger(raw.port) ||
    raw.port < 1 ||
    raw.port > 65535 ||
    !raw.env ||
    Object.values(raw.env).some((v) => typeof v !== 'string')
  )
    throw new Error('서비스 설정 형식이 올바르지 않습니다.');
  return raw;
}
async function waitForService(config: ServiceConfig, paths: ServicePaths) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const connection = await readReadyConnection(config);
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(
    `서버가 준비되지 않았습니다. ${join(paths.logs, 'server-error.log')}를 확인하세요.`,
  );
}
export async function startService(config: ServiceConfig, paths = servicePaths()) {
  domain();
  if (!(await isServiceLoaded())) {
    await assertPortAvailable(config.port);
    await exec('/bin/launchctl', ['enable', `${domain()}/${serviceLabel}`]);
    await exec('/bin/launchctl', ['bootstrap', domain(), paths.plist]);
  }
  return waitForService(config, paths);
}

export async function installService(config: ServiceConfig, paths = servicePaths()) {
  domain();
  await access(join(config.root, 'dist/server/server/index.js'));
  await access(join(config.root, 'dist/client/index.html'));
  const { stdout } = await exec(config.nodePath, ['--version']);
  if (Number(stdout.trim().replace(/^v/, '').split('.')[0]) < 24)
    throw new Error('Node.js 24 이상이 필요합니다.');
  if (await isServiceLoaded()) {
    const previous = createServiceConfig(await loadServiceConfig(paths));
    if (JSON.stringify(previous) !== JSON.stringify(config)) {
      throw new Error(
        '다른 설정의 서비스가 실행 중입니다. npm run service:stop 후 다시 설치하세요.',
      );
    }
    return waitForService(config, paths);
  }
  await assertPortAvailable(config.port);
  await mkdir(paths.support, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.plist), { recursive: true });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  // Atomic writes avoid a partial configuration if installation is interrupted.
  for (const [file, data] of [
    [paths.config, JSON.stringify(config, null, 2)],
    [paths.plist, launchAgentPlist(config, paths)],
  ]) {
    await writeFile(`${file}.tmp`, data, { mode: 0o600 });
    await chmod(`${file}.tmp`, 0o600);
    await rename(`${file}.tmp`, file);
  }
  return startService(config, paths);
}

export async function stopService() {
  domain();
  // Disabling also prevents KeepAlive/login from undoing an explicit stop.
  await exec('/bin/launchctl', ['disable', `${domain()}/${serviceLabel}`]);
  if (await isServiceLoaded())
    await exec('/bin/launchctl', ['bootout', `${domain()}/${serviceLabel}`]);
}
export async function uninstallService(paths = servicePaths()) {
  await stopService();
  await rm(paths.plist, { force: true });
  await rm(paths.config, { force: true });
}
