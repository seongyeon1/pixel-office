import { expect, test } from 'vitest';
import { sessionDocuments } from '../src/shared/task-documents';
import type { ObservedEvent } from '../src/shared/contracts';
const e = (kind: ObservedEvent['kind'], detail: string, title = ''): ObservedEvent => ({
  id: '',
  timestamp: '',
  kind,
  detail,
  title,
  activity: 'idle',
});
const session = { projectPath: '/repo', cwd: '/repo/sub' };
test('session documents belong to the latest request and exclude reads, commands and other work', () => {
  const events = [
    e('request', '이전 일'),
    e('tool', '/repo/old.md', 'Write'),
    e('request', '설계 작성'),
    e('request', '', '작업 시작'),
    e('tool', '/repo/README.md', 'Read'),
    e('tool', 'cat secret.md', 'exec_command'),
    e('tool', 'docs/design.md', 'Write'),
    e('complete', '[설계](/repo/sub/docs/design.md:12)와 `NOTES.md`를 보세요.'),
  ];
  expect(sessionDocuments({ ...session, events }).map((d) => d.path)).toEqual([
    'sub/docs/design.md',
    'sub/NOTES.md',
  ]);
  expect(sessionDocuments({ ...session, events }, true).map((d) => d.path)).toContain('old.md');
});
test('session document paths stay in the project and support encoded links and patch writes', () => {
  const events = [
    e(
      'message',
      '[외부](https://site/x.md) [탈출](/elsewhere/x.md) `../../outside.md` [한글](docs/%EC%84%A4%EA%B3%84.md)',
    ),
    e(
      'tool',
      '*** Begin Patch\n*** Add File: ../report.md\n+hello\n*** Delete File: gone.md\n*** End Patch',
      'apply_patch',
    ),
  ];
  expect(sessionDocuments({ ...session, events }).map((d) => d.path)).toEqual([
    'sub/docs/설계.md',
    'report.md',
  ]);
});
