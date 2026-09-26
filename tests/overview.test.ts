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
const at = { now: 60000 };
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
    at,
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
  const rooms = projectRooms([], rows, at);
  expect(rooms.map((r) => r.root)).toEqual(['/a', '/b']);
  expect(rooms[1]).toMatchObject({
    observedCount: 3,
    activeCount: 1,
    staleCount: 1,
    waitingCount: 0,
  });
  expect(rooms[1].workers.map((w) => w.caption)).toEqual([
    '코드 작성',
    '보고할 게 있어요',
    '상태 확인 필요',
  ]);
  expect(
    projectRooms(
      [],
      rows.map((s) => ({ ...s, status: 'idle' as const })),
      at,
    ).map((r) => r.root),
  ).toEqual(['/a', '/b']);
});
test('shows only the current managed participant, prioritizes waiting, and removes completed runs', () => {
  const [room] = projectRooms([project('/a/app', run)], [session('external', '/a/app')], at);
  expect(room.workers[0]).toMatchObject({
    id: 'run:managed',
    provider: 'claude',
    waiting: true,
    caption: '승인 필요',
    mark: 'approval',
  });
  // During review the implementer stands beside the reviewer.
  expect(room.workers.find((w) => w.visiting)).toMatchObject({
    id: 'run:managed:implementer',
    provider: 'codex',
    visiting: 'run:managed',
  });
  expect(room.activeCount).toBe(3);
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

test('coworkers leave after their terminal closes or half an hour of silence, unless waiting on a person', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const ago = (min: number) => new Date(now - min * 60000).toISOString();
  const rows: ObservedSession[] = [
    { ...session('fresh', '/r', 'idle'), updatedAt: ago(5) },
    { ...session('gone', '/r', 'idle'), updatedAt: ago(45) },
    { ...session('closed', '/r', 'active'), updatedAt: ago(1), processAlive: false },
    {
      ...session('asking', '/r', 'active'),
      updatedAt: ago(90),
      attention: { kind: 'question', certain: true, since: ago(90) },
    },
    { ...session('helper', '/r', 'idle'), updatedAt: ago(3), parentId: 'fresh' },
  ];
  const [room] = projectRooms([], rows, { now });
  expect(room.workers.map((w) => w.session!.id).sort()).toEqual(['asking', 'fresh']);
  expect(room.offDuty.map((w) => w.session!.id)).toEqual(['closed', 'helper', 'gone']);
});

test('question and approval raise a hand, a finished turn is a report until it is seen', () => {
  const rows: ObservedSession[] = [
    { ...session('q', '/r'), attention: { kind: 'question', certain: true, since: '' } },
    { ...session('p', '/r'), attention: { kind: 'approval', certain: false, since: '' } },
    { ...session('done', '/r', 'idle'), updatedAt: new Date(50000).toISOString() },
    { ...session('sub', '/r', 'idle'), updatedAt: new Date(50000).toISOString(), parentId: 'q' },
  ];
  const marks = (seen = {}) =>
    Object.fromEntries(
      projectRooms([], rows, { ...at, seen })[0].workers.map((w) => [w.session!.id, w.mark]),
    );
  expect(marks()).toEqual({ q: 'question', p: 'approval', done: 'report', sub: null });
  const [room] = projectRooms([], rows, at);
  expect(room.workers.find((w) => w.id === 'observed:p')).toMatchObject({
    certain: false,
    caption: '승인 대기 중일 수 있어요',
  });
  expect(room).toMatchObject({ waitingCount: 2, reportCount: 1 });
  expect(marks({ done: new Date(50000).toISOString() }).done).toBeNull();
});

test('desks are grouped by worktree with the main checkout first and subagents beside their lead', () => {
  const tree = (path: string, branch: string, main = false) => ({ path, branch, main });
  const rows: ObservedSession[] = [
    { ...session('z-feature', '/r'), cwd: '/r/.wt/x', worktree: tree('/r/.wt/x', 'feat/x') },
    { ...session('b-main', '/r'), worktree: tree('/r', 'main', true) },
    { ...session('a-main', '/r'), worktree: tree('/r', 'main', true) },
    { ...session('a-sub', '/r'), worktree: tree('/r', 'main', true), parentId: 'b-main' },
  ];
  const [room] = projectRooms([], rows, at);
  expect(room.lanes.map((l) => [l.branch, l.main])).toEqual([
    ['main', true],
    ['feat/x', false],
  ]);
  expect(room.lanes[0].workers.map((w) => w.session!.id)).toEqual(['a-main', 'b-main', 'a-sub']);
  expect(room.lanes[0].workers[2].parentId).toBe('observed:b-main');
});

test('coworkers carry their model family, and the family filter keeps only matching rooms', async () => {
  const { withFamily } = await import('../src/client/overview/projects.js');
  const rows: ObservedSession[] = [
    { ...session('opus', '/a'), provider: 'claude', model: 'claude-opus-5-5' },
    { ...session('astra', '/a'), model: 'gpt-6-astra' },
    { ...session('luna', '/b'), model: 'gpt-6-luna' },
  ];
  const rooms = projectRooms([project('/a', run)], rows, at);
  const a = rooms.find((r) => r.root === '/a')!;
  expect(a.workers.find((w) => w.id === 'observed:opus')!.family.label).toBe('Opus');
  expect(a.workers.find((w) => w.id === 'run:managed')!.family.key).toBe('claude:default');
  const astra = withFamily(rooms, 'codex:astra');
  expect(astra.map((r) => r.root)).toEqual(['/a']);
  expect(astra[0].workers.map((w) => w.id)).toEqual(['observed:astra']);
  expect(astra[0].lanes.flatMap((l) => l.workers).map((w) => w.id)).toEqual(['observed:astra']);
  expect(astra[0]).toMatchObject({ activeCount: 1, waitingCount: 0 });
  expect(withFamily(rooms, '')).toBe(rooms);
});

test('automated sessions stay out of rooms, reports and counts; only running ones are listed apart', () => {
  const rows: ObservedSession[] = [
    { ...session('person', '/r') },
    {
      ...session('journal', '/r', 'idle'),
      automated: true,
      updatedAt: new Date(50000).toISOString(),
    },
    { ...session('summary', '/r', 'active'), automated: true },
  ];
  const [room] = projectRooms([], rows, at);
  expect(room.workers.map((w) => w.id)).toEqual(['observed:person']);
  expect(room.offDuty).toEqual([]);
  expect(room.automations.map((w) => w.id)).toEqual(['observed:summary']);
  expect(room).toMatchObject({ observedCount: 1, reportCount: 0, activeCount: 1 });
});

test('a path with only automated sessions opens no room; a repository shows its origin name', () => {
  const rows: ObservedSession[] = [
    { ...session('smoke', '/tmp/pixel-smoke/project'), automated: true },
    { ...session('person', '/work/repo-access-request'), repoName: 'langconnect-enterprise' },
    { ...session('same', '/work/pixel'), repoName: 'pixel' },
  ];
  const rooms = projectRooms([], rows, at);
  expect(rooms.map((r) => r.root)).toEqual(['/work/pixel', '/work/repo-access-request']);
  expect(rooms.map((r) => r.repoName)).toEqual(['', 'langconnect-enterprise']);
});

test('connected projects stay on the floor when empty; folders only seen in logs leave with their people', async () => {
  const { shownOnFloor } = await import('../src/client/overview/projects.js');
  const rows: ObservedSession[] = [
    { ...session('gone', '/home/me', 'idle'), updatedAt: new Date(0).toISOString() },
    { ...session('here', '/work/busy') },
  ];
  const rooms = projectRooms(
    [{ ...project('/work/connected'), connected: true }, project('/work/ran', run)],
    rows,
    { now: 3600000 },
  );
  const shown = rooms.filter(shownOnFloor).map((r) => r.root);
  expect(shown).toEqual(['/work/busy', '/work/connected', '/work/ran']);
});

test('an open but quiet terminal keeps its desk as away; closing it or an unknown process sends it home', () => {
  const now = Date.parse('2026-09-26T00:30:00Z');
  const yesterday = '2026-09-25T02:59:21Z';
  const rows: ObservedSession[] = [
    { ...session('open', '/r', 'idle'), processAlive: true, updatedAt: yesterday },
    { ...session('closed', '/r', 'idle'), processAlive: false, updatedAt: yesterday },
    { ...session('unknown', '/r', 'idle'), processAlive: null, updatedAt: yesterday },
    {
      ...session('fresh', '/r', 'idle'),
      processAlive: true,
      updatedAt: new Date(now - 60000).toISOString(),
    },
  ];
  const [room] = projectRooms([], rows, { now });
  const open = room.workers.find((w) => w.id === 'observed:open')!;
  expect(open).toMatchObject({ away: true, mark: null });
  expect(open.caption).toMatch(/^자리 비움 · 어제 /);
  expect(room.workers.find((w) => w.id === 'observed:fresh')).toMatchObject({
    away: false,
    mark: 'report',
  });
  expect(room.offDuty.map((w) => w.id).sort()).toEqual(['observed:closed', 'observed:unknown']);
});
