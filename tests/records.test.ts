import { expect, test } from 'vitest';
import { automationKind } from '../src/client/records/kinds.js';
test('automated sessions are grouped by what their prompt asked for', () => {
  const kind = (p: string) => automationKind(p).label;
  expect(kind('다음 에이전트 세션 transcript을 한국어 업무일지 형식으로 요약해주세요.')).toBe('업무일지');
  expect(kind('아래 세션 정보를 요약하세요. 출력은 마크다운 본문만.')).toBe('세션 요약');
  expect(kind('아래 5개 세션 요약을 종합하세요. 출력은 마크다운 본문만.')).toBe('요약 종합');
  expect(kind('아래 Information Summary에서 Knowledge(Case)를 추출하세요.')).toBe('지식 추출');
  expect(kind('아래는 팀 memory-lake에 새로 쌓인 Wisdom(반복 패턴) 1건입니다.')).toBe('메모리 정리');
  expect(kind('당신은 Pixel Office의 개발 에이전트입니다.')).toBe('테스트 실행');
  expect(kind('README 번역해줘')).toBe('기타 자동 작업');
});
