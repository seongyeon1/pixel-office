import { expect, test } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStore } from '../src/server/store.js';
import { createOrchestrator, nextAfterReview } from '../src/server/orchestrator.js';
import {
  defaultTeam,
  type Adapter,
  type PhaseInput,
  type Review,
} from '../src/shared/contracts.js';
import { personaInstructions } from '../src/server/personas.js';
async function project() {
  const p = await mkdtemp(join(tmpdir(), 'pixel-orch-'));
  execFileSync('git', ['init'], { cwd: p, stdio: 'pipe' });
  await writeFile(join(p, 'a.txt'), 'a');
  for (const args of [
    ['add', '.'],
    ['-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed'],
  ])
    execFileSync('git', args, { cwd: p, stdio: 'pipe' });
  return p;
}
const review: Review = { verdict: 'changes_requested', summary: 'fix', findings: [] };
const pass: Review = { verdict: 'pass', summary: 'ok', findings: [] };
const fake = (fn: Adapter['execute']): Adapter => ({
  probe: async () => ({ installed: true, authenticated: true, detail: 'fixture' }),
  execute: fn,
  close: async () => {},
});
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
};
test('revision cap and malformed review never report success', () => {
  expect(nextAfterReview(review, 0)).toBe('revise');
  expect(nextAfterReview(review, 2)).toBe('needs_attention');
  expect(nextAfterReview({ ...pass, verdict: 'inconclusive' }, 0)).toBe('needs_attention');
});
test('hands results between providers and carries persona into actual input', async () => {
  const store = createStore(':memory:');
  const inputs: PhaseInput[] = [];
  let reviews = 0;
  const codex = fake(async (i) => {
    inputs.push(i);
    return { outcome: 'completed', text: 'changed a file' };
  });
  const claude = fake(async (i) => {
    inputs.push(i);
    return { outcome: 'completed', text: 'review', review: reviews++ === 0 ? review : pass };
  });
  const o = createOrchestrator({
    store,
    adapters: { codex, claude },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-data-')),
  });
  const team = defaultTeam();
  team.codex.seniority = 'intern';
  const run = await o.start({
    projectPath: await project(),
    prompt: 'task',
    mode: 'collaborate',
    implementer: 'codex',
    team,
  });
  await wait(() => store.getRun(run.id)?.status === 'completed');
  expect(inputs.map((i) => i.role)).toEqual(['implementer', 'reviewer', 'implementer', 'reviewer']);
  expect(inputs[1].prompt).toContain('changed a file');
  expect(inputs[0].prompt).toContain(personaInstructions(team.codex));
  expect(store.getRun(run.id)?.revision).toBe(1);
  await o.shutdown();
  store.close();
});
test('cancelled implementation cannot trigger reviewer even with late success', async () => {
  const store = createStore(':memory:');
  let reviewer = false;
  const codex = fake(async (i) => {
    await new Promise<void>((r) => i.signal.addEventListener('abort', () => r(), { once: true }));
    return { outcome: 'completed', text: 'late' };
  });
  const claude = fake(async () => {
    reviewer = true;
    return { outcome: 'completed', text: 'bad', review: pass };
  });
  const o = createOrchestrator({
    store,
    adapters: { codex, claude },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-data-')),
  });
  const input = {
    projectPath: await project(),
    prompt: 'task',
    mode: 'collaborate' as const,
    implementer: 'codex' as const,
    team: defaultTeam(),
  };
  const run = await o.start(input);
  await new Promise((r) => setTimeout(r, 15));
  await expect(o.start(input)).rejects.toThrow('진행 중');
  await o.cancel(run.id);
  expect(store.getRun(run.id)?.status).toBe('cancelled');
  expect(reviewer).toBe(false);
  store.close();
});
test('a run keeps the repository harness it started with and hands each provider its own part', async () => {
  const { emptyHarness } = await import('../src/shared/contracts.js');
  const store = createStore(':memory:');
  const inputs: PhaseInput[] = [];
  const both = fake(async (i) => {
    inputs.push(i);
    return i.role === 'reviewer'
      ? { outcome: 'completed', text: 'ok', review: pass }
      : { outcome: 'completed', text: 'done' };
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-data-'));
  const o = createOrchestrator({ store, adapters: { codex: both, claude: both }, dataDir });
  const root = await project();
  const { realpath } = await import('node:fs/promises');
  const harness = emptyHarness();
  harness.codex.plugins = ['linear@curated'];
  harness.claude.skills = ['bc-ship'];
  store.setHarness(await realpath(root), harness);
  const run = await o.start({
    projectPath: root,
    prompt: 'task',
    mode: 'collaborate',
    implementer: 'codex',
    team: defaultTeam(),
  });
  // Editing the settings mid-run does not change the run.
  store.setHarness(await realpath(root), emptyHarness());
  await wait(() => store.getRun(run.id)?.status === 'completed');
  expect(store.getRun(run.id)!.harness).toEqual(harness);
  expect(inputs[0].harness).toEqual(harness.codex);
  expect(inputs[1].harness).toEqual(harness.claude);
  expect(inputs[0].harnessDir).toBe(inputs[1].harnessDir);
  expect(inputs[0].harnessDir!.startsWith(join(dataDir, 'harness'))).toBe(true);
  await o.shutdown();
  store.close();
});
test('a bundle run works in one folder holding a worktree per chosen repository', async () => {
  const store = createStore(':memory:');
  const inputs: PhaseInput[] = [];
  const both = fake(async (i) => {
    inputs.push(i);
    if (i.role === 'implementer') await writeFile(join(i.cwd, 'api', 'b.txt'), 'b');
    return i.role === 'reviewer'
      ? { outcome: 'completed', text: 'ok', review: pass }
      : { outcome: 'completed', text: 'done' };
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-data-'));
  const o = createOrchestrator({ store, adapters: { codex: both, claude: both }, dataDir });
  const { mkdir, rename } = await import('node:fs/promises');
  const folder = await mkdtemp(join(tmpdir(), 'pixel-folder-'));
  await rename(await project(), join(folder, 'api'));
  await mkdir(join(folder, 'apps'));
  await rename(await project(), join(folder, 'apps', 'web'));
  const base = {
    projectPath: folder,
    prompt: 'task',
    mode: 'collaborate' as const,
    implementer: 'codex' as const,
    team: defaultTeam(),
  };
  // A folder of repositories needs a chosen bundle.
  await expect(o.start(base)).rejects.toThrow('저장소');
  const run = await o.start({
    ...base,
    repositories: [join(folder, 'api'), join(folder, 'apps', 'web')],
  });
  expect(run.repos!.map((r) => r.name)).toEqual(['api', 'web']);
  expect(run.worktreePath).toBe(join(dataDir, 'workspaces', run.id));
  await wait(() => store.getRun(run.id)?.status === 'completed');
  expect(inputs[0].cwd).toBe(run.worktreePath);
  expect(inputs[0].prompt).toContain('api/');
  expect(inputs[0].prompt).toContain('web/');
  // The reviewer sees the change under its repository folder.
  expect(inputs[1].prompt).toContain('api/b.txt');
  await o.shutdown();
  store.close();
});

// A quota failure must preserve the worktree and phase, and never bounce between providers.
test.each(['codex', 'claude'] as const)(
  'a %s quota failure hands partial work to the other provider',
  async (exhausted) => {
    const { readFile } = await import('node:fs/promises');
    const store = createStore(':memory:');
    const other = exhausted === 'codex' ? 'claude' : 'codex';
    const inputs: PhaseInput[] = [];
    const adapters = {
      [exhausted]: fake(async (i) => {
        await writeFile(join(i.cwd, 'partial.txt'), 'keep this');
        return {
          outcome: 'failed',
          text: 'partial work summary',
          error: "You've hit your session limit · resets 5:20pm (Asia/Seoul)",
        };
      }),
      [other]: fake(async (i) => {
        inputs.push(i);
        expect(await readFile(join(i.cwd, 'partial.txt'), 'utf8')).toBe('keep this');
        return { outcome: 'completed', text: 'continued', review: pass };
      }),
    } as Record<'codex' | 'claude', Adapter>;
    const o = createOrchestrator({
      store,
      adapters,
      dataDir: await mkdtemp(join(tmpdir(), 'pixel-fallback-')),
    });
    try {
      const run = await o.start({
        projectPath: await project(),
        prompt: 'task',
        mode: 'collaborate',
        implementer: exhausted,
        team: defaultTeam(),
      });
      await wait(() => !o.activeId);
      expect(store.getRun(run.id)?.status).toBe('completed');
      expect(inputs.map((i) => i.role)).toEqual(['implementer', 'reviewer']);
      expect(inputs[0].prompt).toContain('partial work summary');
      expect(inputs[0].prompt).toContain('partial.txt');
      expect(inputs.every((i) => i.cwd === run.worktreePath)).toBe(true);
      expect(store.events(run.id).filter((e) => e.type === 'provider.fallback')).toHaveLength(1);
    } finally {
      await o.shutdown();
      store.close();
    }
  },
);

test('a reviewer quota failure continues read-only review on the available provider', async () => {
  const store = createStore(':memory:');
  const roles: string[] = [];
  const codex = fake(async (i) => {
    roles.push(i.role);
    return { outcome: 'completed', text: 'implementation', review: pass };
  });
  const claude = fake(async () => ({
    outcome: 'failed',
    text: 'review in progress',
    error: 'usage_limit_reached',
  }));
  const o = createOrchestrator({
    store,
    adapters: { codex, claude },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-fallback-')),
  });
  try {
    const run = await o.start({
      projectPath: await project(),
      prompt: 'task',
      mode: 'collaborate',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => !o.activeId);
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(roles).toEqual(['implementer', 'reviewer']);
    const notice = store.events(run.id).find((e) => e.type === 'provider.fallback');
    expect(notice?.payload).toMatchObject({ from: 'claude', to: 'codex', phase: 'review' });
  } finally {
    await o.shutdown();
    store.close();
  }
});

test.each(['quota', 'unavailable', 'ordinary', 'cancel'] as const)(
  'fallback stops correctly for %s',
  async (scenario) => {
    const store = createStore(':memory:');
    let attempts = 0;
    const codex = fake(async (i) => {
      attempts++;
      if (scenario === 'cancel') {
        await new Promise<void>((r) =>
          i.signal.addEventListener('abort', () => r(), { once: true }),
        );
      }
      return {
        outcome: 'failed',
        text: '',
        error: scenario === 'ordinary' ? 'Permission denied' : 'You have hit your usage limit.',
      };
    });
    const claude = fake(async () => {
      attempts++;
      return { outcome: 'failed', text: '', error: 'insufficient_quota' };
    });
    if (scenario === 'unavailable')
      claude.probe = async () => ({
        installed: false,
        authenticated: false,
        detail: 'not installed',
      });
    const o = createOrchestrator({
      store,
      adapters: { codex, claude },
      dataDir: await mkdtemp(join(tmpdir(), 'pixel-fallback-')),
    });
    try {
      const run = await o.start({
        projectPath: await project(),
        prompt: 'task',
        mode: 'codex',
        implementer: 'codex',
        team: defaultTeam(),
      });
      if (scenario === 'cancel') {
        await wait(() => attempts > 0);
        await o.cancel(run.id);
      }
      await wait(() => !o.activeId);
      expect(store.getRun(run.id)?.status).toBe(
        scenario === 'ordinary'
          ? 'failed'
          : scenario === 'cancel'
            ? 'cancelled'
            : 'needs_attention',
      );
      expect(attempts).toBe(scenario === 'quota' ? 2 : 1);
      if (scenario === 'quota' || scenario === 'unavailable')
        expect(store.getRun(run.id)?.error).toContain('한도');
    } finally {
      await o.shutdown();
      store.close();
    }
  },
);

test('after review fallback, revisions and handoffs stay on the available provider', async () => {
  const store = createStore(':memory:');
  const roles: string[] = [];
  let reviews = 0;
  const codex = fake(async (i) => {
    roles.push(i.role);
    return {
      outcome: 'completed',
      text: 'done',
      review: i.role === 'reviewer' ? (reviews++ ? pass : review) : undefined,
    };
  });
  const claude = fake(async () => ({ outcome: 'failed', text: '', error: 'usage_limit_reached' }));
  const o = createOrchestrator({
    store,
    adapters: { codex, claude },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-fallback-')),
  });
  try {
    const run = await o.start({
      projectPath: await project(),
      prompt: 'task',
      mode: 'collaborate',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => !o.activeId);
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(roles).toEqual(['implementer', 'reviewer', 'implementer', 'reviewer']);
    const events = store.events(run.id);
    const fallback = events.findIndex((e) => e.type === 'provider.fallback');
    expect(
      events
        .slice(fallback)
        .filter((e) => e.type === 'handoff')
        .map((e) => e.payload.to),
    ).toEqual(['codex', 'codex']);
  } finally {
    await o.shutdown();
    store.close();
  }
});
