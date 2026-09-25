import type { Run, OfficeEvent, Interaction, Provider, Activity } from '../shared/contracts.js';
export interface AgentState {
  activity: Activity;
  text: string;
  tool: string;
  model: string;
  waiting: boolean;
}
export interface OfficeState {
  run: Run | null;
  events: OfficeEvent[];
  interactions: Interaction[];
  sequence: number;
  agents: Record<Provider, AgentState>;
}
export const emptyState = (): OfficeState => ({
  run: null,
  events: [],
  interactions: [],
  sequence: 0,
  agents: {
    codex: { activity: 'idle', text: '', tool: '', model: '', waiting: false },
    claude: { activity: 'idle', text: '', tool: '', model: '', waiting: false },
  },
});
export function applyEvent(state: OfficeState, event: OfficeEvent): OfficeState {
  if (event.sequence <= state.sequence) return state;
  const next: OfficeState = {
    ...state,
    sequence: event.sequence,
    events: [...state.events, event].slice(-400),
    agents: { codex: { ...state.agents.codex }, claude: { ...state.agents.claude } },
  };
  const p = event.payload;
  if (event.type === 'run.updated') {
    next.run = p.run as Run;
    if (
      ['completed', 'cancelled', 'failed', 'interrupted', 'needs_attention'].includes(
        next.run.status,
      )
    ) {
      for (const a of Object.values(next.agents)) {
        a.activity = 'idle';
        a.waiting = false;
      }
    }
  }
  if (event.type === 'interaction.requested') {
    const i = p.interaction as Interaction;
    next.interactions = [...state.interactions, i];
    next.agents[i.agentId].waiting = true;
  }
  if (event.type === 'interaction.resolved') {
    next.interactions = state.interactions.filter((i) => i.id !== p.id);
    for (const id of ['codex', 'claude'] as const)
      next.agents[id].waiting = next.interactions.some((i) => i.agentId === id);
  }
  if (event.agentId) {
    const a = next.agents[event.agentId];
    if (event.type === 'activity' || event.type === 'phase.started') {
      a.activity = p.activity as Activity;
      a.tool = String(p.tool ?? p.phase ?? '');
    }
    if (event.type === 'message') a.text = (a.text + String(p.text ?? '')).slice(-60000);
    if (event.type === 'agent.session') a.model = String(p.model ?? '');
    if (event.type === 'phase.completed') {
      a.activity = 'idle';
      if (p.text) a.text = String(p.text);
    }
  }
  return next;
}
