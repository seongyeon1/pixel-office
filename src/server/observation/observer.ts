import { readdir, stat, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve, basename, dirname, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Activity,
  Provider,
  ObservedEvent,
  ObservedDetail,
  ObservationSnapshot,
  ObservedAttention,
  ObservedWorktree,
} from '../../shared/contracts.js';
const exec = promisify(execFile);
type RecordValue = Record<string, any>;
type Parsed = {
  sessionId?: string;
  cwd?: string;
  label?: string;
  model?: string;
  prompt?: string;
  event?: Omit<ObservedEvent, 'id'>;
  events?: Omit<ObservedEvent, 'id'>[];
  parentSessionId?: string;
  // Started by a script or hook (claude -p / SDK, codex exec) rather than by a person.
  automated?: boolean;
  toolStarts?: { id: string; name: string }[];
  toolEnds?: string[];
};
// Tools that block on a person by definition.
const QUESTION_TOOLS = new Set([
  'AskUserQuestion',
  'request_user_input',
  'request_user_input_async',
]);
const APPROVAL_TOOLS = new Set(['ExitPlanMode']);
// Tools that legitimately stay open for a long time; never guessed to be permission prompts.
const LONG_TOOLS =
  /^(Agent|Task|TaskOutput|Monitor|Workflow|wait|wait_agent|sleep|spawn_agent|send_message|followup_task)$/;
const SILENT_TOOL_MS = 60000;
// How long a waiting agent keeps its hand raised: a guess expires with the working session,
// a real question lasts one working day.
const GUESSED_WAIT_MS = 30 * 60000;
const CERTAIN_WAIT_MS = 8 * 3600000;
const text = (v: unknown, max = 2000): string =>
  typeof v === 'string'
    ? v
        .replace(/\b(sk-[a-zA-Z0-9_-]{16,})\b/g, '[redacted]')
        .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[redacted]')
        .replace(
          /((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*["']?)[^\s"',;]+/gi,
          '$1[redacted]',
        )
        .slice(0, max)
    : '';
const object = (v: unknown): RecordValue =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : {};
function activity(name: string): Activity {
  if (/edit|write|patch|delete|move/i.test(name)) return 'editing';
  if (/read|view|search|grep|glob|list|find|open/i.test(name)) return 'reading';
  if (/bash|shell|exec|terminal|command/i.test(name)) return 'executing';
  return 'responding';
}
function toolDetail(input: unknown): string {
  let obj = object(input);
  if (typeof input === 'string') {
    try {
      obj = object(JSON.parse(input));
    } catch {
      return text(input, 1000);
    }
  }
  return text(
    obj.command ??
      obj.cmd ??
      obj.file_path ??
      obj.path ??
      obj.pattern ??
      obj.query ??
      obj.description ??
      '',
    1000,
  );
}
// Only visible messages and tool summaries are retained. Thinking, instructions and raw outputs are omitted.
export function parseRecord(provider: Provider, row: RecordValue): Parsed {
  const timestamp =
    typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))
      ? row.timestamp
      : '';
  const event = (
    kind: ObservedEvent['kind'],
    title: string,
    detail: unknown,
    a: Activity,
  ): Omit<ObservedEvent, 'id'> => ({
    timestamp,
    kind,
    title,
    detail: text(detail, 6000),
    activity: a,
  });
  if (provider === 'codex') {
    const p = object(row.payload);
    if (row.type === 'session_meta')
      return {
        sessionId: text(p.id ?? p.session_id, 150),
        cwd: text(p.cwd, 4096),
        label: text(p.agent_nickname ?? p.agent_path, 150),
        parentSessionId: text(p.parent_thread_id, 150) || undefined,
        automated: p.source === 'exec' || /exec/.test(String(p.originator ?? '')),
      };
    if (row.type === 'turn_context') return { model: text(p.model, 100), cwd: text(p.cwd, 4096) };
    if (row.type === 'event_msg') {
      if (p.type === 'task_started')
        return { event: event('request', '작업 시작', '', 'responding') };
      if (p.type === 'user_message')
        return {
          prompt: text(p.message, 500),
          event: event('request', '작업 요청', p.message, 'responding'),
        };
      if (p.type === 'agent_message')
        return { event: event('message', '작업 메시지', p.message, 'responding') };
      if (['task_complete', 'task_completed', 'turn_aborted'].includes(p.type))
        return {
          event: event(
            'complete',
            p.type === 'turn_aborted' ? '응답 중단' : '응답 완료',
            p.last_agent_message,
            'idle',
          ),
        };
    }
    if (row.type === 'response_item') {
      if (['function_call', 'custom_tool_call'].includes(p.type))
        return {
          toolStarts: p.call_id ? [{ id: String(p.call_id), name: text(p.name, 100) }] : [],
          event: event(
            'tool',
            text(p.name, 100),
            toolDetail(p.arguments ?? p.input),
            activity(String(p.name)),
          ),
        };
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type))
        return {
          toolEnds: p.call_id ? [String(p.call_id)] : [],
          event: event(
            'result',
            '도구 결과 수신',
            '원본 출력은 해당 세션에서 확인할 수 있어요.',
            'responding',
          ),
        };
      if (
        p.type === 'message' &&
        p.role === 'assistant' &&
        p.phase !== 'analysis' &&
        p.channel !== 'analysis'
      ) {
        const content = Array.isArray(p.content) ? p.content : [];
        const visible = content
          .filter((c: RecordValue) => ['output_text', 'text'].includes(c.type))
          .map((c: RecordValue) => text(c.text, 6000))
          .join('\n');
        return visible ? { event: event('message', '작업 메시지', visible, 'responding') } : {};
      }
      if (p.type === 'message' && p.role === 'user') {
        const content = Array.isArray(p.content) ? p.content : [];
        const visible = content
          .filter((c: RecordValue) => ['input_text', 'text'].includes(c.type))
          .map((c: RecordValue) => text(c.text, 500))
          .join('\n');
        // Injected environment/instruction messages are not user tasks.
        if (visible && !/^\s*(<|# (AGENTS|Instructions))/.test(visible))
          return {
            prompt: text(visible, 500),
            event: event('request', '작업 요청', visible, 'responding'),
          };
      }
    }
    return {};
  }
  const m = object(row.message);
  const parsed: Parsed = {};
  if (row.cwd) parsed.cwd = text(row.cwd, 4096);
  if (row.sessionId) parsed.sessionId = text(row.sessionId, 150);
  if (m.model) parsed.model = text(m.model, 100);
  if (row.agentId) parsed.label = text(row.agentId, 100);
  // Interactive sessions record cli; claude -p and every SDK (sdk-cli, sdk-ts, sdk-py) record sdk-*.
  if (typeof row.entrypoint === 'string') parsed.automated = row.entrypoint.startsWith('sdk-');
  if (row.type === 'system' && row.subtype === 'turn_duration')
    parsed.event = event('complete', '응답 완료', '', 'idle');
  if (row.type === 'user' && !row.isMeta && typeof m.content === 'string') {
    parsed.prompt = text(m.content, 500);
    parsed.event = event('request', '작업 요청', m.content, 'responding');
  }
  if (Array.isArray(m.content)) {
    const events: Omit<ObservedEvent, 'id'>[] = [];
    const starts: { id: string; name: string }[] = [];
    const ends: string[] = [];
    for (const c of m.content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use' && c.id) starts.push({ id: String(c.id), name: text(c.name, 100) });
      if (c.type === 'tool_result' && c.tool_use_id) ends.push(String(c.tool_use_id));
      if (c.type === 'tool_use')
        events.push(
          event('tool', text(c.name, 100), toolDetail(c.input), activity(String(c.name))),
        );
      if (c.type === 'tool_result')
        events.push(
          event(
            'result',
            c.is_error ? '도구 오류' : '도구 결과 수신',
            '원본 출력은 해당 세션에서 확인할 수 있어요.',
            'responding',
          ),
        );
      if (c.type === 'text' && row.type === 'assistant')
        events.push(
          event(
            m.stop_reason === 'end_turn' ? 'complete' : 'message',
            m.stop_reason === 'end_turn' ? '응답 완료' : '작업 메시지',
            c.text,
            m.stop_reason === 'end_turn' ? 'idle' : 'responding',
          ),
        );
      if (c.type === 'text' && row.type === 'user' && !row.isMeta) {
        parsed.prompt = text(c.text, 500);
        events.push(event('request', '작업 요청', c.text, 'responding'));
      }
    }
    if (events.length) {
      parsed.events = events;
      parsed.event = events.at(-1);
    }
    if (starts.length) parsed.toolStarts = starts;
    if (ends.length) parsed.toolEnds = ends;
  }
  return parsed;
}
interface Cursor {
  file: string;
  provider: Provider;
  inode: number;
  offset: number;
  carry: Buffer;
  info: ObservedDetail;
  openTurn: boolean;
  lastActivity: number;
  cwd: string;
  ignored: boolean;
  // Tool calls without a result yet, by call id.
  pending: Map<string, { name: string; since: number; timestamp: string }>;
  subagent: boolean;
  parentKey: string;
}
interface Options {
  codexHome?: string;
  claudeHome?: string;
  excludeRoots?: string[];
  now?: () => number;
  maxSessions?: number;
}
const within = (root: string, path: string) => {
  const r = relative(root, path);
  return !r || (!r.startsWith('..') && !isAbsolute(r));
};
const READ_LIMIT = 512 * 1024;
export function createObservation(options: Options = {}) {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const claudeHome =
    options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const now = options.now ?? Date.now;
  const excluded = Promise.all(
    (options.excludeRoots ?? []).map((root) => realpath(root).catch(() => resolve(root))),
  );
  const maxSessions = options.maxSessions ?? 200;
  const cursors = new Map<string, Cursor>();
  // Remembered past cursor eviction, so a known hook log never takes a person's slot again.
  const automatedFiles = new Set<string>();
  type Location = { canonical: string; root: string; worktree?: ObservedWorktree };
  const roots = new Map<string, Location & { checked: number }>();
  let warnings: string[] = [],
    scannedAt: string | null = null,
    flight: Promise<void> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false,
    lastDiscovery = 0;
  let candidates: { file: string; provider: Provider; mtime: number; priority: number }[] = [];
  const worktrees = async (dir: string) => {
    const { stdout } = await exec('git', ['-C', dir, 'worktree', 'list', '--porcelain', '-z'], {
      timeout: 2000,
      maxBuffer: 256 * 1024,
    });
    const list: { path: string; branch: string }[] = [];
    for (const field of stdout.split('\0')) {
      if (field.startsWith('worktree ')) {
        const path = field.slice(9);
        list.push({ path: await realpath(path).catch(() => resolve(path)), branch: '' });
      } else if (field.startsWith('branch ') && list.length)
        list[list.length - 1].branch = field.slice(7).replace(/^refs\/heads\//, '');
      else if (field === 'detached' && list.length) list[list.length - 1].branch = 'detached';
    }
    if (!list.length) throw new Error('no worktrees');
    return list;
  };
  const locate = async (cwd: string): Promise<Location> => {
    const known = roots.get(cwd);
    if (known && now() - known.checked < 60000) return known;
    // Resolve through the nearest surviving folder so removed worktrees keep their repository.
    let base = resolve(cwd);
    while (base !== dirname(base) && !(await stat(base).catch(() => null))) base = dirname(base);
    const real = await realpath(base).catch(() => base);
    const canonical = join(real, relative(base, resolve(cwd)));
    const missing = base !== resolve(cwd);
    if (missing && known) {
      roots.set(cwd, { ...known, checked: now() });
      return known;
    }
    let found: Location = { canonical, root: canonical };
    try {
      const list = await worktrees(real);
      const own = list
        .filter((w) => within(w.path, canonical))
        .sort((a, b) => b.path.length - a.path.length)[0];
      found = {
        canonical,
        root: list[0].path,
        worktree:
          own && !(missing && own === list[0])
            ? { path: own.path, branch: own.branch, main: own === list[0] }
            : { path: canonical, branch: '', main: false },
      };
    } catch {
      /* Non-Git folders retain their observed working directory. */
    }
    roots.set(cwd, { ...found, checked: now() });
    return found;
  };
  const discover = async () => {
    const found: typeof candidates = [];
    const registry = await processRegistry();
    const openClaude = new Set([...registry].filter(([, alive]) => alive).map(([id]) => id));
    const locks = (await readdir(join(codexHome, 'thread-writer-locks')).catch(() => []))
      .filter((name) => name.endsWith('.lock'))
      .map((name) => name.slice(0, -5));
    for (const [provider, root] of [
      ['codex', join(codexHome, 'sessions')],
      ['claude', join(claudeHome, 'projects')],
    ] as const) {
      let visited = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 8 || visited > 20000) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const ent of entries) {
          if (++visited > 20000) break;
          const file = join(dir, ent.name);
          if (ent.isDirectory()) await walk(file, depth + 1);
          else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
            const st = await stat(file).catch(() => null);
            const priority =
              provider === 'claude'
                ? openClaude.has(basename(file, '.jsonl'))
                  ? 2
                  : 0
                : locks.some((id) => ent.name.includes(id))
                  ? 1
                  : 0;
            if (st && (priority || st.mtimeMs > now() - 7 * 86400000))
              found.push({
                file,
                provider,
                mtime: st.mtimeMs,
                priority: automatedFiles.has(file) ? -1 : priority,
              });
          }
        }
      };
      try {
        await stat(root);
        await walk(root, 0);
      } catch {
        warnings.push(`${provider === 'codex' ? 'Codex' : 'Claude'} 세션 폴더를 찾을 수 없습니다.`);
      }
      if (visited > 20000) warnings.push('세션 파일이 많아 일부 폴더만 탐색했습니다.');
    }
    found.sort((a, b) => b.priority - a.priority || b.mtime - a.mtime);
    if (found.length > maxSessions) warnings.push(`최근 세션 ${maxSessions}개를 관측합니다.`);
    candidates = found.slice(0, maxSessions);
    lastDiscovery = now();
    const keep = new Set(candidates.map((c) => c.file));
    for (const file of cursors.keys()) if (!keep.has(file)) cursors.delete(file);
  };
  const fresh = (file: string, provider: Provider, inode: number): Cursor => ({
    file,
    provider,
    inode,
    offset: 0,
    carry: Buffer.alloc(0),
    cwd: '',
    openTurn: false,
    lastActivity: 0,
    ignored: false,
    pending: new Map(),
    subagent: provider === 'claude' && file.includes(`${sep}subagents${sep}`),
    parentKey: '',
    info: {
      id:
        'observed-' +
        createHash('sha256')
          .update(provider + file)
          .digest('hex')
          .slice(0, 24),
      sessionId: basename(file, '.jsonl'),
      provider,
      projectPath: '',
      cwd: '',
      label: basename(file).startsWith('agent-') ? basename(file, '.jsonl') : '',
      prompt: '',
      model: '',
      status: 'stale',
      activity: 'idle',
      updatedAt: '',
      processAlive: null,
      truncated: false,
      events: [],
    },
  });
  const consume = (cursor: Cursor, buffer: Buffer) => {
    const data = Buffer.concat([cursor.carry, buffer]);
    let start = 0;
    for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
      const raw = data.subarray(start, end);
      start = end + 1;
      if (raw.length > READ_LIMIT) {
        cursor.info.truncated = true;
        continue;
      }
      try {
        const parsed = parseRecord(cursor.provider, JSON.parse(raw.toString('utf8')));
        if (parsed.cwd && isAbsolute(parsed.cwd)) cursor.cwd = parsed.cwd;
        if (parsed.sessionId) cursor.info.sessionId = parsed.sessionId;
        if (parsed.model) cursor.info.model = parsed.model;
        if (parsed.label) cursor.info.label = parsed.label;
        if (parsed.prompt) cursor.info.prompt = parsed.prompt;
        if (parsed.automated !== undefined) {
          cursor.info.automated = parsed.automated;
          if (parsed.automated) automatedFiles.add(cursor.file);
        }
        if (parsed.parentSessionId) {
          cursor.subagent = true;
          cursor.parentKey = parsed.parentSessionId;
        }
        const stamp = Date.parse(parsed.event?.timestamp ?? '');
        // A finished or newly requested turn abandons whatever the previous turn was waiting on.
        if (
          (parsed.events ?? (parsed.event ? [parsed.event] : [])).some(
            (e) => e.kind === 'complete' || e.kind === 'request',
          )
        )
          cursor.pending.clear();
        for (const id of parsed.toolEnds ?? []) cursor.pending.delete(id);
        if (Number.isFinite(stamp))
          for (const t of parsed.toolStarts ?? [])
            cursor.pending.set(t.id, {
              name: t.name,
              since: stamp,
              timestamp: parsed.event!.timestamp,
            });
        for (const item of parsed.events ?? (parsed.event ? [parsed.event] : [])) {
          if (!item.timestamp) continue;
          const stamp = Date.parse(item.timestamp);
          cursor.info.events.push({
            ...item,
            id: createHash('sha1')
              .update(raw)
              .update(String(cursor.info.events.length))
              .digest('hex')
              .slice(0, 20),
          });
          cursor.info.events = cursor.info.events.slice(-80);
          if (stamp >= cursor.lastActivity) {
            cursor.lastActivity = stamp;
            cursor.openTurn = item.kind !== 'complete';
            cursor.info.activity = item.activity;
            cursor.info.updatedAt = item.timestamp;
          }
        }
      } catch {
        /* Partial/unknown/malformed log records do not stop observation. */
      }
    }
    cursor.carry = data.subarray(start);
    if (cursor.carry.length > READ_LIMIT) {
      cursor.carry = Buffer.alloc(0);
      cursor.info.truncated = true;
    }
  };
  const attentionOf = (c: Cursor): ObservedAttention | null => {
    const pending = [...c.pending.values()];
    const certain = (kind: ObservedAttention['kind'], names: Set<string>) => {
      const hit = pending.find((p) => names.has(p.name));
      return hit ? { kind, certain: true, since: hit.timestamp } : null;
    };
    const silent = pending.find(
      (p) =>
        !LONG_TOOLS.test(p.name) &&
        now() - p.since >= SILENT_TOOL_MS &&
        now() - c.lastActivity >= SILENT_TOOL_MS,
    );
    return (
      certain('question', QUESTION_TOOLS) ??
      certain('approval', APPROVAL_TOOLS) ??
      (silent ? { kind: 'approval', certain: false, since: silent.timestamp } : null)
    );
  };
  const readCursor = async (file: string, provider: Provider) => {
    const st = await stat(file);
    let c = cursors.get(file);
    if (!c || c.inode !== st.ino || st.size < c.offset) {
      c = fresh(file, provider, st.ino);
      cursors.set(file, c);
    }
    if (c.ignored) return;
    const handle = await open(file, 'r');
    try {
      if (c.offset === 0 && st.size > READ_LIMIT) {
        const head = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        consume(c, head.subarray(0, bytesRead));
        c.offset = Math.max(bytesRead, st.size - READ_LIMIT);
        const partial = c.offset > bytesRead || c.carry.length > 0;
        c.carry = Buffer.alloc(0);
        c.info.events = [];
        c.info.truncated = true;
        // Starting in the middle of a record: discard through its first newline.
        const tail = Buffer.alloc(st.size - c.offset);
        await handle.read(tail, 0, tail.length, c.offset);
        const boundary = tail.indexOf(10);
        if (!partial) consume(c, tail);
        else if (boundary >= 0) consume(c, tail.subarray(boundary + 1));
        c.offset = st.size;
      } else if (st.size > c.offset) {
        if (st.size - c.offset > READ_LIMIT) {
          c.offset = st.size - READ_LIMIT;
          c.carry = Buffer.alloc(0);
          c.info.truncated = true;
          const b = Buffer.alloc(READ_LIMIT);
          const read = await handle.read(b, 0, b.length, c.offset);
          const end = b.indexOf(10);
          if (end >= 0) consume(c, b.subarray(end + 1, read.bytesRead));
          c.offset += read.bytesRead;
        } else {
          const b = Buffer.alloc(st.size - c.offset);
          const read = await handle.read(b, 0, b.length, c.offset);
          consume(c, b.subarray(0, read.bytesRead));
          c.offset += read.bytesRead;
        }
      }
    } finally {
      await handle.close();
    }
    if (c.cwd) {
      const location = await locate(c.cwd);
      c.ignored = (await excluded).some((r) => within(r, location.canonical));
      if (!c.ignored) {
        c.info.cwd = location.canonical;
        c.info.projectPath = location.root;
        c.info.worktree = location.worktree;
      }
    }
    if (c.subagent && !c.parentKey) c.parentKey = c.info.sessionId;
  };
  // Runs after the process registry so a closed terminal cannot keep asking.
  const settle = (c: Cursor) => {
    let attention = c.openTurn && c.info.processAlive !== false ? attentionOf(c) : null;
    const quiet = now() - c.lastActivity;
    if (attention && quiet > (attention.certain ? CERTAIN_WAIT_MS : GUESSED_WAIT_MS))
      attention = null;
    c.info.attention = attention;
    c.info.status = c.openTurn
      ? quiet < 120000 || attention?.certain
        ? 'active'
        : 'stale'
      : c.lastActivity
        ? 'idle'
        : 'stale';
    if (c.info.status !== 'active') c.info.activity = 'idle';
  };
  const processRegistry = async () => {
    const alive = new Map<string, boolean>();
    const dir = join(claudeHome, 'sessions');
    for (const name of await readdir(dir).catch(() => [])) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        if ((await stat(join(dir, name))).size > 32768) continue;
        const p = object(JSON.parse(await readFile(join(dir, name), 'utf8')));
        if (typeof p.sessionId !== 'string' || !Number.isSafeInteger(p.pid) || p.pid < 1) continue;
        let running = false;
        try {
          process.kill(p.pid, 0);
          running = true;
        } catch {
          /* Probe only, never terminate. */
        }
        alive.set(p.sessionId, running);
      } catch {
        /* Session registry is optional. */
      }
    }
    return alive;
  };
  const updateProcesses = async () => {
    const alive = await processRegistry();
    for (const c of cursors.values()) {
      c.info.processAlive = c.provider === 'claude' ? (alive.get(c.info.sessionId) ?? null) : null;
      settle(c);
    }
  };
  const scan = () => {
    if (closed) return Promise.resolve();
    if (flight) return flight;
    flight = (async () => {
      if (!lastDiscovery || now() - lastDiscovery > 10000) {
        warnings = [];
        await discover();
      }
      let unreadable = 0;
      for (const c of candidates) {
        try {
          await readCursor(c.file, c.provider);
        } catch {
          unreadable++;
          cursors.delete(c.file);
        }
      }
      await updateProcesses();
      if (unreadable)
        warnings = [
          ...warnings.filter((w) => !w.startsWith('읽지 못한')),
          `읽지 못한 세션 ${unreadable}개는 다음 갱신에서 다시 확인합니다.`,
        ];
      scannedAt = new Date(now()).toISOString();
    })().finally(() => {
      flight = null;
    });
    return flight;
  };
  const list = (): ObservationSnapshot => {
    const visible = [...cursors.values()].filter((c) => !c.ignored && c.info.projectPath);
    const leads = new Map(
      visible
        .filter((c) => !c.subagent)
        .map((c) => [`${c.provider}:${c.info.sessionId}`, c.info.id]),
    );
    return {
      sessions: visible
        .map((c) => {
          const { events, ...summary } = c.info;
          const parentId = c.subagent ? leads.get(`${c.provider}:${c.parentKey}`) : undefined;
          return parentId ? { ...summary, parentId } : summary;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      scannedAt,
      scanning: !!flight,
      warnings: [...warnings],
    };
  };
  return {
    scan,
    list,
    get(id: string) {
      const c = [...cursors.values()].find(
        (c) => c.info.id === id && !c.ignored && c.info.projectPath,
      );
      return c ? structuredClone(c.info) : undefined;
    },
    start() {
      const tick = async () => {
        try {
          await scan();
        } catch {
          warnings = ['세션 탐색 중 오류가 발생했습니다. 다음 갱신에서 다시 확인합니다.'];
        }
        if (!closed) timer = setTimeout(tick, 2000);
      };
      void tick();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
export type Observation = ReturnType<typeof createObservation>;
