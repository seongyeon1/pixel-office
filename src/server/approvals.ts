import { randomUUID } from 'node:crypto';
import { approvalSettingsSchema, type Answer, type Interaction } from '../shared/contracts.js';
import type { Store } from './store.js';

export function approvalSettings(store: Store) {
  const parsed = approvalSettingsSchema.safeParse(
    store.getSetting('approvals', { mode: 'manual' }),
  );
  return parsed.success ? parsed.data : { mode: 'manual' as const };
}

export function recordAutomaticApproval(store: Store, request: Interaction) {
  store.append({
    runId: request.runId,
    agentId: request.agentId,
    type: 'interaction.resolved',
    payload: { id: request.id, automatic: true, text: `자동 승인: ${request.title}` },
  });
}

// Permission grants stay explicit, including pending requests stored by older adapters.
export function isToolApproval(request: Pick<Interaction, 'kind' | 'details'>) {
  return (
    request.kind === 'approval' &&
    !String(request.details.approvalMethod ?? '').includes('/permissions/') &&
    request.details.permissions == null &&
    request.details.additionalPermissions == null &&
    request.details.networkApprovalContext == null &&
    request.details.grantRoot == null
  );
}

// Questions and additional permission grants always need the person's answer.
export function automaticApproval(
  store: Store,
  request: Omit<Interaction, 'id' | 'resolved'>,
): Answer | undefined {
  if (!isToolApproval(request) || approvalSettings(store).mode !== 'auto') return undefined;
  const interaction = { ...request, id: randomUUID(), resolved: false };
  store.saveInteraction(interaction);
  store.resolveInteraction(interaction.id);
  recordAutomaticApproval(store, interaction);
  return { decision: 'approve' };
}
