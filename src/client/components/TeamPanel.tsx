import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  seniorityLabels,
  type TeamConfig,
  type Provider,
  type Seniority,
} from '../../shared/contracts';
export function TeamPanel({
  team,
  onChange,
  implementer,
  onRoleChange,
  disabled = false,
}: {
  team: TeamConfig;
  onChange: (t: TeamConfig) => void;
  implementer: Provider;
  onRoleChange: (p: Provider) => void;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<Record<string, { id: string; label: string }[]>>({});
  useEffect(() => {
    let active = true;
    for (const id of ['claude', 'codex'])
      api<{ models: { id: string; label: string }[] }>(`/models/${id}`)
        .then((r) => {
          if (active) setCatalog((c) => ({ ...c, [id]: r.models }));
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="team-settings">
      <p className="muted">모델과 일하는 방식을 정해주세요. 직급은 업무 지침에 반영됩니다.</p>
      {(['claude', 'codex'] as const).map((id) => (
        <section className="team-setting" key={id}>
          <div className="team-heading">
            <span className={`avatar ${id}`}>{id === 'claude' ? '✳' : '⌘'}</span>
            <div>
              <strong>{id === 'claude' ? 'Claude' : 'Codex'}</strong>
              <p>{implementer === id ? '구현 담당' : '검토 담당'}</p>
            </div>
          </div>
          <label>
            직급
            <select
              disabled={disabled}
              aria-label={`${id} 직급`}
              value={team[id].seniority}
              onChange={(e) =>
                onChange({ ...team, [id]: { ...team[id], seniority: e.target.value as Seniority } })
              }
            >
              {Object.entries(seniorityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            모델
            <input
              disabled={disabled}
              aria-label={`${id} 모델`}
              list={`${id}-models`}
              value={team[id].model ?? ''}
              placeholder="기본 모델 사용"
              onChange={(e) => onChange({ ...team, [id]: { ...team[id], model: e.target.value } })}
            />
            <datalist id={`${id}-models`}>
              {catalog[id]?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </label>
          <p className="hint">
            {team[id].seniority === 'senior'
              ? '구조와 예외를 살피고, 판단 근거를 설명해요.'
              : team[id].seniority === 'junior'
                ? '합의한 범위를 구현하고 테스트해요.'
                : '작은 작업부터 맡기고 검토를 함께 진행해주세요.'}
          </p>
        </section>
      ))}
      <label>
        협업 시 구현 담당
        <select
          value={implementer}
          disabled={disabled}
          onChange={(e) => onRoleChange(e.target.value as Provider)}
        >
          <option value="codex">Codex 구현 · Claude 검토</option>
          <option value="claude">Claude 구현 · Codex 검토</option>
        </select>
      </label>
      <p className="hint">
        모델 식별자를 입력하거나 비워두면 공급자 기본 모델을 사용합니다. 실행 중인 팀 설정은 바뀌지
        않습니다.
      </p>
    </div>
  );
}
