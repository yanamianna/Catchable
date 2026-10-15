import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Store } from '../server/store.mjs';
import { AccountCoordinator } from '../server/accounts.mjs';
import { createHttpServer } from '../server/index.mjs';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const input = { restaurantName: 'HTTP fixture restaurant', restaurantUrl: 'https://www.catchtable.net/shop/http_fixture', dates: ['2026-12-24'], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'notify' };
const slot = { date: input.dates[0], time: '19:00', partySize: 2 };

async function fixture(run) {
  const store = new Store(':memory:', { now: () => NOW });
  let browserCalls = 0;
  const blocked = async () => { browserCalls++; throw new Error('HTTP fixture must not use Chrome or send bookings.'); };
  const bridges = new Map();
  const broker = {
    ensureAccount: async id => { if (!bridges.has(id)) bridges.set(id, { setLabel() {} }); },
    getBridge: id => bridges.get(id),
    state: id => ({ connected: false, status: 'disconnected', clientName: `Fixture ${id}` }),
    pairingInfo: id => ({ accountId: id, pairingCode: `fixture-only-pairing-${id}`, extensionPath: 'fixture-extension' }),
  };
  const c = await new AccountCoordinator({ store, broker, dataDir: '.unused-http-fixture', now: () => NOW,
    adapterFactory: async () => ({ defaultIntegration: 'extension', hasContext: false, inspect: blocked, prepare: blocked, reconcile: blocked,
      openSession: blocked, getSessionStatus: blocked, close: async () => {} }),
  }).init();
  const server = createHttpServer({ store, engine: c.engine(), coordinator: c });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((done, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...headers, ...(encoded === null ? {} : { 'content-length': Buffer.byteLength(encoded) }) } }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { done({ status: response.statusCode, json: JSON.parse(text), headers: response.headers }); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error(`Fixture request timed out: ${method} ${path}`)));
    req.on('error', reject);
    if (encoded !== null) req.write(encoded);
    req.end();
  });
  const post = (path, body) => send(path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
  const addAccount = async values => {
    const response = await post('/api/accounts', { label: 'HTTP fixture second', ...values });
    assert.equal(response.status, 201);
    return response.json.account;
  };
  const addTask = async accountId => {
    const response = await post('/api/tasks', { ...input, accountId });
    assert.equal(response.status, 201);
    return response.json.task;
  };
  try { await run({ store, c, send, post, origin, broker, addAccount, addTask }); assert.equal(browserCalls, 0); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); await c.stop(); store.close(); }
}

test('all and explicit account state tag resources while private fingerprints stay outside every public account response', () => fixture(async ({ store, send, post, addAccount, addTask }) => {
  const second = await addAccount();
  const firstTask = await addTask('default'), secondTask = await addTask(second.id);
  store.bindAccountIdentity('default', 'fixture-principal-first');
  store.bindAccountIdentity(second.id, 'fixture-principal-second');
  const all = await send('/api/state');
  assert.equal(all.status, 200);
  assert.equal(all.json.accounts.length, 2);
  assert.deepEqual(new Set(all.json.tasks.map(task => task.id)), new Set([firstTask.id, secondTask.id]));
  assert.ok(all.json.tasks.every(task => task.accountId && task.accountLabel));
  const single = (await send(`/api/state?accountId=${second.id}`)).json;
  assert.deepEqual(single.tasks.map(task => task.id), [secondTask.id]);
  assert.ok(single.events.every(event => event.accountId === second.id));
  assert.equal(single.stats.totalTasks, 1);
  assert.equal((await send('/api/state?accountId=missing-fixture')).status, 404);
  for (const response of [await send('/api/accounts'), await send('/api/state'), await post(`/api/accounts/${second.id}`, { label: 'Renamed fixture' })]) {
    const serialized = JSON.stringify(response.json);
    assert.equal(serialized.includes('identityFingerprint'), false);
    assert.equal(serialized.includes('fixture-principal-'), false);
  }
}));

test('login totals exclude disconnected extensions even while the last official session result is cached', () => fixture(async ({ c, broker, send, addAccount }) => {
  const second = await addAccount();
  for (const id of ['default', second.id]) c.engine(id).applySession({ status: 'authenticated', accountLabel: 'Synthetic authenticated account' });
  assert.equal((await send('/api/state')).json.engine.authenticatedAccounts, 0);
  broker.state = id => ({ connected: id === second.id, status: id === second.id ? 'connected' : 'disconnected' });
  assert.equal((await send('/api/state')).json.engine.authenticatedAccounts, 1);
  broker.state = () => ({ connected: false, status: 'disconnected' });
  assert.equal((await send('/api/state')).json.engine.authenticatedAccounts, 0);
}));

test('task mutations require the explicit matching account and each account independently accepts five tasks', () => fixture(async ({ send, post, origin, addAccount, addTask, store }) => {
  const second = await addAccount();
  const task = await addTask(second.id);
  assert.equal((await post(`/api/tasks/${task.id}/action`, { accountId: 'default', action: 'pause' })).status, 409);
  assert.equal((await post(`/api/tasks/${task.id}/action`, { action: 'pause' })).status, 409);
  assert.equal((await send(`/api/tasks/${task.id}`, { method: 'DELETE', headers: { origin, 'content-type': 'application/json' }, body: { accountId: 'default' } })).status, 409);
  assert.equal(store.forAccount(second.id).getTask(task.id).status, 'paused');
  assert.equal((await post(`/api/tasks/${task.id}/action`, { accountId: second.id, action: 'pause' })).status, 200);
  for (let index = 0; index < 5; index++) await addTask('default');
  for (let index = 1; index < 5; index++) await addTask(second.id);
  for (const accountId of ['default', second.id]) assert.equal((await post('/api/tasks', { ...input, accountId })).status, 409);
  assert.equal((await send('/api/state')).json.tasks.length, 10);
}));

test('account pause and disable affect only their runtime while global pause remains a separate barrier', () => fixture(async ({ c, post, store, addAccount }) => {
  const second = await addAccount();
  assert.equal((await post('/api/engine/action', { accountId: 'all', action: 'resume' })).status, 200);
  assert.equal((await post('/api/engine/action', { accountId: second.id, action: 'pause' })).status, 200);
  assert.equal(c.engine(second.id).state().paused, true);
  assert.equal(c.engine('default').state().paused, false);
  assert.equal(store.settings().enginePaused, false);
  assert.equal((await post(`/api/accounts/${second.id}/action`, { action: 'disable' })).status, 200);
  assert.equal(store.getAccount(second.id).enabled, false);
  assert.equal(c.engine('default').state().paused, false);
  await post('/api/engine/action', { accountId: second.id, action: 'resume' });
  assert.equal(c.engine(second.id).state().paused, true, 'resuming a disabled account must not activate it');
  await post(`/api/accounts/${second.id}/action`, { action: 'enable' });
  assert.equal(c.engine(second.id).state().paused, false);
  await post('/api/engine/action', { accountId: 'all', action: 'pause' });
  await post('/api/engine/action', { accountId: second.id, action: 'resume' });
  assert.equal(c.engine(second.id).state().paused, true);
  assert.equal(c.engine('default').state().paused, true);
}));

test('account pairing codes require the existing same-origin read guard and never enter normal state', () => fixture(async ({ send, origin, addAccount }) => {
  const second = await addAccount();
  const path = `/api/accounts/${second.id}/pairing`;
  assert.equal((await send(path)).status, 403);
  assert.equal((await send(path, { headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await send(path, { headers: { origin, 'sec-fetch-site': 'cross-site' } })).status, 403);
  const trusted = await send(path, { headers: { origin, 'sec-fetch-site': 'same-origin' } });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.json.accountId, second.id);
  assert.equal((await send('/api/extension/pairing', { headers: { referer: `${origin}/`, 'sec-fetch-site': 'same-origin' } })).json.accountId, 'default');
  assert.equal(JSON.stringify((await send('/api/state')).json).includes('fixture-only-pairing'), false);
}));

test('account pairing endpoints prefer short plaintext codes while the default compatibility endpoint retains its original credential', () => fixture(async ({ send, origin, broker, addAccount }) => {
  const second = await addAccount();
  broker.simplePairingInfo = id => ({ pairingCode: id === 'default' ? '01234567' : '87654321', extensionPath: 'fixture-extension' });
  const headers = { origin, 'sec-fetch-site': 'same-origin' };
  const response = await send(`/api/accounts/${second.id}/pairing`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { pairingCode: '87654321', extensionPath: 'fixture-extension' });
  assert.equal((await send('/api/accounts/default/pairing', { headers })).json.pairingCode, '01234567');
  assert.equal((await send('/api/extension/pairing', { headers })).json.pairingCode, 'fixture-only-pairing-default');
  assert.ok(!JSON.stringify((await send('/api/state')).json).includes('87654321'));
}));

test('public account edits validate contacts but original booking contacts remain frozen and fingerprints stay private', () => fixture(async ({ store, c, send, post, addAccount }) => {
  const second = await addAccount({ bookingName: 'Before fixture', bookingPhoneCountryCode: '+1', bookingPhoneNumber: '2025550101', bookingPhoneAutoFill: true });
  store.bindAccountIdentity(second.id, 'fixture-private-principal');
  const taskResponse = await post('/api/tasks', { ...input, accountId: second.id, mode: 'auto', autoConsent: true });
  assert.equal(taskResponse.status, 201);
  const task = taskResponse.json.task;
  const scoped = store.forAccount(second.id), attempt = scoped.addAttempt(task, slot, 'user_action_required');
  const update = await post(`/api/accounts/${second.id}`, { bookingName: 'After fixture', bookingPhoneCountryCode: '+1', bookingPhoneNumber: '2025550102', bookingPhoneAutoFill: true });
  assert.equal(update.status, 200);
  assert.deepEqual(c.engine(second.id).bookingContactOptions(task, attempt).bookingContact, { countryCode: '+1', phoneNumber: '2025550101', fullName: 'Before fixture' });
  assert.deepEqual(scoped.getAttempt(attempt.id).contactSnapshot, attempt.contactSnapshot);
  assert.equal((await post(`/api/accounts/${second.id}`, { bookingPhoneNumber: 'bad-number' })).status, 400);
  assert.equal(store.getAccount(second.id).settings.bookingPhoneNumber, '2025550102');
  const serialized = JSON.stringify((await send('/api/state')).json);
  assert.equal(serialized.includes('fixture-private-principal'), false);
  assert.equal(serialized.includes('accountIdentityFingerprint'), false);
  assert.equal(serialized.includes('contactSnapshot'), false);
}));

test('clearing one account also hides its records from the all-account view without changing another account or pending locks', () => fixture(async ({ store, send, post, addAccount, addTask }) => {
  const second = await addAccount(), firstTask = await addTask('default'), secondTask = await addTask(second.id);
  const first = store.forAccount('default'), other = store.forAccount(second.id);
  const pending = first.addAttempt(firstTask, slot, 'outcome_unknown');
  const confirmed = first.addAttempt(firstTask, slot, 'confirmed');
  const otherConfirmed = other.addAttempt(secondTask, slot, 'confirmed');
  const firstEvent = first.addEvent({ taskId: firstTask.id, type: 'slot_available', message: 'First fixture availability' });
  first.addNotification(firstEvent);
  const otherEvent = other.addEvent({ taskId: secondTask.id, type: 'slot_available', message: 'Other fixture availability' });
  other.addNotification(otherEvent);
  const response = await post('/api/records/clear', { accountId: 'default', kind: 'all' });
  assert.equal(response.status, 200);
  const all = (await send('/api/state?accountId=all')).json;
  assert.equal(all.events.some(event => event.id === firstEvent.id), false);
  assert.equal(all.events.some(event => event.id === otherEvent.id), true);
  assert.equal(all.notifications.some(notice => notice.eventId === firstEvent.id), false);
  assert.equal(all.notifications.some(notice => notice.eventId === otherEvent.id), true);
  assert.equal(all.bookings.some(booking => booking.id === confirmed.id), false);
  assert.equal(all.bookings.some(booking => booking.id === otherConfirmed.id), true);
  assert.equal(all.bookings.some(booking => booking.id === pending.id), true);
  assert.equal(all.stats.availableEvents, 1);
  assert.equal(all.engine.accountWriteBlocked, true);
  assert.equal(first.getAttempt(confirmed.id).status, 'confirmed');
}));
