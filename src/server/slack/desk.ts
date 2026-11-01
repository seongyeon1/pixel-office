import { terminal, type DeskState, type Run } from '../../shared/contracts.js';
import type { Job } from '../store.js';

// A request nobody has assigned work to within this long is dropped from the desk.
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
        const run = a.runId ? runOf(a.runId) : undefined;
        return !a.runId || (run && !terminal(run.status));
      })
    )
      requests.push({ jobId: job.id, phase: 'working', tasks: assignments.length });
  }
  return requests;
}
