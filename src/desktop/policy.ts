export function shouldStartServer({
  connected,
  loginLaunch,
}: {
  connected: boolean;
  loginLaunch: boolean;
}) {
  return !connected && !loginLaunch;
}

export function navigationTarget(value: string, origin: string): 'internal' | 'external' | 'deny' {
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'deny';
    if (url.origin === origin) return 'internal';
    return url.protocol === 'https:' || url.protocol === 'http:' ? 'external' : 'deny';
  } catch {
    return 'deny';
  }
}

export class RunNotifications {
  private initialized = false;
  private previous = new Map<string, string>();
  update(runs: Array<{ id: string; status: string }>): string[] {
    const messages: Record<string, string> = {
      completed: '작업이 완료되었습니다.',
      waiting_approval: '승인이 필요한 작업이 있습니다.',
      waiting_input: '답변을 기다리는 작업이 있습니다.',
      failed: '작업 중 오류가 발생했습니다.',
      needs_attention: '확인이 필요한 작업이 있습니다.',
    };
    const result: string[] = [];
    for (const run of runs) {
      if (this.initialized && this.previous.get(run.id) !== run.status && messages[run.status])
        result.push(messages[run.status]);
    }
    this.previous = new Map(runs.map((run) => [run.id, run.status]));
    this.initialized = true;
    return [...new Set(result)];
  }
}
