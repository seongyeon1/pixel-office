import { z } from 'zod';
import type { TerminalInfo } from './workspace.js';
import { commandSchema } from './contracts.js';
// A harness is the command a coworker is started with: a provider CLI or a wrapper around one.
// The engine says which CLI it wraps, and so which session logs and resume syntax it has.
export const launchHarnessSchema = z.object({
  engine: z.enum(['claude', 'codex']),
  command: commandSchema,
});
export type LaunchHarness = z.infer<typeof launchHarnessSchema>;
export const launchHarnessesSchema = z.object({
  harnesses: z
    .array(launchHarnessSchema)
    .max(30)
    .refine((list) => new Set(list.map((h) => h.command)).size === list.length, {
      message: '같은 명령이 두 번 등록됐어요.',
    }),
});
export interface LaunchHarnessList {
  harnesses: (LaunchHarness & { available: boolean })[];
}
export const launchSchema = z.object({
  id: z.uuid(),
  root: z.string().min(1),
  provider: z.enum(['claude', 'codex']),
  // A registered harness command; 'personal' and 'standard' remain as the names older clients sent.
  harness: commandSchema,
  model: z
    .string()
    .trim()
    .max(150)
    .regex(/^[^\r\n\0]*$/)
    .optional(),
  prompt: z.string().trim().min(1).max(20000),
});
export type LaunchInput = z.infer<typeof launchSchema>;
export interface LaunchedAgent extends LaunchInput {
  createdAt: string;
  sessionId?: string;
  terminal: TerminalInfo;
}
