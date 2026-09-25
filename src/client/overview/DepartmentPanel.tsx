import { useState } from 'react';
import { Building2, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { Department } from '../../shared/contracts';
// Departments group rooms by folder, e.g. every repository inside project/skt.
export function DepartmentPanel({
  departments,
  onChanged,
}: {
  departments: Department[];
  onChanged: () => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return (
    <details className="department-panel">
      <summary>
        <Building2 size={15} /> 부서 관리 <small>{departments.length}</small>
      </summary>
      <p>폴더 하나를 부서로 정하면, 그 안에 있는 저장소 방이 층의 같은 구역에 모여요.</p>
      <ul>
        {departments.map((d) => (
          <li key={d.id}>
            <strong>{d.name}</strong>
            <code title={d.root}>{d.root}</code>
            <button
              aria-label={`부서 삭제 ${d.name}`}
              onClick={() => void run(() => api(`/departments/${d.id}`, undefined, 'DELETE'))}
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api('/departments', { name: name.trim(), root: root.trim() })).then(
            (ok) => {
              if (ok) {
                setName('');
                setRoot('');
              }
            },
          );
        }}
      >
        <input
          aria-label="부서 이름"
          placeholder="이름 (예: skt)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="부서 폴더"
          placeholder="폴더 절대 경로"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
        />
        <button disabled={!name.trim() || !root.trim()}>추가</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
