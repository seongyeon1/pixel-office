import { expect, test } from 'vitest';
import { documentReference, isMarkdown } from '../src/shared/documents.js';

test('document references resolve relative to the document, including encoded names and anchors', () => {
  expect(documentReference('docs/spec/design.md', '../images/구조%20도.png')).toEqual({
    path: 'docs/images/구조 도.png',
    hash: '',
  });
  expect(documentReference('docs/spec/design.md', '../../README.md#overview')).toEqual({
    path: 'README.md',
    hash: 'overview',
  });
  expect(documentReference('docs/design.md', '#검증')).toEqual({
    path: 'docs/design.md',
    hash: '검증',
  });
  expect(documentReference('docs/design.md', '/README.md')).toEqual({
    path: 'README.md',
    hash: '',
  });
  expect(isMarkdown('REPORT.MARKDOWN')).toBe(true);
  expect(isMarkdown('report.md.exe')).toBe(false);
});

test.each([
  '../../../outside.md',
  '%2e%2e/%2e%2e/outside.md',
  'javascript:alert(1)',
  'data:text/html,x',
  '//other.test/x',
  'https://other.test/x',
  'file:///etc/passwd',
  'bad%00.md',
  '%ZZ',
  '..\\outside.md',
])('unsafe or external document reference is not treated as a local file: %s', (url) => {
  expect(documentReference('docs/report.md', url)).toBeNull();
});
