export interface ExtensionReply {
  source: 'catchable-extension';
  requestId: string;
  ok: boolean;
  status?: string;
  message?: string;
  accountId?: string;
  accountLabel?: string;
  code?: string;
}

export class ExtensionConnectionError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

export function extensionRequest(
  type: 'status' | 'connect',
  values: { pairingCode?: string; accountId?: string; accountLabel?: string; force?: boolean } = {},
  signal?: AbortSignal,
): Promise<ExtensionReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('操作已取消', 'AbortError')); return; }
    const requestId = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new ExtensionConnectionError(type === 'status' ? '此浏览器还未检测到扩展。' : '连接超时，请检查 Chrome 扩展后重试。', type === 'status' ? 'EXTENSION_UNAVAILABLE' : 'CONNECT_TIMEOUT'));
    }, type === 'status' ? 700 : 15000);
    function cleanup() { window.clearTimeout(timeout); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); }
    function abort() { cleanup(); reject(new DOMException('操作已取消', 'AbortError')); }
    function receive(event: MessageEvent) {
      const reply = event.data;
      if (event.source !== window || event.origin !== window.location.origin || !reply || reply.source !== 'catchable-extension' || reply.requestId !== requestId || typeof reply.ok !== 'boolean') return;
      cleanup(); resolve(reply as ExtensionReply);
    }
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    window.postMessage({ source: 'catchable-console', type, requestId, ...values }, window.location.origin);
  });
}
