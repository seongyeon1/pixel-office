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
