import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  launchSchema,
  type LaunchHarness,
  type LaunchInput,
  type LaunchedAgent,
} from '../shared/launcher.js';
import type { Store } from './store.js';
import type { Provider } from '../shared/contracts.js';
import type { createTerminals } from './terminals.js';
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const legacy = new Map<string, Record<Provider, string>>([
  ['personal', { claude: 'sy', codex: 'syc' }],
  ['standard', { claude: 'claude', codex: 'codex' }],
]);
export function onPath(command: string) {
  const dirs = command.includes('/') ? [''] : (process.env.PATH ?? '').split(delimiter);
  return dirs.some((dir) => {
    try {
      accessSync(dir ? join(dir, command) : command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
// Until someone edits the list: the provider CLIs, plus the sy wrappers where they are installed.
export const defaultHarnesses = (found: (command: string) => boolean = onPath): LaunchHarness[] => [
  ...(
    [
      { engine: 'claude', command: 'sy' },
      { engine: 'codex', command: 'syc' },
    ] as const
  ).filter((h) => found(h.command)),
  { engine: 'claude', command: 'claude' },
  { engine: 'codex', command: 'codex' },
];
// The request names a harness; the command that runs is always one from the server's own list.
export function resolveHarness(
  input: Pick<LaunchInput, 'provider' | 'harness'>,
  harnesses: LaunchHarness[],
) {
  const command = legacy.get(input.harness)?.[input.provider] ?? input.harness;
  return harnesses.find((h) => h.command === command && h.engine === input.provider)?.command;
}
export function launchCommand(raw: Omit<LaunchInput, 'root' | 'harness'>, command: string) {
  const input = launchSchema.omit({ root: true, harness: true }).parse(raw);
  return `${command}${input.provider === 'claude' ? ` --session-id ${input.id}` : ''}${input.model ? ` --model ${quote(input.model)}` : ''} ${quote(input.provider === 'codex' ? `<!-- pixel-office-launch:${input.id} -->\n${input.prompt}` : input.prompt)}`;
}
export function createLauncher({
  terminals,
  commands,
  store,
  harnesses = () => defaultHarnesses(),
}: {
  store?: Store;
  terminals: ReturnType<typeof createTerminals>;
  // Server-owned test/integration configuration that replaces every harness command.
  commands?: Record<Provider, string>;
  harnesses?: () => LaunchHarness[];
}) {
  const agents = new Map<string, LaunchedAgent>();
  const saved = () =>
    store?.getSetting<{ agents: LaunchedAgent[] }>('launched-agents', { agents: [] }).agents ?? [];
  return {
    // The command a launched coworker was started with, while that harness is still registered.
    command(id: string) {
      const agent = agents.get(id) ?? saved().find((a) => a.id === id);
      return agent && !commands ? resolveHarness(agent, harnesses()) : undefined;
    },
    start(raw: LaunchInput): LaunchedAgent {
      const input = launchSchema.parse(raw);
      const existing = agents.get(input.id);
      if (existing) {
        if (
          existing.root !== input.root ||
          existing.provider !== input.provider ||
          existing.harness !== input.harness ||
          existing.prompt !== input.prompt ||
          existing.model !== input.model
        )
          throw new Error('이미 다른 동료를 만드는 데 사용한 요청입니다.');
        if (!terminals.get(existing.terminal.id))
          throw new Error('종료된 동료입니다. 새 동료로 시작해 주세요.');
        return existing;
      }
      const command = commands?.[input.provider] ?? resolveHarness(input, harnesses());
      if (!command)
        throw new Error('등록되지 않은 하네스입니다. 실행 하네스 목록을 확인해 주세요.');
      const terminal = terminals.create(input.root, 100, 30, {
        command: launchCommand(input, command),
        tag: `launch:${input.id}`,
        persistent: true,
      });
      const agent = { ...input, terminal, createdAt: new Date().toISOString() };
      agents.set(agent.id, agent);
      store?.setSetting('launched-agents', {
        agents: [agent, ...saved().filter((a) => a.id !== agent.id)].slice(0, 100),
      });
      return agent;
    },
    list(root: string) {
      return [...agents.values()].filter((a) => a.root === root && terminals.get(a.terminal.id));
    },
  };
}
