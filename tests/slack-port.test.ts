import { expect, test } from 'vitest';
import { slackErrorCode } from '../src/server/slack/errors.js';
import { quietLogger, testSlackConnection, type SlackPort } from '../src/server/slack/port.js';

const config = { botToken: 'xoxb-1-secret', appToken: 'xapp-1-secret', ownerId: 'U01ABC' };
const leaky = () =>
  Object.assign(new Error('failed with xoxb-secret'), { data: { error: 'invalid_auth' } });
const fake = (over: Record<string, unknown>) => {
  const calls: string[] = [];
  const port = {
    authTest: async () => ({ teamId: 'T', botUserId: 'B' }),
    openDm: async () => 'D1',
    post: async () => 'ts',
    stop: async () => void calls.push('stop'),
    ...over,
  } as unknown as SlackPort;
  return { port, calls };
};

test('slackErrorCode keeps only a code', () => {
  expect(slackErrorCode(leaky())).toBe('invalid_auth');
  expect(slackErrorCode(new Error('boom xoxb-secret'))).toBe('unknown_error');
  expect(slackErrorCode('xoxb-secret')).toBe('unknown_error');
});

test('the Bolt logger passes on only a Slack code, never a token-bearing error', () => {
  const logged: string[] = [];
  const logger = quietLogger((code) => void logged.push(code));
  const original = { config: { headers: { Authorization: 'Bearer xoxb-1-secret' } } };
  logger.error(
    Object.assign(new Error('A request error occurred'), {
      code: 'slack_webapi_request_error',
      original,
    }),
  );
  logger.error('Failed to retrieve a new WSS URL (error: wss://x?ticket=secret)');
  logger.warn('xapp-1-secret');
  logger.info('xapp-1-secret');
  logger.debug('xapp-1-secret');
  expect(logged).toEqual(['slack_webapi_request_error', 'unknown_error']);
  expect(logger.getLevel()).toBe('error');
});

test('testSlackConnection throws only the Slack code and always stops the port', async () => {
  const { port, calls } = fake({
    authTest: async () => {
      throw leaky();
    },
  });
  const err = await testSlackConnection(config, () => port).catch((e: Error) => e);
  expect((err as Error).message).toBe('invalid_auth');
  expect(calls).toEqual(['stop']);
});

test('testSlackConnection keeps the original error when stop fails', async () => {
  const { port } = fake({
    authTest: async () => {
      throw leaky();
    },
    stop: async () => {
      throw new Error('stop xoxb-secret');
    },
  });
  const err = await testSlackConnection(config, () => port).catch((e: Error) => e);
  expect((err as Error).message).toBe('invalid_auth');
});

test('testSlackConnection sends the hello DM to the owner', async () => {
  const sent: unknown[][] = [];
  const { port, calls } = fake({
    post: async (...a: unknown[]) => (sent.push(a), 'ts'),
  });
  await testSlackConnection(config, () => port);
  expect(sent[0]?.[0]).toBe('D1');
  expect(sent[0]?.[3]).toBe('Pixel Office와 연결됐어요.');
  expect(calls).toEqual(['stop']);
});
