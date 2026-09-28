import { expect, test } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/store.js';
import { createWorkspace, git } from '../src/server/projects.js';
import { createWorktreeCleanup, usesWorktree } from '../src/server/worktrees.js';
import { defaultTeam, type Run } from '../src/shared/contracts.js';

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pixel-cleanup-')));
  const root = join(dir, 'repo');
  await mkdir(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(root, 'file.txt'), 'original');
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'seed']);
  const store = createStore(':memory:');
  async function run(id: string) {
    const w = await createWorkspace(root, id, dir);
    const value: Run = {
      id,
      projectPath: root,
      worktreePath: w.path,
      branch: w.branch,
      baseCommit: w.baseCommit,
      prompt: 'old work',
      mode: 'codex',
      implementer: 'codex',
      status: 'completed',
      phase: 'done',
      revision: 0,
      createdAt: new Date().toISOString(),
      team: defaultTeam(),
      executionMode: 'isolated',
    };
    store.createRun(value);
    return value;
  }
  return {
    dir,
    root,
    store,
    run,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('cleaning a completed linked worktree preserves original files, branch commits and every follow-up record', async () => {
  const f = await fixture();
  try {
    const r = await f.run('original');
    await writeFile(join(r.worktreePath, 'result.txt'), 'saved result');
    await git(r.worktreePath, ['add', '.']);
    await git(r.worktreePath, ['commit', '-m', 'result']);
    f.store.createRun({ ...r, id: 'follow-up', parentRunId: r.id });
    const cleanup = createWorktreeCleanup(f.store, () => undefined);
    const items = await cleanup.list();
    expect(items).toHaveLength(1);
    expect(items[0].runIds).toHaveLength(2);
    expect(items[0].changedFiles).toBe(0);
    await cleanup.remove(r.worktreePath);
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original');
    expect(await git(f.root, ['show', `${r.branch}:result.txt`])).toBe('saved result');
    expect(await cleanup.list()).toEqual([]);
    for (const id of ['original', 'follow-up'])
      expect(f.store.getRun(id)).toMatchObject({
        prompt: 'old work',
        removedWorktrees: [r.worktreePath],
      });
  } finally {
    await f.close();
  }
});

test('uncommitted, untracked and ignored files survive until explicit discard confirmation', async () => {
  const f = await fixture();
  try {
    const r = await f.run('dirty');
    await writeFile(join(r.worktreePath, 'file.txt'), 'edited');
    await writeFile(join(r.worktreePath, 'new.txt'), 'untracked');
    await mkdir(join(r.worktreePath, 'ignored'));
    await writeFile(join(r.worktreePath, 'ignored', 'cache'), 'ignored');
    const cleanup = createWorktreeCleanup(f.store, () => undefined);
    expect((await cleanup.list())[0]).toMatchObject({ changedFiles: 3 });
    await expect(cleanup.remove(r.worktreePath)).rejects.toThrow('직접 확인');
    expect(await readFile(join(r.worktreePath, 'new.txt'), 'utf8')).toBe('untracked');
    await cleanup.remove(r.worktreePath, true);
    await expect(readFile(join(r.worktreePath, 'new.txt'))).rejects.toThrow();
    expect((await git(f.root, ['branch', '--list', r.branch])).trim()).toBe(r.branch);
  } finally {
    await f.close();
  }
});

test('original repositories and unrecorded worktrees cannot be deleted even with force', async () => {
  const f = await fixture();
  try {
    const r = await f.run('owned');
    const foreign = await createWorkspace(f.root, 'unrecorded', f.dir);
    f.store.createRun({ ...r, id: 'personal', worktreePath: f.root, executionMode: 'personal' });
    const cleanup = createWorktreeCleanup(f.store, () => undefined);
    expect((await cleanup.list()).map((i) => i.path)).toEqual([r.worktreePath]);
    await expect(cleanup.remove(f.root, true)).rejects.toThrow('앱에서 만든');
    await expect(cleanup.remove(foreign.path, true)).rejects.toThrow('앱에서 만든');
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original');
  } finally {
    await f.close();
  }
});

test('active follow-ups and terminal conversations block cleanup, and cleanup reserves the whole folder', async () => {
  const f = await fixture();
  try {
    const r = await f.run('busy');
    f.store.createRun({ ...r, id: 'active-follow-up', status: 'running', phase: 'implement' });
    let busy: string | undefined;
    const cleanup = createWorktreeCleanup(f.store, () => busy);
    await expect(cleanup.remove(r.worktreePath, true)).rejects.toThrow('진행 중');
    f.store.updateRun('active-follow-up', { status: 'completed', phase: 'done' });
    busy = '터미널 사용 중';
    await expect(cleanup.remove(r.worktreePath, true)).rejects.toThrow('터미널 사용 중');
    busy = undefined;
    const removing = cleanup.remove(r.worktreePath);
    expect(() => cleanup.assertAvailable(join(r.worktreePath, 'subfolder'))).toThrow('정리 중');
    await expect(cleanup.remove(r.worktreePath, true)).rejects.toThrow('정리 중');
    await removing;
  } finally {
    await f.close();
  }
});

test('bundle cleanup marks all shared history while preserving its other worktree', async () => {
  const f = await fixture();
  try {
    const one = await f.run('bundle-one'),
      two = await f.run('bundle-two');
    f.store.createRun({
      ...one,
      id: 'bundle',
      projectPath: f.dir,
      worktreePath: join(f.dir, 'bundle'),
      repos: [one, two].map((r, i) => ({
        root: f.root,
        worktreePath: r.worktreePath,
        name: String(i),
        branch: r.branch,
        baseCommit: r.baseCommit,
      })),
    });
    const cleanup = createWorktreeCleanup(f.store, () => undefined);
    await cleanup.remove(one.worktreePath);
    expect(f.store.getRun('bundle')?.removedWorktrees).toEqual([one.worktreePath]);
    expect(await readFile(join(two.worktreePath, 'file.txt'), 'utf8')).toBe('original');
  } finally {
    await f.close();
  }
});

test('a manually recreated worktree is not owned by an already-cleaned app record', async () => {
  const f = await fixture();
  try {
    const r = await f.run('reused');
    const cleanup = createWorktreeCleanup(f.store, () => undefined);
    await cleanup.remove(r.worktreePath);
    await git(f.root, ['worktree', 'add', '-b', 'manual-work', r.worktreePath]);
    expect(await cleanup.list()).toEqual([]);
    await expect(cleanup.remove(r.worktreePath, true)).rejects.toThrow('앱에서 만든');
    expect(await readFile(join(r.worktreePath, 'file.txt'), 'utf8')).toBe('original');
  } finally {
    await f.close();
  }
});

test('a follow-up still preparing cannot start after its worktree is cleaned', async () => {
  const { createOrchestrator } = await import('../src/server/orchestrator.js');
  const f = await fixture();
  try {
    const r = await f.run('preparing');
    let release!: () => void;
    const adapter = {
      probe: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { installed: true, authenticated: true, detail: 'ready' };
      },
      execute: async () => ({ outcome: 'completed' as const, text: 'must not run' }),
      close: async () => {},
    };
    const o = createOrchestrator({
      store: f.store,
      adapters: { codex: adapter, claude: adapter },
      dataDir: f.dir,
    });
    const follow = o.followUp(r.id, 'continue');
    await expect.poll(() => !!release).toBe(true);
    await createWorktreeCleanup(f.store, () => undefined).remove(r.worktreePath);
    release();
    await expect(follow).rejects.toThrow('정리한 작업 폴더');
    expect(f.store.cleanupRuns()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('bundle-level conversations protect their members without treating an unrelated parent repo as busy', async () => {
  const f = await fixture();
  try {
    const r = await f.run('bundle-member');
    const bundle = {
      ...r,
      id: 'bundle-source',
      projectPath: f.dir,
      worktreePath: join(f.dir, 'workspaces'),
      repos: [
        {
          root: f.root,
          worktreePath: r.worktreePath,
          name: 'repo',
          branch: r.branch,
          baseCommit: r.baseCommit,
        },
      ],
    };
    expect(usesWorktree(r.worktreePath, bundle.worktreePath, [bundle])).toBe(true);
    expect(usesWorktree(r.worktreePath, join(r.worktreePath, 'src'), [bundle])).toBe(true);
    expect(usesWorktree(r.worktreePath, f.dir, [bundle])).toBe(false);
    expect(usesWorktree(r.worktreePath, bundle.worktreePath, [])).toBe(false);
  } finally {
    await f.close();
  }
});
