import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api, ApiError } from '../api';
import type { TerminalInfo, TerminalMessage } from '../../shared/workspace';

type Open = () => Promise<TerminalInfo>;
export function TerminalPane({
  root,
  storageKey = `pixel.terminal:${root}`,
  recover,
  idle,
  label = '레포 터미널',
  footer = '레포별 터미널 · 연결이 끊기면 5분 후 종료됩니다.',
}: {
  root: string;
  storageKey?: string;
  /** Finds a terminal the server still runs when this browser has no stored id. */
  recover?: () => Promise<TerminalInfo | null>;
  /** Replaces the start screen; `start` opens a terminal with the given request. */
  idle?: (start: (open: Open) => void, pending: boolean) => ReactNode;
  label?: string;
  footer?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [status, setStatus] = useState('터미널을 열면 이 폴더에서 시작합니다.');
  const [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const id = sessionStorage.getItem(storageKey);
    const restore = async () => {
      if (id)
        try {
          const value = await api<TerminalInfo>(`/terminals/${id}`);
          if (value.root === root || (recover && storageKey === `pixel.resume:${value.tag}`)) {
            if (!cancelled) setInfo(value);
            return;
          }
          sessionStorage.removeItem(storageKey);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
          sessionStorage.removeItem(storageKey);
        }
      const found = await recover?.();
      if (found && !cancelled) {
        sessionStorage.setItem(storageKey, found.id);
        setInfo(found);
      }
    };
    restore().catch((e) => {
      if (!cancelled) setError((e as Error).message);
    });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [root, storageKey]);
  useEffect(() => {
    if (!info || !container.current) return;
    let alive = true;
    let exited = false;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Consolas, monospace',
      scrollback: 3000,
      screenReaderMode: true,
      theme: { background: '#202725', foreground: '#edf0e8', cursor: '#c5d6ab' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    term.textarea?.setAttribute('aria-label', '터미널 입력');
    term.textarea?.setAttribute('data-testid', 'terminal-input');
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal?id=${info.id}`,
    );
    socket.current = ws;
    setStatus('터미널 연결 중');
    setConnected(false);
    const resize = () => {
      if (!alive || !container.current?.clientWidth || !container.current?.clientHeight) return;
      fit.fit();
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: Math.max(20, Math.min(300, term.cols)),
            rows: Math.max(5, Math.min(100, term.rows)),
          }),
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });
    ws.onmessage = (event) => {
      if (!alive) return;
      const message = JSON.parse(event.data) as TerminalMessage;
      if (message.type === 'ready') {
        term.reset();
        term.write(message.data);
        setStatus(`${info.command ?? info.shell} · 연결됨`);
        setConnected(true);
        setError('');
        resize();
        term.focus();
      } else if (message.type === 'output') term.write(message.data);
      else if (message.type === 'exit') {
        setConnected(false);
        setStatus(`터미널 종료 · ${message.code}`);
        sessionStorage.removeItem(storageKey);
        setInfo(null);
      } else setError(message.message);
    };
    ws.onerror = () => {
      if (alive) setError('터미널 연결을 확인해 주세요.');
    };
    ws.onclose = () => {
      if (alive && !exited) {
        setConnected(false);
        setStatus('연결 끊김 · 다시 연결할 수 있어요.');
      }
    };
    return () => {
      alive = false;
      observer.disconnect();
      input.dispose();
      socket.current = null;
      ws.close();
      term.dispose();
    };
  }, [info, attempt, storageKey]);
  const start = async (open: Open) => {
    const current = generation.current;
    setPending(true);
    setError('');
    try {
      const next = await open();
      if (generation.current !== current) {
        if (!next.persistent) await api(`/terminals/${next.id}/close`, {});
        return;
      }
      sessionStorage.setItem(storageKey, next.id);
      setInfo(next);
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally {
      if (generation.current === current) setPending(false);
    }
  };
  const reconnect = async () => {
    setError('');
    try {
      await api(`/terminals/${info!.id}`);
      setAttempt((n) => n + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        sessionStorage.removeItem(storageKey);
        setInfo(null);
      }
      setError((e as Error).message);
    }
  };
  const close = async () => {
    try {
      await api(`/terminals/${info!.id}/close`, {});
      sessionStorage.removeItem(storageKey);
      setInfo(null);
      setConnected(false);
      setStatus('터미널을 종료했습니다.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="terminal-pane" aria-label={label}>
      <div className="terminal-toolbar">
        <span role="status">{status}</span>
        <div>
          {connected && (
            <button
              onClick={() =>
                socket.current?.send(JSON.stringify({ type: 'input', data: '\u0003' }))
              }
            >
              <Square size={13} />
              Ctrl+C
            </button>
          )}
          {info && !connected && (
            <button onClick={() => void reconnect()}>
              <RefreshCw size={13} />
              다시 연결
            </button>
          )}
          {info && (
            <button onClick={() => void close()}>
              <Trash2 size={13} />
              터미널 종료
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      {info ? (
        <div ref={container} className="terminal-screen" />
      ) : idle ? (
        idle((open) => void start(open), pending)
      ) : (
        <div className="terminal-empty">
          <p>이 레포에서 명령을 실행하세요.</p>
          <code>{root}</code>
          <button
            className="primary"
            disabled={pending}
            onClick={() =>
              void start(() => api<TerminalInfo>('/terminals', { root, cols: 80, rows: 24 }))
            }
          >
            <Play size={15} />
            {pending ? '여는 중…' : '터미널 시작'}
          </button>
          <small>내 컴퓨터의 셸입니다. 명령은 실제 파일을 변경할 수 있어요.</small>
        </div>
      )}
      <footer>{footer}</footer>
    </section>
  );
}
