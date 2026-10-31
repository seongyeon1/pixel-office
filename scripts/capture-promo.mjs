// Record Pixel Office's local-session discovery and session-specific Q&A.
// Start the isolated demo server first: npx tsx e2e/server.ts
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const output = resolve('.pixel/promo-source');
const frameDir = join(output, 'frames');
await mkdir(output, { recursive: true });
await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: output, size: { width: 1440, height: 900 } },
});
await context.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div');
    cursor.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;border:3px solid white;border-radius:50%;background:#47765a99;box-shadow:0 2px 9px #173d3088;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);transition:width .12s,height .12s,background .12s';
    document.body.append(cursor);
    window.addEventListener('mousemove', (event) => {
      cursor.style.transform = `translate(${event.clientX - 10}px,${event.clientY - 10}px)`;
    });
    window.addEventListener('mousedown', () => {
      cursor.style.width = '31px';
      cursor.style.height = '31px';
      cursor.style.background = '#e5c57caa';
      setTimeout(() => {
        cursor.style.width = '20px';
        cursor.style.height = '20px';
        cursor.style.background = '#47765a99';
      }, 240);
    });
  }, { once: true });
});
const page = await context.newPage();
const start = Date.now();
const marks = [];
const stills = [];
const writes = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
  const index = stills.length;
  stills.push({ index, seconds: (Date.now() - start) / 1000 });
  writes.push(writeFile(join(frameDir, `${String(index).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64')));
  void cdp.send('Page.screencastFrameAck', { sessionId });
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 97, everyNthFrame: 1 });
const mark = (name) => {
  const seconds = (Date.now() - start) / 1000;
  marks.push({ name, seconds });
  console.log(name, seconds.toFixed(2));
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = JSON.parse(await readFile('.pixel/e2e-observer.json', 'utf8'));
const parent = await realpath(await mkdtemp(join(tmpdir(), 'pixel-promo-repos-')));
const roots = Object.fromEntries(['web-app', 'api-server', 'docs-site'].map((name) => [name, join(parent, name)]));
const logFiles = [];
const line = (item) => JSON.stringify(item) + '\n';
const timestamp = new Date().toISOString();
const codexLog = async (id, cwd, prompt, command, complete = false) => {
  const path = join(dirname(fixture.codex), `${id}.jsonl`);
  logFiles.push(path);
  await writeFile(path,
    line({ timestamp, type: 'session_meta', payload: { id, cwd } }) +
    line({ timestamp, type: 'turn_context', payload: { model: 'gpt-6-sol', cwd } }) +
    line({ timestamp, type: 'event_msg', payload: { type: 'user_message', message: prompt } }) +
    line({ timestamp, type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ timestamp, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: command }) } }) +
    (complete ? line({ timestamp, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '작업을 마쳤습니다.' } }) : ''),
  );
};
const claudeLog = async (id, cwd) => {
  const path = join(dirname(fixture.claude), `${id}.jsonl`);
  logFiles.push(path);
  await writeFile(path,
    line({ timestamp, type: 'user', sessionId: id, cwd, message: { content: '결제 API 응답 흐름을 점검해줘' } }) +
    line({ timestamp, type: 'assistant', sessionId: id, cwd, message: { model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'README.md' } }] } }) +
    line({ timestamp, type: 'assistant', sessionId: id, cwd, message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'README.md를 확인하고 API 응답 경로를 살펴보고 있어요.' }] } }),
  );
};

try {
  for (const root of Object.values(roots)) {
    await mkdir(root, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    await writeFile(join(root, 'README.md'), '# Demo project\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed'], { cwd: root, stdio: 'pipe' });
  }
  await page.goto('http://127.0.0.1:4318/#token=e2e-token');
  await page.getByRole('heading', { level: 1, name: /오피스$/ }).waitFor();
  for (const root of Object.values(roots)) {
    const response = await page.request.post('http://127.0.0.1:4318/api/projects/inspect', {
      headers: { origin: 'http://127.0.0.1:4318' }, data: { path: root },
    });
    if (!response.ok()) throw new Error(`Project connection failed: ${root}`);
  }
  await codexLog('promo-web', roots['web-app'], '대시보드 모바일 화면을 정리해줘', 'npm test');
  await claudeLog('promo-api', roots['api-server']);
  await codexLog('promo-docs', roots['docs-site'], '설치 문서를 업데이트해줘', 'git diff -- README.md', true);
  await page.getByRole('button', { name: '전체 맵', exact: true }).click();
  await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1));
  const webWorker = page.getByRole('button', { name: `전체 맵 동료 ${roots['web-app']} promo-web`, exact: true });
  const apiWorker = page.getByRole('button', { name: `전체 맵 동료 ${roots['api-server']} promo-api`, exact: true });
  await webWorker.waitFor({ state: 'visible', timeout: 25000 });
  await apiWorker.waitFor({ state: 'visible', timeout: 25000 });
  await page.getByRole('button', { name: `전체 맵 동료 ${roots['docs-site']} promo-docs`, exact: true }).waitFor({ state: 'visible', timeout: 25000 });
  await page.mouse.wheel(0, 340);
  await pause(900);
  mark('map');
  await pause(2600);
  await webWorker.click();
  await page.getByRole('heading', { level: 1, name: /오피스$/ }).waitFor();
  mark('web');
  await pause(1800);
  await page.getByRole('tab', { name: '작업 내역', exact: true }).click();
  await page.getByRole('tabpanel', { name: '작업 내역' }).getByText('npm test').first().waitFor();
  mark('history');
  await pause(1900);
  await page.getByRole('tab', { name: '대화', exact: true }).click();
  await page.getByLabel('에이전트에게 질문').click();
  mark('question');
  await page.getByLabel('에이전트에게 질문').pressSequentially('최근 어떤 테스트를 실행했어?', { delay: 95 });
  await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await page.locator('.session-chat').getByText('npm test 명령을 실행한 기록이 있어요.').waitFor();
  mark('answer');
  await pause(2600);
  await page.getByRole('button', { name: '전체 맵', exact: true }).click();
  await page.getByLabel('전체 맵 프로젝트 검색').fill(parent.split('/').at(-1));
  await apiWorker.waitFor({ state: 'visible' });
  await page.mouse.wheel(0, 340);
  mark('map_again');
  await pause(1150);
  await apiWorker.click();
  await page.getByRole('tab', { name: '대화', exact: true }).click();
  mark('second_question');
  await page.getByLabel('에이전트에게 질문').pressSequentially('README.md는 확인했어?', { delay: 90 });
  await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await page.locator('.session-chat').getByText('README.md를 확인했어요.').waitFor();
  mark('second_answer');
  await pause(2800);
  mark('end');
  await page.screenshot({ path: join(output, 'end.png') });
} finally {
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  await page.close();
  await context.close();
  await browser.close();
  const video = await page.video()?.path();
  if (video) await copyFile(video, join(output, 'journey.webm'));
  await writeFile(join(output, 'marks.json'), JSON.stringify(marks, null, 2));
  await writeFile(join(output, 'frames.json'), JSON.stringify(stills));
  for (const file of logFiles) await rm(file, { force: true });
  await rm(parent, { recursive: true, force: true });
  console.log(`captured ${stills.length} frames`);
}
