export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? '연결을 확인해 주세요.');
  return data;
}
export async function bootstrap() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (token) {
    await api('/session', { token });
    history.replaceState(null, '', location.pathname);
  }
}
