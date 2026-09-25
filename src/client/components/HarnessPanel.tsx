import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import {
  emptyHarness,
  type HarnessCatalog,
  type HarnessItem,
  type Provider,
  type RepoHarness,
} from '../../shared/contracts';
import { repositoryName } from './RepositoryList';
const providerName = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude');
const docName = (p: Provider) => (p === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
function Choices({
  title,
  items,
  chosen,
  query,
  onToggle,
}: {
  title: string;
  items: HarnessItem[];
  chosen: string[];
  query: string;
  onToggle: (id: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const shown = items.filter((i) =>
    `${i.id} ${i.name} ${i.description}`.toLowerCase().includes(needle),
  );
  // Chosen entries that are no longer installed stay visible so they can be removed.
  const missing = chosen.filter((id) => !items.some((i) => i.id === id));
  return (
    <fieldset className="harness-group">
      <legend>
        {title} <small>{chosen.length}개 선택</small>
      </legend>
      {[
        ...missing.map((id) => ({ id, name: id, description: '설치되어 있지 않아요' })),
        ...shown,
      ].map((item) => (
        <label key={item.id} className={missing.includes(item.id) ? 'missing' : ''}>
          <input
            type="checkbox"
            checked={chosen.includes(item.id)}
            onChange={() => onToggle(item.id)}
          />
          <span>
            <strong>{item.name}</strong>
            {item.id !== item.name && <code>{item.id}</code>}
            {item.description && <small>{item.description}</small>}
          </span>
        </label>
      ))}
      {!items.length && !missing.length && <p className="harness-empty">설치된 항목이 없어요.</p>}
      {items.length > 0 && !shown.length && <p className="harness-empty">검색 결과가 없어요.</p>}
    </fieldset>
  );
}
export function HarnessPanel({ root, onClose }: { root: string; onClose: () => void }) {
  const [catalog, setCatalog] = useState<HarnessCatalog>();
  const [harness, setHarness] = useState<RepoHarness>();
  const [tab, setTab] = useState<Provider>('claude');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api<RepoHarness>(`/harness?root=${encodeURIComponent(root)}`)
      .then((h) => active && setHarness(h))
      .catch(() => active && setHarness(emptyHarness()));
    api<HarnessCatalog>('/harness/catalog')
      .then((c) => active && setCatalog(c))
      .catch((e) => active && setMessage((e as Error).message));
    return () => {
      active = false;
    };
  }, [root]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [onClose]);
  const choice = harness?.[tab];
  const toggle = (key: 'plugins' | 'skills', id: string) =>
    setHarness((h) => {
      if (!h) return h;
      const list = h[tab][key];
      return {
        ...h,
        [tab]: {
          ...h[tab],
          [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
        },
      };
    });
  const save = async () => {
    if (!harness) return;
    setSaving(true);
    setMessage('');
    try {
      setHarness(await api<RepoHarness>('/harness', { root, harness }));
      setMessage('저장했어요. 다음 앱 작업부터 적용돼요.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="레포 하네스"
        className="modal harness-modal"
      >
        <div className="modal-heading">
          <h2>{repositoryName(root)} 하네스</h2>
          <button className="icon-button" aria-label="대화상자 닫기" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <p className="harness-note">
          이 레포에서 <strong>앱 작업</strong>을 실행할 때 쓸 플러그인과 스킬을 골라요. 고르지 않은
          것은 모두 꺼진 채로 실행돼요. 훅과 플러그인의 MCP 서버는 앱 작업에서 항상 꺼지고, 기록
          기반 답변과 이어가기 터미널에는 적용되지 않아요.
        </p>
        <div className="harness-tabs" role="tablist" aria-label="공급자">
          {(['claude', 'codex'] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={tab === p}
              className={tab === p ? 'active' : ''}
              onClick={() => setTab(p)}
            >
              {providerName(p)}
              <small>{harness ? harness[p].plugins.length + harness[p].skills.length : 0}</small>
            </button>
          ))}
        </div>
        {!catalog || !choice ? (
          <p className="harness-empty">설치된 플러그인과 스킬을 확인하고 있어요…</p>
        ) : (
          <>
            {catalog[tab].error && (
              <p className="harness-error" role="alert">
                {providerName(tab)} 목록을 읽지 못했어요: {catalog[tab].error}
              </p>
            )}
            <label className="harness-doc">
              <input
                type="checkbox"
                checked={choice.projectDoc}
                onChange={() =>
                  setHarness(
                    (h) => h && { ...h, [tab]: { ...h[tab], projectDoc: !h[tab].projectDoc } },
                  )
                }
              />
              프로젝트 지침 ({docName(tab)}) 읽기
            </label>
            <label className="harness-search">
              <Search size={15} />
              <input
                aria-label="플러그인·스킬 검색"
                placeholder="이름이나 설명으로 찾기"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="harness-lists">
              <Choices
                title="플러그인"
                items={catalog[tab].plugins}
                chosen={choice.plugins}
                query={query}
                onToggle={(id) => toggle('plugins', id)}
              />
              <Choices
                title="사용자 스킬"
                items={catalog[tab].skills}
                chosen={choice.skills}
                query={query}
                onToggle={(id) => toggle('skills', id)}
              />
            </div>
          </>
        )}
        <div className="harness-actions">
          {message && <span role="status">{message}</span>}
          <button className="primary" disabled={!harness || saving} onClick={() => void save()}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </section>
    </div>
  );
}
