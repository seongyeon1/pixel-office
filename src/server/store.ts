import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  terminal,
  type Run,
  type RunStatus,
  type EventInput,
  type OfficeEvent,
  type Interaction,
} from '../shared/contracts.js';
export function createStore(path: string) {
  const db = new DatabaseSync(path);
  const bus = new EventEmitter();
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, run_id TEXT, data TEXT); CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence); CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, run_id TEXT, resolved INTEGER DEFAULT 0, data TEXT);`,
  );
  const getRun = (id: string) => {
    const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Run) : undefined;
  };
  const listRuns = () =>
    (
      db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 100').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Run);
  const updateRun = (id: string, patch: Partial<Run>) => {
    const run = getRun(id);
    if (!run) throw new Error('실행을 찾을 수 없습니다.');
    const updated = { ...run, ...patch, id };
    db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  };
  const append = (input: EventInput): OfficeEvent => {
    const event = { ...input, eventId: randomUUID(), timestamp: new Date().toISOString() };
    const row = db
      .prepare('INSERT INTO events(id,run_id,data) VALUES(?,?,?)')
      .run(event.eventId, input.runId, JSON.stringify(event));
    const complete = { ...event, sequence: Number(row.lastInsertRowid) };
    bus.emit('event', complete);
    return complete;
  };
  return {
    bus,
    getRun,
    listRuns,
    updateRun,
    createRun(run: Run) {
      db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run(run.id, JSON.stringify(run));
    },
    append,
    events(runId: string, after = 0, limit = 1000): OfficeEvent[] {
      return (
        db
          .prepare(
            'SELECT sequence,data FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
          )
          .all(runId, after, limit) as { sequence: number; data: string }[]
      ).map((r) => ({ ...JSON.parse(r.data), sequence: r.sequence }));
    },
    recentEvents(runId: string, limit = 300): OfficeEvent[] {
      return (
        db
          .prepare('SELECT sequence,data FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT ?')
          .all(runId, limit) as { sequence: number; data: string }[]
      )
        .reverse()
        .map((r) => ({ ...JSON.parse(r.data), sequence: r.sequence }));
    },
    setStatus(id: string, status: RunStatus) {
      updateRun(id, { status });
      append({ runId: id, agentId: null, type: 'run.status', payload: { status } });
    },
    saveInteraction(request: Interaction) {
      db.prepare('INSERT INTO interactions(id,run_id,resolved,data) VALUES(?,?,0,?)').run(
        request.id,
        request.runId,
        JSON.stringify(request),
      );
    },
    getInteraction(id: string): Interaction | undefined {
      const r = db.prepare('SELECT data,resolved FROM interactions WHERE id=?').get(id) as
        { data: string; resolved: number } | undefined;
      return r ? { ...JSON.parse(r.data), resolved: !!r.resolved } : undefined;
    },
    pending(runId: string): Interaction[] {
      return (
        db.prepare('SELECT data FROM interactions WHERE run_id=? AND resolved=0').all(runId) as {
          data: string;
        }[]
      ).map((r) => JSON.parse(r.data));
    },
    resolveInteraction(id: string) {
      return (
        Number(
          db.prepare('UPDATE interactions SET resolved=1 WHERE id=? AND resolved=0').run(id)
            .changes,
        ) === 1
      );
    },
    interruptActive() {
      let count = 0;
      for (const run of listRuns()) {
        if (!terminal(run.status)) {
          updateRun(run.id, {
            status: 'interrupted',
            error: '서버가 재시작되어 실행이 종료되었습니다. 작업 파일은 보존되었습니다.',
          });
          db.prepare('UPDATE interactions SET resolved=1 WHERE run_id=?').run(run.id);
          append({
            runId: run.id,
            agentId: null,
            type: 'run.status',
            payload: { status: 'interrupted' },
          });
          count++;
        }
      }
      return count;
    },
    close() {
      bus.removeAllListeners();
      db.close();
    },
  };
}
export type Store = ReturnType<typeof createStore>;
