import { expect, test } from 'vitest';
import { createStore } from '../src/server/store.js';
import { defaultTeam, type Run } from '../src/shared/contracts.js';
const run = (): Run => ({ id: 'r1', projectPath: '/p', worktreePath: '/w', branch: 'pixel/r1', baseCommit: 'abc', prompt: 'task', mode: 'codex', implementer: 'codex', status: 'running', phase: 'implement', revision: 0, createdAt: new Date().toISOString(), team: defaultTeam() });
test('replays only unacknowledged events and resolves an interaction once', () => {
 const db = createStore(':memory:'); db.createRun(run());
 const a = db.append({runId:'r1',agentId:'codex',type:'message',payload:{text:'a'}});
 const b = db.append({runId:'r1',agentId:'codex',type:'message',payload:{text:'b'}});
 expect(db.events('r1',a.sequence).map(e=>e.eventId)).toEqual([b.eventId]);
 db.saveInteraction({id:'q1',runId:'r1',agentId:'codex',kind:'approval',title:'command',details:{},resolved:false});
 expect(db.pending('r1')).toHaveLength(1);
 expect(db.resolveInteraction('q1')).toBe(true); expect(db.resolveInteraction('q1')).toBe(false);
 expect(db.pending('r1')).toEqual([]); db.close();
});
test('restart interrupts active jobs without changing completed jobs', () => {
 const db = createStore(':memory:'); db.createRun(run()); db.createRun({...run(),id:'r2',status:'completed'});
 expect(db.interruptActive()).toBe(1); expect(db.getRun('r1')?.status).toBe('interrupted'); expect(db.getRun('r2')?.status).toBe('completed'); db.close();
});
