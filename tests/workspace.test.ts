import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceReader, FILE_LIMIT } from '../src/server/workspace.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pixel-files-')));
  dirs.push(parent);
  const root = join(parent, 'repo');
  await mkdir(root);
  return { parent, root, reader: createWorkspaceReader(() => [root]) };
}
test('lists directories first and reads current file text, including empty files', async () => {
  const { root, reader } = await setup();
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'z.ts'), 'const message = "안녕";\n');
  await writeFile(join(root, 'empty.txt'), '');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.env'), 'SECRET=value');
  await writeFile(join(root, '.env.example'), 'PUBLIC=example');
  expect((await reader.list(root)).entries.map((e) => e.name)).toEqual([
    'src',
    '.env.example',
    'empty.txt',
    'z.ts',
  ]);
  expect((await reader.read(root, 'z.ts')).text).toBe('const message = "안녕";\n');
  await writeFile(join(root, 'z.ts'), 'changed');
  expect((await reader.read(root, 'z.ts')).text).toBe('changed');
  expect((await reader.read(root, 'empty.txt')).text).toBe('');
});
test('rejects unregistered roots, traversal, symlink directories and secret paths', async () => {
  const { root, parent, reader } = await setup();
  await writeFile(join(parent, 'outside.txt'), 'outside');
  await symlink(parent, join(root, 'escape'));
  await symlink(join(parent, 'outside.txt'), join(root, 'link.txt'));
  await writeFile(join(root, '.env.local'), 'secret');
  await expect(reader.read(parent, 'outside.txt')).rejects.toThrow('연결된');
  for (const path of [
    '../outside.txt',
    join(parent, 'outside.txt'),
    'escape/outside.txt',
    'link.txt',
    '.env.local',
  ])
    await expect(reader.read(root, path)).rejects.toThrow();
  expect((await reader.list(root)).entries).toEqual([]);
});
test('rejects binary, invalid UTF-8, oversized and non-file input; accepts the size boundary', async () => {
  const { root, reader } = await setup();
  await writeFile(join(root, 'binary'), Buffer.from([1, 0, 3]));
  await writeFile(join(root, 'invalid'), Buffer.from([0xff, 0xfe]));
  await writeFile(join(root, 'large'), 'a'.repeat(FILE_LIMIT + 1));
  await writeFile(join(root, 'limit'), 'a'.repeat(FILE_LIMIT));
  await expect(reader.read(root, 'binary')).rejects.toThrow('바이너리');
  await expect(reader.read(root, 'invalid')).rejects.toThrow('UTF-8');
  await expect(reader.read(root, 'large')).rejects.toThrow('256 KB');
  await expect(reader.read(root, '')).rejects.toThrow('일반 텍스트');
  expect((await reader.read(root, 'limit')).size).toBe(FILE_LIMIT);
});
