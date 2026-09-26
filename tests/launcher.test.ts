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

test('launch command selects personal or standard entrypoint without shell interpolation', async () => {
  const { launchCommand } = await import('../src/server/launcher.js');
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    provider: 'codex' as const,
    harness: 'personal' as const,
    prompt: 'task',
  };
  expect(launchCommand(input)).toBe("syc 'task'");
  expect(launchCommand({ ...input, harness: 'standard' })).toBe("codex 'task'");
  expect(launchCommand({ ...input, provider: 'claude' })).toBe(
    `sy --session-id ${input.id} 'task'`,
  );
  expect(() => launchCommand({ ...input, id: 'bad;id' })).toThrow();
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
    launchCommands: { claude: 'echo sy', codex: 'echo syc' },
  });
  const input = {
    id: '25ff09ab-e861-44cd-9d3a-b5408f853db3',
    root,
    provider: 'codex',
    harness: 'personal',
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
    const created = await post(input);
    expect(created.statusCode).toBe(201);
    expect(created.json().terminal.command).toBe("echo syc 'test'");
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
