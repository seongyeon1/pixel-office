// What an automated session was for, read from how its prompt starts. Display only: a miss falls
// back to "기타 자동 작업" and never changes whether a session counts as automated.
export interface AutomationKind {
  key: string;
  label: string;
}
const KINDS: [RegExp, AutomationKind][] = [
  [/업무일지/, { key: 'journal', label: '업무일지' }],
  [/세션 요약을 종합|요약을 종합/, { key: 'digest', label: '요약 종합' }],
  [/세션 정보를 요약|세션을 요약/, { key: 'summary', label: '세션 요약' }],
  [/memory-lake|Wisdom/i, { key: 'memory', label: '메모리 정리' }],
  [/Knowledge\s*\(Case\)|Knowledge|지식/, { key: 'knowledge', label: '지식 추출' }],
  [/Pixel Office의 개발 에이전트/, { key: 'smoke', label: '테스트 실행' }],
];
export const OTHER: AutomationKind = { key: 'other', label: '기타 자동 작업' };
export function automationKind(prompt: string): AutomationKind {
  const head = prompt.slice(0, 400);
  return KINDS.find(([re]) => re.test(head))?.[1] ?? OTHER;
}
export const automationKinds = [...KINDS.map(([, k]) => k), OTHER];
