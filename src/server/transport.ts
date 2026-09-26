import Fastify from 'fastify';
import { createWorkspaceReader } from './workspace.js';
import { createTerminals } from './terminals.js';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  startSchema,
  answerSchema,
  type Adapter,
  type Provider,
  type HarnessCatalog,
  type ProjectSummary,
  type OfficeEvent,
} from '../shared/contracts.js';
import type { Store } from './store.js';
import type { Orchestrator } from './orchestrator.js';
import { inspectProject, collectChanges } from './projects.js';
import { listModels } from './models.js';
import { harnessCatalog } from './harness.js';
import type { QuestionDesk } from './questions.js';
import { hookStatus, installHook, uninstallHook } from './hook-install.js';
import type { ChatService } from './chat.js';
import type { Observation } from './observation/observer.js';
import { resumeCommand, resumeFolder, ResumeConflict, type AgentCommands } from './resume.js';
export async function createServer({
  store,
  adapters,
  orchestrator,
  token,
  port,
  demo = false,
  terminalShell,
  observation,
  chat,
  agentCommands,
  harnessCatalog: injectedCatalog,
  questions,
  hookToken,
  hookSetup,
}: {
  store: Store;
  adapters: Record<Provider, Adapter>;
  orchestrator: Orchestrator;
  token: string;
  port: number;
  demo?: boolean;
  terminalShell?: string;
  observation?: Observation;
  chat?: ChatService;
  agentCommands?: AgentCommands;
  harnessCatalog?: () => Promise<HarnessCatalog>;
  // Terminal Claude questions arriving through the AskUserQuestion hook.
  questions?: QuestionDesk;
  hookToken?: string;
  hookSetup?: { claudeHome: string; command: string };
}) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  const terminals = createTerminals({ shell: terminalShell });
  const sessionLocks = new Map<string, Promise<void>>();
  const withSession = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const previous = sessionLocks.get(id);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionLocks.set(id, pending);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (sessionLocks.get(id) === pending) sessionLocks.delete(id);
    }
  };
  const visibleSessions = () => {
    const retired = new Set(store.listRetired().map((s) => s.id));
    return (observation?.list().sessions ?? []).filter((s) => !retired.has(s.id));
  };
  // Rooms merged by hand: what the map and office show. File access keeps the real roots.
  const roomSessions = () => {
    const aliases = store.roomAliases();
    return visibleSessions().map((s) => {
      const room = store.resolveRoom(s.projectPath, aliases);
      return room === s.projectPath ? s : { ...s, projectPath: room };
    });
  };
  const workspace = createWorkspaceReader(() => [
    ...store.listProjects().map((p) => p.root),
    ...(observation?.list().sessions ?? []).map((s) => s.projectPath),
    ...store.listRuns().map((r) => r.worktreePath),
  ]);
  const workspaceQuery = z.object({
    root: z.string().min(1),
    path: z.string().max(4096).default(''),
  });
  const session = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const same = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const trusted = (req: IncomingMessage) =>
    req.headers.host === `127.0.0.1:${port}` &&
    (!req.headers.origin || req.headers.origin === origin);
  const authed = (req: IncomingMessage) => {
    const cookie =
      req.headers.cookie
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('pixel_session='))
        ?.slice(14) ?? '';
    return same(cookie, session);
  };
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // The hook is a local process, not a browser: it proves itself with its own token.
    if (req.url.startsWith('/api/hook/')) {
      const token = String(req.headers['x-pixel-hook'] ?? '');
      if (!trusted(req.raw) || !hookToken || !same(token, hookToken))
        reply.code(403).send({ error: '허용되지 않은 요청입니다.' });
      return;
    }
    if (!trusted(req.raw) || (req.method !== 'GET' && req.headers.origin !== origin)) {
      reply.code(403).send({ error: '허용되지 않은 출처입니다.' });
      return;
    }
    if (req.url !== '/api/session' && !authed(req.raw))
      reply.code(401).send({ error: '연결 URL로 앱을 다시 열어 주세요.' });
  });
  app.setErrorHandler((err, req, reply) => {
    reply
      .code(err instanceof z.ZodError ? 400 : 400)
      .send({ error: err instanceof Error ? err.message : '요청을 처리할 수 없습니다.' });
  });
  app.post('/api/session', async (req, reply) => {
    const body = z.object({ token: z.string() }).parse(req.body);
    if (!same(body.token, token))
      return reply.code(401).send({ error: '연결 토큰이 올바르지 않습니다.' });
    reply.header('set-cookie', `pixel_session=${session}; Path=/; HttpOnly; SameSite=Strict`);
    return { ok: true };
  });
  app.get('/api/workspace/tree', async (req) => {
    const { root, path } = workspaceQuery.parse(req.query);
    return workspace.list(root, path);
  });
  app.get('/api/workspace/file', async (req) => {
    const { root, path } = workspaceQuery.parse(req.query);
    return workspace.read(root, path);
  });
  app.post('/api/terminals', async (req) => {
    const { root, cols, rows } = z
      .object({
        root: z.string().min(1),
        cols: z.number().int().min(20).max(300).default(80),
        rows: z.number().int().min(5).max(100).default(24),
      })
      .parse(req.body);
    return terminals.create(await workspace.authorize(root), cols, rows);
  });
  app.get<{ Params: { id: string } }>('/api/terminals/:id', async (req, reply) => {
    return (
      terminals.get(req.params.id) ??
      reply.code(404).send({ error: '종료된 터미널입니다. 새 터미널을 열어 주세요.' })
    );
  });
  app.post<{ Params: { id: string } }>('/api/terminals/:id/close', async (req) => {
    await terminals.end(req.params.id);
    return { ok: true };
  });
  // Resuming runs the provider CLI in the app's PTY; the observed id tags the terminal.
  app.get<{ Params: { id: string } }>('/api/observed/:id/terminal', async (req, reply) => {
    return (
      terminals.find(req.params.id) ??
      reply.code(404).send({ error: '이어서 작업 중인 터미널이 없습니다.' })
    );
  });
  app.post<{ Params: { id: string } }>('/api/observed/:id/resume', async (req, reply) => {
    const { mode, cols, rows } = z
      .object({
        mode: z.enum(['resume', 'fork']),
        cols: z.number().int().min(20).max(300).default(80),
        rows: z.number().int().min(5).max(100).default(24),
      })
      .parse(req.body);
    return withSession(req.params.id, async () => {
      const session = observation?.get(req.params.id);
      if (!session) return reply.code(404).send({ error: '관측 중인 세션을 찾을 수 없습니다.' });
      if (store.isRetired(session.id))
        return reply.code(409).send({ error: '퇴근한 동료입니다. 먼저 다시 출근시켜 주세요.' });
      const existing = terminals.find(session.id);
      if (existing) return existing;
      try {
        const command = resumeCommand(session, mode, agentCommands);
        return terminals.create(await resumeFolder(session), cols, rows, {
          command,
          tag: session.id,
          persistent: true,
        });
      } catch (e) {
        return reply
          .code(e instanceof ResumeConflict ? 409 : 400)
          .send({ error: (e as Error).message });
      }
    });
  });
  app.post<{ Params: { id: string } }>('/api/observed/:id/retire', async (req, reply) =>
    withSession(req.params.id, async () => {
      const session = observation?.get(req.params.id);
      if (!session) return reply.code(404).send({ error: '관측 중인 세션을 찾을 수 없습니다.' });
      store.retire(session);
      chat?.cancel(session.id);
      const terminal = terminals.find(session.id);
      if (terminal) await terminals.end(terminal.id);
      return { ok: true };
    }),
  );
  app.post<{ Params: { id: string } }>('/api/observed/:id/restore', async (req, reply) =>
    withSession(req.params.id, async () => {
      if (!observation?.get(req.params.id))
        return reply.code(409).send({
          error:
            '원본 세션 로그를 현재 찾을 수 없습니다. 원래 CLI에서 세션을 열면 다시 감지됩니다.',
        });
      store.restore(req.params.id);
      return { ok: true };
    }),
  );
  app.get('/api/health', async () => ({
    providers: { codex: await adapters.codex.probe(), claude: await adapters.claude.probe() },
    demo,
    activeId: orchestrator.activeId ?? null,
  }));
  app.post('/api/projects/inspect', async (req) => {
    const project = await inspectProject(z.object({ path: z.string() }).parse(req.body).path);
    store.rememberProject(project.root);
    return project;
  });
  app.get('/api/observed', async () => {
    const snapshot = observation?.list() ?? {
      sessions: [],
      scannedAt: null,
      scanning: false,
      warnings: [],
    };
    const live = new Map(snapshot.sessions.map((s) => [s.id, s]));
    return {
      ...snapshot,
      sessions: roomSessions(),
      retired: store
        .listRetired()
        .map((s) => ({ ...s, ...live.get(s.id), available: live.has(s.id) })),
    };
  });
  app.get<{ Params: { id: string } }>('/api/observed/:id', async (req, reply) => {
    const session = observation?.get(req.params.id);
    return session ?? reply.code(404).send({ error: '관측 중인 세션을 찾을 수 없습니다.' });
  });
  app.get<{ Params: { id: string } }>('/api/observed/:id/chat', async (req, reply) => {
    if (!chat) return reply.code(503).send({ error: '채팅 서비스를 사용할 수 없습니다.' });
    return { mode: 'records', directAvailable: false, messages: chat.list(req.params.id) };
  });
  app.post<{ Params: { id: string } }>('/api/observed/:id/chat', async (req, reply) => {
    if (!chat) return reply.code(503).send({ error: '채팅 서비스를 사용할 수 없습니다.' });
    const { question } = z.object({ question: z.string().trim().min(1).max(4000) }).parse(req.body);
    if (!observation?.get(req.params.id))
      return reply.code(404).send({ error: '관측 중인 세션을 찾을 수 없습니다.' });
    try {
      return reply.code(202).send({
        mode: 'records',
        directAvailable: false,
        messages: chat.ask(req.params.id, question),
      });
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string } }>('/api/observed/:id/chat/cancel', async (req) => {
    chat?.cancel(req.params.id);
    return { ok: true };
  });
  app.get('/api/projects', async () => {
    const aliases = store.roomAliases();
    const projects = new Map<string, ProjectSummary>(
      store
        .listProjects()
        .filter((p) => !aliases.has(p.root))
        .map((p) => [p.root, { ...p, connected: true }]),
    );
    // Script- and hook-started sessions never make a folder a project (e.g. smoke-test repos).
    for (const session of roomSessions().filter((s) => !s.automated)) {
      const p = projects.get(session.projectPath) ?? {
        root: session.projectPath,
        runCount: 0,
        latestRun: null,
      };
      p.observedCount = (p.observedCount ?? 0) + 1;
      p.observedActive = (p.observedActive ?? 0) + (session.status === 'active' ? 1 : 0);
      projects.set(p.root, p);
    }
    return [...projects.values()];
  });
  app.get<{ Querystring: { projectPath?: string } }>('/api/runs', async (req) => {
    const { projectPath } = z
      .object({ projectPath: z.string().min(1).optional() })
      .parse(req.query);
    return store.listRuns(projectPath);
  });
  // Listing spawns the Codex app server, so a panel reopened within a minute reuses the answer.
  let catalogCache: { at: number; value: Promise<HarnessCatalog> } | undefined;
  // Demo mode never reads this machine's plugins unless a catalog is handed in (tests).
  const loadHarnessCatalog =
    injectedCatalog ??
    (demo
      ? async (): Promise<HarnessCatalog> => ({
          claude: { plugins: [], skills: [] },
          codex: { plugins: [], skills: [] },
        })
      : harnessCatalog);
  app.get('/api/harness/catalog', async () => {
    if (!catalogCache || Date.now() - catalogCache.at > 60000)
      catalogCache = { at: Date.now(), value: loadHarnessCatalog() };
    return catalogCache.value;
  });
  app.get<{ Querystring: { root?: string } }>('/api/harness', async (req) =>
    store.getHarness(z.string().min(1).parse(req.query.root)),
  );
  app.post('/api/harness', async (req) => {
    const choice = z
      .object({
        plugins: z.array(z.string().max(300)).max(200),
        skills: z.array(z.string().max(300)).max(500),
        projectDoc: z.boolean(),
      })
      .strict();
    const body = z
      .object({ root: z.string(), harness: z.object({ claude: choice, codex: choice }).strict() })
      .parse(req.body);
    // Only a real repository gets settings, stored under its canonical root.
    const project = await inspectProject(body.root);
    store.setHarness(project.root, body.harness);
    return store.getHarness(project.root);
  });
  const desk = () => {
    if (!questions) throw new Error('질문 연결을 쓸 수 없어요.');
    return questions;
  };
  app.post('/api/hook/questions', async (req) => {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        sessionId: z.string().max(200),
        cwd: z.string().max(4096),
        questions: z.array(z.unknown()).min(1).max(10),
      })
      .parse(req.body);
    return { id: desk().ask(body).id };
  });
  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(
    '/api/hook/questions/:id',
    async (req) =>
      desk().wait(
        z.string().uuid().parse(req.params.id),
        Math.min(25000, Math.max(0, Number(req.query.wait ?? 0) || 0)),
      ),
  );
  app.post<{ Params: { id: string } }>('/api/hook/questions/:id/release', async (req) => {
    desk().release(z.string().uuid().parse(req.params.id));
    return { ok: true };
  });
  app.get('/api/questions', async () => (questions ? questions.list() : []));
  app.post<{ Params: { id: string } }>('/api/questions/:id/answer', async (req) => {
    const { answers } = z
      .object({ answers: z.record(z.string(), z.array(z.string().max(10000)).min(1)) })
      .parse(req.body);
    desk().answer(z.string().uuid().parse(req.params.id), answers);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/questions/:id/release', async (req) => {
    desk().release(z.string().uuid().parse(req.params.id));
    return { ok: true };
  });
  app.get('/api/terminal-hook', async () =>
    hookSetup
      ? { available: true, ...(await hookStatus(hookSetup.claudeHome)) }
      : { available: false },
  );
  app.post('/api/terminal-hook/install', async () => {
    if (!hookSetup) throw new Error('질문 연결을 쓸 수 없어요.');
    await installHook(hookSetup.claudeHome, hookSetup.command);
    return hookStatus(hookSetup.claudeHome);
  });
  app.post('/api/terminal-hook/uninstall', async () => {
    if (!hookSetup) throw new Error('질문 연결을 쓸 수 없어요.');
    await uninstallHook(hookSetup.claudeHome);
    return hookStatus(hookSetup.claudeHome);
  });
  app.get('/api/departments', async () => store.listDepartments());
  app.post('/api/departments', async (req) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(40), root: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    if (!isAbsolute(body.root)) throw new Error('부서 폴더는 절대 경로여야 해요.');
    // Stored as the real path so it matches room roots, which are canonical.
    const root = await realpath(body.root).catch(() => resolve(body.root));
    if (store.listDepartments().some((d) => d.root === root))
      throw new Error('이 폴더는 이미 다른 부서예요.');
    return store.addDepartment(body.name, root);
  });
  app.delete<{ Params: { id: string } }>('/api/departments/:id', async (req) => {
    store.removeDepartment(z.string().uuid().parse(req.params.id));
    return { ok: true };
  });
  app.get('/api/rooms/aliases', async () =>
    [...store.roomAliases()].map(([source, target]) => ({ source, target })),
  );
  app.post('/api/rooms/merge', async (req) => {
    const { source, target } = z
      .object({ source: z.string().min(1).max(4096), target: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    store.mergeRoom(source, target);
    return { source, target };
  });
  app.post('/api/rooms/split', async (req) => {
    const { source } = z
      .object({ source: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    store.splitRoom(source);
    return { source };
  });
  app.get<{ Params: { provider: string } }>('/api/models/:provider', async (req) => {
    const provider = z.enum(['codex', 'claude']).parse(req.params.provider);
    return demo ? { models: [] } : listModels(provider);
  });
  app.post('/api/runs', async (req, reply) => {
    try {
      return await orchestrator.start(startSchema.parse(req.body));
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: '실행 기록이 없습니다.' });
    const events = store.recentEvents(run.id);
    return {
      run,
      events,
      interactions: store.pending(run.id),
      sequence: events.at(-1)?.sequence ?? 0,
    };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/runs/:id/events',
    async (req, reply) => {
      if (!store.getRun(req.params.id))
        return reply.code(404).send({ error: '실행 기록이 없습니다.' });
      const after = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(req.query.after ?? 0);
      return store.events(req.params.id, after, 200);
    },
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id/changes', async (req, reply) => {
    const run = store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: '실행 기록이 없습니다.' });
    return collectChanges(run.worktreePath, run.baseCommit);
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) => {
    await orchestrator.cancel(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/interactions/:id/answer', async (req, reply) => {
    try {
      await orchestrator.answer(req.params.id, answerSchema.parse(req.body));
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname !== '/api/events' && url.pathname !== '/api/terminal') return;
    if (!trusted(req) || req.headers.origin !== origin || !authed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname === '/api/terminal') {
      const id = url.searchParams.get('id') ?? '';
      if (!terminals.get(id)) {
        socket.destroy();
        return;
      }
      terminalSockets.handleUpgrade(req, socket, head, (ws) => terminals.attach(id, ws));
      return;
    }
    const runId = url.searchParams.get('runId') ?? '';
    const after = Number(url.searchParams.get('after') ?? 0);
    if (!store.getRun(runId) || !Number.isSafeInteger(after) || after < 0) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let cursor = after;
      const send = (e: OfficeEvent) => {
        if (e.runId !== runId || e.sequence <= cursor) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 2 * 1024 * 1024) {
          ws.close(1013, 'reconnect');
          return;
        }
        ws.send(JSON.stringify(e));
        cursor = e.sequence;
      };
      const replay = () => {
        let page;
        do {
          page = store.events(runId, cursor, 500);
          for (const e of page) send(e);
        } while (page.length === 500 && ws.readyState === WebSocket.OPEN);
      };
      // Synchronous replay and subscription share the JS event loop, with no gap.
      replay();
      store.bus.on('event', send);
      ws.on('close', () => store.bus.off('event', send));
      ws.on('error', () => ws.close());
    });
  });
  app.addHook('onClose', async () => {
    await terminals.close();
    for (const client of terminalSockets.clients) client.terminate();
    terminalSockets.close();
    await chat?.close();
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return { app, origin };
}
