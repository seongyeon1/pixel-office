import type { ObservedEvent } from './contracts.js';

const MAX = 80;
const clip = (s: string): string => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s);
const firstLine = (s: string): string => s.trim().split('\n')[0].trim();
// The target of a read or edit: the file name when detail is a path, else the first line as is.
const target = (detail: string, fallback: string): string => {
  const patched = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(detail)?.[1] ?? firstLine(detail);
  return patched.split(/[\\/]/).filter(Boolean).at(-1) ?? fallback;
};

/** One short Korean sentence for what a session is doing right now (at most 80 characters). */
export function describeAction(
  event: Pick<ObservedEvent, 'kind' | 'title' | 'detail' | 'activity'>,
): string {
  if (event.kind === 'message') return '답변 쓰는 중';
  if (event.kind === 'request') return '요청 확인 중';
  if (event.kind !== 'tool') return '응답 완료';
  const name = event.title;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return clip(`${mcp[1]} ${mcp[2]} 호출 중`);
  if (/edit|write|patch/i.test(name)) return clip(`${target(event.detail, '파일')} 수정 중`);
  if (/read|grep|glob|view|search|find|list/i.test(name))
    return clip(`${target(event.detail, '파일')} 읽는 중`);
  if (/bash|shell|exec|terminal|command/i.test(name))
    return clip(`명령 실행 중 · ${firstLine(event.detail)}`);
  return clip(`${name} 사용 중`);
}
