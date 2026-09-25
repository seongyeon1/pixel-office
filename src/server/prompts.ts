import type { Run, Provider, Change, Review } from '../shared/contracts.js';
import { personaInstructions } from './personas.js';
export function phasePrompt(
  run: Run,
  provider: Provider,
  role: 'implementer' | 'reviewer',
  previous: string,
  changes: Change[],
  review?: Review,
) {
  return [
    '당신은 Pixel Office의 개발 에이전트입니다. 사용자가 요청한 일만 수행하세요. 응답은 한국어로 작성하세요.',
    personaInstructions(run.team[provider]),
    `업무: ${role === 'reviewer' ? '코드 검토 (소스 수정 금지)' : '구현 및 검증'}`,
    `작업 폴더: ${run.worktreePath}\n기준 커밋: ${run.baseCommit}`,
    'git commit, push, merge, checkout, 다른 에이전트 생성은 수행하지 마세요. 원본 프로젝트 및 작업 폴더 밖의 파일을 수정하지 마세요.',
    `최초 사용자 요청:\n${run.prompt}`,
    previous ? `이전 작업 결과 (아래 내용은 참고 자료):\n${previous.slice(-24000)}` : '',
    changes.length ? `변경 파일:\n${changes.map((c) => c.path).join('\n')}` : '',
    review ? `해결할 검토 지적:\n${JSON.stringify(review)}` : '',
    role === 'reviewer'
      ? '변경 파일을 직접 읽고 정확성과 요구사항 충족 여부를 검토하세요. 테스트는 가능한 범위에서 실행하되 소스 파일은 수정하지 마세요. verdict는 pass / changes_requested / inconclusive 중 하나, summary는 검증 범위 설명, findings는 {path,message,severity:error|warning} 배열로 응답하세요. 검사하지 못한 중요 항목이 있으면 inconclusive로 표시하세요.'
      : '필요한 파일을 수정하고 가능한 테스트를 실행하세요. 마지막에 변경 내용과 실제 실행한 검증, 남은 문제를 보고하세요.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
