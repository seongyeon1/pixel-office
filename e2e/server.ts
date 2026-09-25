import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import staticPlugin from '@fastify/static';
import { createObservation } from '../src/server/observation/observer.js';
import { createChatService } from '../src/server/chat.js';
import { createStore } from '../src/server/store.js';
import { createOrchestrator } from '../src/server/orchestrator.js';
import { createServer } from '../src/server/transport.js';
import type { Adapter, Provider } from '../src/shared/contracts.js';
const dir = await mkdtemp(join(tmpdir(), 'pixel-e2e-'));
const project = join(dir, 'sample');
await mkdir(project);
execFileSync('git', ['init'], { cwd: project, stdio: 'pipe' });
await writeFile(join(project, 'README.md'), 'fixture');
execFileSync('git', ['add', '.'], { cwd: project, stdio: 'pipe' });
execFileSync(
  'git',
  ['-c', 'user.name=Pixel', '-c', 'user.email=pixel@example.test', 'commit', '-m', 'seed'],
  { cwd: project, stdio: 'pipe' },
);
await mkdir('.pixel', { recursive: true });
await writeFile('.pixel/e2e-project.txt', project);
const store = createStore(':memory:');
const make = (id: Provider): Adapter => ({
  probe: async () => ({ installed: true, authenticated: true, detail: '데모 fixture' }),
  close: async () => {},
  execute: async (input, emit, interact) => {
    emit({
      runId: input.runId,
      agentId: id,
      type: 'activity',
      payload: { activity: input.role === 'reviewer' ? 'reviewing' : 'editing', tool: 'Edit' },
    });
    if (input.role === 'reviewer')
      return {
        outcome: 'completed',
        text: '검토 완료',
        review: { verdict: 'pass', summary: '검토 완료', findings: [] },
      };
    if (input.prompt.includes('중단 테스트')) {
      await new Promise<void>((r) => {
        if (input.signal.aborted) r();
        else input.signal.addEventListener('abort', () => r(), { once: true });
      });
      return { outcome: 'cancelled', text: '' };
    }
    const answer = await interact({
      runId: input.runId,
      agentId: id,
      kind: 'approval',
      title: '샘플 파일 수정 승인',
      details: { file: 'hello.txt' },
    });
    if ('decision' in answer && answer.decision === 'deny')
      return {
        outcome: 'failed',
        text: '사용자가 거절했습니다.',
        error: '수정 요청이 거절되었습니다.',
      };
    if (input.prompt.includes('질문 테스트')) {
      const reply = await interact({
        runId: input.runId,
        agentId: id,
        kind: 'question',
        title: '파일 내용 선택',
        details: {
          questions: [
            {
              id: 'content',
              question: '어떤 내용을 쓸까요?',
              options: [{ label: 'hello' }, { label: 'hi' }],
            },
          ],
        },
      });
      if (!('answers' in reply) || reply.answers.content?.[0] !== 'hello')
        throw new Error('질문 응답 전달 실패');
    }
    await writeFile(join(input.cwd, 'hello.txt'), 'hello from the team\n');
    emit({
      runId: input.runId,
      agentId: id,
      type: 'message',
      payload: { text: '샘플 파일을 수정했습니다.' },
    });
    return { outcome: 'completed', text: '구현 완료' };
  },
});
const adapters = { codex: make('codex'), claude: make('claude') };
const orchestrator = createOrchestrator({ store, adapters, dataDir: dir });
const observation = createObservation({
  codexHome: join(dir, 'observed-codex'),
  claudeHome: join(dir, 'observed-claude'),
});
await mkdir(join(dir, 'observed-codex', 'sessions'), { recursive: true });
await mkdir(join(dir, 'observed-claude', 'projects'), { recursive: true });
await writeFile(
  '.pixel/e2e-observer.json',
  JSON.stringify({
    codex: join(dir, 'observed-codex', 'sessions', 'test.jsonl'),
    claude: join(dir, 'observed-claude', 'projects', 'test.jsonl'),
    project,
  }),
);
observation.start();
const chat = createChatService({
  store,
  getSession: observation.get,
  respond: async (input, update) => {
    if (input.prompt.endsWith(JSON.stringify('오류 테스트')))
      throw new Error('샘플 공급자 연결 실패');
    if (input.prompt.endsWith(JSON.stringify('느린 답변 테스트'))) {
      update('긴 답변을 준비 중이에요.', 'fixture-model');
      await new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return;
    }
    update('기록을 확인하고 있어요.', 'fixture-model');
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!input.signal.aborted)
      update(
        input.prompt.includes('README.md')
          ? 'README.md를 확인했어요.'
          : 'npm test 명령을 실행한 기록이 있어요.',
        'fixture-model',
      );
  },
});
const { app } = await createServer({
  store,
  adapters,
  orchestrator,
  token: 'e2e-token',
  terminalShell: '/bin/sh',
  port: 4318,
  demo: true,
  observation,
  chat,
  harnessCatalog: async () => ({
    claude: {
      plugins: [
        { id: 'superpowers@fixture', name: 'superpowers', description: 'Core workflow skills' },
      ],
      skills: [
        { id: 'bc-ship', name: 'bc-ship', description: 'Ship code with checks' },
        { id: 'task-observer', name: 'task-observer', description: 'Watch tasks' },
      ],
    },
    codex: {
      plugins: [{ id: 'linear@fixture', name: 'linear', description: 'fixture' }],
      skills: [{ id: 'bc-arxiv', name: 'bc-arxiv', description: 'Read papers' }],
    },
  }),
  // Stand-ins print their arguments and echo one line, like an interactive CLI would.
  agentCommands: {
    claude: `sh -c 'echo FAKE-CLAUDE "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake-claude`,
    codex: `sh -c 'echo FAKE-CODEX "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake-codex`,
  },
});
await app.register(staticPlugin, { root: resolve('dist/client') });
await app.listen({ port: 4318, host: '127.0.0.1' });
process.on('SIGTERM', async () => {
  observation.close();
  await orchestrator.shutdown();
  await app.close();
  store.close();
  process.exit(0);
});
