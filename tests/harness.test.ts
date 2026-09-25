import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readlink, realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeCatalog, codexHarnessConfig, prepareClaudeHarness } from '../src/server/harness.js';
import { createStore } from '../src/server/store.js';
import { emptyHarness } from '../src/shared/contracts.js';
async function claudeHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pixel-harness-')));
  const plugin = join(home, 'plugins', 'cache', 'mk', 'superpowers', '1.0.0');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'superpowers',
      description: 'Core skills',
      hooks: './hooks/hooks.json',
      mcpServers: { db: { command: 'db' } },
    }),
  );
  await mkdir(join(plugin, 'skills', 'brainstorming'), { recursive: true });
  await mkdir(join(plugin, 'hooks'), { recursive: true });
  await writeFile(join(plugin, 'hooks', 'hooks.json'), '{"hooks":{}}');
  await writeFile(join(plugin, '.mcp.json'), '{}');
  await writeFile(
    join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@mk': [{ scope: 'user', installPath: plugin }],
        'gone@mk': [{ scope: 'user', installPath: join(home, 'missing') }],
      },
    }),
  );
  for (const [name, description] of [
    ['task-observer', 'Watches tasks'],
    ['bc-ship', 'Ships code'],
  ]) {
    await mkdir(join(home, 'skills', name), { recursive: true });
    await writeFile(
      join(home, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nbody`,
    );
  }
  await mkdir(join(home, 'skills', 'not-a-skill'), { recursive: true });
  return { home, plugin };
}
test('lists installed Claude plugins and user skills with their descriptions', async () => {
  const { home } = await claudeHome();
  const catalog = await claudeCatalog(home);
  expect(catalog.plugins).toEqual([
    { id: 'superpowers@mk', name: 'superpowers', description: 'Core skills' },
  ]);
  expect(catalog.skills.map((s) => [s.id, s.description])).toEqual([
    ['bc-ship', 'Ships code'],
    ['task-observer', 'Watches tasks'],
  ]);
});
test('a Claude run gets only the chosen plugins and a wrapper for the chosen user skills', async () => {
  const { home, plugin } = await claudeHome();
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-data-'));
  const cwd = await mkdtemp(join(tmpdir(), 'pixel-cwd-'));
  await writeFile(join(cwd, 'CLAUDE.md'), '# Project rules\nUse pnpm.');
  const first = await prepareClaudeHarness(
    {
      plugins: ['superpowers@mk', 'gone@mk'],
      skills: ['task-observer', 'bc-ship'],
      projectDoc: true,
    },
    { claudeHome: home, harnessDir: join(dataDir, 'a'), cwd },
  );
  // The plugin arrives without its hooks or MCP servers, under its own name.
  const mirror = first.plugins[0].path;
  expect(first.plugins[0]).toMatchObject({ type: 'local', skipMcpDiscovery: true });
  expect((await readdir(mirror)).sort()).toEqual(['.claude-plugin', 'skills']);
  expect(await readlink(join(mirror, 'skills'))).toBe(join(plugin, 'skills'));
  const manifest = JSON.parse(
    await readFile(join(mirror, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  expect(manifest).toEqual({ name: 'superpowers', description: 'Core skills' });
  const wrapper = first.plugins[1].path;
  expect(first.plugins).toHaveLength(2);
  expect((await readdir(join(wrapper, 'skills'))).sort()).toEqual(['bc-ship', 'task-observer']);
  expect(await readlink(join(wrapper, 'skills', 'bc-ship'))).toBe(join(home, 'skills', 'bc-ship'));
  expect(first.promptPrefix).toContain('Use pnpm.');
  // Rebuilt on every run: a skill that was unticked is gone.
  const second = await prepareClaudeHarness(
    { plugins: [], skills: ['bc-ship'], projectDoc: false },
    { claudeHome: home, harnessDir: join(dataDir, 'a'), cwd },
  );
  expect(await readdir(join(second.plugins[0].path, 'skills'))).toEqual(['bc-ship']);
  expect(second.promptPrefix).toBe('');
  // Nothing chosen: no plugins at all, the run stays isolated.
  const none = await prepareClaudeHarness(emptyHarness().claude, {
    claudeHome: home,
    harnessDir: join(dataDir, 'a'),
    cwd,
  });
  expect(none).toEqual({ plugins: [], promptPrefix: '' });
});
test('a Codex run turns off every plugin, skill and hook that was not chosen', () => {
  const config = codexHarnessConfig(
    { plugins: ['superpowers@official'], skills: ['bc-ship'], projectDoc: false },
    ['superpowers@official', 'braincrew@local', 'linear@curated'],
    [
      { name: 'bc-ship', pluginId: null },
      { name: 'bc-arxiv', pluginId: null },
      { name: 'imagegen', pluginId: null },
      { name: 'brainstorming', pluginId: 'superpowers@official' },
    ],
  );
  expect(config.plugins).toEqual({
    'superpowers@official': { enabled: true },
    'braincrew@local': { enabled: false },
    'linear@curated': { enabled: false },
  });
  expect(config.skills).toEqual({
    config: [
      { name: 'bc-arxiv', enabled: false },
      { name: 'imagegen', enabled: false },
    ],
  });
  expect(config['features.hooks']).toBe(false);
  expect(config.project_doc_max_bytes).toBe(0);
  expect(
    codexHarnessConfig({ plugins: [], skills: [], projectDoc: true }, [], []),
  ).not.toHaveProperty('project_doc_max_bytes');
});
test('repository harness settings persist per repository and default to isolated', () => {
  const store = createStore(':memory:');
  expect(store.getHarness('/a')).toEqual(emptyHarness());
  const chosen = emptyHarness();
  chosen.codex.plugins = ['linear@curated'];
  store.setHarness('/a', chosen);
  expect(store.getHarness('/a').codex.plugins).toEqual(['linear@curated']);
  expect(store.getHarness('/b')).toEqual(emptyHarness());
});
