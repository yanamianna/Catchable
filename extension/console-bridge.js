'use strict';

// This script runs only on the local console and never on Catchtable pages.
(() => {
  if (window !== window.top || !['127.0.0.1', 'localhost'].includes(location.hostname) ||
    location.protocol !== 'http:' || !['4174', '4173'].includes(location.port)) return;
  const origin = location.origin;
  const pending = new Set();
  window.addEventListener('message', async event => {
    const request = event.data;
    if (event.source !== window || event.origin !== origin || !request || request.source !== 'catchable-console' ||
      !['status', 'connect'].includes(request.type) || typeof request.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) || pending.has(request.requestId) || pending.size >= 8) return;
    if (request.type === 'connect' && (typeof request.pairingCode !== 'string' ||
      !/^(?:\d{8}|[A-Za-z0-9_-]{24,128})$/.test(request.pairingCode) ||
      typeof request.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.accountId))) return;
    pending.add(request.requestId);
    let response;
    try {
      const result = await chrome.runtime.sendMessage({
        type: request.type,
        ...(request.type === 'connect' ? { pairingCode: request.pairingCode, accountId: request.accountId, force: request.force === true } : {}),
      });
      response = {
        ok: result?.ok === true,
        status: result?.status,
        message: result?.message,
        accountId: result?.accountId,
        accountLabel: result?.accountLabel,
        enabled: result?.enabled === true,
        code: result?.code,
      };
    } catch {
      response = { ok: false, code: 'EXTENSION_RELOAD_REQUIRED', message: '扩展已更新，请刷新控制台后重试。' };
    } finally { pending.delete(request.requestId); }
    window.postMessage({ source: 'catchable-extension', requestId: request.requestId, ...response }, origin);
  });
})();
