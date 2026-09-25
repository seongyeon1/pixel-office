import { useSyncExternalStore } from 'react';
import type { ObservedSession } from '../../shared/contracts';
import type { Seen } from './roster';
const KEY = 'pixel.seenReports';
const listeners = new Set<() => void>();
let seen: Seen = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Seen;
  } catch {
    return {};
  }
})();
export function markSeen(s: Pick<ObservedSession, 'id' | 'updatedAt'>) {
  if (!s.updatedAt || (seen[s.id] ?? '') >= s.updatedAt) return;
  seen = { ...seen, [s.id]: s.updatedAt };
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    /* Private windows keep the mark for this tab only. */
  }
  for (const l of listeners) l();
}
export function useSeenReports(): Seen {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => seen,
  );
}
