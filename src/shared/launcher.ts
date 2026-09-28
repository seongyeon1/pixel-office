import { z } from 'zod';
import type { TerminalInfo } from './workspace.js';
export const launchSchema = z.object({
  id: z.uuid(),
  root: z.string().min(1),
  provider: z.enum(['claude', 'codex']),
  harness: z.enum(['personal', 'standard']),
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
