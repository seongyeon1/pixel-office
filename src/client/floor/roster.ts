import type { ObservedSession } from '../../shared/contracts';
// Half an hour of silence: without a known live process the coworker goes home, with one they stay
// at their desk marked as away.
export const OFF_DUTY_MS = 30 * 60000;
// A finished subagent hands its work back and leaves shortly after.
export const SUBAGENT_LEAVE_MS = 2 * 60000;
export type Seen = Record<string, string>;
const quietFor = (s: ObservedSession, now: number) => now - (Date.parse(s.updatedAt) || 0);
export function onDuty(s: ObservedSession, now: number): boolean {
  if (s.processAlive === false) return false;
  if (s.attention || s.status === 'active') return true;
  if (s.parentId) return quietFor(s, now) < SUBAGENT_LEAVE_MS;
  // An open terminal keeps its desk however long it has been quiet.
  if (s.processAlive === true) return true;
  return quietFor(s, now) < OFF_DUTY_MS;
}
// Still at the desk because the terminal is open, but nothing has happened for a while.
export function isAway(s: ObservedSession, now: number): boolean {
  return (
    s.processAlive === true &&
    !s.attention &&
    s.status !== 'active' &&
    !s.parentId &&
    quietFor(s, now) >= OFF_DUTY_MS
  );
}
// A finished turn is a report until the person opens that coworker.
export function hasReport(s: ObservedSession, seen: Seen): boolean {
  return (
    !s.parentId &&
    !s.automated &&
    s.status === 'idle' &&
    !!s.updatedAt &&
    s.updatedAt > (seen[s.id] ?? '')
  );
}
