import { createCoordinator, type CoordinatorRun } from '../coordinator.js';
import type { Coworkers } from '../coworkers.js';
import type { Orchestrator } from '../orchestrator.js';
import type { Store } from '../store.js';
import { slackErrorCode } from './errors.js';
import { createSlackGateway, type SlackGateway } from './gateway.js';
import { createBoltPort, testSlackConnection, type SlackPort } from './port.js';
import { readSlackConfig, type SlackConfig } from './secrets.js';

const logCode = (code: string) => console.error(`Slack 연결 오류: ${code}`);

// Owns the one live Slack gateway: (re)connect, disconnect, and the boot-time connect.
export function createSlackConnection({
  store,
  coworkers,
  orchestrator,
  dataDir,
  interrupted,
  createPort,
  runCoordinator,
  log = logCode,
}: {
  store: Store;
  coworkers: Pick<Coworkers, 'get' | 'list' | 'forChannel' | 'save'>;
  orchestrator: Pick<Orchestrator, 'startFor' | 'followUp' | 'answer' | 'cancel' | 'queuePosition'>;
  dataDir: string;
  // Runs interruptActive() returned at boot; announced on the first successful connect only.
  interrupted: string[];
  createPort?: (config: SlackConfig) => SlackPort;
  runCoordinator?: CoordinatorRun;
  // Receives only a Slack error code.
  log?: (code: string) => void;
}) {
  const makePort = createPort ?? ((config: SlackConfig) => createBoltPort(config, log));
  let gateway: SlackGateway | undefined;
  let pending = interrupted;
  let error: string | undefined;
  // Boot and a settings save may connect at once; one at a time keeps a single gateway.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  const stopGateway = async () => {
    const current = gateway;
    gateway = undefined;
    await current?.stop();
  };
  const open = async (config: SlackConfig) => {
    await stopGateway().catch(() => {});
    const port = makePort(config);
    // The coordinator and the gateway call each other; the closures bind once both exist.
    let live: SlackGateway | undefined;
    const coordinator = createCoordinator({
      store,
      coworkers,
      orchestrator,
      dataDir,
      reply: (jobId, text) => live!.reply(jobId, text),
      propose: (jobId, draft) => live!.propose(jobId, draft),
      ...(runCoordinator ? { run: runCoordinator } : {}),
    });
    live = createSlackGateway({
      store,
      port,
      coworkers,
      orchestrator,
      coordinator,
      ownerId: config.ownerId,
      onError: log,
    });
    try {
      await live.start();
    } catch (e) {
      await port.stop().catch(() => {});
      error = slackErrorCode(e);
      throw new Error(error);
    }
    gateway = live;
    error = undefined;
    const ids = pending;
    pending = [];
    await live.notifyInterrupted(ids).catch(() => {});
  };
  const connect = (config: SlackConfig) => serial(() => open(config));
  return {
    test: (config: SlackConfig) => testSlackConnection(config, makePort),
    connect,
    disconnect: () =>
      serial(async () => {
        error = undefined;
        await stopGateway();
      }),
    // The last connect failure as a Slack code, shown by GET /api/settings/slack.
    error: () => error,
    // A failure here never blocks the server: it is logged as a code and kept for the settings page.
    async boot() {
      const config = await readSlackConfig(dataDir);
      if (!config) return;
      try {
        await connect(config);
      } catch (e) {
        log(slackErrorCode(e));
      }
    },
  };
}
export type SlackConnection = ReturnType<typeof createSlackConnection>;
