import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkBoard } from '../src/client/overview/WorkBoard.js';
import type { BoardRow } from '../src/client/overview/team.js';
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
