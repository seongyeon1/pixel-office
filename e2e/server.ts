import { randomUUID } from 'node:crypto';
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
import { createQuestionDesk } from '../src/server/questions.js';
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
    if (input.prompt.includes('개별 대화 통합'))
      emit({
        runId: input.runId,
        agentId: id,
        type: 'agent.session',
        payload: { sessionId: input.resumeSessionId ?? randomUUID(), model: 'fixture-model' },
      });
    if (
      input.prompt.includes('모두 한도 테스트') ||
      (input.prompt.includes('구현 한도 테스트') && id === 'codex') ||
      (input.prompt.includes('검토 한도 테스트') && id === 'claude')
    )
      return {
        outcome: 'failed',
        text: '진행 중이던 작업',
        error: "You've hit your session limit · resets 5:20pm (Asia/Seoul)",
      };
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
    if (input.prompt.includes('Git 제외 보고서 테스트')) {
      await writeFile(join(input.cwd, '.gitignore'), 'reports/\n');
      await mkdir(join(input.cwd, 'reports/private'), { recursive: true });
      await writeFile(
        join(input.cwd, 'reports/private/result-summary.md'),
        '# 아티팩트 결과 보고서\n\nGit에서 제외된 보고서입니다.',
      );
      await writeFile(join(input.cwd, 'reports/private/earlier.md'), '# 앞서 작성한 보고서');
      emit({
        runId: input.runId,
        agentId: id,
        type: 'tool.completed',
        payload: {
          item: { type: 'agentMessage', text: '[앞선 보고서](reports/private/earlier.md)' },
        },
      });
      // Keep reports discoverable beyond pagination and the recent-events window.
      for (let i = 0; i < 510; i++)
        emit({
          runId: input.runId,
          agentId: id,
          type: 'tool.output',
          payload: { text: '진행 중' },
        });
      return {
        outcome: 'completed',
        text: `[결과 보고서](${join(input.cwd, 'reports/private/result-summary.md')})를 작성했습니다.`,
      };
    }
    if (input.prompt.includes('문서 산출물 테스트'))
      await writeFile(
        join(input.cwd, 'REPORT.md'),
        '# 작업 결과 보고서\n\n문서 산출물 미리보기 검증.\n',
      );
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
  listSessions: () => observation.list().sessions,
  // Stand-in for a direct turn: asks for one approval, then answers with the instruction.
  direct: async (input, update) => {
    update('지시를 읽고 있어요.', { model: 'fixture-model' });
    const answer = await input.interact({
      agentId: input.session.provider,
      kind: 'approval',
      title: '샘플 파일 수정 승인',
      details: { file: 'hello.txt', text: input.text },
    });
    if (input.signal.aborted) return;
    if ('decision' in answer && answer.decision === 'deny')
      throw new Error('사용자가 작업을 거절했습니다.');
    update(`지시대로 처리했어요: ${input.text}`, {
      model: 'fixture-model',
      sessionId: input.fork ? 'forked-fixture' : input.session.sessionId,
    });
  },
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
  launchCommands: {
    claude: `sh -c 'echo FAKE-SY "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake-sy`,
    codex: `sh -c 'echo FAKE-SYC "$@"; while IFS= read -r line; do echo "GOT:$line"; done' fake-syc`,
  },
  observation,
  chat,
  questions: createQuestionDesk(),
  hookToken: 'e2e-hook',
  hookSetup: { claudeHome: join(dir, 'hook-claude'), command: 'node ask-hook.mjs' },
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
