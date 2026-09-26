import { launchSchema, type LaunchInput, type LaunchedAgent } from '../shared/launcher.js';
import type { Provider } from '../shared/contracts.js';
import type { createTerminals } from './terminals.js';
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const personal = { claude: 'sy', codex: 'syc' };
const standard = { claude: 'claude', codex: 'codex' };
export function launchCommand(raw: Omit<LaunchInput, 'root'>, commands?: Record<Provider, string>) {
  const input = launchSchema.omit({ root: true }).parse(raw);
  // Command overrides are server-owned test/integration configuration, never request input.
  const command =
    commands?.[input.provider] ??
    (input.harness === 'personal' ? personal : standard)[input.provider];
  return `${command}${input.provider === 'claude' ? ` --session-id ${input.id}` : ''} ${quote(input.prompt)}`;
}
export function createLauncher({
  terminals,
  commands,
}: {
  terminals: ReturnType<typeof createTerminals>;
  commands?: Record<Provider, string>;
}) {
  const agents = new Map<string, LaunchedAgent>();
  return {
    start(raw: LaunchInput): LaunchedAgent {
      const input = launchSchema.parse(raw);
      const existing = agents.get(input.id);
      if (existing) {
        if (
          existing.root !== input.root ||
          existing.provider !== input.provider ||
          existing.harness !== input.harness ||
          existing.prompt !== input.prompt
        )
          throw new Error('이미 다른 동료를 만드는 데 사용한 요청입니다.');
        if (!terminals.get(existing.terminal.id))
          throw new Error('종료된 동료입니다. 새 동료로 시작해 주세요.');
        return existing;
      }
      const terminal = terminals.create(input.root, 100, 30, {
        command: launchCommand(input, commands),
        tag: `launch:${input.id}`,
        persistent: true,
      });
      const agent = { ...input, terminal, createdAt: new Date().toISOString() };
      agents.set(agent.id, agent);
      return agent;
    },
    list(root: string) {
      return [...agents.values()].filter((a) => a.root === root && terminals.get(a.terminal.id));
    },
  };
}
