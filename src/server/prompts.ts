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
    run.executionMode === 'isolated'
      ? personaInstructions(run.team[provider])
      : '평소 개인 개발 환경의 지침과 도구를 사용해 요청을 끝까지 수행하세요.',
    `업무: ${role === 'reviewer' ? '코드 검토 (소스 수정 금지)' : '구현 및 검증'}`,
    run.repos
      ? [
          `작업 폴더: ${run.worktreePath} — 저장소 ${run.repos.length}개를 묶은 작업입니다. 각 저장소는 아래 하위 폴더에 있고, 변경 파일 경로는 그 폴더명으로 시작합니다.`,
          ...run.repos.map(
            (r) => `- ${r.name}/ : 원본 ${r.root}, 브랜치 ${r.branch}, 기준 커밋 ${r.baseCommit}`,
          ),
        ].join('\n')
      : `작업 폴더: ${run.worktreePath}\n기준 커밋: ${run.baseCommit}`,
    '기존 변경을 보존하세요. 사용자가 커밋·푸시·PR 생성을 요청하면 대상 저장소와 base 브랜치를 확인한 뒤 작업용 브랜치에서 필요한 git commit, push, gh pr create(또는 glab mr create)를 실제로 수행하고 생성된 URL을 확인해 보고하세요. 이미 받은 게시 승인을 반복해서 묻거나 초안만 보여주고 끝내지 마세요. 원격 변경은 사용자가 요청한 범위만 수행하세요. 병합·배포·강제 푸시·삭제는 각각 요청받지 않았다면 수행하지 마세요.',
    `최초 사용자 요청:\n${run.prompt}`,
    run.pullRequestRequested
      ? '이 작업에는 사용자가 요청한 PR 생성이 포함됩니다. 이전 추가 요청에서 이미 승인한 게시 요청도 유효합니다. 실제 PR URL과 원격 커밋을 확인해야 완료입니다.'
      : '',
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
