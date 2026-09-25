import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import {
  startSchema,
  answerSchema,
  type Adapter,
  type Provider,
  type OfficeEvent,
} from '../shared/contracts.js';
import type { Store } from './store.js';
import type { Orchestrator } from './orchestrator.js';
import { inspectProject, collectChanges } from './projects.js';
import { listModels } from './models.js';
export async function createServer({
  store,
  adapters,
  orchestrator,
  token,
  port,
  demo = false,
}: {
  store: Store;
  adapters: Record<Provider, Adapter>;
  orchestrator: Orchestrator;
  token: string;
  port: number;
  demo?: boolean;
}) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
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
  app.get('/api/health', async () => ({
    providers: { codex: await adapters.codex.probe(), claude: await adapters.claude.probe() },
    demo,
    activeId: orchestrator.activeId ?? null,
  }));
  app.post('/api/projects/inspect', async (req) =>
    inspectProject(z.object({ path: z.string() }).parse(req.body).path),
  );
  app.get('/api/runs', async () => store.listRuns());
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
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname !== '/api/events') return;
    if (!trusted(req) || req.headers.origin !== origin || !authed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
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
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return { app, origin };
}
