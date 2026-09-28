import type { Change, ObservedDetail, ObservedEvent, OfficeEvent, Run } from './contracts.js';
import { documentReference, isMarkdown } from './documents.js';

// Git's change list omits ignored reports and documents already committed during a task.
// Keep explicit answer references as well, using the same workspace boundary as sessions.
export function runDocuments(
  run: Pick<Run, 'worktreePath' | 'summary'>,
  events: OfficeEvent[],
  changes: Change[],
) {
  const messages: ObservedEvent[] = [];
  const add = (text: unknown) => {
    if (typeof text === 'string' && text.trim())
      messages.push({
        id: '',
        timestamp: '',
        kind: 'message',
        title: '',
        detail: text,
        activity: 'idle',
      });
  };
  add(run.summary);
  const streams = new Map<string, string>();
  for (const event of events) {
    const key = event.agentId ?? '';
    if (event.type === 'phase.started') {
      add(streams.get(key));
      streams.delete(key);
    }
    if (event.type === 'message') {
      if (event.payload.delta === true && typeof event.payload.text === 'string')
        streams.set(key, (streams.get(key) ?? '') + event.payload.text);
      else add(event.payload.text);
    }
    if (event.type === 'phase.completed' || event.type === 'agent.result') add(event.payload.text);
    const item = event.payload.item;
    if (
      event.type === 'tool.completed' &&
      item &&
      typeof item === 'object' &&
      'type' in item &&
      item.type === 'agentMessage' &&
      'text' in item
    )
      add(item.text);
  }
  for (const text of streams.values()) add(text);
  const references = sessionDocuments(
    { projectPath: run.worktreePath, cwd: run.worktreePath, events: messages },
    true,
  );
  const deleted = new Set(changes.filter((c) => c.status === 'deleted').map((c) => c.path));
  return [
    ...new Set([
      ...references.map((d) => d.path),
      ...changes.filter((c) => isMarkdown(c.path)).map((c) => c.path),
    ]),
  ].filter((path) => !deleted.has(path));
}

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
