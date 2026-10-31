import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createStore } from '../src/server/store.js';
import { createCoworkers } from '../src/server/coworkers.js';
import { APPROVAL_GROUPS, DEFAULT_RULES, matchToolRule } from '../src/shared/coworkers.js';

const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pixel-coworkers-')));
  const store = createStore(':memory:');
  const coworkers = createCoworkers(store, { dataDir: join(base, 'data') });
  const folder = (name: string) => {
    const path = join(base, name);
    mkdirSync(path);
    return path;
  };
  const input = (id: string, dir: string, extra = {}) => ({
    id,
    name: id,
    folder: dir,
    engine: 'claude',
    role: '역할',
    mode: 'solo',
    bindings: [],
    createdBy: 'user',
    ...extra,
  });
  return { store, coworkers, folder, input };
};

test('matchToolRule picks the first matching rule, case-insensitively', () => {
  const rules = [
    { pattern: 'mcp__atlassian__*create*', action: 'ask' as const },
    { pattern: 'mcp__*', action: 'auto' as const },
  ];
  expect(matchToolRule(rules, 'mcp__atlassian__createConfluencePage')).toBe('ask');
  expect(matchToolRule(rules, 'mcp__notion__search')).toBe('auto');
  expect(matchToolRule(rules, 'MCP__Notion__Search')).toBe('auto');
  expect(matchToolRule(rules, 'Read')).toBeUndefined();
  expect(matchToolRule([{ pattern: 'Rea', action: 'auto' }], 'Read')).toBeUndefined();
  expect(matchToolRule(DEFAULT_RULES, 'mcp__slack__slack_send_message')).toBe('ask');
});

test('default rules ask per destination before the generic write verbs', () => {
  const ask = (tool: string) => matchToolRule(DEFAULT_RULES, tool);
  expect(ask('mcp__atlassian__createConfluencePage')).toBe('ask');
  expect(ask('mcp__atlassian__updateConfluencePage')).toBe('ask');
  expect(ask('mcp__atlassian__getConfluencePage')).toBeUndefined();
  expect(ask('mcp__notion__notion-fetch')).toBeUndefined();
  const confluence = APPROVAL_GROUPS.find((g) => g.label === 'Confluence 게시')!;
  expect(confluence.patterns.some((p) => /create\*Confluence/i.test(p))).toBe(true);
  // Turning the Confluence toggle off makes Confluence writes automatic, nothing else.
  const off = DEFAULT_RULES.map((r) =>
    confluence.patterns.includes(r.pattern) ? { ...r, action: 'auto' as const } : r,
  );
  expect(matchToolRule(off, 'mcp__atlassian__createConfluencePage')).toBe('auto');
  expect(matchToolRule(off, 'mcp__atlassian__updateConfluencePage')).toBe('auto');
  expect(matchToolRule(off, 'mcp__atlassian__createJiraIssue')).toBe('ask');
  expect(matchToolRule(off, 'mcp__github__create_pull_request')).toBe('ask');
  for (const [label, tool] of [
    ['Jira 발급', 'mcp__atlassian__createJiraIssue'],
    ['Jira 발급', 'mcp__atlassian__transitionJiraIssue'],
    ['Jira 발급', 'mcp__atlassian__addCommentToJiraIssue'],
    ['Notion 페이지', 'mcp__notion__notion-create-pages'],
    ['Notion 페이지', 'mcp__notion__notion-update-page'],
    ['Slack 다른 채널 발송', 'mcp__claude_ai_Slack__slack_send_message'],
  ]) {
    const group = APPROVAL_GROUPS.find((g) => g.label === label)!;
    const rules = DEFAULT_RULES.map((r) =>
      group.patterns.includes(r.pattern) ? { ...r, action: 'auto' as const } : r,
    );
    expect(matchToolRule(rules, tool), tool).toBe('auto');
  }
  // The last group owns the generic verbs and comes after every destination.
  expect(APPROVAL_GROUPS.at(-1)!.label).toBe('그 외 외부 쓰기');
  expect(APPROVAL_GROUPS.at(-1)!.patterns).toContain('mcp__*__*create*');
  expect(DEFAULT_RULES.map((r) => r.pattern)).toEqual(APPROVAL_GROUPS.flatMap((g) => g.patterns));
});

test('coworkers round-trip, default rules and coordinator first', () => {
  const { coworkers, folder, input } = setup();
  const saved = coworkers.save(input('skt-dev', folder('a'), { bindings: ['C123'] }));
  expect(saved.rules).toEqual(DEFAULT_RULES);
  expect(coworkers.get('skt-dev')).toEqual(saved);
  expect(coworkers.list().map((c) => c.id)).toEqual(['coordinator', 'skt-dev']);
  expect(coworkers.forFolder(saved.folder)?.id).toBe('skt-dev');
  expect(coworkers.forChannel('C123')?.id).toBe('skt-dev');
  expect(coworkers.forChannel('C999')).toBeUndefined();
  expect(coworkers.save({ ...saved, role: '바뀜' }).role).toBe('바뀜');
  coworkers.remove('skt-dev');
  expect(coworkers.get('skt-dev')).toBeUndefined();
  expect(() => coworkers.remove('skt-dev')).toThrow('동료를 찾을 수 없어요.');
});

test('rejects duplicate folders, a missing folder, bad ids and removing the coordinator', () => {
  const { coworkers, folder, input } = setup();
  const dir = folder('a');
  coworkers.save(input('one', dir));
  expect(() => coworkers.save(input('two', dir))).toThrow('이미 이 폴더를 맡은 동료가 있어요.');
  expect(() => coworkers.save(input('three', join(dir, 'nope')))).toThrow();
  expect(() => coworkers.save(input('SKT Dev', folder('b')))).toThrow();
  expect(() => coworkers.remove('coordinator')).toThrow('코디네이터는 삭제할 수 없어요.');
});

test('suggestions skip folders that already have a coworker', () => {
  const { store, coworkers, folder, input } = setup();
  const [a, b] = [folder('a'), folder('b')];
  store.rememberProject(a);
  store.rememberProject(b);
  coworkers.save(input('one', a));
  expect(coworkers.suggestions()).toEqual([{ name: 'b', folder: b }]);
});

test('the coordinator entry only takes name, role and model changes', () => {
  const { coworkers, folder, input } = setup();
  const before = coworkers.get('coordinator')!;
  const saved = coworkers.save(
    input('coordinator', folder('x'), {
      name: '새 이름',
      role: '새 역할',
      model: 'opus',
      rules: [{ pattern: '*', action: 'auto' }],
      bindings: ['C1'],
      mode: 'collaborate',
    }),
  );
  expect(saved).toEqual({ ...before, name: '새 이름', role: '새 역할', model: 'opus' });
  expect(coworkers.get('coordinator')).toEqual(saved);
});

test('moving a coworker onto another coworker folder is rejected', () => {
  const { coworkers, folder, input } = setup();
  const [a, b] = [folder('a'), folder('b')];
  coworkers.save(input('one', a));
  coworkers.save(input('two', b));
  expect(() => coworkers.save(input('two', a))).toThrow('이미 이 폴더를 맡은 동료가 있어요.');
  expect(coworkers.get('two')?.folder).toBe(b);
});
