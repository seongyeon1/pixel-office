import { z } from 'zod';
import { commandSchema } from './contracts.js';

export const COORDINATOR_ID = 'coordinator';

export const toolRuleSchema = z.object({
  pattern: z.string().min(1).max(200),
  action: z.enum(['auto', 'ask']),
});
export type ToolRule = z.infer<typeof toolRuleSchema>;

export const coworkerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(40),
  folder: z.string().min(1),
  engine: z.enum(['claude', 'codex']),
  command: commandSchema.optional(),
  model: z.string().trim().max(150).optional(),
  role: z.string().trim().max(2000),
  mode: z.enum(['solo', 'collaborate']),
  bindings: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).max(20),
  rules: z.array(toolRuleSchema).max(50),
  createdBy: z.enum(['user', 'coordinator']),
});
export type Coworker = z.infer<typeof coworkerSchema>;
// What the coordinator proposes; the owner's approval fills in the rest.
export type CoworkerDraft = Pick<Coworker, 'id' | 'name' | 'folder' | 'role' | 'engine'>;

// A write-looking tool is asked about; anything unsure leans to `ask`.
export const DEFAULT_RULES: ToolRule[] = [
  'create',
  'update',
  'delete',
  'publish',
  'send',
  'post',
  'comment',
  'transition',
].map((verb) => ({ pattern: `mcp__*__*${verb}*`, action: 'ask' as const }));

const globToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );

export const matchToolRule = (rules: ToolRule[], tool: string): 'auto' | 'ask' | undefined =>
  rules.find((rule) => globToRegExp(rule.pattern).test(tool))?.action;
