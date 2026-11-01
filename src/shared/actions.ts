import type { ObservedEvent } from './contracts.js';

const MAX = 80;
const clip = (s: string): string => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s);
const firstLine = (s: string): string => s.trim().split('\n')[0].trim();
// The target of a read or edit: the file name when detail is a path, else the first line as is.
const target = (detail: string, fallback: string): string => {
  const patched =
    /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(detail)?.[1] ?? firstLine(detail);
  return patched.split(/[\\/]/).filter(Boolean).at(-1) ?? fallback;
};

/** One short Korean sentence for what a session is doing right now (at most 80 characters). */
export function describeAction(
  event: Pick<ObservedEvent, 'kind' | 'title' | 'detail' | 'activity'>,
): string {
  if (event.kind === 'message') return '답변 쓰는 중';
  if (event.kind === 'request') return '요청 확인 중';
  if (event.kind === 'result') return '결과 확인 중';
  if (event.kind !== 'tool') return '응답 완료';
  const name = event.title;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return clip(`${mcp[1]} ${mcp[2]} 호출 중`);
  // Whole tool names only: "WebSearch" or "TodoWrite" must not borrow the read or edit verb.
  if (/^todo_?write$/i.test(name)) return '할 일 정리 중';
  if (/^(multi_?edit|notebook_?edit|edit|write|apply_patch|patch)$/i.test(name))
    return clip(`${target(event.detail, '파일')} 수정 중`);
  if (/^(read|grep|glob|view|search|find|list|ls)$/i.test(name))
    return clip(`${target(event.detail, '파일')} 읽는 중`);
  if (/^(bash|shell|local_shell|exec|exec_command|write_stdin|terminal|command)$/i.test(name)) {
    const command = firstLine(event.detail);
    return clip(command ? `명령 실행 중 · ${command}` : '명령 실행 중');
  }
  return clip(`${name} 사용 중`);
}
