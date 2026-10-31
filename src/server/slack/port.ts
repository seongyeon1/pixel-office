import { App, LogLevel } from '@slack/bolt';
import type { SlackConfig } from './secrets.js';

export type Block = Record<string, unknown>;

export type InboundMessage = {
  eventId: string;
  teamId: string;
  channel: string;
  channelType: 'im' | 'channel' | 'group';
  user?: string;
  botId?: string;
  subtype?: string;
  text: string;
  ts: string;
  threadTs?: string;
  mentionsBot: boolean;
};

export type InboundAction = {
  userId: string;
  channel: string;
  messageTs: string;
  actionId: string;
  value: string;
  respond(blocks: Block[], text: string): Promise<void>;
};

export interface SlackPort {
  start(
    onMessage: (m: InboundMessage) => void,
    onAction: (a: InboundAction) => void,
  ): Promise<void>;
  stop(): Promise<void>;
  react(channel: string, ts: string, name: string): Promise<void>;
  post(
    channel: string,
    threadTs: string | undefined,
    blocks: Block[],
    text: string,
  ): Promise<string>;
  update(channel: string, ts: string, blocks: Block[], text: string): Promise<void>;
  upload(channel: string, threadTs: string, filename: string, content: string): Promise<void>;
  openDm(userId: string): Promise<string>;
  authTest(): Promise<{ teamId: string; botUserId: string }>;
}

// Thin Bolt adapter (Socket Mode). Not unit-tested against real Slack; callers are tested with a fake SlackPort.
export function createBoltPort(config: SlackConfig): SlackPort {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });
  const client = app.client;
  const channelType = (t: unknown): InboundMessage['channelType'] =>
    t === 'im' ? 'im' : t === 'group' || t === 'mpim' ? 'group' : 'channel';
  const blocksOf = (blocks: Block[]) => blocks as never;
  return {
    async start(onMessage, onAction) {
      const { user_id: botUserId } = await client.auth.test();
      const emit = (
        event: Record<string, unknown>,
        body: Record<string, unknown>,
        mention: boolean,
      ) => {
        const text = typeof event.text === 'string' ? event.text : '';
        onMessage({
          eventId: String(body.event_id ?? ''),
          teamId: String(body.team_id ?? (event.team as string | undefined) ?? ''),
          channel: String(event.channel ?? ''),
          channelType: mention && !event.channel_type ? 'channel' : channelType(event.channel_type),
          user: event.user as string | undefined,
          botId: event.bot_id as string | undefined,
          subtype: event.subtype as string | undefined,
          text,
          ts: String(event.ts ?? ''),
          threadTs: event.thread_ts as string | undefined,
          mentionsBot: mention || (!!botUserId && text.includes(`<@${botUserId}>`)),
        });
      };
      app.message(async ({ message, body }) => emit(message as never, body as never, false));
      app.event('app_mention', async ({ event, body }) =>
        emit(event as never, body as never, true),
      );
      app.action(/.*/, async ({ ack, action, body, respond }) => {
        await ack();
        const channel = (body as { channel?: { id?: string } }).channel?.id ?? '';
        const messageTs = (body as { message?: { ts?: string } }).message?.ts ?? '';
        const a = action as { action_id: string; value?: string };
        onAction({
          userId: body.user.id,
          channel,
          messageTs,
          actionId: a.action_id,
          value: a.value ?? '',
          respond: async (blocks, text) => {
            await respond({ replace_original: true, blocks: blocksOf(blocks), text });
          },
        });
      });
      await app.start();
    },
    async stop() {
      await app.stop();
    },
    async react(channel, ts, name) {
      await client.reactions.add({ channel, timestamp: ts, name });
    },
    async post(channel, threadTs, blocks, text) {
      const res = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks: blocksOf(blocks),
        text,
      });
      return res.ts ?? '';
    },
    async update(channel, ts, blocks, text) {
      await client.chat.update({ channel, ts, blocks: blocksOf(blocks), text });
    },
    async upload(channel, threadTs, filename, content) {
      await client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        filename,
        content,
      });
    },
    async openDm(userId) {
      const res = await client.conversations.open({ users: userId });
      return res.channel?.id ?? '';
    },
    async authTest() {
      const res = await client.auth.test();
      return { teamId: res.team_id ?? '', botUserId: res.user_id ?? '' };
    },
  };
}

// Verifies a config end to end: auth, then a hello DM to the owner. Throws only the Slack error code.
export async function testSlackConnection(
  config: SlackConfig,
  create: (c: SlackConfig) => SlackPort = createBoltPort,
): Promise<void> {
  const port = create(config);
  try {
    await port.authTest();
    const dm = await port.openDm(config.ownerId);
    await port.post(dm, undefined, [], 'Pixel Office와 연결됐어요.');
  } catch (e) {
    throw new Error(slackErrorCode(e));
  } finally {
    await port.stop().catch(() => {});
  }
}

// Slack API errors carry the code in `data.error`; fall back to a generic label so tokens never leak.
export function slackErrorCode(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (typeof data?.error === 'string') return data.error;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]+$/i.test(code) ? code : 'unknown_error';
}
