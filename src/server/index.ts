import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createChatService } from './chat.js';
import { createNativeChatResponder } from './adapters/chat.js';
import { createStore } from './store.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createClaudeAdapter } from './adapters/claude.js';
import { createOrchestrator } from './orchestrator.js';
import { createServer } from './transport.js';
import { createObservation } from './observation/observer.js';
const dataDir = resolve(process.env.PIXEL_DATA_DIR ?? '.pixel');
await mkdir(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 4317);
const token = randomBytes(24).toString('hex');
const store = createStore(resolve(dataDir, 'office.sqlite'));
store.interruptActive();
const adapters = { codex: createCodexAdapter(), claude: createClaudeAdapter() };
const orchestrator = createOrchestrator({ store, adapters, dataDir });
const observation = createObservation({
  excludeRoots: [resolve(dataDir, 'workspaces'), resolve(dataDir, 'chat')],
});
observation.start();
const chat = createChatService({
  store,
  getSession: observation.get,
  respond: createNativeChatResponder(resolve(dataDir, 'chat')),
});
const { app, origin } = await createServer({
  store,
  adapters,
  orchestrator,
  token,
  port,
  observation,
  chat,
});
const production = process.argv[1]?.endsWith('.js');
if (production) {
  const { default: staticPlugin } = await import('@fastify/static');
  await app.register(staticPlugin, { root: resolve('dist/client') });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ error: '요청 경로가 없습니다.' })
      : reply.sendFile('index.html'),
  );
} else {
  const { createServer: createVite } = await import('vite');
  const { default: middie } = await import('@fastify/middie');
  await app.register(middie);
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server: app.server } },
    appType: 'spa',
  });
  app.use((req, res, next) =>
    req.url?.startsWith('/api/') ? next() : vite.middlewares(req, res, next),
  );
  app.addHook('onClose', async () => vite.close());
}
await app.listen({ host: '127.0.0.1', port });
const url = `${origin}/#token=${token}`;
await writeFile(resolve(dataDir, 'connection.json'), JSON.stringify({ url, pid: process.pid }), {
  mode: 0o600,
});
console.log(`\n  Pixel Office · 에이전트들의 작은 사무실\n  ${url}\n`);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  observation.close();
  await orchestrator.shutdown();
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
