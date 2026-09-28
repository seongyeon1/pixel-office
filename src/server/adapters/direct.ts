import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import type { Adapter, HarnessChoice, Provider } from '../../shared/contracts.js';
import { interactionRun, type DirectResponder } from '../chat.js';
import { continuationContext } from '../sessions.js';
// Direct conversations use the same native runtime as personal app tasks.
// Each turn owns its adapter so independent coworkers never share an active process handle.
export function createNativeDirectResponder({
  getApprovalMode = () => 'manual',
  factories = { claude: createClaudeAdapter, codex: createCodexAdapter },
}: {
  dataDir?: string;
  getHarness?: (root: string, provider: Provider) => HarnessChoice | undefined;
  claudeHome?: string;
  getApprovalMode?: () => 'manual' | 'auto';
  factories?: Record<Provider, () => Adapter>;
} = {}): DirectResponder {
  return async (input, update) => {
    const { session } = input;
    const adapter = factories[session.provider]();
    const fresh =
      (session.managed?.resumable === false || session.launched?.resumable === false) &&
      !input.viaSessionId;
    // Claude error/system messages may carry <synthetic>, which is not an executable model.
    const requestedModel =
      session.model && !session.model.startsWith('<') ? session.model : undefined;
    let text = '',
      model = requestedModel ?? '',
      sessionId = '';
    try {
      const result = await adapter.execute(
        {
          runId: interactionRun(session.id),
          cwd: session.cwd || session.projectPath,
          prompt: fresh
            ? `${continuationContext(session)}\n\n현재 사용자 요청:\n${input.text}`
            : input.text,
          role: 'implementer',
          profile: { seniority: 'senior', personaVersion: '1', model: requestedModel },
          executionMode: 'personal',
          approvalMode: getApprovalMode(),
          resumeSessionId: fresh ? undefined : (input.viaSessionId ?? session.sessionId),
          forkSession: !fresh && input.fork,
          signal: input.signal,
        },
        (event) => {
          if (event.type === 'agent.session') {
            sessionId = String(event.payload.sessionId ?? '');
            model = String(event.payload.model ?? model);
          } else if (event.type === 'message')
            text = event.payload.delta
              ? text + String(event.payload.text ?? '')
              : String(event.payload.text ?? '');
          else if (event.type === 'agent.result') text = String(event.payload.text ?? text);
          if (['agent.session', 'message', 'agent.result'].includes(event.type))
            update(text, { model, sessionId });
        },
        ({ runId: _runId, ...request }) => input.interact(request),
      );
      if (result.outcome === 'failed')
        throw new Error(result.error || '대화를 이어가지 못했습니다.');
      if (result.outcome === 'completed') update(result.text || text, { model, sessionId });
    } finally {
      await adapter.close();
    }
  };
}
