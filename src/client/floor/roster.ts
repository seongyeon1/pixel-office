import type { ObservedSession } from '../../shared/contracts';
// Nobody keeps a desk after half an hour of silence, unless they are waiting on a person.
export const OFF_DUTY_MS = 30 * 60000;
// A finished subagent hands its work back and leaves shortly after.
export const SUBAGENT_LEAVE_MS = 2 * 60000;
export type Seen = Record<string, string>;
export function onDuty(s: ObservedSession, now: number): boolean {
  if (s.processAlive === false) return false;
  if (s.attention || s.status === 'active') return true;
  const quiet = now - (Date.parse(s.updatedAt) || 0);
  return quiet < (s.parentId ? SUBAGENT_LEAVE_MS : OFF_DUTY_MS);
}
// A finished turn is a report until the person opens that coworker.
export function hasReport(s: ObservedSession, seen: Seen): boolean {
  return !s.parentId && s.status === 'idle' && !!s.updatedAt && s.updatedAt > (seen[s.id] ?? '');
}
