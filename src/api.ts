import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AppState } from './types';

export async function api<T = unknown>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const requestMethod = (method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
  const mutation = requestMethod !== 'GET' && requestMethod !== 'HEAD';
  const response = await fetch(path, {
    signal,
    method: requestMethod,
    headers: mutation ? { 'Content-Type': 'application/json' } : undefined,
    body: mutation ? JSON.stringify(body ?? {}) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : result.message ?? `请求失败 (${response.status})`);
  }
  return result as T;
}

export function useAppState(accountId = 'all') {
  const [snapshot, setSnapshot] = useState<{ accountId: string; state: AppState } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const scope = useRef(accountId);
  scope.current = accountId;
  const refresh = useCallback(async () => {
    if (!alive.current) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const requestId = ++sequence.current; const requestedAccount = scope.current;
    const current = () => alive.current && requestId === sequence.current && requestedAccount === scope.current;
    try {
      const next = await api<AppState>(`/api/state?accountId=${encodeURIComponent(requestedAccount)}`, undefined, undefined, controller.signal);
      if (current()) { setSnapshot({ accountId: requestedAccount, state: next }); setAccounts(next.accounts ?? []); setError(''); }
    } catch (cause) {
      if (current() && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法连接本地服务');
    } finally {
      if (pending.current === controller) pending.current = null;
      if (current()) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    setLoading(true); setError('');
    void refresh();
    const interval = window.setInterval(() => { if (!pending.current) void refresh(); }, 1000);
    return () => { alive.current = false; sequence.current++; pending.current?.abort(); pending.current = null; window.clearInterval(interval); };
  }, [accountId, refresh]);
  return { state: snapshot?.accountId === accountId ? snapshot.state : null, accounts, error, loading, refresh };
}

export function formatTime(value?: string, detail = false) {
  if (!value) return '尚未检查';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', ...(detail ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', ...(detail ? {} : { second: '2-digit' }), hour12: false,
  }).format(parsed);
}
