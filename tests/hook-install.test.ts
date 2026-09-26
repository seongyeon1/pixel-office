import { expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hookStatus, installHook, uninstallHook } from '../src/server/hook-install.js';
const cmd = 'PIXEL_HOOK_FILE="/x/hook.json" node "/x/scripts/ask-hook.mjs"';
test('installing keeps the user hooks, backs up first, and is idempotent; removing takes only ours', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pixel-hook-'));
  const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] };
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [own] } }),
  );
  expect((await hookStatus(home)).installed).toBe(false);
  await installHook(home, cmd, 1);
  await installHook(home, cmd, 2);
  const installed = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  expect(installed.model).toBe('opus');
  expect(installed.hooks.PreToolUse).toEqual([
    own,
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: cmd, timeout: 600 }] },
  ]);
  expect((await hookStatus(home)).installed).toBe(true);
  expect((await readdir(home)).filter((f) => f.includes('pixel-backup'))).toEqual([
    'settings.json.pixel-backup-1',
  ]);
  await uninstallHook(home, 3);
  const removed = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  expect(removed.hooks.PreToolUse).toEqual([own]);
});
test('a missing settings file is created, and an unreadable one is never rewritten', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'pixel-hook-'));
  await installHook(fresh, cmd);
  expect(
    JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8')).hooks.PreToolUse,
  ).toHaveLength(1);
  await uninstallHook(fresh);
  expect(JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8')).hooks).toEqual({});
  const broken = await mkdtemp(join(tmpdir(), 'pixel-hook-'));
  await writeFile(join(broken, 'settings.json'), '{ not json');
  await expect(installHook(broken, cmd)).rejects.toThrow(/건드리지 않았어요/);
  expect(await readFile(join(broken, 'settings.json'), 'utf8')).toBe('{ not json');
});
