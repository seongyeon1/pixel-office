import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const slackConfigSchema = z.object({
  botToken: z.string().regex(/^xoxb-/),
  appToken: z.string().regex(/^xapp-/),
  ownerId: z.string().regex(/^U[A-Z0-9]+$/),
});
export type SlackConfig = z.infer<typeof slackConfigSchema>;

const fileOf = (dataDir: string) => join(dataDir, 'slack.json');

export async function readSlackConfig(dataDir: string): Promise<SlackConfig | undefined> {
  try {
    const parsed = slackConfigSchema.safeParse(JSON.parse(await readFile(fileOf(dataDir), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSlackConfig(dataDir: string, config: SlackConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = fileOf(dataDir);
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function clearSlackConfig(dataDir: string): Promise<void> {
  await rm(fileOf(dataDir), { force: true });
}

export const maskSlack = (c: SlackConfig) => ({
  configured: true as const,
  ownerId: c.ownerId,
  botToken: `xoxb-…${c.botToken.slice(-4)}`,
});
