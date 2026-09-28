import { expect, test } from 'vitest';
import { navigationTarget, RunNotifications, shouldStartServer } from '../src/desktop/policy.js';

test('login launch respects an explicitly stopped server while a manual launch starts it', () => {
  expect(shouldStartServer({ connected: false, loginLaunch: true })).toBe(false);
  expect(shouldStartServer({ connected: false, loginLaunch: false })).toBe(true);
  expect(shouldStartServer({ connected: true, loginLaunch: false })).toBe(false);
});

test('desktop navigation stays on its server and only opens ordinary web links externally', () => {
  const origin = 'http://127.0.0.1:4317';
  expect(navigationTarget(`${origin}/#office`, origin)).toBe('internal');
  expect(navigationTarget('https://example.com/doc', origin)).toBe('external');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'x-apple.systempreferences:foo',
    'http://user:pass@example.com',
    'broken',
  ]) {
    expect(navigationTarget(url, origin)).toBe('deny');
  }
});

test('notifications ignore historical completion and notify once for each new status transition', () => {
  const notifications = new RunNotifications();
  expect(notifications.update([{ id: 'old', status: 'completed' }])).toEqual([]);
  expect(
    notifications.update([
      { id: 'old', status: 'completed' },
      { id: 'new', status: 'waiting_approval' },
    ]),
  ).toEqual(['승인이 필요한 작업이 있습니다.']);
  expect(notifications.update([{ id: 'new', status: 'waiting_approval' }])).toEqual([]);
  expect(notifications.update([{ id: 'new', status: 'completed' }])).toEqual([
    '작업이 완료되었습니다.',
  ]);
});
