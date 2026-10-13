import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { createHttpServer } from '../server/index.mjs';
import { createTask } from '../server/domain.mjs';

const NOW = Date.parse('2026-10-13T00:00:00Z');
const timestamp = new Date(NOW).toISOString();
const slot = { date: '2026-10-24', time: '19:00', partySize: 2 };

function seed(store) {
  const task = store.saveTask(createTask({
    restaurantName: 'Fixture restaurant', restaurantUrl: 'https://www.catchtable.net/shop/fixture',
    dates: [slot.date], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'auto', autoConsent: true,
    groupId: 'fixture-group',
  }, store.settings(), NOW));
  const attempts = ['confirmed', 'rejected', 'submitting', 'outcome_unknown', 'user_action_required', 'pending_restaurant']
    .map((status) => store.addAttempt(task, slot, status, 'Fixture attempt', timestamp));
  for (const attempt of attempts) {
    if (['confirmed', 'pending_restaurant'].includes(attempt.status)) {
      store.saveAttempt({ ...attempt, reservationId: `fixture-${attempt.status}`, submitted: true });
    }
  }
  const pending = attempts.find((attempt) => attempt.status === 'outcome_unknown');
  const event = store.addEvent({ taskId: task.id, bookingId: pending.id, type: 'slot_available', message: 'Fixture event', createdAt: timestamp });
  const notices = ['in_app', 'webhook'].map((channel) => store.addNotification(event, channel, timestamp));
  store.recordSlots(task.id, [slot]);
  return { task, attempts: store.listAttempts(), event, notices };
}

test('clearing displays preserves pending locks, submission evidence and notification/slot deduplication', () => {
  const store = new Store(':memory:');
  try {
    const { task, attempts, event, notices } = seed(store);
    const settings = store.settings();
    const queued = notices.find((notice) => notice.channel === 'webhook');
    assert.equal(store.stats().availableEvents, 1);
    assert.deepEqual(store.clearRecords('all'), { events: 1, notifications: 2, bookings: 2 });
    assert.equal(store.stats().availableEvents, 0, 'visible availability total must follow notification clearing');
    assert.deepEqual(store.listEvents(), []);
    assert.deepEqual(store.listNotifications(), []);
    assert.deepEqual(new Set(store.listVisibleAttempts().map((attempt) => attempt.status)),
      new Set(['submitting', 'outcome_unknown', 'user_action_required', 'pending_restaurant']));
    assert.deepEqual(store.listAttempts(), attempts);
    assert.deepEqual(store.attemptsForTask(task.id), attempts);
    assert.equal(store.hasUncertainLiveAttempt(), true);
    assert.deepEqual(store.settings(), settings);
    assert.deepEqual(store.getTask(task.id), task);
    assert.deepEqual(store.eventsForBooking(event.bookingId), [event]);
    assert.deepEqual(store.nextNotification(timestamp), queued);
    assert.deepEqual(store.recordSlots(task.id, [slot]), [], 'display clearing must not create another slot alert');
    store.addNotification(event, 'webhook', timestamp);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 2);
    store.saveNotification({ ...queued, status: 'accepted', nextAttemptAt: null });
    assert.deepEqual(store.listNotifications(), [], 'delivery updates must not bring hidden notices back');
    assert.deepEqual(store.clearRecords('all'), { events: 0, notifications: 0, bookings: 0 });
  } finally { store.close(); }
});

test('availability card counts visible in-app notifications independently from event clearing', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    assert.equal(store.stats().availableEvents, 1, 'the webhook copy is not another in-app availability notice');
    assert.deepEqual(store.clearRecords('events'), { events: 1, notifications: 0, bookings: 0 });
    assert.deepEqual(store.listEvents(), []);
    assert.equal(store.listNotifications().length, 2);
    assert.equal(store.stats().availableEvents, 1, 'clearing runtime activity leaves notification history and its count intact');
    assert.deepEqual(store.clearRecords('notifications'), { events: 0, notifications: 2, bookings: 0 });
    assert.deepEqual(store.listNotifications(), []);
    assert.equal(store.stats().availableEvents, 0);
    const fresh = store.addEvent({ source: 'live', type: 'slot_available', message: 'Fresh fixture availability' });
    store.addNotification(fresh, 'in_app');
    assert.equal(store.stats().availableEvents, 1);
    store.clearRecords('notifications');
    assert.deepEqual(store.listEvents(), [fresh], 'clearing notifications leaves new runtime activity visible');
    assert.equal(store.stats().availableEvents, 0);
  } finally { store.close(); }
});

test('display boundaries and booking archives persist across database reopen; future messages remain visible', () => {
  const directory = mkdtempSync(join(tmpdir(), 'catchable-records-fixture-'));
  const database = join(directory, 'fixture.sqlite');
  let store;
  try {
    store = new Store(database, { now: () => NOW });
    const { event, attempts } = seed(store);
    store.clearRecords('all');
    store.close();
    store = new Store(database, { now: () => NOW });
    assert.deepEqual(store.listEvents(), []);
    assert.deepEqual(store.listNotifications(), []);
    assert.deepEqual(store.listAttempts(), attempts);
    assert.equal(store.listVisibleAttempts().length, 4);
    assert.deepEqual(store.eventsForBooking(event.bookingId), [event]);
    assert.deepEqual(store.clearRecords('all'), { events: 0, notifications: 0, bookings: 0 });
    const fresh = store.addEvent({ message: 'New fixture message', createdAt: timestamp });
    const freshNotice = store.addNotification(fresh, 'in_app', timestamp);
    assert.deepEqual(store.listEvents(), [fresh]);
    assert.deepEqual(store.listNotifications(), [freshNotice]);
    assert.deepEqual(store.clearRecords('events'), { events: 1, notifications: 0, bookings: 0 });
    assert.deepEqual(store.listNotifications(), [freshNotice], 'each message category has its own boundary');
  } finally {
    store?.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.split(sep).at(-1).startsWith('catchable-records-fixture-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('cleared terminal attempts remain guarded internally and any newly unresolved status becomes visible', () => {
  const store = new Store(':memory:');
  try {
    const { attempts } = seed(store);
    const confirmed = attempts.find((attempt) => attempt.status === 'confirmed');
    assert.deepEqual(store.clearRecords('bookings'), { events: 0, notifications: 0, bookings: 2 });
    assert.equal(store.getAttempt(confirmed.id).reservationId, 'fixture-confirmed');
    assert.equal(store.listAttempts().some((attempt) => attempt.id === confirmed.id && attempt.status === 'confirmed'), true);
    store.saveAttempt({ ...confirmed, status: 'outcome_unknown' });
    assert.equal(store.listVisibleAttempts().some((attempt) => attempt.id === confirmed.id), true);
    assert.equal(store.listPendingAttempts().some((attempt) => attempt.id === confirmed.id), true);
    assert.equal(store.hasUncertainLiveAttempt(), true);
    assert.equal(store.listEvents().length, 1);
    assert.equal(store.listNotifications().length, 2);
  } finally { store.close(); }
});

async function httpFixture(run) {
  const store = new Store(':memory:');
  let browserCalls = 0;
  const blocked = async () => { browserCalls += 1; throw new Error('Record tests must not use a browser or book.'); };
  const engine = new Engine({ store, now: () => NOW, adapter: {
    inspect: blocked, prepare: blocked, reconcile: blocked, openSession: blocked, getSessionStatus: blocked, close: async () => {},
  } });
  const server = createHttpServer({ store, engine });
  await new Promise((started, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', started); });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const clear = (kind) => send('/api/records/clear', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: { kind } });
  try {
    await run({ store, engine, send, clear, origin });
    assert.equal(browserCalls, 0);
  } finally {
    await new Promise((closed) => server.close(closed));
    await engine.stop();
    store.close();
  }
}

test('clear API filters only displayed records and retains pending bookings and account write guard in state', () => httpFixture(async ({ store, send, clear }) => {
  const { attempts } = seed(store);
  const response = await clear('all');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, cleared: { events: 1, notifications: 2, bookings: 2 } });
  const state = (await send('/api/state')).json;
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.notifications, []);
  assert.equal(state.bookings.length, 4);
  assert.equal(state.engine.accountWriteBlocked, true);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.stats.confirmedBookings, 1, 'display clearing must not erase real booking totals');
  assert.ok(state.bookings.every((attempt) => !Object.hasOwn(attempt, 'taskSnapshot')));
  assert.deepEqual(store.listAttempts(), attempts);
  assert.deepEqual((await clear('all')).json.cleared, { events: 0, notifications: 0, bookings: 0 });
}));

test('clear API requires localhost JSON mutation and validates kind before touching records', () => httpFixture(async ({ store, send, origin }) => {
  seed(store);
  const path = '/api/records/clear';
  const cases = [
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: { kind: 'all' } }, 403],
    [{ method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: { kind: 'all' } }, 403],
    [{ method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: { kind: 'all' } }, 415],
    [{ method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: { kind: 'tasks' } }, 400],
    [{ method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: {} }, 400],
    [{ method: 'GET' }, 404],
  ];
  for (const [options, expected] of cases) assert.equal((await send(path, options)).status, expected);
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.listNotifications().length, 2);
  assert.equal(store.listVisibleAttempts().length, 6);
}));

test('clear API waits for engine queue and includes messages created by the preceding operation', () => httpFixture(async ({ store, engine, clear }) => {
  seed(store);
  let release;
  let begin;
  const begun = new Promise((done) => { begin = done; });
  const gate = new Promise((done) => { release = done; });
  const operation = engine.enqueue(async () => {
    begin();
    await gate;
    store.addEvent({ message: 'Fixture event from preceding operation' });
  });
  await begun;
  let finished = false;
  const clearing = clear('events').then((result) => { finished = true; return result; });
  try {
    const deadline = Date.now() + 1000;
    while (engine.pending < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 2));
    assert.equal(engine.pending, 2);
    assert.equal(finished, false);
    assert.equal(store.listEvents().length, 1);
  } finally { release(); }
  await operation;
  assert.deepEqual((await clearing).json.cleared, { events: 2, notifications: 0, bookings: 0 });
  assert.deepEqual(store.listEvents(), []);
  assert.equal(store.listNotifications().length, 2);
}));
