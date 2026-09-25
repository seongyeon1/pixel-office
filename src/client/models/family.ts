import type { Provider } from '../../shared/contracts';
export interface ModelFamily {
  key: string;
  provider: Provider;
  label: string;
  // Generation shown next to the family, e.g. 5.5 for Opus or GPT-6 for Astra.
  version: string;
  order: number;
}
// Display order the user asked for; it groups lists and never changes roles or permissions.
const ORDER: Record<Provider, string[]> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['astra', 'sol', 'terra', 'luna'],
};
const NEW_FAMILY = 50;
const DEFAULT = 90;
const UNKNOWN = 99;
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function modelFamily(provider: Provider, model: string): ModelFamily {
  const id = model.trim().toLowerCase();
  const make = (name: string, label: string, version = '', order?: number): ModelFamily => ({
    key: `${provider}:${name}`,
    provider,
    label,
    version,
    order: order ?? (ORDER[provider].includes(name) ? ORDER[provider].indexOf(name) : NEW_FAMILY),
  });
  if (!id) return make('unknown', '모델 정보 없음', '', UNKNOWN);
  if (id === 'default') return make('default', '기본 모델', '', DEFAULT);
  if (provider === 'claude') {
    const name = ORDER.claude.find((f) => id.split(/[-_]/).includes(f));
    if (!name) return make(id, model);
    // claude-haiku-4-5-20251001 → 4.5: short numeric parts after the family, never the date.
    const rest = id.slice(id.indexOf(name) + name.length).split('-');
    return make(name, title(name), rest.filter((p) => /^\d{1,2}$/.test(p)).join('.'));
  }
  const named = /^gpt-([\d.]+)-([a-z]+)$/.exec(id);
  if (named) return make(named[2], title(named[2]), `GPT-${named[1]}`);
  return make(id, id.replace(/^gpt/, 'GPT'));
}
export const compareFamilies = (a: ModelFamily, b: ModelFamily) =>
  a.provider.localeCompare(b.provider) || a.order - b.order || a.label.localeCompare(b.label);
