import { expect, test } from 'vitest';
import { modelFamily, compareFamilies } from '../src/client/models/family.js';
test('observed model ids resolve to a family and version', () => {
  expect(modelFamily('claude', 'claude-opus-5-5')).toMatchObject({
    key: 'claude:opus',
    label: 'Opus',
    version: '5.5',
  });
  expect(modelFamily('claude', 'claude-haiku-4-5-20251001')).toMatchObject({
    label: 'Haiku',
    version: '4.5',
  });
  expect(modelFamily('claude', 'claude-fable-5-1')).toMatchObject({
    label: 'Fable',
    version: '5.1',
  });
  expect(modelFamily('claude', 'claude-opus-5')).toMatchObject({ label: 'Opus', version: '5' });
  expect(modelFamily('claude', 'sonnet')).toMatchObject({ label: 'Sonnet', version: '' });
  expect(modelFamily('codex', 'gpt-6-astra')).toMatchObject({
    key: 'codex:astra',
    label: 'Astra',
    version: 'GPT-6',
  });
  expect(modelFamily('codex', 'gpt-5.6-sol')).toMatchObject({ label: 'Sol', version: 'GPT-5.6' });
  expect(modelFamily('codex', 'gpt-5.5')).toMatchObject({ key: 'codex:gpt-5.5', label: 'GPT-5.5' });
  expect(modelFamily('claude', '')).toMatchObject({
    key: 'claude:unknown',
    label: '모델 정보 없음',
  });
  expect(modelFamily('codex', 'default')).toMatchObject({
    key: 'codex:default',
    label: '기본 모델',
  });
  expect(modelFamily('claude', 'default')).toMatchObject({
    key: 'claude:default',
    label: '기본 모델',
  });
});
test('families sort in the stated display order per provider, unknown last', () => {
  const ids: ['claude' | 'codex', string][] = [
    ['codex', 'gpt-6-luna'],
    ['claude', 'claude-haiku-4-5'],
    ['claude', ''],
    ['codex', 'gpt-6-astra'],
    ['claude', 'claude-opus-5-5'],
    ['codex', 'gpt-6-sol'],
    ['claude', 'claude-fable-5-1'],
    ['codex', 'gpt-9-nova'],
  ];
  expect(
    ids
      .map(([p, m]) => modelFamily(p, m))
      .sort(compareFamilies)
      .map((f) => f.label),
  ).toEqual(['Fable', 'Opus', 'Haiku', '모델 정보 없음', 'Astra', 'Sol', 'Luna', 'Nova']);
});
