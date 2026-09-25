import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
export class RpcClient extends EventEmitter {
  private id = 0;
  private buffer = '';
  private dead = false;
  private stderr = '';
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 8 * 1024 * 1024) {
        this.fail(new Error('공급자 메시지 크기 초과'));
        void this.close();
        return;
      }
      let n;
      while ((n = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, n);
        this.buffer = this.buffer.slice(n + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined && !m.method) {
            const p = this.pending.get(m.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(m.id);
              m.error
                ? p.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
                : p.resolve(m.result);
            }
          } else this.emit('message', m);
        } catch {
          this.emit('diagnostic', line.slice(0, 1000));
        }
      }
    });
    child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    child.on('error', (e) => this.fail(e));
    child.on('close', (code) => {
      this.dead = true;
      this.fail(new Error(`Codex 프로세스 종료 (${code}) ${this.stderr.slice(-1000)}`));
    });
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.dead) return Promise.reject(new Error('Codex 연결이 종료되었습니다.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 응답 시간 초과: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        }
      });
    });
  }
  notify(method: string, params?: unknown) {
    if (!this.dead)
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  respond(id: string | number, result: unknown) {
    if (!this.dead) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.emit('failure', e);
  }
  async close() {
    if (this.dead) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
      }, 1500);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}
