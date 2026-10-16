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

function shareJson<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return previous as T;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const byId = next.some((value, index) => value?.id && value.id !== previous[index]?.id)
      ? new Map(previous.filter(value => value?.id).map(value => [value.id, value])) : null;
    const values = next.map((value, index) => shareJson(byId && value?.id ? byId.get(value.id) : previous[index], value));
    return (previous.length === values.length && values.every((value, index) => value === previous[index]) ? previous : values) as T;
  }
  if (previous && next && typeof previous === 'object' && typeof next === 'object' && !Array.isArray(previous) && !Array.isArray(next)) {
    const oldObject = previous as Record<string, unknown>, newObject = next as Record<string, unknown>;
    const keys = Object.keys(newObject);
    let same = keys.length === Object.keys(oldObject).length;
    const shared: Record<string, unknown> = {};
    for (const key of keys) {
      shared[key] = shareJson(oldObject[key], newObject[key]);
      if (!Object.hasOwn(oldObject, key) || shared[key] !== oldObject[key]) same = false;
    }
    return (same ? previous : shared) as T;
  }
  return next;
}

interface StateRequest { accountId: string; controller: AbortController; promise: Promise<void> }

export function useAppState(accountId = 'all') {
  const [snapshot, setSnapshot] = useState<{ accountId: string; state: AppState } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const pending = useRef<StateRequest | null>(null);
  const queued = useRef<{ accountId: string; promise: Promise<void> } | null>(null);
  const sharedAccounts = useRef<Account[]>([]);
  const sharedSnapshot = useRef<{ accountId: string; state: AppState } | null>(null);
  const currentError = useRef('');
  const currentLoading = useRef(true);
  const sequence = useRef(0);
  const scope = useRef(accountId);
  scope.current = accountId;
  const refresh = useCallback(function refreshState(afterAction = true): Promise<void> {
    if (!alive.current) return Promise.resolve();
    const requestedAccount = scope.current;
    const existing = pending.current;
    if (existing?.accountId === requestedAccount) {
      if (!afterAction) return existing.promise;
      if (queued.current?.accountId === requestedAccount) return queued.current.promise;
      // A response already in flight may precede the completed action. Share
      // one follow-up request rather than aborting it or displaying stale data.
      const followUp = { accountId: requestedAccount, promise: Promise.resolve() };
      followUp.promise = existing.promise.then(() => {
        if (queued.current === followUp) queued.current = null;
        if (alive.current && scope.current === requestedAccount) return refreshState(false);
      });
      queued.current = followUp;
      return followUp.promise;
    }
    const controller = new AbortController();
    const requestId = ++sequence.current;
    const current = () => alive.current && requestId === sequence.current && requestedAccount === scope.current;
    const request: StateRequest = { accountId: requestedAccount, controller, promise: Promise.resolve() };
    request.promise = (async () => {
      try {
        const next = await api<AppState>(`/api/state?accountId=${encodeURIComponent(requestedAccount)}`, undefined, undefined, controller.signal);
        if (current()) {
          const nextAccounts = shareJson(sharedAccounts.current, next.accounts ?? []);
          if (sharedAccounts.current !== nextAccounts) { sharedAccounts.current = nextAccounts; setAccounts(nextAccounts); }
          const previous = sharedSnapshot.current;
          const nextState = shareJson(previous?.accountId === requestedAccount ? previous.state : undefined, { ...next, accounts: nextAccounts });
          if (previous?.accountId !== requestedAccount || previous.state !== nextState) {
            sharedSnapshot.current = { accountId: requestedAccount, state: nextState };
            setSnapshot(sharedSnapshot.current);
          }
          if (currentError.current) { currentError.current = ''; setError(''); }
        }
      } catch (cause) {
        if (current() && !controller.signal.aborted) {
          const message = cause instanceof Error ? cause.message : '无法连接本地服务';
          if (currentError.current !== message) { currentError.current = message; setError(message); }
        }
      } finally {
        if (pending.current === request) pending.current = null;
        if (current() && currentLoading.current) { currentLoading.current = false; setLoading(false); }
      }
    })();
    pending.current = request;
    return request.promise;
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!currentLoading.current) { currentLoading.current = true; setLoading(true); }
    if (currentError.current) { currentError.current = ''; setError(''); }
    if (!document.hidden) void refresh(false);
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(false); }, 1000);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { alive.current = false; sequence.current++; pending.current?.controller.abort(); pending.current = null; queued.current = null; window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisibility); };
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
