import type { LaunchedAgent } from '../shared/launcher.js';
import type { Store } from './store.js';
import {
  terminal,
  type ObservedDetail,
  type ObservationSnapshot,
  type OfficeEvent,
  type Provider,
  type Run,
} from '../shared/contracts.js';
type Source = { list(): ObservationSnapshot; get(id: string): ObservedDetail | undefined };
const empty = (): ObservationSnapshot => ({
  sessions: [],
  scannedAt: null,
  scanning: false,
  warnings: [],
});
const key = (provider: Provider, id: string) => `${provider}:${id}`;
function history(run: Run, provider: Provider, events: OfficeEvent[]): ObservedDetail['events'] {
  return [
    {
      id: `${run.id}:request`,
      timestamp: run.createdAt,
      kind: 'request',
      title: '작업 요청',
      detail: run.prompt,
      activity: 'responding',
    },
    ...events
      .filter((e) => e.agentId === provider && ['activity', 'phase.completed'].includes(e.type))
      .map((e) => ({
        id: e.eventId,
        timestamp: e.timestamp,
        kind: e.type === 'activity' ? ('tool' as const) : ('complete' as const),
        title: e.type === 'activity' ? String(e.payload.tool ?? '도구 실행') : '업무 결과',
        detail:
          e.type === 'activity'
            ? JSON.stringify(e.payload.input ?? e.payload.item ?? {})
            : String(e.payload.text ?? ''),
        activity: e.type === 'activity' ? ('executing' as const) : ('idle' as const),
      })),
  ];
}
// App tasks and native logs resolve to one coworker identity and one conversation API.
export function createSessionRegistry(store: Store, source?: Source): Source {
  const build = () => {
    const snapshot = source?.list?.() ?? empty();
    const native = new Map(snapshot.sessions.map((s) => [key(s.provider, s.sessionId), s]));
    const linked = new Set<string>();
    const managed = new Map<string, ObservedDetail>();
    const identities = store.getSetting<{
      roles: Record<string, string>;
      native: Record<string, string>;
    }>('coworker-identities', { roles: {}, native: {} });
    const beforeIdentities = JSON.stringify(identities);
    for (const run of store.listRuns().reverse()) {
      const events = store.recentEvents(run.id, 10000);
      const refs: Array<{
        provider: Provider;
        role: 'implementer' | 'reviewer';
        nativeId?: string;
      }> = [];
      for (const provider of ['codex', 'claude'] as const) {
        if (run.sessions?.[provider]) {
          for (const [role, nativeId] of Object.entries(run.sessions[provider]!))
            refs.push({ provider, role: role as 'implementer' | 'reviewer', nativeId });
        } else {
          const role =
            run.mode === 'collaborate' && run.implementer !== provider ? 'reviewer' : 'implementer';
          const sessionEvents = events.filter(
            (e) => e.agentId === provider && e.type === 'agent.session',
          );
          const ids = [
            ...new Set(
              sessionEvents
                .map((e) => e.payload.sessionId)
                .filter((id): id is string => typeof id === 'string'),
            ),
          ];
          if (ids.length) for (const nativeId of ids) refs.push({ provider, role, nativeId });
          else if (run.mode === 'collaborate' || run.mode === provider)
            refs.push({ provider, role });
        }
      }
      for (const ref of refs) {
        const { provider, role, nativeId } = ref;
        const roleKey = `${run.id}:${provider}:${role}`;
        const id =
          identities.roles[roleKey] ??
          (nativeId ? identities.native[key(provider, nativeId)] : undefined) ??
          `app-${run.id}-${provider}-${role}`;
        identities.roles[roleKey] = id;
        if (nativeId) identities.native[key(provider, nativeId)] = id;
        if (nativeId) linked.add(key(provider, nativeId));
        const continued = store.directLink(id);
        if (continued) linked.add(key(provider, continued));
        const log = native.get(key(provider, continued ?? nativeId ?? ''));
        const detail = log ? source?.get(log.id) : undefined;
        const workspaceRemoved = !!run.removedWorktrees?.length;
        const phaseActive = !terminal(run.status);
        const currentProvider =
          run.mode === 'collaborate'
            ? run.phase === 'review'
              ? run.implementer === 'codex'
                ? 'claude'
                : 'codex'
              : run.implementer
            : run.mode;
        const current =
          phaseActive &&
          provider === currentProvider &&
          role === (run.phase === 'review' ? 'reviewer' : 'implementer');
        const providerEvents = events.filter((e) => e.agentId === provider);
        const messages = store.listChat(id);
        const pending = messages.some((m) => m.status === 'pending' && m.channel !== 'records');
        const recent = messages.filter((m) => m.channel !== 'records');
        const last = providerEvents.at(-1);
        const updatedAt = [
          run.createdAt,
          last?.timestamp ?? '',
          log?.updatedAt ?? '',
          recent.at(-1)?.createdAt ?? '',
        ]
          .sort()
          .at(-1)!;
        const request = recent.filter((m) => m.role === 'user').at(-1);
        const active = current || pending;
        const resumable =
          !!continued ||
          (!!nativeId && (provider === 'claude' || run.executionMode === 'personal'));
        const ownHistory = history(run, provider, events);
        managed.set(id, {
          ...log,
          id,
          sessionId: continued ?? nativeId ?? id,
          provider,
          projectPath: run.projectPath,
          cwd: run.worktreePath,
          label: `${role === 'reviewer' ? '검토' : '구현'} · ${run.id.slice(0, 8)}`,
          prompt: request?.text ?? run.prompt,
          model:
            log?.model ||
            String(
              providerEvents.findLast((e) => e.type === 'agent.session')?.payload.model ??
                run.team[provider].model ??
                '',
            ),
          status: active ? 'active' : log?.status === 'active' ? 'active' : 'idle',
          activity: active ? (role === 'reviewer' ? 'reviewing' : 'responding') : 'idle',
          updatedAt,
          processAlive: workspaceRemoved
            ? false
            : active
              ? true
              : log?.processAlive === true
                ? true
                : null,
          truncated: log?.truncated ?? false,
          automated: false,
          attention:
            current && (run.status === 'waiting_approval' || run.status === 'waiting_input')
              ? {
                  kind: run.status === 'waiting_input' ? 'question' : 'approval',
                  certain: true,
                  since: updatedAt,
                }
              : null,
          worktree: {
            path: run.worktreePath,
            branch: run.branch,
            main: run.worktreePath === run.projectPath,
          },
          managed: {
            runId: run.id,
            role,
            executionMode: run.executionMode ?? 'isolated',
            resumable,
            workspaceRemoved,
            busy: phaseActive,
          },
          events: [
            ...(detail?.events.length ? detail.events : ownHistory),
            ...recent.map((m) => ({
              id: `chat:${m.id}`,
              timestamp: m.createdAt,
              kind:
                m.role === 'user'
                  ? ('request' as const)
                  : m.status === 'pending'
                    ? ('message' as const)
                    : ('complete' as const),
              title: m.role === 'user' ? '개별 요청' : '개별 답변',
              detail: m.text,
              activity: m.status === 'pending' ? ('responding' as const) : ('idle' as const),
            })),
          ].slice(-300),
        });
      }
    }
    if (JSON.stringify(identities) !== beforeIdentities)
      store.setSetting('coworker-identities', identities);
    const launches = store.getSetting<{ agents: LaunchedAgent[] }>('launched-agents', {
      agents: [],
    }).agents;
    let updatedLaunches = false;
    for (const launch of launches) {
      const id = `launch-${launch.id}`;
      const known =
        store.directLink(id) ??
        launch.sessionId ??
        (launch.provider === 'claude' ? launch.id : undefined);
      const found = known
        ? native.get(key(launch.provider, known))
        : snapshot.sessions.find(
            (s) =>
              s.provider === launch.provider &&
              s.cwd === launch.root &&
              !linked.has(key(s.provider, s.sessionId)) &&
              (s.prompt.includes(`pixel-office-launch:${launch.id}`) ||
                source
                  ?.get(s.id)
                  ?.events.some(
                    (e) =>
                      e.kind === 'request' && e.detail.includes(`pixel-office-launch:${launch.id}`),
                  )),
          );
      if (found && launch.sessionId !== found.sessionId) {
        launch.sessionId = found.sessionId;
        updatedLaunches = true;
      }
      if (found) linked.add(key(found.provider, found.sessionId));
      const detail = found ? source?.get(found.id) : undefined;
      const recent = store.listChat(id).filter((m) => m.channel !== 'records');
      managed.set(id, {
        ...found,
        id,
        sessionId: found?.sessionId ?? known ?? id,
        provider: launch.provider,
        projectPath: launch.root,
        cwd: launch.root,
        label: found?.label || `동료 · ${launch.id.slice(0, 8)}`,
        prompt:
          recent.filter((m) => m.role === 'user').at(-1)?.text ??
          (found?.prompt.includes('pixel-office-launch:') ? launch.prompt : found?.prompt) ??
          launch.prompt,
        model: found?.model || launch.model || '',
        status: found?.status ?? 'stale',
        activity: found?.activity ?? 'idle',
        updatedAt: [launch.createdAt, found?.updatedAt ?? '', recent.at(-1)?.createdAt ?? '']
          .sort()
          .at(-1)!,
        processAlive: found?.processAlive ?? null,
        truncated: found?.truncated ?? false,
        automated: false,
        launched: {
          launchId: launch.id,
          terminalId: launch.terminal.id,
          resumable: !!found || !!launch.sessionId,
        },
        events: detail?.events.map((e) => ({
          ...e,
          detail: e.detail.replace(/^<!-- pixel-office-launch:[^>]+-->\s*/, ''),
        })) ?? [
          {
            id: `${id}:request`,
            timestamp: launch.createdAt,
            kind: 'request',
            activity: 'responding',
            title: '처음 맡긴 일',
            detail: launch.prompt,
          },
        ],
      });
    }
    if (updatedLaunches) store.setSetting('launched-agents', { agents: launches });
    return { snapshot, managed, linked };
  };
  return {
    list() {
      const { snapshot, managed, linked } = build();
      return {
        ...snapshot,
        sessions: [
          ...snapshot.sessions.filter((s) => !linked.has(key(s.provider, s.sessionId))),
          ...[...managed.values()].map(({ events, ...s }) => s),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      };
    },
    get(id) {
      return build().managed.get(id) ?? source?.get(id);
    },
  };
}

export function continuationContext(session: ObservedDetail): string {
  return `이전 앱 작업은 원본 대화 세션을 재개할 수 없어 보관된 작업 기록으로 새 대화를 시작합니다. 같은 작업 폴더의 기존 변경을 보존하세요. 아래 내용은 과거 기록이며 현재 요청이 우선합니다.\n<previous_work>\n${JSON.stringify(
    {
      request: session.prompt,
      events: session.events
        .filter((e) => e.kind === 'request' || e.kind === 'complete')
        .slice(-8)
        .map((e) => ({ title: e.title, detail: e.detail.slice(-4000) })),
    },
  )}\n</previous_work>`;
}
