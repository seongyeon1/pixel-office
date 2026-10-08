import { lazy, Suspense, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../api';
import type { ProjectSummary } from '../../shared/contracts';
import type { LaunchedAgent, LaunchHarnessList, LaunchInput } from '../../shared/launcher';
import './agent-launcher.css';
const TerminalPane = lazy(() =>
  import('../workspace/TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
export function AgentLauncher({
  root,
  onClose,
  onStarted,
}: {
  root: string;
  onClose: () => void;
  onStarted: (agent: LaunchedAgent) => void | Promise<void>;
}) {
  const [folder, setFolder] = useState(root);
  const [folders, setFolders] = useState<ProjectSummary[]>([]);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [agents, setAgents] = useState<LaunchedAgent[]>([]);
  const [selected, setSelected] = useState<LaunchedAgent>();
  const [provider, setProvider] = useState<LaunchInput['provider']>('claude');
  const [harnesses, setHarnesses] = useState<LaunchHarnessList['harnesses']>([]);
  const [picked, setHarness] = useState('');
  const [adding, setAdding] = useState('');
  const options = harnesses.filter((h) => h.engine === provider);
  const harness = options.some((h) => h.command === picked) ? picked : (options[0]?.command ?? '');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [request, setRequest] = useState<{ key: string; id: string }>();
  useEffect(() => {
    let stopped = false;
    api<LaunchedAgent[]>(`/agents?root=${encodeURIComponent(root)}`).then(
      (list) => {
        if (!stopped) setAgents(list);
      },
      (e: Error) => {
        if (!stopped) setError(e.message);
      },
    );
    return () => {
      stopped = true;
    };
  }, [root]);
  useEffect(() => {
    api<ProjectSummary[]>('/projects').then(setFolders, () => {});
    api<LaunchHarnessList>('/settings/harnesses').then(
      (r) => setHarnesses(r.harnesses),
      (e: Error) => setError(e.message),
    );
  }, []);
  const saveHarnesses = async (next: { engine: LaunchInput['provider']; command: string }[]) => {
    setError('');
    try {
      const saved = await api<LaunchHarnessList>('/settings/harnesses', {
        harnesses: next.map(({ engine, command }) => ({ engine, command })),
      });
      setHarnesses(saved.harnesses);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const addHarness = async () => {
    const command = adding.trim();
    if (!command) return;
    if (await saveHarnesses([...harnesses, { engine: provider, command }])) {
      setHarness(command);
      setAdding('');
    }
  };
  useEffect(() => {
    let active = true;
    setModels([]);
    api<{ models: { id: string; label: string }[] }>(`/models/${provider}`).then(
      (r) => {
        if (active) setModels(r.models);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [provider]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [onClose]);
  const start = async () => {
    setPending(true);
    setError('');
    const key = JSON.stringify({ root: folder, provider, harness, prompt, model });
    const id = request?.key === key ? request.id : crypto.randomUUID();
    setRequest({ key, id });
    try {
      const chosen = await api<{ root: string }>('/launch-folders', { root: folder.trim() });
      const agent = await api<LaunchedAgent>('/agents', {
        id,
        root: chosen.root,
        provider,
        harness,
        prompt,
        model: model.trim() || undefined,
      });
      setAgents((items) => [...items.filter((a) => a.id !== agent.id), agent]);
      setSelected(agent);
      setPrompt('');
      setRequest(undefined);
      onClose();
      await onStarted(agent);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="workspace-dock agent-launcher" aria-label="새 동료 시작">
      <header className="workspace-dock-header">
        <strong>내 하네스로 동료 시작</strong>
        <button aria-label="새 동료 창 숨기기" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="launcher-tabs" aria-label="앱에서 시작한 동료">
        <button onClick={() => setSelected(undefined)} aria-pressed={!selected}>
          <Plus size={14} /> 새 동료
        </button>
        {agents.map((a) => (
          <button key={a.id} aria-pressed={selected?.id === a.id} onClick={() => setSelected(a)}>
            {a.provider === 'claude' ? 'Claude' : 'Codex'} · {a.prompt.slice(0, 25)}
          </button>
        ))}
      </div>
      {selected ? (
        <Suspense fallback={<p role="status">터미널을 불러오는 중…</p>}>
          <TerminalPane
            key={selected.id}
            root={selected.root}
            storageKey={`pixel.launch:${selected.id}`}
            recover={() => api(`/terminals/${selected.terminal.id}`)}
            label="새 동료 터미널"
            footer="창을 숨겨도 계속 실행돼요. 터미널 종료를 누르면 이 동료의 실행이 끝납니다."
            idle={() => (
              <p className="terminal-empty">종료된 동료입니다. 새 동료를 눌러 다시 시작하세요.</p>
            )}
          />
        </Suspense>
      ) : (
        <form
          className="launcher-form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <p>
            선택한 폴더에서 새 세션을 시작합니다. 평소 쓰는 하네스의 설정과 권한이 그대로 적용돼요.
          </p>
          <label>
            작업 폴더
            <input
              list="launcher-folders"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="폴더의 절대 경로"
              required
              disabled={pending}
            />
            <datalist id="launcher-folders">
              {folders.map((p) => (
                <option key={p.root} value={p.root} />
              ))}
            </datalist>
          </label>
          <small>연결된 폴더를 고르거나 새 폴더의 절대 경로를 입력하세요.</small>
          <div className="launcher-options">
            <label>
              동료
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as LaunchInput['provider']);
                  setModel('');
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              실행 하네스
              <select value={harness} onChange={(e) => setHarness(e.target.value)}>
                {options.map((h) => (
                  <option key={h.command} value={h.command}>
                    {h.command}
                    {h.command === provider ? ' · 기본 CLI' : ''}
                    {h.available ? '' : ' · 설치 안 됨'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="launcher-harnesses">
            <summary>하네스 추가 · 삭제</summary>
            <p>
              {provider === 'claude' ? 'Claude Code' : 'Codex'}를 감싸 실행하는 명령(예: sy)을
              등록하면 그 설정 그대로 동료를 시작하고 이어갑니다.
            </p>
            <div className="launcher-harness-add">
              <input
                aria-label="추가할 하네스 명령"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void addHarness();
                }}
                placeholder="실행 파일 이름"
                maxLength={80}
              />
              <button type="button" disabled={!adding.trim()} onClick={() => void addHarness()}>
                추가
              </button>
            </div>
            <ul>
              {options.map((h) => (
                <li key={h.command}>
                  <code>{h.command}</code>
                  <button
                    type="button"
                    aria-label={`하네스 ${h.command} 삭제`}
                    onClick={() => void saveHarnesses(harnesses.filter((x) => x !== h))}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </details>
          <label>
            모델
            <input
              list="launcher-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="개인 설정의 기본 모델"
              maxLength={150}
              disabled={pending}
            />
            <datalist id="launcher-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            처음 맡길 일
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={20000}
              rows={3}
              required
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={pending || !prompt.trim() || !folder.trim() || !harness}
            type="submit"
          >
            {pending ? '시작 중…' : '동료 시작'}
          </button>
        </form>
      )}
    </section>
  );
}
