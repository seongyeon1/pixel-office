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
test('auto approval executes tools, keeps questions interactive, and can change during a run', async () => {
  const store = createStore(':memory:');
  store.setSetting('approvals', { mode: 'auto' });
  const approvals: string[] = [];
  const adapter = fake(async (input, _emit, interact) => {
    const request = {
      runId: input.runId,
      agentId: 'codex' as const,
      title: 'git diff',
      details: {},
    };
    const first = await interact({ ...request, kind: 'approval' });
    if ('decision' in first) approvals.push(first.decision);
    await interact({ ...request, kind: 'question', title: '어떤 파일을 수정할까요?' });
    await interact({
      ...request,
      kind: 'approval',
      title: '추가 권한',
      details: {
        approvalMethod: 'item/permissions/requestApproval',
        permissions: { fileSystem: { write: ['/outside'] } },
      },
    });
    const second = await interact({ ...request, kind: 'approval' });
    if ('decision' in second) approvals.push(second.decision);
    return { outcome: 'completed', text: 'done' };
  });
  const o = createOrchestrator({
    store,
    adapters: { codex: adapter, claude: adapter },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-approval-')),
  });
  try {
    const run = await o.start({
      projectPath: await project(),
      prompt: 'task',
      mode: 'codex',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => store.pending(run.id)[0]?.kind === 'question');
    expect(approvals).toEqual(['approve']);
    expect(store.getRun(run.id)?.status).toBe('waiting_input');
    await o.approvePending();
    expect(store.pending(run.id)[0].kind).toBe('question');
    store.setSetting('approvals', { mode: 'manual' });
    await o.answer(store.pending(run.id)[0].id, { answers: { file: ['a.txt'] } });
    await wait(() => store.pending(run.id)[0]?.title === '추가 권한');
    store.setSetting('approvals', { mode: 'auto' });
    await o.approvePending();
    expect(store.pending(run.id)[0]?.title).toBe('추가 권한');
    store.setSetting('approvals', { mode: 'manual' });
    await o.answer(store.pending(run.id)[0].id, { decision: 'deny' });
    await wait(() => store.pending(run.id)[0]?.kind === 'approval');
    await o.approvePending();
    expect(store.pending(run.id)).toHaveLength(1);
    store.setSetting('approvals', { mode: 'auto' });
    await o.approvePending();
    await wait(() => store.getRun(run.id)?.status === 'completed');
    expect(approvals).toEqual(['approve', 'approve']);
    expect(store.pending(run.id)).toEqual([]);
    expect(store.events(run.id, 0).filter((e) => e.payload.automatic)).toHaveLength(2);
  } finally {
    await o.shutdown();
    store.close();
  }
});
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
    executionMode: 'isolated',
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
    executionMode: 'isolated' as const,
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
    executionMode: 'isolated' as const,
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
  const next = await o.followUp(run.id, 'bundle follow-up');
  await wait(() => store.getRun(next.id)?.status === 'completed');
  expect(next.repos).toEqual(run.repos);
  expect(inputs[2].cwd).toBe(run.worktreePath);
  expect(inputs[2].prompt).toContain('api/b.txt');
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

test('follow-up preserves workspace files, context and separate durable run history', async () => {
  const { readFile, rm } = await import('node:fs/promises');
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-followup-'));
  const dbPath = join(dataDir, 'history.sqlite');
  const store = createStore(dbPath);
  const inputs: PhaseInput[] = [];
  const adapter = fake(async (input) => {
    inputs.push(input);
    if (inputs.length === 1) await writeFile(join(input.cwd, 'kept.txt'), 'original change');
    else expect(await readFile(join(input.cwd, 'kept.txt'), 'utf8')).toBe('original change');
    return { outcome: 'completed', text: `result ${inputs.length}` };
  });
  const o = createOrchestrator({ store, adapters: { codex: adapter, claude: adapter }, dataDir });
  try {
    const first = await o.start({
      projectPath: await project(),
      prompt: 'first request',
      mode: 'codex',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => store.getRun(first.id)?.status === 'completed');
    await expect(o.followUp(first.id, '  ')).rejects.toThrow();
    await expect(o.followUp('missing', 'next')).rejects.toThrow();
    const next = await o.followUp(first.id, 'second request');
    expect(next).toMatchObject({
      parentRunId: first.id,
      worktreePath: first.worktreePath,
      baseCommit: first.baseCommit,
      branch: first.branch,
    });
    await expect(o.followUp(first.id, 'concurrent')).rejects.toThrow('진행 중');
    await wait(() => store.getRun(next.id)?.status === 'completed');
    expect(inputs[1].prompt).toContain('first request');
    expect(inputs[1].prompt).toContain('result 1');
    expect(inputs[1].prompt).toContain('second request');
    expect(store.getRun(first.id)).toMatchObject({
      prompt: 'first request',
      summary: 'result 1',
      status: 'completed',
    });
    expect(store.listRuns(first.projectPath).map((r) => r.id)).toEqual([next.id, first.id]);
    const third = await o.followUp(next.id, 'third request');
    await wait(() => store.getRun(third.id)?.status === 'completed');
    expect(inputs[2].prompt).toContain('first request');
    expect(inputs[2].prompt).toContain('second request');
    await rm(first.worktreePath, { recursive: true });
    await expect(o.followUp(third.id, 'missing workspace')).rejects.toThrow('작업 폴더');
    expect(store.listRuns()).toHaveLength(3);
  } finally {
    await o.shutdown();
    store.close();
  }
  const reopened = createStore(dbPath);
  try {
    const saved = reopened.listRuns();
    expect(saved.map((r) => r.prompt)).toEqual([
      'third request',
      'second request',
      'first request',
    ]);
    expect(saved[0].parentRunId).toBe(saved[1].id);
    expect(saved[1].parentRunId).toBe(saved[2].id);
    expect(saved[2].summary).toBe('result 1');
  } finally {
    reopened.close();
  }
});

test('personal follow-ups preserve per-role sessions and do not impose junior restrictions', async () => {
  const store = createStore(':memory:');
  const inputs: PhaseInput[] = [];
  const adapter = fake(async (input, emit) => {
    inputs.push(input);
    emit({
      runId: input.runId,
      agentId: input.role === 'implementer' ? 'codex' : 'claude',
      type: 'agent.session',
      payload: { sessionId: `${input.role}-session` },
    });
    return input.role === 'reviewer'
      ? { outcome: 'completed', text: 'review', review: pass }
      : { outcome: 'completed', text: 'implementation' };
  });
  const o = createOrchestrator({
    store,
    adapters: { codex: adapter, claude: adapter },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-personal-')),
  });
  try {
    const first = await o.start({
      projectPath: await project(),
      prompt: 'task',
      mode: 'collaborate',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => store.getRun(first.id)?.status === 'completed');
    const next = await o.followUp(first.id, 'follow-up');
    await wait(() => store.getRun(next.id)?.status === 'completed');
    expect(inputs[0].executionMode).toBe('personal');
    expect(inputs[0].prompt).not.toContain('주니어 엔지니어');
    expect(inputs[2].resumeSessionId).toBe('implementer-session');
    expect(inputs[3].resumeSessionId).toBe('reviewer-session');
    expect(inputs[2].prompt).not.toContain('git commit, push, merge, checkout');
  } finally {
    await o.shutdown();
    store.close();
  }
});

test('a code review pass is not completion when the requested PR was not created', async () => {
  const store = createStore(':memory:');
  const adapter = fake(async (i) =>
    i.role === 'reviewer'
      ? { outcome: 'completed', text: 'review passed', review: pass }
      : { outcome: 'completed', text: 'could not publish' },
  );
  const o = createOrchestrator({
    store,
    adapters: { codex: adapter, claude: adapter },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-pr-')),
    verifyDelivery: async () => ({ urls: [], error: 'PR 생성 미완료' }),
  });
  try {
    const run = await o.start({
      projectPath: await project(),
      prompt: 'PR 올려줘',
      mode: 'collaborate',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => ['needs_attention', 'completed'].includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)).toMatchObject({
      status: 'needs_attention',
      error: 'PR 생성 미완료',
    });
    expect(store.getRun(run.id)?.summary).toContain('could not publish');
    const next = await o.followUp(run.id, '계속해');
    expect(next.pullRequestRequested).toBe(true);
    await wait(() => store.getRun(next.id)?.status === 'needs_attention');
    const cancelled = await o.followUp(next.id, 'PR 만들지 마');
    expect(cancelled.pullRequestRequested).toBe(false);
  } finally {
    await o.shutdown();
    store.close();
  }
});

test('personal runs use the selected working folder including uncommitted local context', async () => {
  const { realpath, readFile } = await import('node:fs/promises');
  const root = await realpath(await project());
  await writeFile(join(root, 'a.txt'), 'uncommitted context');
  const nested = join(root, '.claude/worktrees/existing-task');
  execFileSync('git', ['worktree', 'add', '-b', 'existing-task', nested], {
    cwd: root,
    stdio: 'pipe',
  });
  const store = createStore(':memory:');
  const adapter = fake(async (input) => {
    expect(input.cwd).toBe(root);
    expect(await readFile(join(input.cwd, 'a.txt'), 'utf8')).toBe('uncommitted context');
    return { outcome: 'completed', text: 'kept' };
  });
  const o = createOrchestrator({
    store,
    adapters: { codex: adapter, claude: adapter },
    dataDir: await mkdtemp(join(tmpdir(), 'pixel-personal-cwd-')),
  });
  try {
    const run = await o.start({
      projectPath: root,
      prompt: 'task',
      mode: 'codex',
      implementer: 'codex',
      team: defaultTeam(),
    });
    await wait(() => ['failed', 'completed'].includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(run.worktreePath).toBe(root);
    expect(run.initialChanges?.[nested + '/']).toBeTruthy();
  } finally {
    await o.shutdown();
    store.close();
  }
});
