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
