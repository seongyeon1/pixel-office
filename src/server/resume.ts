import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ObservedSession, Provider } from '../shared/contracts.js';

export type ResumeMode = 'resume' | 'fork';
export type AgentCommands = Record<Provider, string>;
export class ResumeConflict extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The session id is interpolated into a shell command, so only a plain UUID is accepted.
export function resumeCommand(
  session: Pick<ObservedSession, 'provider' | 'sessionId' | 'processAlive'> &
    Partial<Pick<ObservedSession, 'status'>>,
  mode: ResumeMode,
  commands: AgentCommands = { claude: 'claude', codex: 'codex' },
) {
  if (!uuid.test(session.sessionId)) throw new Error('이어갈 수 없는 세션 ID입니다.');
  // Two processes appending to one transcript interleave their turns; fork instead.
  if (mode === 'resume' && (session.processAlive === true || session.status === 'active'))
    throw new ResumeConflict(
      '실행 중이거나 최근 활동이 있는 세션이에요. 원래 작업을 종료한 뒤 이어가거나 복제해 주세요.',
    );
  const bin = commands[session.provider];
  if (session.provider === 'claude')
    return `${bin} --resume ${session.sessionId}${mode === 'fork' ? ' --fork-session' : ''}`;
  return `${bin} ${mode} ${session.sessionId}`;
}

// Claude finds a transcript by the directory it was started in, so resume must start there.
export async function resumeFolder(session: Pick<ObservedSession, 'cwd' | 'projectPath'>) {
  for (const candidate of [session.cwd || session.projectPath]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const folder = await realpath(candidate);
      if ((await lstat(folder)).isDirectory()) return folder;
    } catch {}
  }
  throw new Error(
    '세션의 원래 작업 폴더를 찾을 수 없습니다. 삭제된 워크트리라면 먼저 복구해 주세요.',
  );
}
