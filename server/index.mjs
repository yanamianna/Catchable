import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { ExtensionBroker } from './extension-bridge.mjs';
import { AccountCoordinator } from './accounts.mjs';
import { accountApi } from './account-api.mjs';
import { backupBeforeAccounts } from './upgrade.mjs';
import { HttpError, TASK_LIMIT, createTask, resolvePollInterval, safeMessage, validateBookingContactSettings, validateWebhookUrl } from './domain.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw new HttpError(413, '请求内容过大。');
  }
  if (!body) return {};
  try {
    const value = JSON.parse(body);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, '请求内容须为 JSON 对象。'); }
}

export function createHttpServer({ store, engine, extensionBridge, coordinator, frontendDir = resolve('dist'), port = 4174 }) {
  const server = createServer(async (request, response) => {
    try {
      const actualPort = server.address()?.port || port;
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowedHosts.has(request.headers.host)) throw new HttpError(403, '仅允许通过本机地址访问。');
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      const method = request.method;
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST', 'DELETE'].includes(method)) throw new HttpError(405, '不支持该请求方式。');
        if (method !== 'GET') {
          const origins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, 'http://127.0.0.1:4173', 'http://localhost:4173']);
          if (!origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '操作须从本机系统页面发起。');
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new HttpError(415, '操作请求须使用 application/json。');
        }
        const body = method === 'GET' ? {} : await readJson(request);
        if(coordinator) {
          const result=await accountApi({coordinator,url,method,body,request,port:actualPort});
          if(result)return sendJson(response,result.status || 200,result.value);
        }
        if (method === 'GET' && url.pathname === '/api/extension/pairing') {
          const origins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, 'http://127.0.0.1:4173', 'http://localhost:4173']);
          const site = request.headers['sec-fetch-site'];
          let refererOrigin;
          try { refererOrigin = new URL(request.headers.referer).origin; } catch {}
          const trusted = request.headers.origin
            ? origins.has(request.headers.origin) && (!site || site === 'same-origin')
            : site === 'same-origin' && origins.has(refererOrigin);
          if (!trusted) throw new HttpError(403, '扩展配对信息只能从本机系统页面读取。');
          if (!extensionBridge) throw new HttpError(503, '扩展桥尚未启用。');
          return sendJson(response, 200, extensionBridge.pairingInfo());
        }
        if (method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'catchtable-local', timestamp: engine.timestamp() });
        if (method === 'GET' && url.pathname === '/api/state') {
          const bookings = store.listVisibleAttempts().map(({ taskSnapshot, ...booking }) => booking);
          return sendJson(response, 200, { tasks: store.listTasks(), events: store.listEvents(), bookings, notifications: store.listNotifications(), settings: store.settings(), session: engine.session, engine: engine.state(), stats: store.stats(), ...(extensionBridge ? { extension: extensionBridge.state() } : {}) });
        }
        if (method === 'POST' && url.pathname === '/api/records/clear') {
          if (!['events', 'notifications', 'bookings', 'all'].includes(body.kind)) throw new HttpError(400, '记录类型须为 events、notifications、bookings 或 all。');
          const cleared = await engine.enqueue(() => store.clearRecords(body.kind));
          return sendJson(response, 200, { ok: true, cleared });
        }
        if (method === 'POST' && url.pathname === '/api/tasks') {
          if (store.listTasks().filter((task) => task.source === 'live').length >= TASK_LIMIT) throw new HttpError(409, `第一版最多保存 ${TASK_LIMIT} 条真实餐厅任务，请删除旧任务后再添加。`);
          const task = createTask(body, store.settings(), engine.now());
          store.saveTask(task);
          engine.event(task, 'created', '任务已保存，等待用户启动。');
          engine.schedule();
          return sendJson(response, 201, { task });
        }
        const action = url.pathname.match(/^\/api\/tasks\/([^/]+)\/action$/);
        if (method === 'POST' && action) return sendJson(response, 200, await engine.taskAction(decodeURIComponent(action[1]), body.action, body));
        const deletion = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (method === 'DELETE' && deletion) {
          engine.deleteTask(decodeURIComponent(deletion[1]));
          return sendJson(response, 200, { ok: true });
        }
        if (method === 'POST' && ['/api/session/open', '/api/session/check'].includes(url.pathname)) return sendJson(response, 200, await engine.sessionAction(url.pathname.endsWith('/open') ? 'open' : 'check',body));
        if (method === 'POST' && url.pathname === '/api/restaurants/resolve') return sendJson(response, 200, await engine.restaurantResolve(body.restaurantUrl));
        if (method === 'POST' && url.pathname === '/api/settings') {
          const changes = {};
          if (Object.hasOwn(body, 'pollIntervalMs') || Object.hasOwn(body, 'pollIntervalSeconds')) changes.pollIntervalMs = resolvePollInterval(body);
          if (body.webhookUrl !== undefined) changes.webhookUrl = (await validateWebhookUrl(body.webhookUrl)).url;
          for (const key of ['bookingPhoneCountryCode','bookingPhoneNumber','bookingPhoneAutoFill']) {
            if (body[key] !== undefined) changes[key] = body[key];
          }
          if (body.browserIntegration !== undefined) {
            if (!['extension','dedicated'].includes(body.browserIntegration)) throw new HttpError(400, '浏览器连接方式须为 extension 或 dedicated。');
            changes.browserIntegration = body.browserIntegration;
          }
          if(body.browserChannel!==undefined) {
            if(!['chrome','msedge'].includes(body.browserChannel))throw new HttpError(400,'专用浏览器须选择 chrome 或 msedge。');
            changes.browserChannel=body.browserChannel;
          }
          if(body.applyToExistingTasks!==undefined && typeof body.applyToExistingTasks!=='boolean')throw new HttpError(400,'applyToExistingTasks 须为布尔值。');
          validateBookingContactSettings(changes,store.settings());
          if (body.browserIntegration !== undefined && body.browserIntegration !== store.settings().browserIntegration) await engine.changeIntegration(body.browserIntegration);
          if(body.browserChannel!==undefined && body.browserChannel!==store.settings().browserChannel)await engine.changeBrowser(body.browserChannel);
          const settings = engine.updateSettings(changes, { applyToExistingTasks: body.applyToExistingTasks ?? false });
          return sendJson(response, 200, { settings });
        }
        if (method === 'POST' && url.pathname === '/api/engine/action') return sendJson(response, 200, engine.globalAction(body.action));
        if (method === 'POST' && url.pathname === '/api/demo/run') return sendJson(response, 200, await engine.runDemo());
        throw new HttpError(404, '找不到该接口。');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持该请求方式。');
      const root = resolve(frontendDir);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '网址编码不正确。'); }
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new HttpError(403, '禁止访问该文件。');
      try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html'); }
      catch { file = resolve(root, 'index.html'); }
      let contents;
      try { contents = await readFile(file); }
      catch { throw new HttpError(503, '前端尚未构建。请执行 npm run build，或使用 npm run dev。'); }
      response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      response.end(method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      sendJson(response, error instanceof HttpError ? error.status : 500, { error: safeMessage(error) });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  if (extensionBridge) {
    extensionBridge.attach(server);
    const closeHttp = server.close.bind(server);
    server.close = (callback) => {
      // An upgraded socket is not released by HTTP close alone. Close the
      // local tunnels first; this never issues Browser.close to Chrome.
      extensionBridge.close().then(() => closeHttp(callback), () => closeHttp(callback));
      return server;
    };
  }
  return server;
}

export async function startServer({ dataDir = resolve(process.env.DATA_DIR || '.local-data'), port = Number(process.env.PORT || 4174), adapter, extensionBridge, frontendDir } = {}) {
  await backupBeforeAccounts(dataDir);
  const store = new Store(resolve(dataDir, 'catchtable.sqlite'));
  extensionBridge ||= new ExtensionBroker({dataDir,port});
  await extensionBridge.init();
  const coordinator=await new AccountCoordinator({store,broker:extensionBridge,dataDir,...(adapter?{adapterFactory:()=>adapter}:{})}).init();
  const engine=coordinator.engine();
  const server = createHttpServer({ store, engine, extensionBridge, coordinator, frontendDir, port });
  await new Promise((resolveStarted, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveStarted); });
  coordinator.start();
  const close = async () => {
    // WebSocket clients otherwise keep HTTP close waiting indefinitely.
    await extensionBridge?.close();
    await new Promise((resolveClosed) => server.close(resolveClosed));
    await coordinator.stop();
    store.close();
  };
  return { server, store, engine, extensionBridge, coordinator, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startServer().then((app) => {
    console.log(`Catchtable 本地系统已启动：http://127.0.0.1:${app.server.address().port}`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      app.close().then(() => process.exit(0)).catch((error) => { console.error(safeMessage(error)); process.exit(1); });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((error) => { console.error(safeMessage(error)); process.exitCode = 1; });
}
