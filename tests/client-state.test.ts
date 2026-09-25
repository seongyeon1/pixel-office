import { expect, test } from 'vitest';
import { applyEvent, emptyState } from '../src/client/state.js';
test('deduplicates events and removes only resolved interactions', () => {
  let state = emptyState();
  const event = {
    eventId: 'e',
    sequence: 1,
    runId: 'r',
    agentId: 'codex' as const,
    timestamp: 'now',
    type: 'message',
    payload: { text: 'hello' },
  };
  state = applyEvent(state, event);
  state = applyEvent(state, event);
  expect(state.events).toHaveLength(1);
  expect(state.agents.codex.text).toBe('hello');
  state = applyEvent(state, {
    ...event,
    eventId: 'q',
    sequence: 2,
    type: 'interaction.requested',
    payload: {
      interaction: {
        id: 'q',
        runId: 'r',
        agentId: 'codex',
        kind: 'approval',
        title: 'run',
        details: {},
        resolved: false,
      },
    },
  });
  expect(state.interactions).toHaveLength(1);
  state = applyEvent(state, {
    ...event,
    eventId: 'a',
    sequence: 3,
    type: 'interaction.resolved',
    payload: { id: 'q' },
  });
  expect(state.interactions).toHaveLength(0);
});
import { defaultTeam, type Run } from '../src/shared/contracts.js';
test('server restart status clears running animation and obsolete approval state', () => {
  const state = emptyState();
  state.run = {
    id: 'r',
    projectPath: '/p',
    worktreePath: '/w',
    branch: 'b',
    baseCommit: 'a',
    prompt: 'x',
    mode: 'codex',
    implementer: 'codex',
    status: 'running',
    phase: 'implement',
    revision: 0,
    createdAt: 'now',
    team: defaultTeam(),
  };
  state.agents.codex.activity = 'editing';
  const next = applyEvent(state, {
    eventId: 'stop',
    sequence: 1,
    runId: 'r',
    agentId: null,
    timestamp: 'now',
    type: 'run.status',
    payload: { status: 'interrupted' },
  });
  expect(next.run?.status).toBe('interrupted');
  expect(next.agents.codex.activity).toBe('idle');
});
