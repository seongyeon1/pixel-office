import type { Activity, EventInput, Provider } from '../../shared/contracts.js';
export function activityForTool(name: string): Activity {
  if (/read|grep|glob|search/i.test(name)) return 'reading';
  if (/edit|write|patch/i.test(name)) return 'editing';
  if (/bash|shell|command|exec/i.test(name)) return 'executing';
  return 'responding';
}
const ev = (
  runId: string,
  agentId: Provider,
  type: string,
  payload: Record<string, unknown>,
): EventInput => ({ runId, agentId, type, payload });
// Provider protocols are validated at the envelope boundary; unknown fields stay diagnostic data.
export function normalizeCodex(runId: string, m: any): EventInput[] {
  const p = m?.params ?? {};
  const item = p.item;
  if (m.method === 'item/agentMessage/delta')
    return [ev(runId, 'codex', 'message', { text: p.delta, delta: true })];
  if (m.method === 'item/commandExecution/outputDelta')
    return [ev(runId, 'codex', 'tool.output', { text: p.delta })];
  if (m.method === 'item/started' && item) {
    const activity: Activity =
      item.type === 'fileChange'
        ? 'editing'
        : item.type === 'commandExecution'
          ? 'executing'
          : item.type === 'webSearch'
            ? 'reading'
            : 'responding';
    return [ev(runId, 'codex', 'activity', { activity, tool: item.type, item })];
  }
  if (m.method === 'item/completed' && item)
    return [ev(runId, 'codex', 'tool.completed', { item })];
  if (m.method === 'error')
    return [
      ev(runId, 'codex', 'diagnostic', { text: p.error?.message ?? p.message ?? '공급자 오류' }),
    ];
  return [];
}
export function normalizeClaude(runId: string, m: any): EventInput[] {
  if (m?.type === 'stream_event' && m.event?.delta?.type === 'text_delta')
    return [ev(runId, 'claude', 'message', { text: m.event.delta.text, delta: true })];
  if (m?.type === 'assistant')
    return (m.message?.content ?? []).flatMap((b: any) =>
      b.type === 'tool_use'
        ? [
            ev(runId, 'claude', 'activity', {
              activity: activityForTool(b.name),
              tool: b.name,
              input: b.input,
              id: b.id,
            }),
          ]
        : [],
    );
  if (m?.type === 'user')
    return (m.message?.content ?? [])
      .filter((b: any) => b.type === 'tool_result')
      .map((b: any) =>
        ev(runId, 'claude', 'tool.completed', {
          text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
          isError: b.is_error,
        }),
      );
  if (m?.type === 'result')
    return [
      ev(runId, 'claude', m.is_error ? 'agent.failed' : 'agent.result', {
        text: m.result ?? (m.errors ?? []).join('\n'),
        cost: m.total_cost_usd,
        usage: m.usage,
      }),
    ];
  return [];
}
