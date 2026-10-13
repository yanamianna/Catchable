import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from './types';

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const requestMethod = (method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
  const mutation = requestMethod !== 'GET' && requestMethod !== 'HEAD';
  const response = await fetch(path, {
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

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    if (pending.current) await pending.current;
    if (!alive.current) return;
    const request = async () => {
      try {
        const next = await api<AppState>('/api/state');
        if (alive.current) { setState(next); setError(''); }
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : '无法连接本地服务');
      } finally {
        if (alive.current) setLoading(false);
      }
    };
    pending.current = request();
    await pending.current;
    pending.current = null;
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const interval = window.setInterval(() => { if (!pending.current) void refresh(); }, 1000);
    return () => { alive.current = false; window.clearInterval(interval); };
  }, [refresh]);
  return { state, error, loading, refresh };
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
