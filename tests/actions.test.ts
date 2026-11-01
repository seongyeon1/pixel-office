import { expect, test } from 'vitest';
import { describeAction } from '../src/shared/actions.js';

const base = { kind: 'tool', activity: 'reading', detail: '' } as const;
test('describes reads, edits, commands and MCP calls in Korean', () => {
  expect(describeAction({ ...base, title: 'Read', detail: '/r/app/README.md' })).toBe(
    'README.md 읽는 중',
  );
  expect(describeAction({ ...base, title: 'Edit', detail: '/r/app/a.ts' })).toBe('a.ts 수정 중');
  expect(
    describeAction({
      ...base,
      title: 'apply_patch',
      detail: '*** Begin Patch\n*** Update File: src/b.ts\n',
    }),
  ).toBe('b.ts 수정 중');
  expect(describeAction({ ...base, title: 'Bash', detail: 'npm test\nmore' })).toBe(
    '명령 실행 중 · npm test',
  );
  expect(describeAction({ ...base, title: 'exec_command', detail: 'ls' })).toBe(
    '명령 실행 중 · ls',
  );
  expect(describeAction({ ...base, title: 'mcp__atlassian__createJiraIssue' })).toBe(
    'atlassian createJiraIssue 호출 중',
  );
  expect(describeAction({ ...base, title: 'Task' })).toBe('Task 사용 중');
  expect(describeAction({ ...base, kind: 'message', title: '' })).toBe('답변 쓰는 중');
  expect(describeAction({ ...base, kind: 'request', title: '' })).toBe('요청 확인 중');
  expect(describeAction({ ...base, kind: 'complete', title: '' })).toBe('응답 완료');
});
test('action text is short', () => {
  const out = describeAction({ ...base, title: 'Bash', detail: 'x'.repeat(500) });
  expect(out.length).toBeLessThanOrEqual(80);
  expect(out.endsWith('…')).toBe(true);
});
