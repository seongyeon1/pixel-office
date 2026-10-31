import { useEffect, useState } from 'react';
import { api } from '../api';

interface SlackStatus {
  configured: boolean;
  ownerId?: string;
  botToken?: string;
  error?: string;
}

export function SlackSettings() {
  const [status, setStatus] = useState<SlackStatus>();
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [limit, setLimit] = useState('3');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<SlackStatus>('/settings/slack').then(setStatus, (e: Error) => setError(e.message));
    api<{ limit: number }>('/settings/concurrency').then(
      (r) => setLimit(String(r.limit)),
      () => {},
    );
  }, []);
  async function run(task: () => Promise<string>) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      setMessage(await task());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const connect = () =>
    run(async () => {
      const owner = ownerId.trim();
      if (!botToken.startsWith('xoxb-')) throw new Error('Bot 토큰은 xoxb-로 시작해야 해요.');
      if (!appToken.startsWith('xapp-')) throw new Error('App 토큰은 xapp-로 시작해야 해요.');
      if (!/^[UW][A-Z0-9]+$/.test(owner))
        throw new Error('Slack member ID는 U나 W로 시작하는 영문 대문자·숫자예요. 예: U0123ABCD');
      try {
        setStatus(
          await api<SlackStatus>('/settings/slack', { botToken, appToken, ownerId: owner }),
        );
      } finally {
        setBotToken('');
        setAppToken('');
      }
      return 'Slack에 연결했어요.';
    });
  const disconnect = () =>
    run(async () => {
      await api('/settings/slack', undefined, 'DELETE');
      setStatus({ configured: false });
      return 'Slack 연결을 해제했어요.';
    });
  const saveLimit = () =>
    run(async () => {
      const value = Number(limit);
      if (!limit.trim() || !Number.isInteger(value) || value < 1 || value > 8)
        throw new Error('동시 실행 상한은 1에서 8 사이의 정수로 입력해 주세요.');
      await api('/settings/concurrency', { limit: value });
      return '동시 실행 상한을 저장했어요.';
    });
  return (
    <section className="slack-settings" aria-label="Slack 설정">
      <h3>Slack</h3>
      <p className="slack-status" aria-live="polite">
        {!status
          ? '상태를 확인하는 중…'
          : status.configured && !status.error
            ? `연결됨 · 소유자 ${status.ownerId}`
            : `안 됨${status.error ? ` · ${status.error}` : ''}`}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label>
          Bot 토큰
          <input
            type="password"
            autoComplete="off"
            value={botToken}
            placeholder={status?.botToken ?? 'xoxb-…'}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </label>
        <label>
          App 토큰
          <input
            type="password"
            autoComplete="off"
            value={appToken}
            placeholder="xapp-…"
            onChange={(e) => setAppToken(e.target.value)}
          />
        </label>
        <label>
          내 Slack member ID
          <input
            value={ownerId}
            placeholder={status?.ownerId ?? 'U0123ABCD'}
            onChange={(e) => setOwnerId(e.target.value)}
          />
        </label>
        <div className="coworker-actions">
          <button type="submit" className="primary" disabled={busy}>
            연결 테스트 후 저장
          </button>
          {status?.configured && (
            <button type="button" disabled={busy} onClick={() => void disconnect()}>
              연결 해제
            </button>
          )}
        </div>
      </form>
      <label>
        동시 실행 상한 (1–8)
        <input
          type="number"
          min={1}
          max={8}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </label>
      <button type="button" disabled={busy} onClick={() => void saveLimit()}>
        상한 저장
      </button>
      {message && (
        <p className="approval-setting-status" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
