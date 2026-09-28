import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  createServiceConfig,
  installService,
  isServiceLoaded,
  loadServiceConfig,
  readReadyConnection,
  servicePaths,
  startService,
  stopService,
  uninstallService,
} from './service.js';

async function main() {
  const command = process.argv[2] ?? 'status';
  const paths = servicePaths();
  if (command === 'install') {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const config = createServiceConfig({
      root,
      nodePath: process.execPath,
      dataDir: process.env.PIXEL_DATA_DIR,
      port: Number(process.env.PORT ?? 4317),
    });
    await installService(config, paths);
    console.log('Pixel Office 백그라운드 실행을 설치했습니다. 로그인 시 자동 실행됩니다.');
  } else if (command === 'stop') {
    await stopService();
    console.log('서버와 로그인 시 자동 실행을 중지했습니다. 다시 켜기: npm run service:start');
  } else if (command === 'uninstall') {
    await uninstallService(paths);
    console.log('백그라운드 서비스를 제거했습니다. 작업 기록과 로그는 보존했습니다.');
  } else if (command === 'start' || command === 'open') {
    const connection = await startService(await loadServiceConfig(paths), paths);
    if (command === 'open') execFile('/usr/bin/open', [connection.url]);
    console.log(
      command === 'open' ? '브라우저에서 Pixel Office를 열었습니다.' : '서버가 준비됐습니다.',
    );
  } else if (command === 'status') {
    const config = await loadServiceConfig(paths).catch(() => null);
    const connection = config ? await readReadyConnection(config) : null;
    console.log(
      JSON.stringify(
        {
          installed: !!config,
          loaded: await isServiceLoaded(),
          ready: !!connection,
          pid: connection?.pid ?? null,
          port: config?.port ?? null,
          logs: paths.logs,
        },
        null,
        2,
      ),
    );
  } else throw new Error('사용법: service-cli.js install|start|stop|status|open|uninstall');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
