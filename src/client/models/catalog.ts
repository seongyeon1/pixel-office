import { useSyncExternalStore } from 'react';
import { api } from '../api';
import type { Provider } from '../../shared/contracts';
import { modelFamily } from './family';
export interface CatalogModel {
  id: string;
  label: string;
  description: string;
}
type Catalog = Partial<Record<Provider, CatalogModel[]>>;
// One fetch per provider per page load; the server caches the CLI catalog for five minutes.
let catalog: Catalog = {};
const listeners = new Set<() => void>();
let requested = false;
function load() {
  if (requested) return;
  requested = true;
  for (const provider of ['claude', 'codex'] as const)
    api<{ models: CatalogModel[] }>(`/models/${provider}`)
      .then((r) => {
        catalog = { ...catalog, [provider]: r.models };
        for (const l of listeners) l();
      })
      .catch(() => {
        /* Families still resolve from the model id; only descriptions are missing. */
      });
}
export function useModelCatalog(): Catalog {
  return useSyncExternalStore(
    (l) => {
      load();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => catalog,
  );
}
// The provider's own words for a model: exact id first, then the same family.
export function describeModel(c: Catalog, provider: Provider, model: string): string {
  const models = c[provider] ?? [];
  const exact = models.find((m) => m.id === model);
  if (exact) return exact.description;
  const family = modelFamily(provider, model).key;
  return models.find((m) => modelFamily(provider, m.id).key === family)?.description ?? '';
}
