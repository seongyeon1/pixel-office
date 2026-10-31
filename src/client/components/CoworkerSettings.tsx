import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ProjectSummary } from '../../shared/contracts';
import type { LaunchHarnessList } from '../../shared/launcher';
import {
  COORDINATOR_ID,
  DEFAULT_RULES,
  type Coworker,
  type ToolRule,
} from '../../shared/coworkers';
import { HarnessPanel } from './HarnessPanel';

// Each toggle owns some of the default patterns; on = `ask`, off = `auto`.
const verbPattern = (verb: string) => `mcp__*__*${verb}*`;
const TOGGLES: { label: string; patterns: string[] }[] = [
  { label: 'Confluence 게시', patterns: [verbPattern('publish')] },
  { label: 'Jira 발급', patterns: [verbPattern('create')] },
  { label: 'Notion 페이지', patterns: [verbPattern('update')] },
  { label: 'Slack 다른 채널 발송', patterns: [verbPattern('send')] },
  {
    label: '그 외 외부 쓰기',
    patterns: ['delete', 'post', 'comment', 'transition'].map(verbPattern),
  },
];
const toggled = new Set(TOGGLES.flatMap((t) => t.patterns));
const firstAction = (rules: ToolRule[], pattern: string): ToolRule['action'] =>
  rules.find((r) => r.pattern === pattern)?.action ?? 'auto';
const askCount = (rules: ToolRule[], patterns: string[]) =>
  patterns.filter((p) => firstAction(rules, p) === 'ask').length;
// Toggle-owned patterns lead the list (first match wins), so a broader custom rule cannot shadow them.
function normalize(rules: ToolRule[]): { rules: ToolRule[]; merged: number } {
  const owned = rules.filter((r) => toggled.has(r.pattern));
  const lead = [...toggled].map((pattern): ToolRule => ({
    pattern,
    action: firstAction(rules, pattern),
  }));
  return {
    rules: [...lead, ...rules.filter((r) => !toggled.has(r.pattern))],
    merged: owned.length - new Set(owned.map((r) => r.pattern)).size,
  };
}
const setToggle = (rules: ToolRule[], patterns: string[], on: boolean): ToolRule[] =>
  normalize(rules).rules.map((r) =>
    patterns.includes(r.pattern) ? { ...r, action: on ? 'ask' : 'auto' } : r,
  );

type Draft = Omit<Coworker, 'bindings'> & { bindings: string };
const toDraft = (c: Coworker): Draft => ({
  ...c,
  bindings: c.bindings.join(', '),
});
const slug = (folder: string) =>
  (folder.split('/').filter(Boolean).pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
const blank = (name = '', folder = ''): Draft => ({
  id: slug(folder),
  name,
  folder,
  engine: 'claude',
  role: '',
  mode: 'solo',
  bindings: '',
  rules: DEFAULT_RULES.map((r) => ({ ...r })),
  createdBy: 'user',
});

export function CoworkerSettings() {
  const [list, setList] = useState<Coworker[]>([]);
  const [suggestions, setSuggestions] = useState<{ name: string; folder: string }[]>([]);
  const [folders, setFolders] = useState<ProjectSummary[]>([]);
  const [commands, setCommands] = useState<LaunchHarnessList['harnesses']>([]);
  const [draft, setDraft] = useState<Draft>();
  const [isNew, setIsNew] = useState(false);
  const [merged, setMerged] = useState(0);
  const [harnessRoot, setHarnessRoot] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const load = async () => {
    const items = await api<Coworker[]>('/coworkers');
    setList(items);
    setSuggestions(
      items.length <= 1
        ? await api<{ name: string; folder: string }[]>('/coworkers/suggestions').catch(() => [])
        : [],
    );
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    api<ProjectSummary[]>('/projects').then(setFolders, () => {});
    api<LaunchHarnessList>('/settings/harnesses').then(
      (r) => setCommands(r.harnesses),
      () => {},
    );
  }, []);
  const open = (next: Draft, created: boolean) => {
    setMerged(normalize(next.rules).merged);
    setDraft({ ...next, rules: normalize(next.rules).rules });
    setIsNew(created);
    setSaved('');
    setWarnings([]);
    setError('');
  };
  const closeForm = () => {
    setDraft(undefined);
    setWarnings([]);
    setSaved('');
  };
  const patch = (value: Partial<Draft>) => setDraft((d) => d && { ...d, ...value });
  const patchRule = (i: number, value: Partial<ToolRule>) =>
    draft && patch({ rules: draft.rules.map((x, j) => (j === i ? { ...x, ...value } : x)) });
  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaved('');
    setError('');
    try {
      const { bindings, command, model, ...rest } = draft;
      const result = await api<Coworker & { warnings?: string[] }>('/coworkers', {
        ...rest,
        rules: normalize(rest.rules).rules,
        command: command || undefined,
        model: model?.trim() || undefined,
        bindings: bindings.split(/[\s,]+/).filter(Boolean),
      });
      setWarnings(result.warnings ?? []);
      setSaved(`${result.name} 설정을 저장했어요.`);
      setDraft({ ...toDraft(result), rules: normalize(result.rules).rules });
      setMerged(0);
      setIsNew(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function remove(c: Coworker) {
    setError('');
    try {
      await api(`/coworkers/${c.id}`, undefined, 'DELETE');
      if (draft?.id === c.id) closeForm();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const coordinator = draft?.id === COORDINATOR_ID;
  const commandOptions = commands.filter((h) => h.engine === draft?.engine);
  return (
    <section className="coworker-settings" aria-label="동료 설정">
      <h3>동료</h3>
      <ul className="coworker-list">
        {list.map((c) => (
          <li key={c.id}>
            <div>
              <strong>{c.name}</strong> <code>{c.id}</code>
              <small>
                {c.id === COORDINATOR_ID
                  ? `AGENTS.md: ${c.folder}/AGENTS.md`
                  : `${c.folder} · ${c.engine}${c.bindings.length ? ` · ${c.bindings.join(', ')}` : ''}`}
              </small>
            </div>
            <button type="button" onClick={() => open(toDraft(c), false)}>
              수정
            </button>
            {c.id !== COORDINATOR_ID && (
              <button type="button" onClick={() => void remove(c)}>
                삭제
              </button>
            )}
          </li>
        ))}
      </ul>
      {suggestions.length > 0 && (
        <div className="coworker-suggestions">
          <p className="hint">최근 작업한 폴더로 동료 만들기</p>
          {suggestions.map((s) => (
            <button
              type="button"
              key={s.folder}
              onClick={() => open(blank(s.name, s.folder), true)}
            >
              <strong>{s.name}</strong>
              <small>{s.folder}</small>
            </button>
          ))}
        </div>
      )}
      {!draft && (
        <button type="button" onClick={() => open(blank(), true)}>
          동료 추가
        </button>
      )}
      {draft && (
        <form
          className="coworker-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            이름
            <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required />
          </label>
          <label>
            동료 id
            <input
              value={draft.id}
              disabled={!isNew}
              pattern="[a-z0-9][a-z0-9\-]{0,39}"
              placeholder="영문 소문자, 숫자, -"
              onChange={(e) => patch({ id: e.target.value })}
              required
            />
          </label>
          {!coordinator && (
            <>
              <label>
                폴더
                <input
                  list="coworker-folders"
                  value={draft.folder}
                  placeholder="폴더의 절대 경로"
                  onChange={(e) => patch({ folder: e.target.value })}
                  required
                />
                <datalist id="coworker-folders">
                  {folders.map((p) => (
                    <option key={p.root} value={p.root} />
                  ))}
                </datalist>
              </label>
              <label>
                엔진
                <select
                  value={draft.engine}
                  onChange={(e) =>
                    patch({ engine: e.target.value as Coworker['engine'], command: undefined })
                  }
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label>
                실행 명령
                <select
                  value={draft.command ?? ''}
                  onChange={(e) => patch({ command: e.target.value || undefined })}
                >
                  <option value="">기본값</option>
                  {draft.command && !commandOptions.some((h) => h.command === draft.command) && (
                    <option value={draft.command}>{draft.command}</option>
                  )}
                  {commandOptions.map((h) => (
                    <option key={h.command} value={h.command}>
                      {h.command}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            모델
            <input
              value={draft.model ?? ''}
              placeholder="기본 모델 사용"
              onChange={(e) => patch({ model: e.target.value })}
            />
          </label>
          <label>
            역할
            <textarea
              rows={3}
              value={draft.role}
              onChange={(e) => patch({ role: e.target.value })}
            />
          </label>
          {!coordinator && (
            <>
              <label>
                모드
                <select
                  value={draft.mode}
                  onChange={(e) => patch({ mode: e.target.value as Coworker['mode'] })}
                >
                  <option value="solo">문서·컨텐츠</option>
                  <option value="collaborate">코드 리뷰 포함</option>
                </select>
              </label>
              <label>
                바인딩 채널 id
                <input
                  value={draft.bindings}
                  placeholder="C0123ABCD, C0456EFGH"
                  onChange={(e) => patch({ bindings: e.target.value })}
                />
              </label>
              <fieldset className="coworker-rules">
                <legend>승인 규칙</legend>
                <p className="hint">
                  켜 두면 해당 도구를 쓸 때마다 확인하고, 끄면 자동으로 진행해요.
                </p>
                {TOGGLES.map((t) => (
                  <label key={t.label} className="coworker-toggle">
                    <input
                      type="checkbox"
                      ref={(el) => {
                        if (!el) return;
                        const n = askCount(draft.rules, t.patterns);
                        el.indeterminate = n > 0 && n < t.patterns.length;
                      }}
                      aria-checked={
                        askCount(draft.rules, t.patterns) === 0
                          ? 'false'
                          : askCount(draft.rules, t.patterns) === t.patterns.length
                            ? 'true'
                            : 'mixed'
                      }
                      checked={askCount(draft.rules, t.patterns) === t.patterns.length}
                      onChange={(e) =>
                        patch({ rules: setToggle(draft.rules, t.patterns, e.target.checked) })
                      }
                    />
                    {t.label}
                  </label>
                ))}
                {merged > 0 && (
                  <p className="hint">
                    토글과 같은 패턴의 규칙 {merged}개를 토글 설정으로 합쳤어요.
                  </p>
                )}
                {draft.rules.map(
                  (r, i) =>
                    !toggled.has(r.pattern) && (
                      <div className="coworker-rule" key={i}>
                        <input
                          aria-label="규칙 패턴"
                          value={r.pattern}
                          onChange={(e) => patchRule(i, { pattern: e.target.value })}
                        />
                        <select
                          aria-label="규칙 동작"
                          value={r.action}
                          onChange={(e) =>
                            patchRule(i, { action: e.target.value as ToolRule['action'] })
                          }
                        >
                          <option value="ask">확인</option>
                          <option value="auto">자동</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => patch({ rules: draft.rules.filter((_, j) => j !== i) })}
                        >
                          규칙 삭제
                        </button>
                      </div>
                    ),
                )}
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      rules: [...draft.rules, { pattern: 'mcp__server__tool*', action: 'ask' }],
                    })
                  }
                >
                  규칙 추가
                </button>
              </fieldset>
              <div className="coworker-bundle">
                <button
                  type="button"
                  disabled={!draft.folder.trim()}
                  onClick={() => setHarnessRoot(draft.folder.trim())}
                >
                  플러그인·스킬 묶음
                </button>
                <p className="hint">
                  묶음은 격리 환경 실행에 적용돼요. 내 환경(personal) 실행은 내 설정을 그대로 써요.
                </p>
              </div>
            </>
          )}
          <div className="coworker-actions">
            <button type="submit" className="primary" disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </button>
            <button type="button" onClick={closeForm}>
              닫기
            </button>
          </div>
        </form>
      )}
      {warnings.map((w) => (
        <p className="hint coworker-warning" role="status" key={w}>
          {w}
        </p>
      ))}
      {saved && (
        <p className="approval-setting-status" role="status">
          {saved}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {harnessRoot && <HarnessPanel root={harnessRoot} onClose={() => setHarnessRoot('')} />}
    </section>
  );
}
