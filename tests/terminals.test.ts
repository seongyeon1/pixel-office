import { expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createTerminals } from '../src/server/terminals.js';
import type { AddressInfo } from 'node:net';

test('real PTY accepts input, keeps cwd across reconnect, resizes, interrupts and exits', async () => {
  const manager = createTerminals({ shell: '/bin/sh', detachedMs: 5000 });
  const root = await realpath(tmpdir());
  const session = manager.create(root, 80, 24);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (ws) => manager.attach(session.id, ws));
  let ws: WebSocket | undefined;
  let output = '';
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    socket.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.data) output += m.data;
    });
    await once(socket, 'open');
    return socket;
  };
  const input = (data: string) => ws!.send(JSON.stringify({ type: 'input', data }));
  try {
    ws = await connect();
    input(`printf 'ROOT:%s\\n' "$PWD"\r`);
    await expect.poll(() => output).toContain(`ROOT:${root}`);
    input(`read answer; printf 'ANSWER:%s\\n' "$answer"\r`);
    input('interactive-value\r');
    await expect.poll(() => output).toContain('ANSWER:interactive-value');
    ws.send(JSON.stringify({ type: 'resize', cols: 95, rows: 31 }));
    input('stty size\r');
    await expect.poll(() => output).toContain('31 95');
    input('cd /; printf \'MOVED:%s\\n\' "$PWD"\r');
    await expect.poll(() => output).toContain('MOVED:/');
    ws.close();
    await once(ws, 'close');
    output = '';
    ws = await connect();
    await expect.poll(() => output).toContain('ANSWER:interactive-value');
    input('printf \'STILL:%s\\n\' "$PWD"\r');
    await expect.poll(() => output).toContain('STILL:/');
    input('sleep 30\r');
    // Let the foreground process take the PTY before delivering the interrupt.
    await new Promise((r) => setTimeout(r, 150));
    input('\u0003');
    input("printf '%s%s\\n' RESUMED _OK\r");
    await expect.poll(() => output, { timeout: 3000 }).toContain('RESUMED_OK');
    const closed = once(ws, 'close');
    input('exit\r');
    await closed;
    expect(manager.get(session.id)).toBeUndefined();
  } finally {
    ws?.terminate();
    await manager.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('detached sessions expire and explicit close removes the shell', async () => {
  const manager = createTerminals({ shell: '/bin/sh', detachedMs: 100 });
  try {
    const a = manager.create(await realpath(tmpdir()), 80, 24);
    const b = manager.create(await realpath(tmpdir()), 80, 24);
    await manager.end(a.id);
    expect(manager.get(a.id)).toBeUndefined();
    await expect.poll(() => manager.get(b.id), { timeout: 2000 }).toBeUndefined();
  } finally {
    await manager.close();
  }
});

test('closing the service terminates a shell that ignores hangup', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pixel-pty-shutdown-')));
  const shell = join(root, 'stubborn-shell');
  await writeFile(
    shell,
    '#!/bin/sh\ntrap "" HUP\nprintf "%s" "$$" > shell.pid\nwhile :; do sleep 1; done\n',
    { mode: 0o700 },
  );
  const manager = createTerminals({ shell });
  let pid = 0;
  try {
    manager.create(root, 80, 24);
    await expect
      .poll(async () => {
        try {
          pid = Number(await readFile(join(root, 'shell.pid'), 'utf8'));
          return pid > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await manager.close();
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    await manager.close();
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});
