import { expect, test } from 'vitest';
import { requestsPullRequest } from '../src/server/delivery.js';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/server/projects.js';
import { workingState } from '../src/server/delivery.js';

test('working state accepts nested worktrees and detects edits inside them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pixel-nested-worktree-'));
  try {
    await git(cwd, ['init']);
    await git(cwd, ['config', 'user.name', 'Test']);
    await git(cwd, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(cwd, 'file.txt'), 'base');
    await git(cwd, ['add', '.']);
    await git(cwd, ['commit', '-m', 'base']);
    const nested = join(cwd, '.claude/worktrees/task');
    await git(cwd, ['worktree', 'add', '-b', 'task', nested]);
    const targets = [{ worktreePath: cwd, baseCommit: '' }];
    const before = await workingState(targets);
    expect(Object.keys(before)).toEqual([nested + '/']);
    expect(await workingState(targets)).toEqual(before);
    await writeFile(join(nested, 'file.txt'), 'changed');
    const changed = await workingState(targets);
    expect(changed[nested + '/']).not.toBe(before[nested + '/']);
    await writeFile(join(nested, 'notes.txt'), 'new note');
    expect((await workingState(targets))[nested + '/']).not.toBe(changed[nested + '/']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('working state snapshots symlink targets and a tracked file replaced by a directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pixel-state-types-'));
  try {
    await git(cwd, ['init']);
    await writeFile(join(cwd, 'file.txt'), 'base');
    await git(cwd, ['add', '.']);
    await git(cwd, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'base',
    ]);
    await unlink(join(cwd, 'file.txt'));
    await mkdir(join(cwd, 'file.txt'));
    await writeFile(join(cwd, 'file.txt/child.txt'), 'child');
    await symlink('missing-target', join(cwd, 'link'));
    const targets = [{ worktreePath: cwd, baseCommit: '' }];
    const before = await workingState(targets);
    expect(before[join(cwd, 'file.txt')]).toBe('directory');
    expect(before[join(cwd, 'link')]).not.toBe('deleted');
    await unlink(join(cwd, 'link'));
    await symlink('another-missing-target', join(cwd, 'link'));
    expect((await workingState(targets))[join(cwd, 'link')]).not.toBe(before[join(cwd, 'link')]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test.each(['pr올려줘 올려도돼', '수정하고 PR 만들어줘', 'create a pull request', 'open a PR'])(
  'detects an actual publishing request: %s',
  (prompt) => {
    expect(requestsPullRequest(prompt)).toBe(true);
  },
);
test.each([
  'PR은 만들지 마',
  'PR 목록 UI 수정',
  "don't create a PR",
  'PR 생성하지 말고 코드만 수정',
])('does not require publication for %s', (prompt) => {
  expect(requestsPullRequest(prompt)).toBe(false);
});

test('verifies an existing committed PR and preserves unrelated pre-existing edits', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { git } = await import('../src/server/projects.js');
  const { workingState, verifyPullRequests } = await import('../src/server/delivery.js');
  const cwd = await mkdtemp(join(tmpdir(), 'pixel-delivery-'));
  try {
    await git(cwd, ['init']);
    await git(cwd, ['config', 'user.name', 'Test']);
    await git(cwd, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(cwd, 'file.txt'), 'base');
    await git(cwd, ['add', '.']);
    await git(cwd, ['commit', '-m', 'base']);
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(cwd, 'notes.txt'), 'unrelated original edit');
    const target = { worktreePath: cwd, baseCommit: head };
    const run = {
      ...target,
      prompt: '계속해',
      pullRequestRequested: true,
      initialChanges: await workingState([target]),
    } as any;
    const pr = { url: 'https://github.com/example/repo/pull/1', state: 'OPEN', headRefOid: head };
    expect(await verifyPullRequests(run, async () => pr)).toEqual({ urls: [pr.url] });
    expect(
      (await verifyPullRequests(run, async () => ({ ...pr, headRefOid: 'old' }))).error,
    ).toContain('현재 커밋');
    expect(
      (
        await verifyPullRequests(run, async () => {
          throw new Error('No PR');
        })
      ).error,
    ).toContain('No PR');
    await writeFile(join(cwd, 'file.txt'), 'not yet committed');
    expect((await verifyPullRequests(run, async () => pr)).error).toContain('커밋되지 않은');
    expect(
      await verifyPullRequests({ ...run, pullRequestRequested: false }, async () => pr),
    ).toEqual({ urls: [] });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
