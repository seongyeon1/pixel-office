import type { ObservedDetail } from './contracts.js';
import { documentReference, isMarkdown } from './documents.js';

// These are recorded references, not a claim that a tool call succeeded or owns the file.
export function sessionDocuments(
  session: Pick<ObservedDetail, 'projectPath' | 'cwd' | 'events'>,
  wholeSession = false,
): { path: string }[] {
  const root = session.projectPath.replace(/\/$/, '');
  const cwd =
    session.cwd === root
      ? ''
      : session.cwd.startsWith(root + '/')
        ? session.cwd.slice(root.length + 1)
        : '';
  const paths = new Set<string>();
  const add = (value: string) => {
    let path: string;
    try {
      path = decodeURIComponent(
        value
          .trim()
          .replace(/^<|>$/g, '')
          .replace(/:\d+(?::\d+)?$/, ''),
      );
    } catch {
      return;
    }
    if (path.startsWith('/')) {
      if (!path.startsWith(root + '/')) return;
      path = '/' + path.slice(root.length + 1);
    }
    // Already decoded above; escape literal % before passing through URL resolution.
    const ref = documentReference(cwd ? `${cwd}/_` : '_', path.replace(/%/g, '%25'));
    if (ref && isMarkdown(ref.path)) paths.add(ref.path);
  };
  const start = wholeSession
    ? -1
    : session.events.findLastIndex((e) => e.kind === 'request' && !!e.detail.trim());
  for (const event of session.events.slice(Math.max(0, start))) {
    if (event.kind === 'message' || event.kind === 'complete') {
      for (const match of event.detail.matchAll(
        /\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g,
      ))
        add(match[1]);
      for (const match of event.detail.matchAll(/`([^`\n]+\.(?:md|markdown|mdown)(?::\d+)?)`/gi))
        add(match[1]);
    } else if (event.kind === 'tool') {
      const tool = event.title.split('.').at(-1) ?? '';
      if (/^(Write|Edit|MultiEdit|write_file|edit_file)$/i.test(tool)) add(event.detail);
      if (/^apply_patch$/i.test(tool)) {
        for (const match of event.detail.matchAll(
          /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm,
        ))
          add(match[1]);
      }
    }
  }
  return [...paths].map((path) => ({ path }));
}
