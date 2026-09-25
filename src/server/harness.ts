import { readFile, readdir, stat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { HarnessCatalog, HarnessChoice, HarnessItem } from '../shared/contracts.js';
import { RpcClient } from './adapters/codex-rpc.js';
// Per-repository plugins and skills for app runs. Everything not chosen stays off, and hooks are
// always off: a personal hook such as a commit gate must not stall an unattended run.
const PROJECT_DOC_LIMIT = 20 * 1024;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return Object.fromEntries(
    block
      .split('\n')
      .map((line) => /^([a-zA-Z_-]+):\s*(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '').trim()]),
  );
}
async function installedClaudePlugins(claudeHome: string) {
  try {
    const data = await readJson(join(claudeHome, 'plugins', 'installed_plugins.json'));
    const out: { id: string; path: string }[] = [];
    for (const [id, installs] of Object.entries<any[]>(data.plugins ?? {})) {
      const path = installs?.[0]?.installPath;
      if (typeof path === 'string' && (await exists(path))) out.push({ id, path });
    }
    return out;
  } catch {
    return [];
  }
}
async function claudeUserSkills(claudeHome: string) {
  const dir = join(claudeHome, 'skills');
  const out: (HarnessItem & { path: string })[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const text = await readFile(join(path, 'SKILL.md'), 'utf8').catch(() => '');
    if (!text) continue;
    const meta = frontmatter(text);
    out.push({ id: name, name: meta.name || name, description: meta.description ?? '', path });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
export async function claudeCatalog(claudeHome: string) {
  const plugins: HarnessItem[] = [];
  for (const { id, path } of await installedClaudePlugins(claudeHome)) {
    const manifest = await readJson(join(path, '.claude-plugin', 'plugin.json')).catch(() => ({}));
    plugins.push({
      id,
      name: manifest.name ?? id.split('@')[0],
      description: manifest.description ?? '',
    });
  }
  const skills = (await claudeUserSkills(claudeHome)).map(({ path: _path, ...item }) => item);
  return { plugins: plugins.sort((a, b) => a.id.localeCompare(b.id)), skills };
}
// Claude: chosen plugins by install path, plus one wrapper plugin holding the chosen user skills.
// The wrapper is rebuilt on every run so unticked skills disappear.
// Plugin parts never loaded into an app run: hooks run arbitrary commands around tools, and MCP
// servers are external processes. Everything else (skills, agents, commands) is linked as is.
const WITHHELD = new Set(['.claude-plugin', 'hooks', '.mcp.json', '.lsp.json']);
async function mirrorPlugin(source: string, target: string) {
  await mkdir(join(target, '.claude-plugin'), { recursive: true });
  const manifest = await readJson(join(source, '.claude-plugin', 'plugin.json')).catch(() => ({}));
  const { hooks: _hooks, mcpServers: _mcp, lspServers: _lsp, ...rest } = manifest;
  // The same name keeps skill names such as superpowers:brainstorming unchanged.
  await writeFile(join(target, '.claude-plugin', 'plugin.json'), JSON.stringify(rest));
  for (const entry of await readdir(source))
    if (!WITHHELD.has(entry)) await symlink(join(source, entry), join(target, entry));
}
// Claude: the chosen plugins without their hooks and MCP servers, plus one wrapper plugin holding
// the chosen user skills. Rebuilt on every run so anything unticked disappears.
export async function prepareClaudeHarness(
  choice: HarnessChoice,
  { claudeHome, harnessDir, cwd }: { claudeHome: string; harnessDir: string; cwd: string },
) {
  const dir = join(harnessDir, 'claude');
  await rm(dir, { recursive: true, force: true });
  const installed = await installedClaudePlugins(claudeHome);
  const plugins: { type: 'local'; path: string; skipMcpDiscovery: true }[] = [];
  for (const id of choice.plugins) {
    const found = installed.find((p) => p.id === id);
    if (!found) continue;
    const target = join(dir, 'plugins', id.replace(/[^\w.-]/g, '_'));
    await mirrorPlugin(found.path, target);
    plugins.push({ type: 'local', path: target, skipMcpDiscovery: true });
  }
  const skills = (await claudeUserSkills(claudeHome)).filter((s) => choice.skills.includes(s.id));
  if (skills.length) {
    const wrapper = join(dir, 'repo-skills');
    await mkdir(join(wrapper, '.claude-plugin'), { recursive: true });
    await mkdir(join(wrapper, 'skills'));
    await writeFile(
      join(wrapper, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'repo-skills',
        version: '0.0.0',
        description: 'Skills chosen for this repository',
      }),
    );
    for (const s of skills) await symlink(s.path, join(wrapper, 'skills', s.id), 'dir');
    plugins.push({ type: 'local', path: wrapper, skipMcpDiscovery: true });
  }
  let promptPrefix = '';
  if (choice.projectDoc) {
    const doc = await readFile(join(cwd, 'CLAUDE.md'), 'utf8').catch(() => '');
    if (doc.trim())
      promptPrefix = `Project instructions from CLAUDE.md:\n\n${doc.slice(0, PROJECT_DOC_LIMIT)}\n\n---\n\n`;
  }
  return { plugins, promptPrefix };
}
// Codex: thread-level overrides. Only standalone skills are listed one by one; plugin skills
// follow their plugin. Nested objects keep plugin ids with dots and @ intact.
export function codexHarnessConfig(
  choice: HarnessChoice,
  pluginIds: string[],
  skills: { name: string; pluginId?: string | null }[],
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    'features.hooks': false,
    plugins: Object.fromEntries(
      pluginIds.map((id) => [id, { enabled: choice.plugins.includes(id) }]),
    ),
    skills: {
      config: [
        ...new Set(
          skills.filter((s) => !s.pluginId && !choice.skills.includes(s.name)).map((s) => s.name),
        ),
      ].map((name) => ({ name, enabled: false })),
    },
  };
  if (!choice.projectDoc) config.project_doc_max_bytes = 0;
  return config;
}

// Where a repository's generated harness files live, e.g. the Claude skill wrapper.
export const harnessDirFor = (dataDir: string, root: string) =>
  join(dataDir, 'harness', createHash('sha256').update(root).digest('hex').slice(0, 16));
// Codex lists its own plugins and skills; only standalone skills are offered one by one.
export async function codexCatalog(cwd = homedir()) {
  const rpc = new RpcClient(
    spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  );
  try {
    await rpc.request('initialize', { clientInfo: { name: 'pixel_harness', version: '0.1.0' } });
    rpc.notify('initialized');
    const effective = await rpc.request('config/read', { cwd, includeLayers: false });
    const listed = await rpc.request('skills/list', { cwds: [cwd] });
    const skills = new Map<string, HarnessItem>();
    for (const s of (listed.data ?? []).flatMap((e: any) => e.skills ?? []))
      if (!s.pluginId && !skills.has(s.name))
        skills.set(s.name, {
          id: s.name,
          name: s.name,
          description: s.interface?.shortDescription ?? s.shortDescription ?? s.description ?? '',
        });
    return {
      plugins: Object.keys(effective.config?.plugins ?? {})
        .sort()
        .map((id) => ({ id, name: id.split('@')[0], description: id.split('@')[1] ?? '' })),
      skills: [...skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  } finally {
    await rpc.close();
  }
}
export async function harnessCatalog(
  claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
): Promise<HarnessCatalog> {
  const settle = async (load: () => Promise<{ plugins: HarnessItem[]; skills: HarnessItem[] }>) => {
    try {
      return await load();
    } catch (e) {
      return { plugins: [], skills: [], error: (e as Error).message };
    }
  };
  const [claude, codex] = await Promise.all([
    settle(() => claudeCatalog(claudeHome)),
    settle(() => codexCatalog()),
  ]);
  return { claude, codex };
}
