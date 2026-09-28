import { afterEach, expect, test, vi } from 'vitest';
import { createStore } from '../src/server/store.js';
import { createChatService, buildChatContext, type ChatResponder } from '../src/server/chat.js';
import type { ObservedDetail } from '../src/shared/contracts.js';
const detail = (id: string): ObservedDetail => ({
  id,
  sessionId: id,
  provider: 'codex',
  projectPath: '/repo/' + id,
  cwd: '/repo/' + id,
  label: id,
  prompt: 'task ' + id,
  model: '',
  status: 'active',
  activity: 'reading',
  updatedAt: new Date().toISOString(),
  processAlive: null,
  truncated: false,
  events: [
    {
      id: 'event',
      timestamp: new Date().toISOString(),
      kind: 'tool',
      activity: 'reading',
      title: 'Read',
      detail: 'file-' + id,
    },
  ],
});
const clean: (() => Promise<void>)[] = [];
test('direct instructions apply auto approval to current and new tools but still ask questions', async () => {
  const store = createStore(':memory:');
  const decisions: unknown[] = [];
  const service = createChatService({
    store,
    getSession: (id) => detail(id),
    respond: async () => {},
    direct: async (input, update) => {
      const request = { agentId: 'codex' as const, title: 'git diff', details: {} };
      decisions.push(await input.interact({ ...request, kind: 'approval' }));
      decisions.push(await input.interact({ ...request, kind: 'approval' }));
      decisions.push(await input.interact({ ...request, kind: 'question' }));
      await input.interact({
        ...request,
        kind: 'approval',
        title: '추가 권한',
        details: {
          approvalMethod: 'item/permissions/requestApproval',
          permissions: { network: { enabled: true } },
        },
      });
      update('done');
    },
  });
  clean.push(async () => {
    await service.close();
    store.close();
  });
  service.say('one', '작업해줘');
  await vi.waitFor(() => expect(service.pending('one')).toHaveLength(1));
  service.approvePending();
  expect(service.pending('one')).toHaveLength(1);
  store.setSetting('approvals', { mode: 'auto' });
  service.approvePending();
  await vi.waitFor(() => expect(service.pending('one')[0]?.kind).toBe('question'));
  expect(decisions).toEqual([{ decision: 'approve' }, { decision: 'approve' }]);
  service.approvePending();
  const question = service.pending('one')[0];
  expect(question.kind).toBe('question');
  service.answer('one', question.id, { answers: { choice: ['yes'] } });
  await vi.waitFor(() => expect(service.pending('one')[0]?.title).toBe('추가 권한'));
  service.approvePending();
  expect(service.pending('one')[0]?.title).toBe('추가 권한');
  service.answer('one', service.pending('one')[0].id, { decision: 'deny' });
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('completed'));
  expect(store.events('observed:one', 0).filter((e) => e.payload.automatic)).toHaveLength(2);
});
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});
function fixture(respond: ChatResponder, timeoutMs = 1000) {
  const store = createStore(':memory:');
  const service = createChatService({ store, getSession: (id) => detail(id), respond, timeoutMs });
  clean.push(async () => {
    await service.close();
    store.close();
  });
  return { service, store };
}
test('isolates history, bounds context and refuses duplicate generation per session', async () => {
  let finish!: () => void;
  let captured = '';
  const { service } = fixture(async (input, update) => {
    captured = input.prompt;
    update('확인 중');
    await new Promise<void>((r) => {
      finish = r;
    });
    update('file-one을 읽었어요.');
  });
  service.ask('one', '어떤 파일?');
  expect(() => service.ask('one', 'again')).toThrow('답변');
  expect(service.list('two')).toEqual([]);
  await vi.waitFor(() => expect(captured).toContain('file-one'));
  expect(captured).not.toContain('file-two');
  finish();
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('completed'));
  expect(service.list('one').at(-1)?.text).toBe('file-one을 읽었어요.');
  const long = detail('one');
  long.events = Array.from({ length: 80 }, (_, i) => ({
    ...long.events[0],
    id: String(i),
    detail: 'x'.repeat(10000),
  }));
  expect(buildChatContext(long, service.list('one'), 'hi').length).toBeLessThan(50000);
});
test('cancellation settles the message and late output cannot resurrect it', async () => {
  let late!: (text: string) => void;
  const { service } = fixture(async (input, update) => {
    late = update;
    await new Promise<void>((r) =>
      input.signal.addEventListener('abort', () => r(), { once: true }),
    );
  });
  service.ask('one', 'hello');
  await vi.waitFor(() => expect(late).toBeTypeOf('function'));
  service.cancel('one');
  late('late answer');
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('cancelled'));
  expect(service.list('one').at(-1)?.text).not.toBe('late answer');
});
test('reports native errors and timeout, and permits retry', async () => {
  const { service } = fixture(async () => {
    throw new Error('login required');
  });
  service.ask('one', 'hi');
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('failed'));
  expect(service.list('one').at(-1)?.error).toContain('login required');
  expect(() => service.ask('one', 'retry')).not.toThrow();
  const timed = fixture(
    async (input) =>
      new Promise<void>((r) => input.signal.addEventListener('abort', () => r(), { once: true })),
    20,
  );
  timed.service.ask('slow', 'hi');
  await vi.waitFor(() => expect(timed.service.list('slow').at(-1)?.status).toBe('failed'));
  expect(timed.service.list('slow').at(-1)?.error).toContain('시간');
});
test('recovers persisted pending answers on restart without losing conversation', async () => {
  const store = createStore(':memory:');
  store.saveChat({
    id: 'u',
    sessionId: 'one',
    role: 'user',
    text: 'hello',
    status: 'completed',
    createdAt: '2026-09-25T01:00:00Z',
  });
  store.saveChat({
    id: 'a',
    sessionId: 'one',
    role: 'assistant',
    text: 'partial',
    status: 'pending',
    createdAt: '2026-09-25T01:00:00Z',
  });
  const service = createChatService({ store, getSession: detail, respond: async () => {} });
  expect(service.list('one')[0].text).toBe('hello');
  expect(service.list('one')[1].status).toBe('failed');
  expect(service.list('one')[1].error).toContain('재시작');
  await service.close();
  store.close();
});

test('limits parallel generations, validates requests and bounds stored answers', async () => {
  const { service } = fixture(async (input, update) => {
    update('x'.repeat(20000));
    await new Promise<void>((r) =>
      input.signal.addEventListener('abort', () => r(), { once: true }),
    );
  });
  expect(() => service.ask('one', ' ')).toThrow();
  expect(() => service.ask('one', 'x'.repeat(4001))).toThrow();
  service.ask('one', 'hi');
  service.ask('two', 'hi');
  expect(() => service.ask('three', 'hi')).toThrow('다른 답변');
  await vi.waitFor(() => expect(service.list('one').at(-1)?.text.length).toBe(16000));
  await service.close();
  expect(service.list('one').at(-1)?.status).toBe('cancelled');
  expect(service.list('two').at(-1)?.status).toBe('cancelled');
});

test('conversation survives closing and reopening the SQLite file', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pixel-chat-test-'));
  const path = join(dir, 'chat.db');
  try {
    const first = createStore(path);
    first.saveChat({
      id: 'persisted',
      sessionId: 'one',
      role: 'assistant',
      text: 'saved answer',
      status: 'completed',
      createdAt: new Date().toISOString(),
    });
    first.close();
    const second = createStore(path);
    expect(second.listChat('one')[0].text).toBe('saved answer');
    expect(second.listChat('two')).toEqual([]);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Instructions: typed into a terminal and answered through the logs, or run as a direct turn.
const observed = (id: string, over: Partial<ObservedDetail> = {}): ObservedDetail => ({
  ...detail(id),
  status: 'idle',
  events: [],
  ...over,
});
test('a terminal instruction is typed once and its reply is read from the same-text request in the logs', async () => {
  const store = createStore(':memory:');
  const sessions = new Map<string, ObservedDetail>([['one', observed('one')]]);
  const typed: string[] = [];
  const service = createChatService({
    store,
    getSession: (id) => sessions.get(id),
    listSessions: () => [...sessions.values()],
    respond: async () => {},
    terminal: {
      isOpen: () => true,
      send: async (_s, text) => {
        typed.push(text);
        return { forked: false };
      },
    },
    trackIntervalMs: 10,
  });
  clean.push(async () => {
    await service.close();
    store.close();
  });
  expect(service.channels('one').next).toBe('terminal');
  service.say('one', '테스트를 돌려줘');
  await vi.waitFor(() => expect(typed).toEqual(['테스트를 돌려줘']));
  expect(() => service.ask('one', 'hi')).toThrow('작성 중');
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ev = (kind: 'request' | 'message' | 'complete', text: string, ms = 0) => ({
    id: kind + text,
    timestamp: at(ms),
    kind,
    activity: 'responding' as const,
    title: '',
    detail: text,
  });
  // An older request with the same text is not the answer to this instruction.
  sessions.set('one', observed('one', { events: [ev('request', '테스트를 돌려줘', -60000)] }));
  await new Promise((r) => setTimeout(r, 50));
  expect(service.list('one').at(-1)?.status).toBe('pending');
  sessions.set('one', {
    ...sessions.get('one')!,
    model: 'm1',
    events: [
      ev('request', '테스트를 돌려줘'),
      ev('message', '돌리는 중이에요'),
      { ...ev('request', '테스트를 돌려줘'), id: 'chat:synthetic-user' },
    ],
  });
  await vi.waitFor(() => expect(service.list('one').at(-1)?.text).toBe('돌리는 중이에요'));
  await new Promise((r) => setTimeout(r, 40));
  expect(service.list('one').at(-1)?.status).toBe('pending');
  sessions.set('one', {
    ...sessions.get('one')!,
    events: [
      ev('request', '테스트를 돌려줘'),
      ev('message', '돌리는 중이에요'),
      ev('complete', '테스트 12건 통과'),
    ],
  });
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('completed'));
  const reply = service.list('one').at(-1)!;
  expect(reply.text).toBe('테스트 12건 통과');
  expect(reply.channel).toBe('terminal');
  expect(reply.model).toBe('m1');
  expect(service.list('one')[0]).toMatchObject({ role: 'user', channel: 'terminal' });
  // A live session is forked: the reply lands in a newer session, which later instructions follow.
  sessions.set('two', observed('two', { status: 'active', projectPath: '/repo/two' }));
  service.say('two', '문서 고쳐줘');
  await vi.waitFor(() => expect(typed).toHaveLength(2));
  sessions.set('two-fork', {
    ...observed('two-fork', { projectPath: '/repo/two', sessionId: 'forked-uuid' }),
    events: [ev('request', '문서 고쳐줘'), ev('complete', '고쳤어요')],
  });
  await vi.waitFor(() => expect(service.list('two').at(-1)?.status).toBe('completed'));
  expect(service.list('two').at(-1)?.viaSessionId).toBe('forked-uuid');
  expect(store.directLink('two')).toBe('forked-uuid');
  expect(service.channels('two').viaSessionId).toBe('forked-uuid');
});
test('a direct instruction runs a turn, parks approvals until answered, and records a fork', async () => {
  const store = createStore(':memory:');
  const seen: { fork: boolean; via?: string }[] = [];
  const service = createChatService({
    store,
    getSession: (id) => observed(id, { status: id === 'live' ? 'active' : 'idle' }),
    respond: async () => {},
    direct: async (input, update) => {
      seen.push({ fork: input.fork, via: input.viaSessionId });
      update('', {
        model: 'direct-model',
        sessionId: input.fork ? 'fork-1' : input.session.sessionId,
      });
      const a = await input.interact({
        agentId: 'codex',
        kind: 'approval',
        title: 'rm build',
        details: {},
      });
      if ('decision' in a && a.decision === 'deny') throw new Error('거절됨');
      update(`했어요: ${input.text}`, { model: 'direct-model' });
    },
  });
  clean.push(async () => {
    await service.close();
    store.close();
  });
  expect(service.channels('one').next).toBe('direct');
  service.say('one', '빌드 정리해줘');
  await vi.waitFor(() => expect(service.pending('one')).toHaveLength(1));
  const req = service.pending('one')[0];
  expect(req.runId).toBe('observed:one');
  expect(() => service.answer('one', req.id, { answers: {} })).toThrow('종류');
  expect(() => service.answer('other', req.id, { decision: 'approve' })).toThrow('사라진');
  service.answer('one', req.id, { decision: 'approve' });
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('completed'));
  expect(service.list('one').at(-1)).toMatchObject({
    text: '했어요: 빌드 정리해줘',
    channel: 'direct',
    model: 'direct-model',
  });
  expect(service.pending('one')).toHaveLength(0);
  expect(store.directLink('one')).toBeUndefined();
  // Denying fails the instruction and clears the request.
  service.say('one', '다시');
  await vi.waitFor(() => expect(service.pending('one')).toHaveLength(1));
  service.answer('one', service.pending('one')[0].id, { decision: 'deny' });
  await vi.waitFor(() => expect(service.list('one').at(-1)?.status).toBe('failed'));
  expect(service.list('one').at(-1)?.error).toContain('거절');
  // A session running elsewhere is forked once; the next instruction continues on the fork.
  service.say('live', '첫 지시');
  await vi.waitFor(() => expect(service.pending('live')).toHaveLength(1));
  service.answer('live', service.pending('live')[0].id, { decision: 'approve' });
  await vi.waitFor(() => expect(service.list('live').at(-1)?.status).toBe('completed'));
  expect(service.list('live').at(-1)?.viaSessionId).toBe('fork-1');
  service.say('live', '둘째 지시');
  await vi.waitFor(() => expect(seen).toHaveLength(4));
  expect(seen[2]).toEqual({ fork: true, via: undefined });
  expect(seen[3]).toEqual({ fork: false, via: 'fork-1' });
  service.cancel('live');
  await vi.waitFor(() => expect(service.list('live').at(-1)?.status).toBe('cancelled'));
  expect(service.pending('live')).toHaveLength(0);
});
