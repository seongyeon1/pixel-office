import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  createServiceConfig,
  launchAgentPlist,
  parseConnection,
  readReadyConnection,
  servicePaths,
  assertPortAvailable,
} from '../src/desktop/service.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test('launch agent preserves argument boundaries and only selected user environment', () => {
  const config = createServiceConfig({
    root: '/Users/me/Pixel & Office',
    nodePath: '/opt/my node/bin/node',
    env: {
      PATH: '/opt/bin:/usr/bin',
      HOME: '/Users/me',
      CODEX_HOME: '/Users/me/codex data',
      CLAUDE_CONFIG_DIR: '/Users/me/claude',
      ANTHROPIC_API_KEY: 'secret',
      CLAUDECODE: '1',
    },
  });
  const plist = launchAgentPlist(config, servicePaths('/Users/me'));
  expect(plist).toContain(
    '<string>/Users/me/Pixel &amp; Office/dist/server/server/index.js</string>',
  );
  expect(plist).toContain('<string>/opt/my node/bin/node</string>');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  expect(plist).toContain('<key>RunAtLoad</key><true/>');
  expect(config.dataDir).toBe('/Users/me/Pixel & Office/.pixel');
  expect(config.env.CODEX_HOME).toBe('/Users/me/codex data');
  expect(config.env.CLAUDE_CONFIG_DIR).toBe('/Users/me/claude');
  expect(plist).not.toContain('secret');
  expect(plist).not.toContain('CLAUDECODE');
});

test('invalid port is rejected before writing a launch agent', () => {
  for (const port of [0, -1, 65536, 1.5, NaN]) {
    expect(() =>
      createServiceConfig({ root: '/tmp/pixel', nodePath: '/usr/bin/node', port }),
    ).toThrow();
  }
});

test('nested npm commands produce the same stable service configuration', () => {
  const base = { root: '/tmp/pixel', nodePath: '/opt/bin/node' };
  const direct = createServiceConfig({
    ...base,
    env: { PATH: '/tmp/pixel/node_modules/.bin:/opt/bin:/usr/bin' },
  });
  const nested = createServiceConfig({
    ...base,
    env: { PATH: '/tmp/pixel/node_modules/.bin:/tmp/pixel/node_modules/.bin:/opt/bin:/usr/bin' },
  });
  const terminal = createServiceConfig({ ...base, env: { PATH: '/opt/bin:/usr/bin' } });
  expect(nested).toEqual(direct);
  expect(direct).toEqual(terminal);
  expect(
    createServiceConfig({ ...base, env: { PATH: '/tmp/npm/node-gyp-bin:/opt/bin:/usr/bin' } }),
  ).toEqual(terminal);
});

test('only a token-bearing loopback connection for the configured port is accepted', () => {
  const token = 'a'.repeat(48);
  expect(
    parseConnection({ url: `http://127.0.0.1:4317/#token=${token}`, pid: 123 }, 4317)?.pid,
  ).toBe(123);
  for (const url of [
    `https://example.com/#token=${token}`,
    `http://127.0.0.1:9000/#token=${token}`,
    `http://evil@127.0.0.1:4317/#token=${token}`,
    'http://127.0.0.1:4317/',
    `http://127.0.0.1:4317/elsewhere#token=${token}`,
  ])
    expect(parseConnection({ url, pid: 123 }, 4317)).toBeNull();
});

test('readiness authenticates the current token; stale files and an occupied port are not success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-service-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const token = 'b'.repeat(48);
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const good =
      req.method === 'POST' && req.url === '/api/session' && JSON.parse(body).token === token;
    res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: good }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const config = createServiceConfig({ root: dir, dataDir: dir, nodePath: process.execPath, port });
  const file = join(dir, 'connection.json');
  await writeFile(
    file,
    JSON.stringify({ url: `http://127.0.0.1:${port}/#token=${'c'.repeat(48)}`, pid: process.pid }),
  );
  expect(await readReadyConnection(config)).toBeNull();
  await expect(assertPortAvailable(port)).rejects.toThrow('포트');
  await writeFile(
    file,
    JSON.stringify({ url: `http://127.0.0.1:${port}/#token=${token}`, pid: process.pid }),
  );
  expect((await readReadyConnection(config))?.pid).toBe(process.pid);
  await writeFile(file, '{broken');
  expect(await readReadyConnection(config)).toBeNull();
});
