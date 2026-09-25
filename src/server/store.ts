import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  terminal,
  type Run,
  type ChatMessage,
  type ProjectSummary,
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
  db.exec(`CREATE TABLE IF NOT EXISTS projects(root TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS runs_project ON runs(json_extract(data, '$.projectPath'));`);
  db.exec(`CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS chat_session ON chat_messages(session_id);`);
  const getRun = (id: string) => {
    const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Run) : undefined;
  };
  const listRuns = (projectPath?: string) => {
    const rows =
      projectPath === undefined
        ? db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 100').all()
        : db
            .prepare(
              "SELECT data FROM runs WHERE json_extract(data, '$.projectPath')=? ORDER BY rowid DESC LIMIT 100",
            )
            .all(projectPath);
    return (rows as { data: string }[]).map((r) => JSON.parse(r.data) as Run);
  };
  const listProjects = (): ProjectSummary[] => {
    const rows = db
      .prepare(
        `WITH grouped AS (
      SELECT json_extract(data, '$.projectPath') AS root, COUNT(*) AS runCount, MAX(rowid) AS latest
      FROM runs GROUP BY json_extract(data, '$.projectPath')
    ), roots AS (SELECT root FROM projects UNION SELECT root FROM grouped)
    SELECT roots.root, COALESCE(grouped.runCount, 0) AS runCount, runs.data
    FROM roots LEFT JOIN grouped ON grouped.root=roots.root
    LEFT JOIN runs ON runs.rowid=grouped.latest
    ORDER BY grouped.latest DESC, roots.root`,
      )
      .all() as { root: string; runCount: number; data: string | null }[];
    return rows.map(({ root, runCount, data }) => ({
      root,
      runCount,
      latestRun: data ? (JSON.parse(data) as Run) : null,
    }));
  };
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
    listProjects,
    saveChat(message: ChatMessage) {
      db.prepare(
        'INSERT INTO chat_messages(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      ).run(message.id, message.sessionId, JSON.stringify(message));
    },
    listChat(sessionId: string): ChatMessage[] {
      return (
        db
          .prepare(
            'SELECT data FROM chat_messages WHERE session_id=? ORDER BY rowid DESC LIMIT 100',
          )
          .all(sessionId) as { data: string }[]
      )
        .reverse()
        .map((row) => JSON.parse(row.data));
    },
    interruptChat() {
      db.prepare(
        `UPDATE chat_messages SET data=json_set(data, '$.status', 'failed', '$.error', '서버가 재시작되어 답변이 중단되었습니다. 다시 질문해주세요.') WHERE json_extract(data, '$.status')='pending'`,
      ).run();
    },
    rememberProject(root: string) {
      db.prepare('INSERT OR IGNORE INTO projects(root) VALUES(?)').run(root);
    },
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
