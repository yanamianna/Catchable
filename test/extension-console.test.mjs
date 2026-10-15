import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../extension/console-bridge.js', import.meta.url), 'utf8');
function bridge({ url = 'http://127.0.0.1:4174/', frame = false, sendMessage = async () => ({ ok: true, status: 'connected', accountId: 'default', accountLabel: 'Account A' }) } = {}) {
  const location = new URL(url); const listeners = []; const posts = []; const requests = [];
  const window = { addEventListener: (type, listener) => { assert.equal(type, 'message'); listeners.push(listener); }, postMessage: (message, origin) => posts.push({ message, origin }) };
  window.top = frame ? {} : window;
  const chrome = { runtime: { sendMessage: async request => { requests.push(request); return sendMessage(request); } } };
  runInContext(source, createContext({ window, location, chrome }));
  const event = (request, overrides = {}) => ({ source: window, origin: location.origin, data: { source: 'catchable-console', type: 'status', requestId: 'fixture-request', ...request }, ...overrides });
  return { window, location, listeners, posts, requests, dispatch: (request, overrides) => listeners[0]?.(event(request, overrides)) };
}

test('local console relay forwards only explicit fields and never echoes a pairing code', async () => {
  const fixture = bridge({ sendMessage: async () => ({ ok: true, status: 'connected', accountId: 'default', accountLabel: 'Account A', pairingCode: '12345678', secret: 'do-not-forward' }) });
  await fixture.dispatch({ type: 'connect', pairingCode: '12345678', accountId: 'default', accountLabel: 'Untrusted page label', force: true, serverUrl: 'wss://evil.invalid/' });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests)), [{ type: 'connect', pairingCode: '12345678', accountId: 'default', force: true }]);
  assert.equal(fixture.posts.length, 1); assert.equal(fixture.posts[0].origin, 'http://127.0.0.1:4174');
  assert.equal(fixture.posts[0].message.source, 'catchable-extension'); assert.equal(fixture.posts[0].message.requestId, 'fixture-request');
  assert.equal(fixture.posts[0].message.accountLabel, 'Account A');
  assert.ok(!JSON.stringify(fixture.posts).includes('12345678')); assert.ok(!JSON.stringify(fixture.posts).includes('do-not-forward'));
});

test('console relay rejects foreign window/origin, malformed messages and nonlocal frame injection', async () => {
  const fixture = bridge();
  await fixture.dispatch({}, { source: {} }); await fixture.dispatch({}, { origin: 'http://evil.invalid' });
  for (const request of [
    { source: 'foreign' }, { type: 'disconnect' }, { type: 'open_console' }, { requestId: 'bad request' },
    { type: 'connect', pairingCode: '1234567', accountId: 'default' },
    { type: 'connect', pairingCode: '12345678' },
    { type: 'connect', pairingCode: '12345678', accountId: '../default' },
  ]) await fixture.dispatch(request);
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.posts.length, 0);
  for (const options of [{ url: 'http://evil.invalid:4174/' }, { url: 'https://127.0.0.1:4174/' }, { url: 'http://localhost:9999/' }, { frame: true }]) assert.equal(bridge(options).listeners.length, 0);
  const localhost = bridge({ url: 'http://localhost:4173/' }); await localhost.dispatch({}); assert.equal(localhost.requests.length, 1);
});

test('extension replacement errors are reported without leaking internals and repeated in-flight requests are ignored', async () => {
  let finish;
  const fixture = bridge({ sendMessage: () => new Promise(resolve => { finish = resolve; }) });
  const first = fixture.dispatch({}); await fixture.dispatch({});
  assert.equal(fixture.requests.length, 1);
  finish({ ok: false, code: 'ACCOUNT_CONFLICT', accountLabel: 'Account B', message: '请确认更换绑定' }); await first;
  assert.equal(fixture.posts[0].message.code, 'ACCOUNT_CONFLICT'); assert.equal(fixture.posts[0].message.accountLabel, 'Account B');
  const replaced = bridge({ sendMessage: async () => { throw new Error('Extension context invalidated; token=secret'); } });
  await replaced.dispatch({}); assert.equal(replaced.posts[0].message.code, 'EXTENSION_RELOAD_REQUIRED'); assert.ok(!JSON.stringify(replaced.posts).includes('secret'));
});
