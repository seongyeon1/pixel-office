import { expect, test } from 'vitest';
import { projectRooms } from '../src/client/overview/projects.js';
import {
  defaultTeam,
  type ObservedSession,
  type ProjectSummary,
  type Run,
} from '../src/shared/contracts.js';
const session = (
  id: string,
  root: string,
  status: ObservedSession['status'] = 'active',
): ObservedSession => ({
  id,
  sessionId: id,
  projectPath: root,
  cwd: root,
  provider: 'codex',
  label: id,
  prompt: 'test task',
  model: 'test',
  status,
  activity: 'editing',
  updatedAt: new Date(0).toISOString(),
  processAlive: null,
  truncated: false,
});
const project = (root: string, latestRun: Run | null = null): ProjectSummary => ({
  root,
  latestRun,
  runCount: latestRun ? 1 : 0,
});
const run: Run = {
  id: 'managed',
  projectPath: '/a/app',
  worktreePath: '/worktree',
  branch: 'pixel/test',
  baseCommit: 'abc',
  prompt: 'review work',
  mode: 'collaborate',
  implementer: 'codex',
  status: 'waiting_approval',
  phase: 'review',
  revision: 0,
  createdAt: '',
  team: defaultTeam(),
};
test('combines connected and newly observed projects without merging identical folder names', () => {
  const rooms = projectRooms(
    [project('/a/app'), project('/empty')],
    [session('one', '/a/app'), session('two', '/b/app')],
  );
  expect(rooms.map((r) => r.root)).toEqual(['/a/app', '/b/app', '/empty']);
  expect(rooms[0].workers.map((w) => w.session?.id)).toEqual(['one']);
  expect(rooms[1].workers.map((w) => w.session?.id)).toEqual(['two']);
  expect(rooms[2].workers).toEqual([]);
});
test('counts active, idle and stale observations separately and keeps project positions stable', () => {
  const rows = [
    session('a', '/b', 'active'),
    session('b', '/b', 'idle'),
    session('c', '/b', 'stale'),
    session('d', '/a'),
  ];
  const rooms = projectRooms([], rows);
  expect(rooms.map((r) => r.root)).toEqual(['/a', '/b']);
  expect(rooms[1]).toMatchObject({
    observedCount: 3,
    activeCount: 1,
    staleCount: 1,
    waitingCount: 0,
  });
  expect(rooms[1].workers.map((w) => w.caption)).toEqual([
    '코드 작성',
    '응답 완료 · 대기',
    '상태 확인 필요',
  ]);
  expect(
    projectRooms(
      [],
      rows.map((s) => ({ ...s, status: 'idle' as const })),
    ).map((r) => r.root),
  ).toEqual(['/a', '/b']);
});
test('shows only the current managed participant, prioritizes waiting, and removes completed runs', () => {
  const [room] = projectRooms([project('/a/app', run)], [session('external', '/a/app')]);
  expect(room.workers[0]).toMatchObject({
    id: 'run:managed',
    provider: 'claude',
    waiting: true,
    caption: '승인 필요',
  });
  expect(room.activeCount).toBe(2);
  expect(room.waitingCount).toBe(1);
  expect(
    projectRooms([project('/a/app', { ...run, status: 'completed', phase: 'done' })], [])[0]
      .workers,
  ).toEqual([]);
  expect(
    projectRooms([project('/a/app', { ...run, mode: 'codex', phase: 'review' })], [])[0].workers[0]
      .provider,
  ).toBe('codex');
});

test('short paths retain enough parent folders to disambiguate matching project suffixes', () => {
  const rooms = projectRooms(
    [project('/home/alpha/clients/team/app'), project('/home/beta/clients/team/app')],
    [],
  );
  expect(rooms.map((r) => r.pathLabel)).toEqual([
    '…/alpha/clients/team/app',
    '…/beta/clients/team/app',
  ]);
});
