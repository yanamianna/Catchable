import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const PAIRING_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;
const ROOT_TARGET_METHODS = new Set(['Target.getTargets','Target.getTargetInfo','Target.getBrowserContexts','Target.setDiscoverTargets','Target.setAutoAttach','Target.attachToTarget','Target.detachFromTarget','Target.createTarget','Target.closeTarget','Target.activateTarget']);
const PAGE_DOMAINS = new Set(['Page','Runtime','DOM','CSS','Network','Log','Inspector','Emulation','Input','Accessibility','Target']);
const FORBIDDEN_METHODS = /^(?:Storage\.|DOMStorage\.|IndexedDB\.|CacheStorage\.|Network\.(?:getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies|getRequestPostData)|Browser\.(?:close|getBrowserCommandLine|grantPermissions|resetPermissions)|Target\.(?:createBrowserContext|disposeBrowserContext))/;
const STORAGE_EXPRESSION = /\b(?:localStorage|sessionStorage|indexedDB|cookieStore)\b|\bdocument\s*(?:\.\s*cookie|\[\s*['"]cookie['"]\s*\])/;
const SENSITIVE_FIELDS = new Set(['cookies','associatedCookies','blockedCookies','headersText','postData','postDataEntries']);
const SECRET_HEADERS = /^(?:cookie|set-cookie|authorization|proxy-authorization)$/i;
const ISSUE_MESSAGES = {
  origin_invalid: '扩展连接来源未通过核验。请重新加载 Chrome 中的 Catchable 扩展，再从扩展面板连接。',
  protocol_invalid: '扩展连接协议不匹配。请在 Chrome 扩展页重新加载最新版 Catchable 扩展后再连接。',
  pairing_mismatch: '扩展配对码不匹配。请从本机控制台重新复制配对码，粘贴到扩展面板后连接。',
  already_connected: '已有一个 Chrome 扩展连接。请先在已连接的扩展面板断开，再连接当前扩展。',
  hello_invalid: '扩展初始化消息无效。请重新加载最新版 Catchable 扩展后再连接。',
  hello_timeout: '扩展初始化超时。请重新加载 Catchable 扩展后再连接。',
  worker_disconnected: 'Chrome 扩展连接已断开。请在扩展面板重新连接；未完成的预约操作不会自动重发。',
};

function bridgeError(message, code = 'EXTENSION_BRIDGE_ERROR') {
  return Object.assign(new Error(message), { code });
}

function equalSecret(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(value), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAllowedExtensionTarget(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['catchtable.net','www.catchtable.net'].includes(url.hostname)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function isAllowedObservedResponse(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['catchtable.net','www.catchtable.net','api.catchtable.net'].includes(url.hostname)
      && !url.username && !url.password && !url.port
      && !/(?:^|\/)(?:auth|oauth|login|token|cookies?)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

// The bridge does not transport cookies, authorization headers, or request bodies.
// Normal observed account/order responses remain available to the existing adapter.
export function redactExtensionPayload(value) {
  if (Array.isArray(value)) return value.map(redactExtensionPayload);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(key)) continue;
    if (/^(?:headers|requestHeaders|responseHeaders)$/i.test(key) && item && typeof item === 'object') {
      output[key] = Object.fromEntries(Object.entries(item).filter(([name]) => !SECRET_HEADERS.test(name)));
    } else output[key] = redactExtensionPayload(item);
  }
  return output;
}

export class ExtensionBridge {
  #pairingCode;
  #cdpToken = randomBytes(32).toString('base64url');
  #extension = null;
  #hello = null;
  #pending = new Map();
  #nextId = 1;
  #targets = new Map();
  #sessions = new Map();
  #responses = new Map();
  #mainFrames = new Map();
  #cdpClients = new Set();
  #closed = false;
  #server = null;
  #upgrade;
  #workerServer;
  #cdpServer;
  #initialized = false;
  #lastIssue = null;

  constructor({ dataDir = resolve('.local-data'), extensionPath = resolve('extension'), port = 4174, pairingCode, commandTimeoutMs = 15000, handshakeTimeoutMs = 5000 } = {}) {
    this.dataDir = resolve(dataDir); this.extensionPath = resolve(extensionPath); this.port = port;
    this.commandTimeoutMs = commandTimeoutMs; this.handshakeTimeoutMs = handshakeTimeoutMs;
    if (pairingCode !== undefined && !PAIRING_PATTERN.test(pairingCode)) throw new Error('扩展配对码格式不正确。');
    this.#pairingCode = pairingCode;
  }

  async init() {
    if (this.#initialized) return this;
    if (!this.#pairingCode) {
      await mkdir(this.dataDir, { recursive: true });
      const file = join(this.dataDir, 'extension-pairing.key');
      try { this.#pairingCode = (await readFile(file, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法读取本地扩展配对设置。');
        const generated = randomBytes(32).toString('base64url');
        try { await writeFile(file, `${generated}\n`, { flag: 'wx', mode: 0o600 }); this.#pairingCode = generated; }
        catch (failure) {
          if (failure.code !== 'EEXIST') throw new Error('无法保存本地扩展配对设置。');
          this.#pairingCode = (await readFile(file, 'utf8')).trim();
        }
      }
      if (!PAIRING_PATTERN.test(this.#pairingCode)) throw new Error('本地扩展配对设置已损坏。');
    }
    this.#initialized = true;
    return this;
  }

  state() {
    const connected = Boolean(this.#hello && this.#extension?.readyState === WebSocket.OPEN && !this.#closed);
    return { connected, status: this.#closed ? 'closed' : connected ? 'connected' : this.#extension ? 'connecting' : 'disconnected',
      message: this.#closed ? '本地扩展桥已停止。' : this.#lastIssue ? ISSUE_MESSAGES[this.#lastIssue.code] : connected ? 'Chrome 扩展已连接；登录状态由官方页面另行核验。' : 'Chrome 扩展尚未连接，请安装扩展并完成本机配对。',
      clientName: connected ? (/Edg\//.test(this.#hello.userAgent) ? 'Microsoft Edge 扩展' : 'Google Chrome 扩展') : null,
      lastIssue: this.#lastIssue ? { ...this.#lastIssue } : null };
  }

  #issue(code) {
    this.#lastIssue = { code, timestamp: new Date().toISOString() };
  }

  pairingInfo() {
    if (!this.#initialized) throw new Error('扩展桥尚未初始化。');
    return { pairingCode: this.#pairingCode, extensionPath: this.extensionPath };
  }

  getCdpEndpoint() {
    if (!this.state().connected) throw bridgeError('Chrome 扩展尚未连接，请先完成扩展配对。', 'EXTENSION_NOT_CONNECTED');
    const port = this.#server?.address()?.port || this.port;
    return `ws://127.0.0.1:${port}/cdp/${this.#cdpToken}`;
  }

  attach(server) {
    if (!this.#initialized) throw new Error('请先初始化扩展桥。');
    if (this.#server) throw new Error('扩展桥已经绑定本地服务。');
    this.#server = server;
    this.#workerServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, handleProtocols: protocols => protocols.has('catchable') ? 'catchable' : false });
    this.#cdpServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.#workerServer.on('connection', socket => this.#connectExtension(socket));
    this.#cdpServer.on('connection', socket => this.#connectCdp(socket));
    this.#upgrade = (request, socket, head) => {
      const port = server.address()?.port || this.port;
      const host = request.headers.host;
      const local = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
      const localHost = [`127.0.0.1:${port}`,`localhost:${port}`].includes(host);
      const diagnosticRequest = local && localHost && request.url === '/extension';
      const reject = (status = 403) => { socket.write(`HTTP/1.1 ${status} ${status === 409 ? 'Conflict' : 'Forbidden'}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
      const issue = code => { if (diagnosticRequest) this.#issue(code); };
      if (this.#closed || !local || !localHost) return reject();
      let url;
      try { url = new URL(request.url, `http://127.0.0.1:${port}`); } catch { return reject(); }
      if (url.search || url.hash) return reject();
      if (url.pathname === '/extension') {
        const origin = request.headers.origin || '';
        const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { issue('origin_invalid'); return reject(); }
        if (protocols.length !== 2 || protocols[0] !== 'catchable' || !/^pair\.[A-Za-z0-9_-]{24,128}$/.test(protocols[1])) { issue('protocol_invalid'); return reject(); }
        if (!equalSecret(protocols[1], `pair.${this.#pairingCode}`)) { issue('pairing_mismatch'); return reject(); }
        if (this.#extension && this.#extension.readyState !== WebSocket.CLOSED) { issue('already_connected'); return reject(409); }
        return this.#workerServer.handleUpgrade(request, socket, head, accepted => this.#workerServer.emit('connection', accepted, request));
      }
      if (url.pathname.startsWith('/cdp/')) {
        if (request.headers.origin || !equalSecret(url.pathname, `/cdp/${this.#cdpToken}`) || !this.state().connected) return reject();
        if (this.#cdpClients.size) return reject(409);
        return this.#cdpServer.handleUpgrade(request, socket, head, accepted => this.#cdpServer.emit('connection', accepted, request));
      }
      return reject();
    };
    server.on('upgrade', this.#upgrade);
    server.once('close', () => { void this.close(); });
    return this;
  }

  #connectExtension(socket) {
    this.#extension = socket; this.#hello = null;
    let handshakeFailed = false;
    const invalidHello = reason => {
      if (!this.#hello) { handshakeFailed = true; this.#issue('hello_invalid'); }
      socket.close(1008, reason);
    };
    const timer = setTimeout(() => {
      handshakeFailed = true; this.#issue('hello_timeout'); socket.close(1008, 'Extension handshake required');
    }, this.handshakeTimeoutMs);
    timer.unref?.();
    socket.on('error', () => {});
    socket.on('message', (data, binary) => {
      if (binary) return invalidHello('JSON messages required');
      let message;
      try { message = JSON.parse(data.toString()); } catch { return invalidHello('Invalid extension message'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return invalidHello('Invalid extension message');
      if (!this.#hello) {
        if (message.type !== 'hello' || message.protocolVersion !== '1.3' || typeof message.userAgent !== 'string' || !message.userAgent || message.userAgent.length > 2048)
          return invalidHello('Invalid extension handshake');
        this.#hello = { userAgent: message.userAgent, protocolVersion: '1.3' };
        this.#lastIssue = null;
        clearTimeout(timer); return;
      }
      if (message.type === 'result') {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(bridgeError('Chrome 扩展无法执行该页面命令。', 'EXTENSION_COMMAND_FAILED'));
        else {
          let result = redactExtensionPayload(message.result ?? {});
          if (pending.method === 'Page.getFrameTree') {
            const info = this.#sessions.get(pending.sessionId);
            const nativeId = result.frameTree?.frame?.id;
            if (info?.type === 'page' && typeof nativeId === 'string') this.#mainFrames.set(info.targetId, nativeId);
          }
          result = this.#translateFrames(result, false);
          pending.resolve(result);
        }
      } else if (message.type === 'event') this.#extensionEvent(message);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (this.#extension !== socket) return;
      if (!handshakeFailed) this.#issue('worker_disconnected');
      this.#extension = null; this.#hello = null;
      this.#targets.clear(); this.#sessions.clear(); this.#responses.clear(); this.#mainFrames.clear();
      this.#rejectPending(bridgeError('Chrome 扩展已断开；未完成的命令不会自动重发。', 'EXTENSION_DISCONNECTED'));
      for (const client of this.#cdpClients) client.close(1011, 'Extension disconnected');
    });
  }

  #targetInfo(info) {
    if (!info || typeof info.targetId !== 'string' || !['page','iframe'].includes(info.type) || !isAllowedExtensionTarget(info.url)) return null;
    return { ...info, browserContextId: 'catchable-default' };
  }

  // Chromium normally uses the page target ID as its main frame ID. Our tabs
  // have virtual target IDs, so frame references must agree in both directions.
  #translateFrames(value, toNative) {
    if (Array.isArray(value)) return value.map(item => this.#translateFrames(item, toNative));
    if (!value || typeof value !== 'object') return value;
    const frame = typeof value.url === 'string' && ('loaderId' in value || 'securityOrigin' in value);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (['frameId','parentFrameId','openerFrameId','parentId'].includes(key) || (frame && key === 'id'))) {
        let replacement = item;
        for (const [virtualId,nativeId] of this.#mainFrames) {
          if (item === (toNative ? virtualId : nativeId)) { replacement = toNative ? nativeId : virtualId; break; }
        }
        output[key] = replacement;
      } else output[key] = this.#translateFrames(item, toNative);
    }
    return output;
  }

  #extensionEvent(message) {
    if (typeof message.method !== 'string' || !message.params || typeof message.params !== 'object') return;
    let params = redactExtensionPayload(message.params);
    const parent = message.sessionId;
    if (message.method === 'Target.attachedToTarget') {
      const info = this.#targetInfo(params.targetInfo);
      if (!info || typeof params.sessionId !== 'string' || (parent && !this.#sessions.has(parent))) return;
      this.#targets.set(info.targetId, info); this.#sessions.set(params.sessionId, info);
      params.targetInfo = info;
    } else if (['Target.targetCreated','Target.targetInfoChanged'].includes(message.method)) {
      const info = this.#targetInfo(params.targetInfo);
      if (!info) return;
      this.#targets.set(info.targetId, info); params.targetInfo = info;
    } else if (message.method === 'Target.detachedFromTarget') {
      if (!this.#sessions.has(params.sessionId)) return;
      this.#sessions.delete(params.sessionId);
    } else if (message.method === 'Target.targetDestroyed') {
      if (!this.#targets.has(params.targetId)) return;
      this.#targets.delete(params.targetId); this.#mainFrames.delete(params.targetId);
    } else {
      if (!parent || !this.#sessions.has(parent) || !PAGE_DOMAINS.has(message.method.split('.')[0])) return;
      if (message.method === 'Network.responseReceived' && params.response && typeof params.requestId === 'string' && isAllowedObservedResponse(params.response.url)) {
        this.#responses.set(`${parent}:${params.requestId}`, params.response.url);
        if (this.#responses.size > 2000) this.#responses.delete(this.#responses.keys().next().value);
      }
      if (message.method === 'Page.frameNavigated' && !params.frame?.parentId && !isAllowedExtensionTarget(params.frame?.url)) {
        this.#sessions.delete(parent); return;
      }
      if (message.method === 'Page.frameNavigated' && !params.frame?.parentId) {
        const info = this.#sessions.get(parent);
        if (info?.type === 'page' && typeof params.frame?.id === 'string') this.#mainFrames.set(info.targetId,params.frame.id);
      }
    }
    params = this.#translateFrames(params, false);
    const output = { method: message.method, params, ...(parent ? { sessionId: parent } : {}) };
    for (const client of this.#cdpClients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(output));
  }

  #validateCommand(method, params, sessionId) {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method) || !params || typeof params !== 'object' || Array.isArray(params)) throw bridgeError('CDP 命令格式不正确。');
    if (FORBIDDEN_METHODS.test(method)) throw bridgeError('扩展桥禁止读取认证存储或关闭用户浏览器。', 'EXTENSION_COMMAND_BLOCKED');
    if (sessionId) {
      if (!this.#sessions.has(sessionId) || !PAGE_DOMAINS.has(method.split('.')[0])) throw bridgeError('只能操作扩展创建的 Catchtable 页面。', 'EXTENSION_TARGET_BLOCKED');
    } else if (!ROOT_TARGET_METHODS.has(method) && !['Browser.getVersion','Browser.setDownloadBehavior'].includes(method)) throw bridgeError('扩展桥不支持该浏览器级命令。', 'EXTENSION_COMMAND_BLOCKED');
    if (['Page.navigate','Target.createTarget'].includes(method) && !isAllowedExtensionTarget(params.url)) throw bridgeError('只允许打开 Catchtable 官方页面。', 'EXTENSION_TARGET_BLOCKED');
    if (params.browserContextId && params.browserContextId !== 'catchable-default') throw bridgeError('不允许创建或切换用户浏览器资料。', 'EXTENSION_TARGET_BLOCKED');
    if (['Target.closeTarget','Target.activateTarget','Target.attachToTarget'].includes(method) && !this.#targets.has(params.targetId)) throw bridgeError('该标签不属于本扩展。', 'EXTENSION_TARGET_BLOCKED');
    if (method === 'Target.getTargetInfo' && params.targetId && !this.#targets.has(params.targetId)) throw bridgeError('该标签不属于本扩展。', 'EXTENSION_TARGET_BLOCKED');
    if (method === 'Target.detachFromTarget' && !this.#sessions.has(params.sessionId)) throw bridgeError('该调试会话不属于本扩展。', 'EXTENSION_TARGET_BLOCKED');
    if (['Runtime.evaluate','Runtime.callFunctionOn','Page.addScriptToEvaluateOnNewDocument'].includes(method)
      && STORAGE_EXPRESSION.test(String(params.expression || params.functionDeclaration || params.source || ''))) throw bridgeError('扩展桥禁止读取认证存储。', 'EXTENSION_COMMAND_BLOCKED');
    if (method === 'Network.getResponseBody' && !this.#responses.has(`${sessionId}:${params.requestId}`)) throw bridgeError('只能读取正常导航中已观察到的官方响应。', 'EXTENSION_COMMAND_BLOCKED');
  }

  async requestCDP(method, params = {}, sessionId) {
    if (!this.state().connected) throw bridgeError('Chrome 扩展尚未连接。', 'EXTENSION_NOT_CONNECTED');
    this.#validateCommand(method, params, sessionId);
    // noDefaults preserves the personal browser's settings, but also skips
    // Playwright's focus emulation. Restore it only for an owned page being
    // activated, so animation-frame action checks work in an occluded window.
    if (method === 'Page.bringToFront' && this.#sessions.get(sessionId)?.type === 'page') {
      await this.requestCDP('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    }
    if (method === 'Browser.getVersion') {
      const version = this.#hello.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] || '1.0.0.0';
      return { protocolVersion: '1.3', product: `Chrome/${version}`, revision: 'catchable-extension', userAgent: this.#hello.userAgent, jsVersion: '0' };
    }
    // Preserve the user's normal download configuration; noDefaults normally skips this.
    if (method === 'Browser.setDownloadBehavior') return {};
    const id = this.#nextId++;
    const result = await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(bridgeError('扩展页面命令超时；结果未知，未自动重发。', 'EXTENSION_COMMAND_TIMEOUT'));
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolveResult, reject, timer, method, sessionId });
      this.#extension.send(JSON.stringify({ type: 'command', id, method, params: this.#translateFrames(params,true), ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id); clearTimeout(timer); reject(bridgeError('Chrome 扩展命令发送失败。', 'EXTENSION_DISCONNECTED'));
      });
    });
    if (method === 'Target.getTargets') {
      const infos = Array.isArray(result.targetInfos) ? result.targetInfos.map(info => this.#targetInfo(info)).filter(Boolean) : [];
      for (const info of infos) this.#targets.set(info.targetId, info);
      return { targetInfos: infos };
    }
    if (method === 'Target.getTargetInfo' && result.targetInfo?.type !== 'browser') {
      const info = this.#targetInfo(result.targetInfo);
      if (!info) throw bridgeError('扩展返回了范围外的标签。', 'EXTENSION_TARGET_BLOCKED');
      return { targetInfo: info };
    }
    if (method === 'Target.closeTarget' && result.success) {
      this.#targets.delete(params.targetId); this.#mainFrames.delete(params.targetId);
    }
    return result;
  }

  #connectCdp(socket) {
    this.#cdpClients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => this.#cdpClients.delete(socket));
    socket.on('message', async (data, binary) => {
      if (binary) return socket.close(1008, 'JSON messages required');
      let message;
      try { message = JSON.parse(data.toString()); } catch { return socket.close(1008, 'Invalid CDP message'); }
      if (!Number.isSafeInteger(message?.id) || message.id < 0) return socket.close(1008, 'Invalid CDP message');
      const response = { id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
      try { response.result = await this.requestCDP(message.method, message.params || {}, message.sessionId); }
      catch (error) { response.error = { code: -32000, message: error.message }; }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
    });
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#server?.off('upgrade', this.#upgrade);
    this.#rejectPending(bridgeError('本地扩展桥已停止；未完成命令不会重发。', 'EXTENSION_DISCONNECTED'));
    for (const client of this.#cdpClients) client.terminate();
    this.#extension?.terminate();
    this.#cdpClients.clear(); this.#extension = null; this.#hello = null;
    this.#targets.clear(); this.#sessions.clear(); this.#responses.clear(); this.#mainFrames.clear();
    await Promise.all([this.#workerServer, this.#cdpServer].filter(Boolean).map(server => new Promise(done => server.close(() => done()))));
  }
}
