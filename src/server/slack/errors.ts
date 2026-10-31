// Reduces any error to a short Slack error code so tokens in raw messages never leak.
export function slackErrorCode(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (typeof data?.error === 'string') return data.error;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z0-9_]+$/i.test(code)) return code;
  const message = e instanceof Error ? e.message : '';
  return /^[a-z0-9_]+$/i.test(message) ? message : 'unknown_error';
}
