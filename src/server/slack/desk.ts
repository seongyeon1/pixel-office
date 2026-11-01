import { terminal, type DeskState, type Run } from '../../shared/contracts.js';
import type { Job } from '../store.js';

// A request nobody has assigned work to, or an assignment that has not started, is dropped after this long.
const PLANNING_MS = 30 * 60_000;

// The coordinator's open Slack requests: planning (no assignments yet) or working (some run unfinished).
export function deskRequests(
  jobs: Job[],
  runOf: (id: string) => Run | undefined,
  now: number,
): DeskState['requests'] {
  const requests: DeskState['requests'] = [];
  for (const job of jobs) {
    if (job.route.kind !== 'coordinator') continue;
    const { assignments } = job;
    if (!assignments.length) {
      if (now - Date.parse(job.createdAt) < PLANNING_MS)
        requests.push({ jobId: job.id, phase: 'planning', tasks: 0 });
    } else if (
      assignments.some((a) => {
        const live = (runId?: string) => {
          const run = runId ? runOf(runId) : undefined;
          return !!run && !terminal(run.status);
        };
        if (a.runId) return live(a.runId);
        // Not started yet: it waits on a live predecessor, or is still young enough to be starting.
        const before = assignments.find((b) => b.id === a.after);
        return live(before?.runId) || now - Date.parse(job.createdAt) < PLANNING_MS;
      })
    )
      requests.push({ jobId: job.id, phase: 'working', tasks: assignments.length });
  }
  return requests;
}
