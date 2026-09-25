import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { TerminalInfo, TerminalMessage } from '../shared/workspace.js';

const input = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(32768) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(100),
  }),
]);
interface Session {
  info: TerminalInfo;
  pty: IPty;
  buffer: string;
  sockets: Set<WebSocket>;
  done: Promise<void>;
  exited: boolean;
  timer?: ReturnType<typeof setTimeout>;
  persistent: boolean;
}
interface CreateOptions {
  command?: string;
  tag?: string;
  persistent?: boolean;
}
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export function createTerminals({
  detachedMs = 5 * 60 * 1000,
  shell = process.env.SHELL || '/bin/sh',
} = {}) {
  const sessions = new Map<string, Session>();
  const closing = new Set<Promise<void>>();
  const send = (ws: WebSocket, message: TerminalMessage) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
      ws.close(1013, 'terminal output is too fast');
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const end = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearTimeout(s.timer);
    for (const ws of s.sockets) {
      send(ws, { type: 'exit', code: -1 });
      ws.close();
    }
    s.pty.kill('SIGHUP');
    // A custom shell may trap HUP; do not leave it behind after closing the app.
    const force = setTimeout(() => {
      if (!s.exited) s.pty.kill('SIGKILL');
    }, 500);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const termination = Promise.race([
      s.done,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 1500);
      }),
    ]);
    closing.add(termination);
    await termination;
    closing.delete(termination);
    clearTimeout(force);
    clearTimeout(deadline);
  };
  const expire = (s: Session) => {
    clearTimeout(s.timer);
    // An agent keeps working while nobody watches; only an explicit close or shutdown ends it.
    if (s.persistent) return;
    s.timer = setTimeout(() => void end(s.info.id), detachedMs);
    s.timer.unref();
  };
  return {
    create(
      root: string,
      cols: number,
      rows: number,
      { command, tag, persistent = false }: CreateOptions = {},
    ): TerminalInfo {
      if (sessions.size >= 8)
        throw new Error(
          '터미널은 최대 8개까지 열 수 있습니다. 사용하지 않는 터미널을 종료해 주세요.',
        );
      // An interactive shell loads the user's PATH and aliases, then stays open after the command.
      const args = command ? ['-i', '-c', `${command}; exec ${quote(shell)} -i`] : ['-i'];
      const pty = spawn(shell, args, {
        name: 'xterm-256color',
        cwd: root,
        cols,
        rows,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      const info: TerminalInfo = {
        id: randomUUID(),
        root,
        cols,
        rows,
        shell: basename(shell),
        ...(command && { command }),
        ...(persistent && { persistent }),
        ...(tag && { tag }),
      };
      let exited!: () => void;
      const done = new Promise<void>((resolve) => {
        exited = resolve;
      });
      const s: Session = {
        info,
        pty,
        buffer: '',
        sockets: new Set(),
        done,
        exited: false,
        persistent,
      };
      sessions.set(info.id, s);
      expire(s);
      pty.onData((data) => {
        s.buffer = (s.buffer + data).slice(-256 * 1024);
        for (const ws of s.sockets) send(ws, { type: 'output', data });
      });
      pty.onExit(({ exitCode }) => {
        s.exited = true;
        exited();
        clearTimeout(s.timer);
        sessions.delete(info.id);
        for (const ws of s.sockets) {
          send(ws, { type: 'exit', code: exitCode });
          ws.close();
        }
      });
      return info;
    },
    get(id: string) {
      return sessions.get(id)?.info;
    },
    find(tag: string) {
      return [...sessions.values()].find((s) => s.info.tag === tag)?.info;
    },
    attach(id: string, ws: WebSocket) {
      const s = sessions.get(id);
      if (!s) {
        ws.close(1008, 'terminal not found');
        return;
      }
      clearTimeout(s.timer);
      s.sockets.add(ws);
      send(ws, { type: 'ready', data: s.buffer });
      ws.on('message', (raw, binary) => {
        try {
          if (binary) throw new Error('invalid input');
          const message = input.parse(JSON.parse(raw.toString()));
          if (message.type === 'input') s.pty.write(message.data);
          else {
            s.pty.resize(message.cols, message.rows);
            s.info.cols = message.cols;
            s.info.rows = message.rows;
          }
        } catch {
          send(ws, { type: 'error', message: '터미널 입력을 처리할 수 없습니다.' });
        }
      });
      ws.on('close', () => {
        s.sockets.delete(ws);
        if (!s.sockets.size && sessions.has(id)) expire(s);
      });
      ws.on('error', () => ws.close());
    },
    end,
    async close() {
      await Promise.all([...sessions.keys()].map(end).concat([...closing]));
    },
  };
}
