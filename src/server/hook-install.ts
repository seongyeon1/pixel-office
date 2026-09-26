import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Adds or removes the one PreToolUse entry that sends AskUserQuestion to the app. The user's own
// settings are backed up before every write, never rewritten when unreadable, and other hooks stay.
export const HOOK_MARK = 'ask-hook.mjs';
type Settings = { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> };
const settingsPath = (claudeHome: string) => join(claudeHome, 'settings.json');
async function read(claudeHome: string): Promise<{ settings: Settings; exists: boolean }> {
  const text = await readFile(settingsPath(claudeHome), 'utf8').catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  });
  if (text === undefined) return { settings: {}, exists: false };
  try {
    return { settings: JSON.parse(text) as Settings, exists: true };
  } catch {
    throw new Error(
      'Claude 설정 파일을 읽을 수 없어 건드리지 않았어요. settings.json의 JSON을 확인해 주세요.',
    );
  }
}
const ours = (entry: { hooks?: { command?: string }[] }) =>
  (entry.hooks ?? []).some((h) => h.command?.includes(HOOK_MARK));
async function write(claudeHome: string, settings: Settings, exists: boolean, now: number) {
  if (exists)
    await copyFile(settingsPath(claudeHome), `${settingsPath(claudeHome)}.pixel-backup-${now}`);
  await writeFile(settingsPath(claudeHome), JSON.stringify(settings, null, 2) + '\n');
}
export async function hookStatus(claudeHome: string) {
  const { settings } = await read(claudeHome).catch(() => ({ settings: {} as Settings }));
  return {
    installed: (settings.hooks?.PreToolUse ?? []).some(ours),
    settingsPath: settingsPath(claudeHome),
  };
}
export async function installHook(claudeHome: string, command: string, now = Date.now()) {
  const { settings, exists } = await read(claudeHome);
  const list = (settings.hooks ??= {}).PreToolUse ?? [];
  if (list.some(ours)) return;
  settings.hooks.PreToolUse = [
    ...list,
    // Ten minutes: the hook itself gives up earlier and hands the question back to the terminal.
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, timeout: 600 } as never] },
  ];
  await write(claudeHome, settings, exists, now);
}
export async function uninstallHook(claudeHome: string, now = Date.now()) {
  const { settings, exists } = await read(claudeHome);
  const list = settings.hooks?.PreToolUse ?? [];
  if (!exists || !list.some(ours)) return;
  const kept = list
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks ?? []).filter((h) => !h.command?.includes(HOOK_MARK)),
    }))
    .filter((entry) => entry.hooks.length);
  if (kept.length) settings.hooks!.PreToolUse = kept;
  else delete settings.hooks!.PreToolUse;
  await write(claudeHome, settings, exists, now);
}
