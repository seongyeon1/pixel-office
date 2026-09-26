import { expect, test } from 'vitest';
import { dropParentSession, withoutParentSession } from '../src/server/env.js';
test('a parent Claude Code session is not passed on, user settings are', () => {
  const env = {
    CLAUDECODE: '1',
    CLAUDE_PID: '90044',
    CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/90044.sock',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CONFIG_DIR: '/home/me/.claude',
    ANTHROPIC_MODEL: 'claude-opus-5-5',
    PATH: '/usr/bin',
  };
  expect(withoutParentSession(env)).toEqual({
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CONFIG_DIR: '/home/me/.claude',
    ANTHROPIC_MODEL: 'claude-opus-5-5',
    PATH: '/usr/bin',
  });
  expect(env.CLAUDECODE).toBe('1');
  dropParentSession(env);
  expect(Object.keys(env).sort()).toEqual([
    'ANTHROPIC_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CONFIG_DIR',
    'PATH',
  ]);
});
