import { packager } from '@electron/packager';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { desktopIcon, writeDesktopAssets } from './desktop-icon.mjs';

const exec = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('현재 데스크톱 패키지는 macOS용입니다.');
const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'dist', 'desktop-stage');
await mkdir(stage, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'pixel-office-desktop',
    productName: 'Pixel Office',
    version: pkg.version,
    type: 'module',
    main: 'main.js',
  }),
);
for (const name of ['main.js', 'service.js', 'policy.js'])
  await cp(join(root, 'dist', 'desktop', name), join(stage, name));
await writeDesktopAssets(join(stage, 'assets'));
const iconset = join(root, 'dist', 'PixelOffice.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    await writeFile(
      join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      desktopIcon(size * scale),
    );
  }
const icon = join(root, 'dist', 'PixelOffice.icns');
await exec('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
).version;
const [output] = await packager({
  dir: stage,
  out: join(root, 'dist', 'mac'),
  name: 'Pixel Office',
  platform: 'darwin',
  arch: process.arch,
  electronVersion,
  appBundleId: 'io.pixeloffice.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  icon,
  overwrite: true,
  asar: true,
});
const bundle = join(output, 'Pixel Office.app');
console.log(`앱 생성: ${bundle}`);
if (process.argv.includes('--install')) {
  const applications = join(homedir(), 'Applications');
  const target = join(applications, 'Pixel Office.app');
  const temporary = join(applications, '.Pixel Office.installing.app');
  const previous = join(applications, '.Pixel Office.previous.app');
  await mkdir(applications, { recursive: true });
  const exists = await access(target).then(
    () => true,
    () => false,
  );
  if (exists) {
    const { stdout } = await exec('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      join(target, 'Contents/Info.plist'),
    ]);
    if (stdout.trim() !== 'io.pixeloffice.desktop')
      throw new Error(`${target}에 다른 앱이 있습니다. 덮어쓰지 않았습니다.`);
    await exec('/usr/bin/osascript', [
      '-e',
      'if application id "io.pixeloffice.desktop" is running then tell application id "io.pixeloffice.desktop" to quit',
    ]);
    // AppleScript acknowledges quit before LaunchServices has finished removing the process.
    const executable = join(target, 'Contents', 'MacOS', 'Pixel Office');
    const deadline = Date.now() + 10000;
    while (true) {
      const { stdout: processes } = await exec('/bin/ps', ['-axo', 'comm=']);
      if (!processes.split('\n').some((line) => line.trim() === executable)) break;
      if (Date.now() >= deadline)
        throw new Error(
          'Pixel Office 앱을 종료한 뒤 설치를 다시 실행하세요. 서버는 계속 실행 중입니다.',
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await rm(temporary, { recursive: true, force: true });
  // Frameworks contain relative symlinks. Rewriting them to the build directory
  // breaks Chromium's resource discovery and makes the installed app nonportable.
  await cp(bundle, temporary, { recursive: true, verbatimSymlinks: true });
  await rm(previous, { recursive: true, force: true });
  if (exists) await rename(target, previous);
  try {
    await rename(temporary, target);
  } catch (error) {
    if (exists) await rename(previous, target);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  await exec('/usr/bin/open', exists ? [target] : [target, '--args', '--enable-login']);
  console.log(`앱 설치 및 실행: ${target}`);
}
