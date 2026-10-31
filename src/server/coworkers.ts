import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  COORDINATOR_ID,
  DEFAULT_RULES,
  coworkerSchema,
  type Coworker,
} from '../shared/coworkers.js';
import type { Store } from './store.js';

export function createCoworkers(store: Store, { dataDir }: { dataDir: string }) {
  const list = (): Coworker[] => {
    let items = store.listCoworkers();
    if (!items.some((c) => c.id === COORDINATOR_ID)) {
      const folder = join(dataDir, 'coordinator');
      mkdirSync(folder, { recursive: true });
      const coordinator: Coworker = {
        id: COORDINATOR_ID,
        name: '코디네이터',
        folder,
        engine: 'claude',
        role: '',
        mode: 'solo',
        bindings: [],
        rules: [],
        createdBy: 'user',
      };
      store.putCoworker(coordinator);
      items = [coordinator, ...items];
    }
    return [
      ...items.filter((c) => c.id === COORDINATOR_ID),
      ...items.filter((c) => c.id !== COORDINATOR_ID),
    ];
  };
  return {
    list,
    get: (id: string) => list().find((c) => c.id === id),
    save(input: unknown): Coworker {
      const raw = (input ?? {}) as Record<string, unknown>;
      const parsed = coworkerSchema.parse({ rules: DEFAULT_RULES.map((r) => ({ ...r })), ...raw });
      let folder: string;
      try {
        if (!statSync(parsed.folder).isDirectory()) throw new Error();
        folder = realpathSync(parsed.folder);
      } catch {
        throw new Error('폴더를 찾을 수 없어요.');
      }
      const coworker = { ...parsed, folder };
      const all = list();
      if (all.some((c) => c.id !== coworker.id && c.folder === folder))
        throw new Error('이미 이 폴더를 맡은 동료가 있어요.');
      store.putCoworker(coworker);
      return coworker;
    },
    remove(id: string) {
      if (id === COORDINATOR_ID) throw new Error('코디네이터는 삭제할 수 없어요.');
      const all = list();
      if (!all.some((c) => c.id === id)) throw new Error('동료를 찾을 수 없어요.');
      store.deleteCoworker(id);
    },
    forFolder: (root: string) => list().find((c) => c.folder === root),
    forChannel: (channelId: string) => list().find((c) => c.bindings.includes(channelId)),
    suggestions(): { name: string; folder: string }[] {
      const taken = new Set(list().map((c) => c.folder));
      return store
        .listProjects()
        .slice(0, 5)
        .filter((p) => !taken.has(p.root))
        .map((p) => ({ name: basename(p.root), folder: p.root }));
    },
  };
}
export type Coworkers = ReturnType<typeof createCoworkers>;
