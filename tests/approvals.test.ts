import { expect, test } from 'vitest';
import { automaticApproval, isToolApproval } from '../src/server/approvals.js';
import { createStore } from '../src/server/store.js';

test.each([
  { approvalMethod: 'item/permissions/requestApproval' },
  { permissions: { network: { enabled: true } } },
  { additionalPermissions: { fileSystem: { write: ['/outside'] } } },
  { networkApprovalContext: { host: 'example.com', protocol: 'https' } },
  { grantRoot: '/outside' },
])('auto mode leaves additional permission request %j unresolved', (details) => {
  const store = createStore(':memory:');
  try {
    store.setSetting('approvals', { mode: 'auto' });
    const request = {
      runId: 'run',
      agentId: 'codex' as const,
      kind: 'approval' as const,
      title: '추가 권한',
      details,
    };
    expect(isToolApproval(request)).toBe(false);
    expect(automaticApproval(store, request)).toBeUndefined();
    expect(store.events('run', 0)).toEqual([]);
  } finally {
    store.close();
  }
});
