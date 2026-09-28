import { useEffect, useState } from 'react';
import type { ApprovalSettings as Settings } from '../../shared/contracts';
import { api } from '../api';

export function ApprovalSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Settings>('/settings/approvals').then(
      (value) => {
        if (active) setSettings(value);
      },
      (e: Error) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  async function change(mode: Settings['mode']) {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      setSettings(await api<Settings>('/settings/approvals', { mode }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="approval-settings" aria-label="도구 승인 설정">
      <label>
        도구 승인 방식
        <select
          value={settings?.mode ?? 'manual'}
          disabled={!settings || saving}
          onChange={(e) => void change(e.target.value as Settings['mode'])}
        >
          <option value="manual">매번 확인</option>
          <option value="auto">자동 승인</option>
        </select>
      </label>
      <p className="hint">
        내 환경의 자동 승인은 sy / syc처럼 권한 확인과 샌드박스 제한을 해제해요. 변경은 다음
        구현·검토 단계부터 적용돼요. 실행 중 바로 바꾸려면 중단 후 추가 요청으로 재개해주세요.
        질문에는 직접 답해주세요.
      </p>
      <p className="hint">
        앱에 맡긴 작업과 앱에서 직접 보낸 지시에 적용돼요. 외부·이어가기 터미널의 승인 설정은 해당
        CLI에서 정해주세요.
      </p>
      <p className="approval-setting-status" role="status">
        {saving
          ? '저장 중…'
          : saved
            ? '승인 방식을 저장했어요.'
            : !settings && !error
              ? '설정을 불러오는 중…'
              : ''}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
