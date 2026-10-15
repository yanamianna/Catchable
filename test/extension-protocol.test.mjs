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
  const popupSender = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/popup.html` };
  const message = (value, sender = popupSender) => new Promise(done => chrome.runtime.onMessage.listeners[0](value, sender, done));
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
  return { context, chrome, tabs, calls, sockets, timers, connect, command, create, message, popupSender };
}

test('extension has only the declared local transport and browser-control permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['debugger', 'tabs', 'storage']);
  assert.equal(manifest.manifest_version, 3); assert.equal(manifest.minimum_chrome_version, '125');
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(manifest.content_security_policy.extension_pages.includes('connect-src ws://127.0.0.1:4174'));
  assert.ok(!manifest.externally_connectable);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://127.0.0.1:4174/*', 'http://localhost:4174/*', 'http://127.0.0.1:4173/*', 'http://localhost:4173/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
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

const consoleSender = { id: 'fixture-extension', url: 'http://127.0.0.1:4174/', tab: { id: 99, url: 'http://127.0.0.1:4174/' }, frameId: 0 };
const tick = () => new Promise(done => setImmediate(done));
async function acknowledge(socket, accountId = 'default', accountLabel = 'Account A') {
  socket.open();
  await socket.onmessage({ data: JSON.stringify({ type: 'hello_ack', accountId, accountLabel }) });
}

test('one-click accepts eight digits, waits for real acknowledgement and preserves a connected account', async () => {
  const fixture = await worker();
  let settled = false;
  const connecting = fixture.message({ type: 'connect', pairingCode: '12345678', accountId: 'default' }, consoleSender).then(value => { settled = true; return value; });
  await tick(); const socket = fixture.sockets.at(-1);
  assert.equal(socket.protocols[1], 'pair.12345678');
  socket.open(); await tick(); assert.equal(settled, false);
  assert.equal((await fixture.message({ type: 'status' })).status, 'connecting');
  await socket.onmessage({ data: JSON.stringify({ type: 'hello_ack', accountId: 'default', accountLabel: 'Account A' }) });
  const connected = await connecting;
  assert.equal(connected.ok, true); assert.equal(connected.status, 'connected'); assert.equal(connected.accountId, 'default');
  const owned = await fixture.create();
  const repeated = await fixture.message({ type: 'connect', pairingCode: '87654321', accountId: 'default' }, consoleSender);
  assert.equal(repeated.ok, true); assert.equal(fixture.sockets.length, 1);
  assert.equal(repeated.ownedTabs, 1); assert.equal(repeated.attachedTabs, 1);
  assert.equal(fixture.calls.filter(call => call.api === 'detach').length, 0);
  assert.ok((await fixture.command('Target.getTargetInfo', { targetId: owned.targetId })).result);
  assert.equal(fixture.chrome.storage.local.values.boundAccountId, 'default');
  assert.ok(!JSON.stringify(repeated).includes('12345678'));
});

test('a different account requires explicit confirmation and switches without adopting prior tabs', async () => {
  const fixture = await worker(); await fixture.connect();
  const original = fixture.sockets.at(-1);
  await original.onmessage({ data: JSON.stringify({ type: 'hello_ack', accountId: 'default', accountLabel: 'Account A' }) });
  const owned = await fixture.create();
  const request = { type: 'connect', pairingCode: '12345678', accountId: 'second' };
  const conflict = await fixture.message(request, consoleSender);
  assert.equal(conflict.ok, false); assert.equal(conflict.code, 'ACCOUNT_CONFLICT'); assert.equal(conflict.accountLabel, 'Account A');
  assert.equal(fixture.sockets.length, 1); assert.equal(original.closed, undefined);
  const change = fixture.message({ ...request, force: true }, consoleSender);
  await tick(); assert.equal(fixture.sockets.length, 2);
  const next = fixture.sockets.at(-1); await acknowledge(next, 'second', 'Account B');
  assert.equal((await change).ok, true); assert.equal(original.closed, true);
  assert.ok(fixture.tabs.has(owned.tabId)); assert.equal((await fixture.command('Target.getTargets')).result.targetInfos.length, 0);
  assert.equal(fixture.chrome.storage.local.values.boundAccountId, 'second');
});

test('one-click rejects a mismatched or missing acknowledged account and serializes competing connects', async () => {
  const fixture = await worker();
  const first = fixture.message({ type: 'connect', pairingCode: '12345678', accountId: 'default' }, consoleSender);
  const second = fixture.message({ type: 'connect', pairingCode: '87654321', accountId: 'second' }, consoleSender);
  await tick(); assert.equal(fixture.sockets.length, 1);
  await acknowledge(fixture.sockets[0], 'default');
  assert.equal((await first).ok, true); assert.equal((await second).code, 'ACCOUNT_CONFLICT'); assert.equal(fixture.sockets.length, 1);
  const wrong = await worker();
  const pending = wrong.message({ type: 'connect', pairingCode: '12345678', accountId: 'default' }, consoleSender);
  await tick(); wrong.sockets[0].open();
  // Explicitly simulate an older server without accountId.
  await wrong.sockets[0].onmessage({ data: JSON.stringify({ type: 'hello_ack', accountLabel: 'Unknown' }) });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.code, 'ACCOUNT_MISMATCH');
});

test('worker accepts only its own popup or a top-level local console and limits console commands', async () => {
  const fixture = await worker(); const listener = fixture.chrome.runtime.onMessage.listeners[0];
  for (const sender of [
    { id: 'another-extension', url: fixture.popupSender.url },
    { id: fixture.chrome.runtime.id },
    { ...consoleSender, frameId: 2 },
    { ...consoleSender, url: 'https://www.catchtable.net/' },
    { ...consoleSender, tab: { id: 99, url: 'http://evil.invalid:4174/' } },
    { ...consoleSender, url: 'http://127.0.0.1:8888/' },
  ]) assert.equal(listener({ type: 'connect', pairingCode: '12345678' }, sender, () => assert.fail('invalid sender was accepted')), false);
  assert.equal(listener({ type: 'disconnect' }, consoleSender, () => assert.fail('console cannot disconnect')), false);
  assert.equal(listener({ type: 'open_console' }, consoleSender, () => assert.fail('console cannot create arbitrary tabs')), false);
  assert.equal(fixture.sockets.length, 0);
});

test('one-click timeout reports incomplete connection and a retry can complete after the actual acknowledgement', async () => {
  const fixture = await worker();
  const request = { type: 'connect', pairingCode: '12345678', accountId: 'default' };
  const first = fixture.message(request, consoleSender);
  await tick(); const socket = fixture.sockets[0]; socket.open();
  const waiting = [...fixture.timers.values()].find(timer => !timer.interval && timer.duration === 6000);
  assert.ok(waiting); waiting.callback();
  const timedOut = await first; assert.equal(timedOut.ok, false); assert.equal(timedOut.code, 'CONNECTION_TIMEOUT');
  const retry = fixture.message(request, consoleSender);
  await tick(); assert.equal(fixture.sockets.length, 1);
  await socket.onmessage({ data: JSON.stringify({ type: 'hello_ack', accountId: 'default', accountLabel: 'Account A' }) });
  assert.equal((await retry).ok, true);
});

test('server account labels are displayed safely and switching pairing never adopts the previous account tabs',async()=>{
  const fixture=await worker();const socket=await fixture.connect();const owned=await fixture.create();
  await socket.onmessage({data:JSON.stringify({type:'hello_ack',accountLabel:'Synthetic account A'})});
  assert.equal((await fixture.message({type:'status'})).accountLabel,'Synthetic account A');
  assert.equal((await fixture.message({type:'connect',pairingCode:'different_fixture_pairing_0123456789'})).code,'ACCOUNT_CONFLICT');
  await fixture.message({type:'connect',pairingCode:'different_fixture_pairing_0123456789',force:true});
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

test('download chunk bursts are not transported while request, response, body and completion evidence remain intact', async () => {
  const fixture = await worker(); const socket = await fixture.connect(); const owned = await fixture.create();
  const source = { tabId: owned.tabId };
  const requestId = 'chunked-account';
  const url = 'https://api.catchtable.net/api/v5/user/info';
  fixture.chrome.debugger.onEvent.fire(source, 'Network.requestWillBeSent', { requestId, request: { url, headers: {} } });
  fixture.chrome.debugger.onEvent.fire(source, 'Network.responseReceived', { requestId, response: { url, status: 200, headers: {} } });
  const before = socket.sent.length;
  for (let i = 0; i < 10000; i++) fixture.chrome.debugger.onEvent.fire(source, 'Network.dataReceived', {
    requestId, timestamp: i, dataLength: 1024, encodedDataLength: 512,
  });
  assert.equal(socket.sent.length - before, 0, '10,000 progress chunks must send no transport frames');
  fixture.chrome.debugger.onEvent.fire(source, 'Network.loadingFinished', { requestId, timestamp: 10001, encodedDataLength: 5120000 });
  assert.deepEqual(socket.sent.filter(value => value.params?.requestId === requestId).map(value => value.method), [
    'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
  ]);
  assert.equal((await fixture.command('Network.getResponseBody', { requestId }, owned.sessionId)).result.body, '{"fixture":true}');
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

test('closing one owned page removes only its session and keeps the profile connection and other pages usable', async () => {
  const fixture = await worker(); const socket = await fixture.connect();
  const closing = await fixture.create(); const remaining = await fixture.create();
  // Chrome may emit debugger detachment before the corresponding tabs.onRemoved.
  fixture.chrome.debugger.onDetach.fire({ tabId: closing.tabId }, 'target_closed');
  fixture.tabs.delete(closing.tabId); fixture.chrome.tabs.onRemoved.fire(closing.tabId);
  await tick();
  const state = await fixture.message({ type: 'status' });
  assert.equal(state.enabled, true); assert.equal(state.attachedTabs, 1);
  assert.equal(socket.closed, undefined);
  assert.ok((await fixture.command('Runtime.evaluate', { expression: 'document.body.innerText' }, remaining.sessionId)).result);
  assert.equal((await fixture.command('Target.getTargets')).result.targetInfos.length, 1);
});

test('an asynchronous reconnect preparation cannot create a socket after explicit disconnection', async () => {
  const fixture = await worker(); const first = await fixture.connect();
  await first.serverClose();
  const originalGet = fixture.chrome.storage.local.get;
  let release;
  fixture.chrome.storage.local.get = key => key === 'pairingCode'
    ? new Promise(done => { release = () => done({ pairingCode: fixtureCode }); }) : originalGet(key);
  const reconnect = [...fixture.timers.values()].find(value => !value.interval);
  assert.ok(reconnect); reconnect.callback(); await tick(); assert.equal(typeof release, 'function');
  assert.equal((await fixture.message({ type: 'disconnect' })).ok, true);
  release(); await tick();
  assert.equal(fixture.sockets.length, 1, 'a stale storage read must not reopen an explicitly disconnected connection');
  assert.equal((await fixture.message({ type: 'status' })).enabled, false);
});

test('manual reconnect waits for earlier disconnect cleanup and is not overwritten by its stale close handler', async () => {
  const fixture = await worker(); const first = await fixture.connect(); await fixture.create();
  const originalDetach = fixture.chrome.debugger.detach;
  let release;
  fixture.chrome.debugger.detach = target => new Promise(done => { release = async () => { await originalDetach(target); done(); }; });
  const disconnected = first.serverClose(); await tick(); assert.equal(typeof release, 'function');
  const reconnect = fixture.message({ type: 'connect', pairingCode: fixtureCode });
  await tick(); assert.equal(fixture.sockets.length, 1);
  await release(); await disconnected;
  assert.equal((await reconnect).ok, true);
  const second = fixture.sockets.at(-1); await acknowledge(second);
  const state = await fixture.message({ type: 'status' });
  assert.equal(state.status, 'connected'); assert.equal(state.enabled, true);
  assert.equal(fixture.sockets.length, 2);
  assert.equal([...fixture.timers.values()].filter(value => !value.interval).length, 0, 'the old close handler must not schedule an extra connection');
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
