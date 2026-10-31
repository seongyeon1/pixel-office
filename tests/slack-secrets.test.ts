import { expect, test } from 'vitest';
import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSlackConfig,
  maskSlack,
  readSlackConfig,
  writeSlackConfig,
} from '../src/server/slack/secrets.js';

const config = {
  botToken: 'xoxb-1234-secret-abcd',
  appToken: 'xapp-1-secret-token',
  ownerId: 'U01ABC',
};

test('Slack credentials are stored owner-only and can be read and cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-slack-'));
  expect(await readSlackConfig(dir)).toBeUndefined();
  await writeSlackConfig(dir, config);
  await writeSlackConfig(dir, config);
  const file = join(dir, 'slack.json');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readSlackConfig(dir)).toEqual(config);
  await clearSlackConfig(dir);
  expect(await readSlackConfig(dir)).toBeUndefined();
  await clearSlackConfig(dir);
});

test('masked config never contains the original tokens', () => {
  const masked = maskSlack(config);
  const json = JSON.stringify(masked);
  expect(masked).toEqual({ configured: true, ownerId: 'U01ABC', botToken: 'xoxb-…abcd' });
  expect(json).not.toContain(config.botToken);
  expect(json).not.toContain(config.appToken);
  expect(json).not.toContain('secret');
});

test('rewriting a looser existing file never leaves loose permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixel-slack-'));
  const file = join(dir, 'slack.json');
  await writeFile(file, '{}');
  await chmod(file, 0o644);
  await writeSlackConfig(dir, config);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readSlackConfig(dir)).toEqual(config);
});
