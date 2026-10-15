import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const workerSource = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const fixtureCode = 'local_fixture_pairing_0123456789';
function channel() {
  const listeners = [];
  return { addListener: value => listeners.push(value), fire: (...args) => listeners.map(value => value(...args)), listeners };
}
function store(initial = {}) {
  const values = { ...initial };
  return { values, get: async key => typeof key === 'string' ? { [key]: values[key] } : { ...key, ...values }, set: async changes => Object.assign(values, changes) };
}
async function worker() {
  const tabs = new Map([[1, { id: 1, title: 'Personal existing Catchtable tab', url: 'https://www.catchtable.net/shop/personal_fixture' }]]);
  const calls = []; const sockets = []; const timers = new Map(); let timerId = 0; let nextTab = 10;
  const chrome = {
    storage: { local: store(), session: store() }, runtime: { id: 'fixture-extension', onMessage: channel() },
    tabs: {
      onCreated: channel(), onUpdated: channel(), onRemoved: channel(),
      get: async id => { if (!tabs.has(id)) throw new Error('Fixture tab missing'); return { ...tabs.get(id) }; },
      create: async options => { const tab = { id: ++nextTab, title: 'Owned fixture', ...options }; tabs.set(tab.id, tab); calls.push({ api: 'create', options }); chrome.tabs.onCreated.fire(tab); return { ...tab }; },
      update: async (id, changes) => { calls.push({ api: 'update', id, changes }); Object.assign(tabs.get(id), changes); return { ...tabs.get(id) }; },
      remove: async id => { calls.push({ api: 'remove', id }); tabs.delete(id); chrome.tabs.onRemoved.fire(id); },
    },
    debugger: {
      onEvent: channel(), onDetach: channel(),
      attach: async (target, version) => { calls.push({ api: 'attach', target, version }); },
      detach: async target => { calls.push({ api: 'detach', target }); chrome.debugger.onDetach.fire(target, 'canceled_by_user'); },
      sendCommand: async (target, method, params) => { calls.push({ api: 'command', target: JSON.parse(JSON.stringify(target)), method, params }); return method === 'Network.getResponseBody' ? { body: '{"fixture":true}', base64Encoded: false } : { fixture: true }; },
    },
  };
  class FakeSocket {
    static OPEN = 1;
    constructor(url, protocols) { this.url = url; this.protocols = [...protocols]; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.closed = true; return this.onclose?.({ code: 1000 }); }
    serverClose(code = 1006) { this.readyState = 3; return this.onclose?.({ code }); }
  }
  const timer = (callback, duration, interval = false) => { const id = ++timerId; timers.set(id, { callback, duration, interval }); return id; };
  const context = createContext({ chrome, WebSocket: FakeSocket, URL, navigator: { userAgent: 'Fixture Chrome/154.0.0.0' },
    setTimeout: (callback, duration) => timer(callback, duration), clearTimeout: id => timers.delete(id),
    setInterval: (callback, duration) => timer(callback, duration, true), clearInterval: id => timers.delete(id),
  });
  runInContext(workerSource, context); await runInContext('ready', context);
  const message = value => new Promise(done => chrome.runtime.onMessage.listeners[0](value, { id: chrome.runtime.id }, done));
  const connect = async () => { assert.equal((await message({ type: 'connect', pairingCode: fixtureCode })).ok, true); const socket = sockets.at(-1); socket.open(); return socket; };
  let commandId = 0;
  const command = async (method, params = {}, sessionId, socket = sockets.at(-1)) => {
    const id = ++commandId;
    await socket.onmessage({ data: JSON.stringify({ type: 'command', id, method, params, ...(sessionId ? { sessionId } : {}) }) });
    const reply = socket.sent.find(value => value.type === 'result' && value.id === id);
    assert.ok(reply, `fixture response expected for ${method}`); return reply;
  };
  const create = async () => {
    await command('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const result = await command('Target.createTarget', { url: 'about:blank' });
    assert.ok(result.result?.targetId);
    const targetId = result.result.targetId; const tabId = Number(targetId.slice(4));
    const attached = sockets.at(-1).sent.findLast(value => value.method === 'Target.attachedToTarget' && value.params.targetInfo.targetId === targetId);
    return { targetId, tabId, sessionId: attached.params.sessionId };
  };
  return { context, chrome, tabs, calls, sockets, timers, connect, command, create, message };
}

test('extension has only the declared local transport and browser-control permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['debugger', 'tabs', 'storage']);
  assert.equal(manifest.manifest_version, 3); assert.equal(manifest.minimum_chrome_version, '125');
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(manifest.content_security_policy.extension_pages.includes('connect-src ws://127.0.0.1:4174'));
  assert.ok(!manifest.content_scripts && !manifest.externally_connectable);
});

test('pairing uses the fixed local WebSocket endpoint and keeps the code out of status', async () => {
  const fixture = await worker();
  assert.equal((await fixture.message({ type: 'connect', pairingCode: 'bad' })).ok, false);
  assert.equal((await fixture.message({ type: 'connect', pairingCode: 'a'.repeat(23) })).ok, false);
  assert.equal(fixture.sockets.length, 0);
  await fixture.message({ type: 'connect', pairingCode: fixtureCode, serverUrl: 'wss://evil.invalid/' });
  const socket = fixture.sockets[0]; socket.open();
  assert.equal(socket.url, 'ws://127.0.0.1:4174/extension');
  assert.deepEqual(socket.protocols, ['catchable', `pair.${fixtureCode}`]);
  assert.deepEqual(socket.sent[0], { type: 'hello', userAgent: 'Fixture Chrome/154.0.0.0', protocolVersion: '1.3' });
  assert.ok(!JSON.stringify(await fixture.message({ type: 'status' })).includes(fixtureCode));
  const keepalive = [...fixture.timers.values()].find(value => value.interval);
  assert.equal(keepalive.duration, 20000); keepalive.callback(); assert.equal(socket.sent.at(-1).type, 'ping');
});

test('server account labels are displayed safely and switching pairing never adopts the previous account tabs',async()=>{
  const fixture=await worker();const socket=await fixture.connect();const owned=await fixture.create();
  await socket.onmessage({data:JSON.stringify({type:'hello_ack',accountLabel:'Synthetic account A'})});
  assert.equal((await fixture.message({type:'status'})).accountLabel,'Synthetic account A');
  await fixture.message({type:'connect',pairingCode:'different_fixture_pairing_0123456789'});
  const next=fixture.sockets.at(-1);next.open();
  assert.equal((await fixture.message({type:'status'})).accountLabel,null);
  assert.ok(fixture.tabs.has(owned.tabId),'switching account preserves its former tabs');
  assert.equal((await fixture.command('Target.getTargets')).result.targetInfos.length,0);
  assert.ok((await fixture.command('Target.attachToTarget',{targetId:owned.targetId})).error);
  await next.onmessage({data:JSON.stringify({type:'hello_ack',accountLabel:'Synthetic account B'})});
  assert.equal((await fixture.message({type:'status'})).accountLabel,'Synthetic account B');
  assert.equal(fixture.calls.filter(call=>call.api==='remove').length,0);
});

test('virtual target and session commands control only new owned tabs and never close Chrome', async () => {
  const fixture = await worker(); await fixture.connect(); const owned = await fixture.create();
  const attached = fixture.sockets[0].sent.find(value => value.method === 'Target.attachedToTarget');
  assert.equal(attached.params.targetInfo.browserContextId, 'catchable-default'); assert.equal(attached.params.waitingForDebugger, false);
  const listed = await fixture.command('Target.getTargets');
  assert.deepEqual(listed.result.targetInfos.map(value => value.targetId), [owned.targetId]);
  assert.ok((await fixture.command('Target.attachToTarget', { targetId: 'tab-1' })).error);
  assert.ok((await fixture.command('Target.closeTarget', { targetId: 'tab-1' })).error);
  assert.ok((await fixture.command('Target.createTarget', { url: 'https://accounts.google.com/' })).error);
  assert.ok((await fixture.command('Page.navigate', { url: 'https://evil.invalid/' }, owned.sessionId)).error);
  assert.ok((await fixture.command('Page.navigate', { url: 'https://www.catchtable.net/shop/fixture' }, owned.sessionId)).result);
  assert.ok((await fixture.command('Runtime.evaluate', { expression: 'document.body.innerText' }, owned.sessionId)).result);
  const native = fixture.calls.find(value => value.api === 'command' && value.method === 'Runtime.evaluate');
  assert.deepEqual(native.target, { tabId: owned.tabId });
  await fixture.command('Browser.close');
  assert.ok(fixture.tabs.has(1) && fixture.tabs.has(owned.tabId)); assert.ok(!fixture.calls.some(value => value.api === 'remove'));
  assert.equal((await fixture.message({ type: 'status' })).attachedTabs, 0);
});

test('cookie, storage, private request-body and credential-reading commands are rejected before Chrome API calls', async () => {
  const fixture = await worker(); await fixture.connect(); const owned = await fixture.create();
  const initialCommands = fixture.calls.filter(value => value.api === 'command').length;
  const forbidden = ['Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies', 'Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies', 'Network.getRequestPostData', 'Target.createBrowserContext', 'Browser.setPermission'];
  for (const method of forbidden) assert.ok((await fixture.command(method, {}, owned.sessionId)).error, method);
  for (const expression of ['document.cookie', 'document["cookie"]', 'localStorage.getItem("fixture")', 'sessionStorage.foo', 'fetch("https://evil.invalid")']) {
    assert.ok((await fixture.command('Runtime.evaluate', { expression }, owned.sessionId)).error);
  }
  assert.equal(fixture.calls.filter(value => value.api === 'command').length, initialCommands);
});

test('each newly attached owned tab receives Korean time before navigation and failed timezone setup cannot attach', async () => {
  const fixture = await worker(); const socket = await fixture.connect(); const owned = await fixture.create();
  const timezone = fixture.calls.find(value => value.api === 'command' && value.method === 'Emulation.setTimezoneOverride');
  assert.deepEqual(timezone.target, { tabId: owned.tabId });
  assert.equal(timezone.params.timezoneId, 'Asia/Seoul');
  assert.ok(!fixture.calls.some(value => value.api === 'command' && value.target.tabId === 1));
  await fixture.command('Page.navigate', { url: 'https://www.catchtable.net/shop/fixture' }, owned.sessionId);
  const timezoneIndex = fixture.calls.indexOf(timezone);
  const navigateIndex = fixture.calls.findIndex(value => value.api === 'command' && value.method === 'Page.navigate');
  assert.ok(timezoneIndex < navigateIndex);
  assert.equal(socket.sent.filter(value => value.method === 'Target.attachedToTarget').length, 1);
  await fixture.command('Target.attachToTarget', { targetId: owned.targetId });
  assert.equal(fixture.calls.filter(value => value.api === 'command' && value.method === 'Emulation.setTimezoneOverride').length, 1);
  const direct = await fixture.command('Target.createTarget', { url: 'https://www.catchtable.net/shop/fixture_direct' });
  assert.ok(direct.result.targetId);
  const directTabId = Number(direct.result.targetId.slice(4));
  assert.equal(fixture.calls.filter(value => value.api === 'create').at(-1).options.url, 'about:blank');
  const directTimezoneIndex = fixture.calls.findIndex(value => value.api === 'command' && value.target.tabId === directTabId && value.method === 'Emulation.setTimezoneOverride');
  const directNavigateIndex = fixture.calls.findIndex(value => value.api === 'command' && value.target.tabId === directTabId && value.method === 'Page.navigate');
  assert.ok(directTimezoneIndex >= 0 && directTimezoneIndex < directNavigateIndex);

  const failure = await worker(); const failedSocket = await failure.connect();
  failure.chrome.debugger.sendCommand = async (target, method) => { failure.calls.push({ api: 'command', target, method }); throw new Error('Fixture timezone unavailable'); };
  await failure.command('Target.setAutoAttach', { autoAttach: true });
  const result = await failure.command('Target.createTarget', { url: 'about:blank' });
  assert.match(result.error.message, /无法.*韩国时区/);
  assert.equal(failedSocket.sent.filter(value => value.method === 'Target.attachedToTarget').length, 0);
  assert.equal((await failure.message({ type: 'status' })).attachedTabs, 0);
  assert.ok(failure.calls.some(value => value.api === 'detach' && value.target.tabId !== 1));
});

test('network events retain Playwright response status while stripping cookies, authentication headers and posted secrets', async () => {
  const fixture = await worker(); const socket = await fixture.connect(); const owned = await fixture.create();
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId }, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api.catchtable.net/api/v6/my-dining/scheduled', headers: { Cookie: 'fixture-secret', Authorization: 'Bearer fixture-secret', Accept: 'application/json' }, postData: 'fixture-secret', postDataEntries: [{ bytes: 'fixture-secret' }] } });
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId }, 'Network.responseReceivedExtraInfo', { requestId: 'r1', statusCode: 200, headers: { 'Set-Cookie': 'fixture-secret', 'proxy-authorization': 'fixture-secret', 'content-type': 'application/json' }, associatedCookies: ['fixture-secret'], blockedCookies: ['fixture-secret'], headersText: 'fixture-secret' });
  const request = socket.sent.find(value => value.method === 'Network.requestWillBeSent');
  const response = socket.sent.find(value => value.method === 'Network.responseReceivedExtraInfo');
  assert.equal(request.sessionId, owned.sessionId); assert.deepEqual(request.params.request.headers, { Accept: 'application/json' });
  assert.equal(response.params.statusCode, 200); assert.deepEqual(response.params.headers, { 'content-type': 'application/json' });
  assert.ok(!JSON.stringify([request, response]).includes('fixture-secret'));
});

test('response bodies require observed official normal responses and exclude authentication endpoints', async () => {
  const fixture = await worker(); await fixture.connect(); const owned = await fixture.create();
  assert.ok((await fixture.command('Network.getResponseBody', { requestId: 'unknown' }, owned.sessionId)).error);
  const observe = (requestId, url) => fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId }, 'Network.responseReceived', { requestId, response: { url, headers: {} } });
  observe('normal', 'https://api.catchtable.net/api/v6/my-dining/scheduled?page=0&size=10');
  observe('userinfo', 'https://api.catchtable.net/api/v1/user/info');
  observe('auth', 'https://api.catchtable.net/api/v1/user/loginGoogle');
  observe('third-party', 'https://evil.invalid/orders');
  assert.equal((await fixture.command('Network.getResponseBody', { requestId: 'normal' }, owned.sessionId)).result.body, '{"fixture":true}');
  assert.ok((await fixture.command('Network.getResponseBody', { requestId: 'userinfo' }, owned.sessionId)).result);
  assert.ok((await fixture.command('Network.getResponseBody', { requestId: 'auth' }, owned.sessionId)).error);
  assert.ok((await fixture.command('Network.getResponseBody', { requestId: 'third-party' }, owned.sessionId)).error);
});

test('flat child-target sessions map back to the same owned tab and reject third-party frames', async () => {
  const fixture = await worker(); const socket = await fixture.connect(); const owned = await fixture.create();
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId }, 'Target.attachedToTarget', { sessionId: 'native-child', targetInfo: { targetId: 'native-frame', type: 'iframe', url: 'https://www.catchtable.net/frame' }, waitingForDebugger: true });
  const attached = socket.sent.findLast(value => value.method === 'Target.attachedToTarget');
  const childSession = attached.params.sessionId; assert.equal(attached.sessionId, owned.sessionId);
  await fixture.command('Runtime.enable', {}, childSession);
  assert.deepEqual(fixture.calls.at(-1).target, { tabId: owned.tabId, sessionId: 'native-child' });
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId, sessionId: 'native-child' }, 'Runtime.executionContextCreated', { context: { id: 42 } });
  assert.equal(socket.sent.at(-1).sessionId, childSession);
  const attachedCount = socket.sent.filter(value => value.method === 'Target.attachedToTarget').length;
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId }, 'Target.attachedToTarget', { sessionId: 'foreign-child', targetInfo: { targetId: 'foreign-frame', type: 'iframe', url: 'https://evil.invalid/' } });
  assert.equal(socket.sent.filter(value => value.method === 'Target.attachedToTarget').length, attachedCount);
  assert.equal(fixture.calls.at(-1).method, 'Target.detachFromTarget');
  const contextCount = socket.sent.filter(value => value.method === 'Runtime.executionContextCreated').length;
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId }, 'Runtime.executionContextCreated', { context: { id: 43, origin: 'https://evil.invalid' } });
  assert.equal(socket.sent.filter(value => value.method === 'Runtime.executionContextCreated').length, contextCount);
  fixture.chrome.debugger.onEvent.fire({ tabId: owned.tabId, sessionId: 'native-child' }, 'Page.frameNavigated', { frame: { id: 'native-frame', url: 'https://evil.invalid/' } });
  assert.ok((await fixture.command('Runtime.evaluate', { expression: 'document.body.innerText' }, childSession)).error);
  assert.equal(fixture.calls.at(-1).method, 'Target.detachFromTarget');
});

test('user debugger detachment stops the local connection without closing or reclaiming any tabs', async () => {
  const fixture = await worker(); const socket = await fixture.connect(); const owned = await fixture.create();
  fixture.chrome.debugger.onDetach.fire({ tabId: owned.tabId }, 'canceled_by_user');
  await new Promise(done => setImmediate(done));
  assert.ok(socket.sent.some(value => value.method === 'Inspector.detached' && value.sessionId === owned.sessionId));
  assert.equal((await fixture.message({ type: 'status' })).enabled, false); assert.equal(socket.closed, true);
  assert.ok(fixture.tabs.has(1) && fixture.tabs.has(owned.tabId)); assert.ok(!fixture.calls.some(value => value.api === 'remove'));
});

test('an older programmatic detach cannot hide a user stopping a newly attached session', async () => {
  const fixture = await worker(); const socket = await fixture.connect(); const owned = await fixture.create();
  fixture.chrome.debugger.detach = async target => { fixture.calls.push({ api: 'detach', target }); };
  await fixture.command('Browser.close');
  await fixture.command('Target.setAutoAttach', { autoAttach: true });
  const newSession = socket.sent.findLast(value => value.method === 'Target.attachedToTarget').params.sessionId;
  assert.notEqual(newSession, owned.sessionId);
  fixture.chrome.debugger.onDetach.fire({ tabId: owned.tabId }, 'canceled_by_user');
  await new Promise(done => setImmediate(done));
  assert.equal((await fixture.message({ type: 'status' })).enabled, false);
  assert.ok(socket.sent.some(value => value.method === 'Inspector.detached' && value.sessionId === newSession));
});

test('server reconnect starts a new transport and never replays previous browser commands', async () => {
  const fixture = await worker(); const first = await fixture.connect(); const owned = await fixture.create();
  await fixture.command('Runtime.evaluate', { expression: 'document.body.innerText' }, owned.sessionId);
  const commandCount = fixture.calls.filter(value => value.api === 'command').length;
  await first.serverClose();
  const reconnect = [...fixture.timers.values()].find(value => !value.interval); assert.ok(reconnect); reconnect.callback();
  await new Promise(done => setImmediate(done));
  const second = fixture.sockets.at(-1); assert.notEqual(second, first); second.open();
  assert.equal(second.sent.length, 1); assert.equal(second.sent[0].type, 'hello');
  assert.equal(fixture.calls.filter(value => value.api === 'command').length, commandCount);
  assert.ok(fixture.tabs.has(1) && fixture.tabs.has(owned.tabId));
});
