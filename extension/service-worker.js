'use strict';

const SOCKET_URL = 'ws://127.0.0.1:4174/extension';
const CONSOLE_URL = 'http://127.0.0.1:4174/';
const CONTEXT_ID = 'catchable-default';
const ownedTabs = new Set();
const sessions = new Map();
const tabSessions = new Map();
const expectedDetach = new Map();
const responses = new Map();
let socket = null;
let enabled = false;
let autoAttach = false;
let discover = false;
let generation = 0;
let sequence = 0;
let retryCount = 0;
let reconnectTimer = null;
let keepaliveTimer = null;
let currentStatus = { status: 'disconnected', message: '在当前 Chrome 打开本地控制台，点击连接浏览器。' };
let accountLabel = null;
let accountId = null;
let acknowledged = false;
let operationQueue = Promise.resolve();
let detachQueue = Promise.resolve();
const connectionWaiters = new Set();

function officialPage(url, blank = false) {
  if (blank && url === 'about:blank') return true;
  try { const value = new URL(url); return value.protocol === 'https:' && !value.username && !value.password && ['www.catchtable.net', 'catchtable.net'].includes(value.hostname) && !value.port; }
  catch { return false; }
}
function officialResponse(url) {
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && !value.username && !value.password && !value.port &&
      ['www.catchtable.net', 'catchtable.net', 'api.catchtable.net'].includes(value.hostname) &&
      !/(?:^|\/)[^/]*(?:auth|oauth|login|logout|token|refresh|cookie|sign[-_]?in)[^/]*(?:\/|$)/i.test(value.pathname);
  } catch { return false; }
}
function pairingCode(value) { return typeof value === 'string' && /^(?:\d{8}|[A-Za-z0-9_-]{24,128})$/.test(value); }
function status() { return { ...currentStatus, accountLabel, accountId, enabled, ownedTabs: ownedTabs.size, attachedTabs: tabSessions.size, checkedAt: new Date().toISOString() }; }
function setStatus(value, message) { currentStatus = { status: value, message }; }
function connectionError(message, code = 'CONNECTION_FAILED') { return Object.assign(new Error(message), { code }); }
function settleConnection(error) { for (const waiter of [...connectionWaiters]) waiter(error); }
function waitForConnection() {
  if (socket?.readyState === WebSocket.OPEN && acknowledged) return Promise.resolve(status());
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); connectionWaiters.delete(finish); error ? reject(error) : resolve(status()); };
    const timer = setTimeout(() => finish(connectionError('连接尚未完成，请确认本地系统正在运行后重试。', 'CONNECTION_TIMEOUT')), 6000);
    connectionWaiters.add(finish);
  });
}
function serializeOperation(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => {});
  return next;
}
function localConsole(url) {
  try { const value = new URL(url); return value.protocol === 'http:' && !value.username && !value.password && ['127.0.0.1', 'localhost'].includes(value.hostname) && ['4174', '4173'].includes(value.port); }
  catch { return false; }
}
function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  if (sender.tab) return Number.isInteger(sender.tab.id) && sender.frameId === 0 && localConsole(sender.url) && localConsole(sender.tab.url) && new URL(sender.url).origin === new URL(sender.tab.url).origin ? 'console' : null;
  return sender.url === `chrome-extension://${chrome.runtime.id}/popup.html` ? 'popup' : null;
}
function send(value, transport = socket) {
  if (transport && transport === socket && transport.readyState === WebSocket.OPEN) transport.send(JSON.stringify(value));
}
function event(method, params, sessionId) { send({ type: 'event', method, params, ...(sessionId ? { sessionId } : {}) }); }
function targetInfo(tab) {
  return { targetId: `tab-${tab.id}`, type: 'page', title: tab.title || '', url: tab.url || 'about:blank', attached: tabSessions.has(tab.id), browserContextId: CONTEXT_ID, canAccessOpener: false };
}
async function persistOwned() { await chrome.storage.session.set({ ownedTabIds: [...ownedTabs] }); }
async function ownedTab(tabId) {
  if (!Number.isInteger(tabId) || !ownedTabs.has(tabId)) throw new Error('只能控制扩展新建的 Catchtable 标签页。');
  const tab = await chrome.tabs.get(tabId);
  if (!officialPage(tab.url || 'about:blank', true)) throw new Error('该标签页已离开 Catchtable，已停止控制。');
  return tab;
}
function fromTarget(targetId) {
  const match = /^tab-([1-9]\d*)$/.exec(targetId || '');
  if (!match) throw new Error('未知标签页目标。');
  return Number(match[1]);
}
async function ownedTargets() {
  const output = [];
  for (const tabId of ownedTabs) {
    try { output.push(targetInfo(await ownedTab(tabId))); } catch { /* Closed or navigated tabs are never exposed. */ }
  }
  return output;
}
function forgetSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  if (!session.nativeId) tabSessions.delete(session.tabId);
  for (const [key, child] of sessions) if (child.parent === sessionId) forgetSession(key);
  responses.delete(sessionId);
}
async function detachTab(tabId) {
  const sessionId = tabSessions.get(tabId);
  if (!sessionId) return;
  expectedDetach.set(tabId, sessionId);
  try { await chrome.debugger.detach({ tabId }); }
  catch { expectedDetach.delete(tabId); }
  forgetSession(sessionId);
  event('Target.detachedFromTarget', { sessionId, targetId: `tab-${tabId}` });
}
async function detachAll() {
  // Socket close and an explicit reconnect may overlap while Chrome is still
  // detaching a tab. Finish that cleanup before a new transport can attach it.
  const cleanup = detachQueue.then(async () => {
    for (const tabId of [...tabSessions.keys()]) await detachTab(tabId);
    sessions.clear(); tabSessions.clear(); responses.clear();
  });
  detachQueue = cleanup.catch(() => {});
  return cleanup;
}
async function attachTab(tab) {
  await ownedTab(tab.id);
  const previous = tabSessions.get(tab.id);
  if (previous) return previous;
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });
  } catch (error) {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* Keep the user-owned Chrome open even on attach failure. */ }
    throw new Error(`无法为助手标签页设置韩国时区，尚未建立控制会话：${error.message || '时区设置失败'}`);
  }
  const sessionId = `catchable-${tab.id}-${++sequence}`;
  sessions.set(sessionId, { tabId: tab.id, nativeId: null, parent: null });
  tabSessions.set(tab.id, sessionId);
  event('Target.attachedToTarget', { sessionId, targetInfo: targetInfo(tab), waitingForDebugger: false });
  return sessionId;
}
function cleanHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !/cookie|authorization|proxy-authorization|token|api-key/i.test(name)));
}
function safeNetworkEvent(method, params) {
  const output = { ...params };
  if (output.request) {
    output.request = { ...output.request, headers: cleanHeaders(output.request.headers) };
    delete output.request.postData; delete output.request.postDataEntries;
  }
  if (output.response) {
    output.response = { ...output.response, headers: cleanHeaders(output.response.headers) };
    if (output.response.requestHeaders) output.response.requestHeaders = cleanHeaders(output.response.requestHeaders);
    delete output.response.headersText; delete output.response.requestHeadersText;
  }
  if (output.headers) output.headers = cleanHeaders(output.headers);
  delete output.associatedCookies; delete output.blockedCookies; delete output.exemptedCookies; delete output.headersText;
  return output;
}
function blockedCommand(method, params) {
  if (/cookie/i.test(method) || /^(?:Storage|CacheStorage|Database|IndexedDB|IO|Fetch)\./.test(method) ||
    ['Network.getRequestPostData', 'Network.loadNetworkResource', 'Network.setExtraHTTPHeaders', 'Network.setUserAgentOverride', 'Emulation.setAutomationOverride', 'Page.handleFileChooser', 'Page.setDownloadBehavior'].includes(method)) return true;
  const script = [params.expression, params.functionDeclaration, params.source].filter(value => typeof value === 'string').join('\n');
  return /\b(?:localStorage|sessionStorage|indexedDB)\b|document\s*(?:\.\s*cookie|\[\s*['"]cookie['"]\s*\])|\b(?:fetch|XMLHttpRequest)\s*\(/i.test(script);
}
async function rootCommand(method, params) {
  if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
  if (method === 'Target.getTargets') return { targetInfos: await ownedTargets() };
  if (method === 'Target.getTargetInfo') {
    if (!params.targetId) return { targetInfo: { targetId: 'catchable-browser', type: 'browser', title: 'Catchable', url: '', attached: true, browserContextId: CONTEXT_ID } };
    return { targetInfo: targetInfo(await ownedTab(fromTarget(params.targetId))) };
  }
  if (method === 'Target.setDiscoverTargets') {
    discover = params.discover === true;
    if (discover) for (const info of await ownedTargets()) event('Target.targetCreated', { targetInfo: info });
    return {};
  }
  if (method === 'Target.setAutoAttach') {
    autoAttach = params.autoAttach === true;
    if (autoAttach) for (const tabId of [...ownedTabs]) {
      let tab; try { tab = await ownedTab(tabId); } catch { continue; }
      await attachTab(tab);
    }
    return {};
  }
  if (method === 'Target.createTarget') {
    if (params.browserContextId && params.browserContextId !== CONTEXT_ID) throw new Error('只允许默认 Chrome 登录会话。');
    const url = params.url || 'about:blank';
    if (!officialPage(url, true)) throw new Error('新标签页只允许 Catchtable HTTPS 页面。');
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    ownedTabs.add(tab.id); await persistOwned();
    if (discover) event('Target.targetCreated', { targetInfo: targetInfo(tab) });
    if (autoAttach || url !== 'about:blank') await attachTab(tab);
    if (url !== 'about:blank') await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.navigate', { url });
    return { targetId: `tab-${tab.id}` };
  }
  if (method === 'Target.attachToTarget') return { sessionId: await attachTab(await ownedTab(fromTarget(params.targetId))) };
  if (method === 'Target.detachFromTarget') {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('调试会话已断开。');
    if (session.nativeId) {
      await chrome.debugger.sendCommand({ tabId: session.tabId }, 'Target.detachFromTarget', { sessionId: session.nativeId });
      forgetSession(params.sessionId);
    } else await detachTab(session.tabId);
    return {};
  }
  if (method === 'Target.activateTarget') { await chrome.tabs.update((await ownedTab(fromTarget(params.targetId))).id, { active: true }); return {}; }
  if (method === 'Target.closeTarget') {
    const tab = await ownedTab(fromTarget(params.targetId));
    await detachTab(tab.id); ownedTabs.delete(tab.id); await persistOwned(); await chrome.tabs.remove(tab.id);
    if (discover) event('Target.targetDestroyed', { targetId: `tab-${tab.id}` });
    return { success: true };
  }
  if (method === 'Browser.close') { await detachAll(); return {}; }
  throw new Error(`不支持的浏览器命令：${method}`);
}
async function sessionCommand(sessionId, method, params) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('调试会话已断开，请重新连接并核验登录。');
  await ownedTab(session.tabId);
  if (method === 'Page.close') { await rootCommand('Target.closeTarget', { targetId: `tab-${session.tabId}` }); return {}; }
  if (blockedCommand(method, params) || !/^(?:Page|Runtime|DOM|DOMSnapshot|Input|Network|Accessibility|Emulation|Log|Performance|Target)\./.test(method)) throw new Error('此命令超出 Catchtable 标签页控制范围。');
  if (method === 'Page.navigate' && !officialPage(params.url, true)) throw new Error('禁止导航到 Catchtable 以外的页面。');
  if (method === 'Page.navigateToHistoryEntry') throw new Error('不允许导航到未核验的历史页面。');
  if (method.startsWith('Target.') && !['Target.setAutoAttach', 'Target.detachFromTarget'].includes(method)) throw new Error('请使用受限的浏览器标签页命令。');
  if (method === 'Target.detachFromTarget') {
    const child = sessions.get(params.sessionId);
    if (!child?.nativeId || child.tabId !== session.tabId) throw new Error('只能分离该标签页已登记的子会话。');
    return rootCommand(method, params);
  }
  if (method === 'Network.getResponseBody' && !responses.get(sessionId)?.has(params.requestId)) throw new Error('仅允许读取已观察到的 Catchtable 正常响应。');
  const debuggee = { tabId: session.tabId, ...(session.nativeId ? { sessionId: session.nativeId } : {}) };
  // Do not pause unrelated external iframe execution while excluding its target.
  const safeParams = method === 'Target.setAutoAttach' ? { ...params, waitForDebuggerOnStart: false } : params;
  const result = await chrome.debugger.sendCommand(debuggee, method, safeParams);
  return result || {};
}
async function dispatch(command) {
  const params = command.params && typeof command.params === 'object' && !Array.isArray(command.params) ? command.params : {};
  if (typeof command.method !== 'string') throw new Error('无效调试命令。');
  return command.sessionId ? sessionCommand(command.sessionId, command.method, params) : rootCommand(command.method, params);
}
function clearTimers() { if (keepaliveTimer) clearInterval(keepaliveTimer); if (reconnectTimer) clearTimeout(reconnectTimer); keepaliveTimer = null; reconnectTimer = null; }
async function stopConnection(message = '已断开，保留所有 Chrome 标签页。', persist = true) {
  enabled = false; generation++; clearTimers(); acknowledged = false;
  settleConnection(connectionError(message, 'CONNECTION_CLOSED'));
  if (persist) await chrome.storage.local.set({ connectionEnabled: false });
  const previous = socket; socket = null; previous?.close();
  await detachAll(); autoAttach = false; discover = false;
  setStatus('disconnected', message);
}
function scheduleReconnect() {
  if (!enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connectSocket(); }, Math.min(10000, 1000 * 2 ** Math.min(retryCount++, 4)));
}
async function connectSocket() {
  if (!enabled || socket) return;
  const preparingEpoch = generation;
  await detachQueue;
  if (!enabled || socket || preparingEpoch !== generation) return;
  const saved = await chrome.storage.local.get('pairingCode');
  // A user may disconnect or start a different binding during this storage
  // read. Its old result must never create or replace the new transport.
  if (!enabled || socket || preparingEpoch !== generation) return;
  if (!pairingCode(saved.pairingCode)) { enabled = false; setStatus('error', '配对码格式无效，请重新粘贴本地控制台提供的配对码。'); return; }
  // The endpoint is a constant; pairing never accepts a remote server URL.
  const transport = new WebSocket(SOCKET_URL, ['catchable', `pair.${saved.pairingCode}`]);
  socket = transport;
  const epoch = ++generation;
  acknowledged = false;
  const activeCommands = new Set();
  setStatus('connecting', '正在连接本机 Catchable…');
  transport.onopen = () => {
    if (socket !== transport || epoch !== generation) return;
    retryCount = 0; setStatus('connecting', '正在确认账号连接…');
    send({ type: 'hello', userAgent: navigator.userAgent, protocolVersion: '1.3' }, transport);
    keepaliveTimer = setInterval(() => send({ type: 'ping' }, transport), 20000);
  };
  transport.onmessage = async (message) => {
    if (socket !== transport || epoch !== generation) return;
    let command; try { command = JSON.parse(message.data); } catch { return; }
    if (command?.type === 'hello_ack') {
      accountLabel = typeof command.accountLabel === 'string' && command.accountLabel.trim() ? command.accountLabel.trim().slice(0,100) : null;
      accountId = typeof command.accountId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(command.accountId) ? command.accountId : null;
      acknowledged = true;
      setStatus('connected', '已连接，后续会自动重连。');
      await chrome.storage.local.set({ boundAccountId: accountId, boundAccountLabel: accountLabel });
      if (socket !== transport || epoch !== generation) return;
      settleConnection();
      return;
    }
    if (command.type !== 'command' || !Number.isSafeInteger(command.id) || command.id < 0 || activeCommands.has(command.id)) return;
    activeCommands.add(command.id);
    try {
      const result = await dispatch(command);
      if (epoch === generation) send({ type: 'result', id: command.id, result }, transport);
    } catch (error) {
      if (epoch === generation) send({ type: 'result', id: command.id, error: { code: -32000, message: error.message || '扩展命令执行失败。' } }, transport);
    } finally { activeCommands.delete(command.id); }
  };
  transport.onclose = async (closed) => {
    if (socket !== transport) return;
    socket = null; const closedEpoch = ++generation; acknowledged = false; if (keepaliveTimer) clearInterval(keepaliveTimer); keepaliveTimer = null;
    settleConnection(connectionError(closed.code === 1008 ? '配对码无效，请重新获取。' : '本机连接已断开，请重试。', closed.code === 1008 ? 'PAIRING_REJECTED' : 'CONNECTION_CLOSED'));
    const cleanup = detachAll();
    if (closed.code === 1008) { enabled = false; await chrome.storage.local.set({ connectionEnabled: false }); }
    await cleanup;
    if (generation !== closedEpoch || socket) return;
    autoAttach = false; discover = false;
    if (closed.code === 1008) { setStatus('error', '配对被拒绝，请从本地控制台重新获取配对码。'); return; }
    setStatus('disconnected', enabled ? '本机连接中断，等待重新连接；不会重放预约操作。' : '已断开。');
    scheduleReconnect();
  };
  transport.onerror = () => { if (socket === transport) setStatus('error', '连接本机失败。请确认 Catchable 正在运行。'); };
}
chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  // Playwright does not consume chunk-progress events. Keep request, response
  // and completion events intact without serializing every downloaded chunk.
  if (method === 'Network.dataReceived') return;
  const rootSession = tabSessions.get(source.tabId);
  if (!rootSession) return;
  const sessionId = source.sessionId ? [...sessions].find(([, value]) => value.tabId === source.tabId && value.nativeId === source.sessionId)?.[0] : rootSession;
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  const navigatedUrl = method === 'Page.frameNavigated' ? params.frame?.url : method === 'Target.targetInfoChanged' ? params.targetInfo?.url : null;
  if (session?.nativeId && navigatedUrl && !officialPage(navigatedUrl, true)) {
    event('Target.detachedFromTarget', { sessionId, targetId: params.frame?.id || params.targetInfo?.targetId }, session.parent);
    void chrome.debugger.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: session.nativeId }).catch(() => {});
    forgetSession(sessionId); return;
  }
  if (method === 'Runtime.executionContextCreated') {
    const origin = params.context?.origin;
    if (origin && origin !== '://' && !officialPage(origin)) return;
  }
  if (method === 'Target.attachedToTarget') {
    const child = params.targetInfo;
    if (!child || !officialPage(child.url || 'about:blank', true)) {
      void chrome.debugger.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: params.sessionId }).catch(() => {}); return;
    }
    const childId = `child-${++sequence}`;
    sessions.set(childId, { tabId: source.tabId, nativeId: params.sessionId, parent: sessionId });
    event(method, { ...params, sessionId: childId, targetInfo: { ...child, browserContextId: CONTEXT_ID } }, sessionId); return;
  }
  if (method === 'Target.detachedFromTarget') {
    const childId = [...sessions].find(([, value]) => value.tabId === source.tabId && value.nativeId === params.sessionId)?.[0];
    if (childId) { event(method, { ...params, sessionId: childId }, sessionId); forgetSession(childId); } return;
  }
  if (method === 'Network.responseReceived') {
    if (officialResponse(params.response?.url)) {
      if (!responses.has(sessionId)) responses.set(sessionId, new Set());
      const observed = responses.get(sessionId); observed.add(params.requestId); if (observed.size > 500) observed.delete(observed.values().next().value);
    } else responses.get(sessionId)?.delete(params.requestId);
  }
  if (method === 'Network.requestWillBeSent') responses.get(sessionId)?.delete(params.requestId);
  event(method, method.startsWith('Network.') ? safeNetworkEvent(method, params) : params, sessionId);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const sessionId = tabSessions.get(source.tabId);
  const expectedSession = expectedDetach.get(source.tabId);
  expectedDetach.delete(source.tabId);
  if (expectedSession && (!sessionId || expectedSession === sessionId)) { if (sessionId) forgetSession(sessionId); return; }
  if (!sessionId) return;
  event('Inspector.detached', { reason }, sessionId);
  event('Target.detachedFromTarget', { sessionId, targetId: `tab-${source.tabId}` }); forgetSession(sessionId);
  // Closing an individual helper tab is not a request to stop this profile.
  // tabs.onRemoved will forget the target; the other owned pages stay attached.
  if (reason === 'target_closed') return;
  void stopConnection('Chrome 已停止调试控制。请确认原因后手动重新连接。');
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!ownedTabs.has(tabId)) return;
  if (change.url && !officialPage(change.url, true)) {
    void (async () => { await detachTab(tabId); ownedTabs.delete(tabId); await persistOwned(); await stopConnection('助手标签页离开 Catchtable，已停止控制并保留该页面。'); })(); return;
  }
  if (discover && (change.url || change.title)) event('Target.targetInfoChanged', { targetInfo: targetInfo(tab) });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!ownedTabs.delete(tabId)) return;
  const sessionId = tabSessions.get(tabId);
  if (sessionId) { event('Target.detachedFromTarget', { sessionId, targetId: `tab-${tabId}` }); forgetSession(sessionId); }
  if (discover) event('Target.targetDestroyed', { targetId: `tab-${tabId}` });
  void persistOwned();
});
chrome.tabs.onCreated.addListener((tab) => {
  if (!ownedTabs.has(tab.openerTabId) || !officialPage(tab.url || tab.pendingUrl || 'about:blank', true)) return;
  ownedTabs.add(tab.id);
  void (async () => { await persistOwned(); if (discover) event('Target.targetCreated', { targetInfo: targetInfo(tab) }); if (autoAttach) await attachTab(tab); })().catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const kind = senderKind(sender);
  if (!kind || !message || !['status', 'connect', ...(kind === 'popup' ? ['open_console', 'disconnect'] : [])].includes(message.type)) return false;
  void (async () => {
    await ready;
    if (message?.type === 'status') return status();
    if (message?.type === 'open_console') { await chrome.tabs.create({ url: CONSOLE_URL, active: true }); return status(); }
    return serializeOperation(async () => {
      if (message.type === 'disconnect') { await stopConnection(); return status(); }
      const saved = await chrome.storage.local.get('pairingCode');
      let code = typeof message.pairingCode === 'string' ? message.pairingCode.trim() : saved.pairingCode;
      if (!pairingCode(code)) throw new Error('请粘贴有效的本地配对码。');
      const expectedId = typeof message.accountId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(message.accountId) ? message.accountId : null;
      const sameAccount = expectedId && accountId && expectedId === accountId;
      const differentBinding = saved.pairingCode && (code !== saved.pairingCode && !sameAccount || expectedId && accountId && expectedId !== accountId);
      if (differentBinding && message.force !== true) {
        throw connectionError(`此 Chrome 已绑定${accountLabel ? `「${accountLabel}」` : '其他账号'}。请使用该账号的 Chrome，或确认更换绑定。`, 'ACCOUNT_CONFLICT');
      }
      if (sameAccount && saved.pairingCode && message.force !== true) code = saved.pairingCode;
      if (code === saved.pairingCode && socket && enabled) {
        if (kind === 'console' || message.awaitAcknowledgement === true) await waitForConnection();
        if (expectedId && expectedId !== accountId) throw connectionError('扩展返回的账号与所选账号不同，请重新连接。', 'ACCOUNT_MISMATCH');
        return status();
      }
      await stopConnection('正在重新连接…', false);
      // Switching accounts must not adopt the preceding account's pages.
      // Leave those tabs open, detach them, and create fresh owned tabs.
      if (saved.pairingCode !== code) {
        ownedTabs.clear(); accountId = null; accountLabel = null; await persistOwned();
        await chrome.storage.local.set({ boundAccountId: null, boundAccountLabel: null });
      }
      await chrome.storage.local.set({ pairingCode: code, connectionEnabled: true });
      enabled = true; await connectSocket();
      if (kind === 'console' || message.awaitAcknowledgement === true) await waitForConnection();
      if (expectedId && expectedId !== accountId) {
        await stopConnection('账号不匹配，已停止连接。');
        throw connectionError('配对账号与所选账号不同，请重新连接。', 'ACCOUNT_MISMATCH');
      }
      return status();
    });
  })().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, ...status(), code: error.code || 'OPERATION_FAILED', message: error.message || '操作失败。' }));
  return true;
});
const ready = (async () => {
  const savedOwned = await chrome.storage.session.get({ ownedTabIds: [] });
  for (const tabId of savedOwned.ownedTabIds || []) {
    if (!Number.isInteger(tabId)) continue;
    try { const tab = await chrome.tabs.get(tabId); if (officialPage(tab.url || 'about:blank', true)) ownedTabs.add(tabId); } catch { /* Closed fixture or previous owned tabs. */ }
  }
  const saved = await chrome.storage.local.get({ connectionEnabled: false, boundAccountId: null, boundAccountLabel: null });
  accountId = typeof saved.boundAccountId === 'string' ? saved.boundAccountId : null;
  accountLabel = typeof saved.boundAccountLabel === 'string' ? saved.boundAccountLabel : null;
  enabled = saved.connectionEnabled === true;
  if (enabled) await connectSocket();
})();
