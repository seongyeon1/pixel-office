import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkBoard } from '../src/client/overview/WorkBoard.js';
import type { BoardRow } from '../src/client/overview/team.js';
import { RoomCell } from '../src/client/floor/FloorMap.js';
import type { Cell } from '../src/client/floor/layout.js';
import {
  emptyRoom,
  type ProjectRoom,
  type ProjectWorker,
} from '../src/client/overview/projects.js';
import type { Interaction } from '../src/shared/contracts.js';
const row = (id: string, extra: Partial<BoardRow> = {}): BoardRow => ({
  id,
  workerId: `w:${id}`,
  root: '/r/app',
  task: `${id} 일`,
  source: 'terminal',
  owner: 'dev 님',
  action: 'README.md 읽는 중',
  waiting: false,
  ...extra,
});
const approval: Interaction = {
  id: 'i1',
  runId: 'r1',
  agentId: 'claude',
  kind: 'approval',
  title: 'Jira 발급',
  details: {},
  resolved: false,
};
const render = (rows: BoardRow[], selectedId?: string) =>
  renderToStaticMarkup(
    createElement(WorkBoard, {
      rows,
      selectedId,
      onHover: () => {},
      onOpen: () => {},
      onAnswer: async () => {},
    }),
  );
test('the board groups waiting work first and answers app approvals in place', () => {
  const html = render(
    [
      row('ask', { waiting: true, source: 'slack', interaction: approval }),
      row('term', { waiting: true }),
      row('busy', { source: 'office' }),
    ],
    'w:busy',
  );
  expect(html.indexOf('승인 필요')).toBeLessThan(html.indexOf('진행 중</h3>'));
  expect(html.indexOf('ask 일')).toBeLessThan(html.indexOf('busy 일'));
  expect(html).toContain('>승인</button>');
  expect(html).toContain('>거절</button>');
  // A terminal prompt cannot be answered from here, so the row opens the session instead.
  expect(html).toContain('>터미널에서 확인</button>');
  for (const badge of ['Slack', '오피스', '터미널']) expect(html).toContain(`>${badge}<`);
  expect(html).toContain('data-worker-id="w:busy"');
  expect(html.match(/work-board-row[^"]*highlight/g)).toHaveLength(1);
});
test('an empty board says nothing is running', () => {
  expect(render([])).toContain('지금 진행 중인 일이 없어요');
});
test('a question or a waiting app run opens the work; only terminal prompts say 터미널', () => {
  const question: Interaction = { ...approval, id: 'q1', kind: 'question', title: '어느 쪽?' };
  const html = render([
    row('q', { waiting: true, source: 'office', interaction: question }),
    row('slack', { waiting: true, source: 'slack' }),
  ]);
  // Approve/deny would be refused for a question, so neither shows.
  expect(html).not.toContain('>승인</button>');
  expect(html).not.toContain('>거절</button>');
  expect(html).not.toContain('터미널에서 확인');
  expect(html.match(/>열어서 답하기<\/button>/g)).toHaveLength(2);
});
test('a room picked on the map lights up all of its rows, a sign only its own', () => {
  const rows = [row('a'), row('b'), row('c', { root: '/r/other' })];
  const lit = (selectedId?: string, selectedRoom?: string) =>
    renderToStaticMarkup(
      createElement(WorkBoard, {
        rows,
        selectedId,
        selectedRoom,
        onHover: () => {},
        onOpen: () => {},
        onAnswer: async () => {},
      }),
    ).match(/work-board-row[^"]*highlight/g)?.length ?? 0;
  expect(lit(undefined, '/r/app')).toBe(2);
  expect(lit('w:a', '/r/app')).toBe(1);
});
test('the map lights the room of the picked worker and names each register button', () => {
  const busy: ProjectRoom = {
    ...emptyRoom('/r/app'),
    temporary: true,
    workers: [{ id: 'w:a', root: '/r/app' } as ProjectWorker],
  };
  const idle: ProjectRoom = { ...emptyRoom('/r/notes'), temporary: true };
  // FloorMap itself needs a browser (model catalog store); its rooms render on their own.
  const cell: Cell = {
    key: '',
    kind: 'room',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    band: 0,
    upper: true,
    door: { x: 0, y: 0 },
  };
  const html = [busy, idle]
    .map((room) =>
      renderToStaticMarkup(
        createElement(RoomCell, {
          cell: { ...cell, key: room.root },
          room,
          hidden: 0,
          signs: [],
          selectedId: 'w:a',
          onOpen: () => {},
          onRegister: () => {},
        }),
      ),
    )
    .join('');
  expect(html.match(/<article[^>]*highlight[^>]*>/g)).toHaveLength(1);
  expect(html).toMatch(/<article[^>]*highlight[^>]*프로젝트 공간 \/r\/app"/);
  expect(html).toContain('aria-label="app 동료로 등록"');
  expect(html).toContain('aria-label="notes 동료로 등록"');
});
