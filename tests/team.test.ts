import { expect, test } from 'vitest';
import { boardRows, deskSummary, teamRooms } from '../src/client/overview/team.js';
import {
  defaultTeam,
  type Interaction,
  type ObservedSession,
  type ProjectSummary,
  type Run,
} from '../src/shared/contracts.js';
import type { Coworker } from '../src/shared/coworkers.js';
const now = 60000;
const session = (
  id: string,
  root: string,
  extra: Partial<ObservedSession> = {},
): ObservedSession => ({
  id,
  sessionId: id,
  projectPath: root,
  cwd: root,
  provider: 'claude',
  label: id,
  prompt: `${id} task\nmore detail`,
  model: 'test',
  status: 'active',
  activity: 'editing',
  updatedAt: new Date(0).toISOString(),
  processAlive: null,
  truncated: false,
  ...extra,
});
const project = (root: string, latestRun: Run | null = null): ProjectSummary => ({
  root,
  latestRun,
  runCount: latestRun ? 1 : 0,
});
const run = (id: string, extra: Partial<Run> = {}): Run => ({
  id,
  projectPath: '/r/app',
  worktreePath: `/data/workspaces/${id}`,
  branch: `pixel/${id}`,
  baseCommit: 'abc',
  prompt: `${id} title\nbody`,
  mode: 'claude',
  implementer: 'claude',
  status: 'running',
  phase: 'implement',
  revision: 0,
  createdAt: new Date(0).toISOString(),
  team: defaultTeam(),
  ...extra,
});
const coworker = (id: string, folder: string): Coworker => ({
  id,
  name: `${id} 님`,
  folder,
  engine: 'claude',
  role: '',
  mode: 'solo',
  bindings: [],
  rules: [],
  createdBy: 'user',
});
const team = (input: Partial<Parameters<typeof teamRooms>[0]>) =>
  teamRooms({ projects: [], sessions: [], runs: [], coworkers: [], now, seen: {}, ...input });

test('no coworkers keeps every repository as a temporary room', () => {
  const sessions = [session('a', '/r/a'), session('b', '/r/b'), session('c', '/r/c')];
  const rooms = team({ sessions });
  expect(rooms.map((r) => [r.root, r.temporary])).toEqual([
    ['/r/a', true],
    ['/r/b', true],
    ['/r/c', true],
  ]);
  const rows = boardRows(rooms, []);
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.workerId === 'observed:a')).toMatchObject({
    owner: 'a',
    task: 'a task',
    source: 'terminal',
  });
});

test('a terminal session in a coworker subfolder sits in that coworker room', () => {
  const sessions = [
    session('main', '/r/app'),
    session('sub', '/r/app/api'),
    session('tree', '/r/app', { worktree: { path: '/r/app-wt', branch: 'feat/x', main: false } }),
    session('other', '/r/other'),
  ];
  const rooms = team({ sessions, coworkers: [coworker('dev', '/r/app')] });
  expect(rooms.map((r) => [r.root, r.coworker?.id, !!r.temporary])).toEqual([
    ['/r/app', 'dev', false],
    ['/r/other', undefined, true],
  ]);
  const [room] = rooms;
  expect(room.workers.map((w) => w.id).sort()).toEqual([
    'observed:main',
    'observed:sub',
    'observed:tree',
  ]);
  // Each repository keeps its own desks: the worktree branch and the subfolder checkout.
  expect(room.lanes.map((l) => [l.key, l.branch, l.main])).toEqual([
    ['/r/app', '', true],
    ['/r/app/api', '', true],
    ['/r/app-wt', 'feat/x', false],
  ]);
  expect(room.activeCount).toBe(3);
  expect(boardRows(rooms, []).filter((r) => r.owner === 'dev 님')).toHaveLength(3);
});

test('every active run of a coworker gets its own row and sign', () => {
  const slack = run('slack', { coworkerId: 'dev', origin: { kind: 'slack', jobId: 'j1' } });
  const office = run('office', { coworkerId: 'dev' });
  const rooms = team({
    projects: [project('/r/app', office)],
    runs: [slack, office, run('done', { coworkerId: 'dev', status: 'completed' })],
    coworkers: [coworker('dev', '/r/app')],
  });
  expect(rooms).toHaveLength(1);
  const rows = boardRows(rooms, []);
  expect(rows.map((r) => [r.workerId, r.source, r.task, r.owner]).sort()).toEqual([
    ['run:office', 'office', 'office title', 'dev 님'],
    ['run:slack', 'slack', 'slack title', 'dev 님'],
  ]);
});

test('a run and its managed session are one row; subagents fold into the parent', () => {
  const r = run('r1');
  const managed = session('m', '/r/app', {
    managed: {
      runId: 'r1',
      role: 'implementer',
      executionMode: 'isolated',
      resumable: true,
      busy: true,
    },
    action: 'src/app.ts 고치는 중',
  });
  const sub = session('s', '/r/app', { parentId: 'm' });
  const rooms = team({ projects: [project('/r/app', r)], runs: [r], sessions: [managed, sub] });
  expect(rooms[0].lanes[0].workers.map((w) => w.id)).toEqual(['observed:m', 'observed:s']);
  const rows = boardRows(rooms, []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    workerId: 'observed:m',
    task: 'r1 title',
    source: 'office',
    action: 'src/app.ts 고치는 중',
  });
});

test('a coworker run whose session works in a worktree still lands in that coworker room', () => {
  const r = run('r1', { coworkerId: 'dev', origin: { kind: 'slack', jobId: 'j1' } });
  const managed = session('m', '/data/workspaces/r1', {
    managed: {
      runId: 'r1',
      role: 'implementer',
      executionMode: 'isolated',
      resumable: true,
      busy: true,
    },
  });
  const rooms = team({ runs: [r], sessions: [managed], coworkers: [coworker('dev', '/r/app')] });
  const dev = rooms.find((room) => room.coworker?.id === 'dev')!;
  expect(dev.workers.map((w) => w.id)).toEqual(['observed:m']);
  expect(rooms.flatMap((room) => room.workers)).toHaveLength(1);
  expect(boardRows(rooms, [])).toMatchObject([{ owner: 'dev 님', source: 'slack' }]);
});

test('a reviewed run with its implementer session is still one row', () => {
  const r = run('r1', { mode: 'collaborate', implementer: 'codex', phase: 'review' });
  const implementer = session('impl', '/r/app', {
    provider: 'codex',
    status: 'idle',
    managed: {
      runId: 'r1',
      role: 'implementer',
      executionMode: 'isolated',
      resumable: true,
      busy: false,
    },
  });
  const rooms = team({ projects: [project('/r/app', r)], runs: [r], sessions: [implementer] });
  const rows = boardRows(rooms, []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ workerId: 'run:r1', action: '코드 검토' });
});

test('waiting rows come first and carry the app interaction', () => {
  const r = run('r1', { status: 'waiting_approval' });
  const later = session('busy', '/r/b', { updatedAt: new Date(50000).toISOString() });
  const ask: Interaction = {
    id: 'i1',
    runId: 'r1',
    agentId: 'claude',
    kind: 'approval',
    title: 'Bash',
    details: {},
    resolved: false,
  };
  const rooms = team({ projects: [project('/r/app', r)], runs: [r], sessions: [later] });
  const rows = boardRows(rooms, [ask]);
  expect(rows.map((row) => [row.workerId, row.waiting])).toEqual([
    ['run:r1', true],
    ['observed:busy', false],
  ]);
  expect(rows[0].interaction?.id).toBe('i1');
  expect(rows[0].action).toBe('승인 필요');
});

test('an idle coworker still has a room', () => {
  const rooms = team({
    coworkers: [coworker('coordinator', '/r'), coworker('b', '/r/b'), coworker('a', '/r/a')],
  });
  expect(rooms.map((r) => [r.root, r.coworker?.id, r.workers.length, r.connected])).toEqual([
    ['/r/b', 'b', 0, true],
    ['/r/a', 'a', 0, true],
  ]);
  expect(boardRows(rooms, [])).toEqual([]);
});

test('a waiting subagent makes its parent row wait', () => {
  const parent = session('p', '/r/app');
  const sub = session('s', '/r/app', {
    parentId: 'p',
    attention: { kind: 'approval', certain: true, since: new Date(0).toISOString() },
  });
  const rows = boardRows(team({ sessions: [parent, sub] }), []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ workerId: 'observed:p', waiting: true, action: '승인 기다려요' });
});

test('a reviewed run that is not the latest one keeps its reviewer desk', () => {
  const r = run('r1', { mode: 'collaborate', implementer: 'codex', phase: 'review' });
  const implementer = session('impl', '/r/app', {
    provider: 'codex',
    status: 'idle',
    managed: {
      runId: 'r1',
      role: 'implementer',
      executionMode: 'isolated',
      resumable: true,
      busy: false,
    },
  });
  const rooms = team({ projects: [project('/r/app')], runs: [r], sessions: [implementer] });
  expect(rooms[0].workers.map((w) => w.id).sort()).toEqual(['observed:impl', 'run:r1']);
  expect(rooms[0].workers.find((w) => w.id === 'observed:impl')!.label).toBe('앱 작업 · impl');
  const rows = boardRows(rooms, []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ workerId: 'run:r1', action: '코드 검토' });
});

test('the reception desk says whether Slack is on and what the coordinator is doing', () => {
  expect(deskSummary(undefined)).toBe('상태 확인 중');
  expect(deskSummary({ slack: 'off', requests: [] })).toBe('Slack 연결 안 됨');
  expect(deskSummary({ slack: 'error', requests: [] })).toBe('Slack 연결 오류');
  expect(deskSummary({ slack: 'connected', requests: [] })).toBe('대기 중');
  expect(
    deskSummary({
      slack: 'connected',
      requests: [
        { jobId: 'a', phase: 'working', tasks: 2 },
        { jobId: 'b', phase: 'planning', tasks: 0 },
      ],
    }),
  ).toBe('요청 2건 · 배정 계획 중');
  expect(
    deskSummary({ slack: 'connected', requests: [{ jobId: 'a', phase: 'working', tasks: 1 }] }),
  ).toBe('요청 1건 · 동료 작업 중');
});

test('an idle on-duty terminal has no row and an away worker keeps its caption', () => {
  const idle = session('idle', '/r/app', { status: 'idle', activity: 'idle' });
  const rooms = team({ sessions: [idle, session('busy', '/r/app')] });
  expect(boardRows(rooms, []).map((r) => r.workerId)).toEqual(['observed:busy']);
  const away = rooms[0].workers.find((w) => w.id === 'observed:idle')!;
  expect(away.active).toBe(false);
  expect(away.action).toBe(away.caption);
});

test('a waiting subagent keeps its own row when its parent is idle', () => {
  const parent = session('p', '/r/app', { status: 'idle', activity: 'idle' });
  const sub = session('s', '/r/app', {
    parentId: 'p',
    prompt: '',
    attention: { kind: 'approval', certain: true, since: new Date(0).toISOString() },
  });
  const rows = boardRows(team({ sessions: [parent, sub] }), []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ workerId: 'observed:s', waiting: true, task: 'p task' });
});
