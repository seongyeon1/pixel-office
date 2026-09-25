import { expect, test } from 'vitest';
import { normalizeModels } from '../src/server/models.js';
test('model catalog preserves provider identifiers without inferring seniority', () => {
  expect(
    normalizeModels([
      { model: 'fast-model', displayName: 'Fast', description: 'quick' },
      { value: 'deep-model', displayName: 'Deep', description: 'detailed' },
    ]),
  ).toEqual([
    { id: 'fast-model', label: 'Fast', description: 'quick' },
    { id: 'deep-model', label: 'Deep', description: 'detailed' },
  ]);
});
