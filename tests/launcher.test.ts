import { expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLauncher } from '../src/server/launcher.js';
import { createTerminals } from '../src/server/terminals.js';

// Exercise the real shell/PTY: user text must remain one literal argument.
test('a harness launch preserves quoted tasks, deduplicates retries, and can be recovered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pixel-launch-'));
  const output = join(root, 'args.json');
  const { writeFile } = await import('node:fs/promises');
  const script = join(root, 'fake.cjs');
  await writeFile(
    script,
    `require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); setInterval(()=>{}, 1000);`,
  );
  const terminals = createTerminals({ shell: '/bin/sh' });
  const launcher = createLauncher({
    terminals,
    commands: {
      claude: `${process.execPath} ${script} ${output}`,
      codex: `${process.execPath} ${script} ${output}`,
    },
  });
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    root,
    provider: 'claude' as const,
    harness: 'personal' as const,
    prompt: "Fix 'quote'\n$(touch injected) `touch injected2` ; hello",
  };
  try {
    const first = launcher.start(input);
    expect(launcher.start(input).terminal.id).toBe(first.terminal.id);
    expect(launcher.list(root).map((a) => a.id)).toEqual([input.id]);
    let args: string[] = [];
    await expect
      .poll(async () => {
        args = await readFile(output, 'utf8').then(JSON.parse, () => []);
        return args.length;
      })
      .toBeGreaterThan(0);
    expect(args.at(-1)).toBe(input.prompt);
    expect(args).toContain('--session-id');
    expect(args).toContain(input.id);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(root)).not.toContain('injected');
    expect(await readdir(root)).not.toContain('injected2');
    await terminals.end(first.terminal.id);
    expect(launcher.list(root)).toEqual([]);
    expect(() => launcher.start({ ...input, root: '/other' })).toThrow();
  } finally {
    await terminals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('launch command follows the engine of the harness without shell interpolation', async () => {
  const { launchCommand } = await import('../src/server/launcher.js');
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    provider: 'codex' as const,
    prompt: 'task',
  };
  expect(launchCommand(input, 'syc')).toBe(
    "syc '<!-- pixel-office-launch:25ff09ab-e861-44cd-9d3a-b5408f853db3 -->\ntask'",
  );
  expect(launchCommand({ ...input, provider: 'claude' }, 'dots')).toBe(
    `dots --session-id ${input.id} 'task'`,
  );
  expect(() => launchCommand({ ...input, id: 'bad;id' }, 'syc')).toThrow();
});

test('a harness is any registered command for its engine; unregistered names never run', async () => {
  const { resolveHarness, defaultHarnesses } = await import('../src/server/launcher.js');
  const list = [
    { engine: 'claude' as const, command: 'dots' },
    { engine: 'codex' as const, command: 'grokbot' },
    ...defaultHarnesses((c) => c === 'sy'),
  ];
  expect(defaultHarnesses(() => false).map((h) => h.command)).toEqual(['claude', 'codex']);
  expect(resolveHarness({ provider: 'claude', harness: 'dots' }, list)).toBe('dots');
  // Registered for the other engine: its logs and resume syntax would not match.
  expect(resolveHarness({ provider: 'claude', harness: 'grokbot' }, list)).toBeUndefined();
  expect(resolveHarness({ provider: 'claude', harness: 'muse' }, list)).toBeUndefined();
  // Names sent by older clients.
  expect(resolveHarness({ provider: 'claude', harness: 'personal' }, list)).toBe('sy');
  expect(resolveHarness({ provider: 'codex', harness: 'personal' }, list)).toBeUndefined();
  expect(resolveHarness({ provider: 'codex', harness: 'standard' }, list)).toBe('codex');
});

test('a launched coworker keeps the command of its harness for resuming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pixel-launch-own-'));
  const terminals = createTerminals({ shell: '/bin/sh' });
  let harnesses = [{ engine: 'claude' as const, command: 'true' }];
  const launcher = createLauncher({ terminals, harnesses: () => harnesses });
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    root,
    provider: 'claude' as const,
    harness: 'true',
    prompt: 'task',
  };
  try {
    expect(() => launcher.start({ ...input, harness: 'false' })).toThrow('등록되지 않은');
    launcher.start(input);
    expect(launcher.command(input.id)).toBe('true');
    expect(launcher.command('unknown')).toBeUndefined();
    // Removed from the list since: fall back to the default resume command.
    harnesses = [];
    expect(launcher.command(input.id)).toBeUndefined();
  } finally {
    await terminals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('launch API requires browser authentication and a connected folder', async () => {
  const { createStore } = await import('../src/server/store.js');
  const { createServer } = await import('../src/server/transport.js');
  const { createOrchestrator } = await import('../src/server/orchestrator.js');
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-launch-api-')));
  const store = createStore(':memory:');
  store.rememberProject(root);
  const adapter = {
    probe: async () => ({ installed: true, authenticated: true, detail: '' }),
    execute: async () => ({ outcome: 'completed' as const, text: '' }),
    close: async () => {},
  };
  const adapters = { claude: adapter, codex: adapter };
  const { app, origin } = await createServer({
    store,
    adapters,
    orchestrator: createOrchestrator({ store, adapters, dataDir: root }),
    token: 'test',
    port: 4318,
    terminalShell: '/bin/sh',
  });
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    root,
    provider: 'codex',
    harness: 'echo',
    prompt: 'test',
  };
  const headers = { host: '127.0.0.1:4318', origin };
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents', headers, payload: input }))
        .statusCode,
    ).toBe(401);
    const auth = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers,
      payload: { token: 'test' },
    });
    const cookie = (auth.headers['set-cookie'] as string).split(';')[0];
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/agents', headers: { ...headers, cookie }, payload });
    expect((await post({ ...input, root: tmpdir() })).statusCode).toBe(400);
    expect((await post({ ...input, id: 'bad;id' })).statusCode).toBe(400);
    const settings = (payload?: Record<string, unknown>) =>
      app.inject({
        method: payload ? 'POST' : 'GET',
        url: '/api/settings/harnesses',
        headers: { ...headers, cookie },
        payload,
      });
    expect((await settings()).json().harnesses.map((h: { command: string }) => h.command)).toEqual(
      expect.arrayContaining(['claude', 'codex']),
    );
    // Not registered yet, and never a shell fragment.
    expect((await post(input)).statusCode).toBe(400);
    expect(
      (await settings({ harnesses: [{ engine: 'codex', command: 'echo; rm -rf ~' }] })).statusCode,
    ).toBe(400);
    const saved = await settings({
      harnesses: [
        { engine: 'codex', command: 'echo' },
        { engine: 'claude', command: 'no-such-harness-here' },
      ],
    });
    expect(saved.json().harnesses).toEqual([
      { engine: 'codex', command: 'echo', available: true },
      { engine: 'claude', command: 'no-such-harness-here', available: false },
    ]);
    expect((await post({ ...input, provider: 'claude' })).statusCode).toBe(400);
    const created = await post(input);
    expect(created.statusCode).toBe(201);
    expect(created.json().terminal.command).toBe(
      "echo '<!-- pixel-office-launch:25ff09ab-e861-44cd-9d3a-b5408f853db3 -->\ntest'",
    );
    const list = await app.inject({
      url: `/api/agents?root=${encodeURIComponent(root)}`,
      headers: { ...headers, cookie },
    });
    expect(list.json().map((a: { id: string }) => a.id)).toEqual([input.id]);
    expect((await post(input)).json().terminal.id).toBe(created.json().terminal.id);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the chosen model is passed as a literal CLI argument for both personal launchers', async () => {
  const { launchCommand } = await import('../src/server/launcher.js');
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    provider: 'codex' as const,
    prompt: 'task',
    model: 'gpt-6-astra',
  };
  expect(launchCommand(input, 'syc')).toBe(
    "syc --model 'gpt-6-astra' '<!-- pixel-office-launch:25ff09ab-e861-44cd-9d3a-b5408f853db3 -->\ntask'",
  );
  expect(launchCommand({ ...input, provider: 'claude', model: 'opus[1m]' }, 'sy')).toBe(
    `sy --session-id ${input.id} --model 'opus[1m]' 'task'`,
  );
});
