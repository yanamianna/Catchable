import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createTask, intervalMs, localDate, resolvePollInterval } from '../server/domain.mjs';
import { Engine } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';
import { createHttpServer } from '../server/index.mjs';

function taskFor(now = Date.now(), changes = {}) {
  return { ...createTask({
    restaurantName: 'Local fixture', restaurantUrl: 'https://www.catchtable.net/shop/local_fixture',
    dates: [localDate(now)], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'notify',
    pollIntervalMs: 1, deadline: new Date(now + 60000).toISOString(),
  }, {}, now), ...changes };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function within(promise, timeout = 600) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Local fixture did not progress within ${timeout} ms.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

function memoryEngine(adapter, now = Date.now) {
  const store = new Store(':memory:', { now });
  const engine = new Engine({ store, adapter, now });
  return { store, engine, async close() { await engine.stop(); store.close(); } };
}

test('millisecond intervals are bounded integers and conflicting unit inputs are rejected', () => {
  assert.equal(intervalMs(), 1000);
  for (const value of [1, 1000, 3600000]) assert.equal(intervalMs(value), value);
  for (const value of [0, -1, 1.5, 3600001, NaN, Infinity, '1', null, true]) {
    assert.throws(() => intervalMs(value), (error) => error.status === 400, String(value));
  }
  assert.equal(resolvePollInterval({}), 1000);
  assert.equal(resolvePollInterval({ pollIntervalMs: 1 }), 1);
  assert.equal(resolvePollInterval({ pollIntervalSeconds: 0.001 }), 1);
  assert.equal(resolvePollInterval({ pollIntervalSeconds: 30 }), 30000);
  assert.equal(resolvePollInterval({}, 25), 25);
  assert.throws(() => resolvePollInterval({ pollIntervalMs: 1000, pollIntervalSeconds: 1 }), (error) => error.status === 400);
});

test('one millisecond scheduling wakes from idle and runs serially with measured browser duration', async () => {
  const completedThree = deferred();
  const starts = [];
  const finishes = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const adapter = {
    inspect: async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      starts.push(Date.now());
      await delay(12);
      finishes.push(Date.now());
      inFlight -= 1;
      if (finishes.length === 3) completedThree.resolve();
      return { status: 'unavailable', slots: [] };
    },
    close: async () => {},
  };
  const app = memoryEngine(adapter);
  const task = taskFor();
  app.store.saveTask(task);
  try {
    app.engine.start();
    await delay(10); // Let the idle scheduler settle before the explicit task start.
    await app.engine.taskAction(task.id, 'start');
    await within(completedThree.promise);
    await app.engine.taskAction(task.id, 'pause');
    await app.engine.tail;
    const paused = app.store.getTask(task.id);
    assert.equal(maximumInFlight, 1);
    assert.ok(starts.length >= 3, 'the old fixed one-second timer must not constrain a 1 ms task');
    for (let index = 1; index < starts.length; index += 1) {
      assert.ok(starts[index] >= finishes[index - 1], 'a new inspect must wait for the previous inspect to finish');
    }
    assert.equal(paused.status, 'paused');
    assert.equal(paused.nextCheckAt, null);
    assert.ok(paused.lastCheckDurationMs >= 5, 'actual adapter work must be measured rather than displayed as 1 ms');
    assert.ok(paused.effectiveIntervalMs >= 5, 'effective cadence must include adapter work');
    const callsAtPause = starts.length;
    await delay(35);
    assert.equal(starts.length, callsAtPause, 'pause must prevent subsequent inspect calls');
  } finally { await app.close(); }
});

test('stop during an in-flight inspect drains it without starting another due task', async () => {
  const firstStarted = deferred();
  const release = deferred();
  let calls = 0;
  let closed = false;
  const app = memoryEngine({
    inspect: async () => { calls += 1; firstStarted.resolve(); await release.promise; return { status: 'unavailable', slots: [] }; },
    close: async () => { closed = true; },
  });
  const now = Date.now();
  for (let index = 0; index < 2; index += 1) {
    app.store.saveTask(taskFor(now, { status: 'active', nextCheckAt: new Date(now - 1).toISOString() }));
  }
  let stopped = false;
  try {
    app.engine.start();
    await within(firstStarted.promise);
    const stopping = app.engine.stop().then(() => { stopped = true; });
    await delay(15);
    assert.equal(stopped, false, 'stop waits for the existing inspect');
    assert.equal(calls, 1);
    release.resolve();
    await within(stopping);
    await delay(25);
    assert.equal(calls, 1, 'an already due second task must not start after stop');
    assert.equal(closed, true);
  } finally { release.resolve(); await app.close(); }
});

test('global pause during inspect blocks further requests and resume wakes the scheduler', async () => {
  const firstStarted = deferred();
  const release = deferred();
  const resumed = deferred();
  let calls = 0;
  const app = memoryEngine({
    inspect: async () => {
      calls += 1;
      if (calls === 1) { firstStarted.resolve(); await release.promise; }
      else resumed.resolve();
      return { status: 'unavailable', slots: [] };
    }, close: async () => {},
  });
  const now = Date.now();
  app.store.saveTask(taskFor(now, { status: 'active', nextCheckAt: new Date(now - 1).toISOString() }));
  try {
    app.engine.start();
    await within(firstStarted.promise);
    app.engine.globalAction('pause_all');
    release.resolve();
    await app.engine.tail;
    await delay(35);
    assert.equal(calls, 1);
    app.engine.globalAction('resume_all');
    await within(resumed.promise);
    assert.ok(calls >= 2);
  } finally { release.resolve(); await app.close(); }
});

test('an idle or globally paused engine does not run a millisecond polling loop', async () => {
  for (const paused of [false, true]) {
    let inspectCalls = 0;
    const app = memoryEngine({ inspect: async () => { inspectCalls += 1; return { status: 'unavailable', slots: [] }; }, close: async () => {} });
    let ticks = 0;
    const tick = app.engine.tick.bind(app.engine);
    app.engine.tick = async () => { ticks += 1; return tick(); };
    if (paused) {
      const now = Date.now();
      app.store.saveTask(taskFor(now, { status: 'active', nextCheckAt: new Date(now - 1).toISOString() }));
      app.engine.globalAction('pause_all');
    }
    try {
      app.engine.start();
      await delay(75);
      assert.equal(inspectCalls, 0);
      assert.ok(ticks <= 2, `idle/paused engine executed ${ticks} ticks in 75 ms`);
    } finally { await app.close(); }
  }
});

test('a newly saved paused task schedules its deadline without starting browser checks', async () => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const expired = deferred();
  let inspectCalls = 0;
  const app = memoryEngine({ inspect: async () => { inspectCalls += 1; return { status: 'unavailable', slots: [] }; }, close: async () => {} }, () => now);
  const event = app.engine.event.bind(app.engine);
  app.engine.event = (...args) => {
    const result = event(...args);
    if (args[1] === 'expired') expired.resolve();
    return result;
  };
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  try {
    app.engine.start();
    assert.equal(app.engine.timer, null, 'an empty engine has no unnecessary timer');
    const input = taskFor(now);
    input.deadline = new Date(now + 40).toISOString();
    const created = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/api/tasks', method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(input));
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.status, 'paused');
    now += 41;
    await within(expired.promise);
    assert.equal(app.store.getTask(created.json.task.id).status, 'expired');
    assert.equal(inspectCalls, 0, 'saving a task must not start its browser checks');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  }
});

test('unknown observations use at least one second of backoff even at a 1 ms target', async () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const app = memoryEngine({ inspect: async () => { throw new Error('Local network fixture failure'); }, close: async () => {} }, () => now);
  const task = taskFor(now, { status: 'active', nextCheckAt: new Date(now).toISOString() });
  app.store.saveTask(task);
  try {
    await app.engine.checkTask(task.id);
    const first = app.store.getTask(task.id);
    assert.equal(first.status, 'backoff');
    assert.ok(Date.parse(first.nextCheckAt) - now >= 1000);
    await app.engine.checkTask(task.id);
    const second = app.store.getTask(task.id);
    assert.ok(Date.parse(second.nextCheckAt) - now >= 2000);
  } finally { await app.close(); }
});

test('applying a new interval preserves paused, pending and terminal task states', async () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const app = memoryEngine({ inspect: async () => ({ status: 'unavailable', slots: [] }), close: async () => {} }, () => now);
  const statuses = ['active', 'paused', 'user_action_required', 'confirmed', 'expired'];
  const tasks = statuses.map((status) => taskFor(now, { status, pollIntervalMs: 30000, nextCheckAt: status === 'active' ? new Date(now + 30000).toISOString() : null }));
  const demo = taskFor(now, { source: 'demo', status: 'active', pollIntervalMs: 30000, nextCheckAt: new Date(now + 30000).toISOString() });
  for (const task of [...tasks, demo]) app.store.saveTask(task);
  try {
    app.engine.updateSettings({ pollIntervalMs: 15 }, { applyToExistingTasks: true });
    assert.equal(app.store.settings().pollIntervalMs, 15);
    for (const original of tasks) {
      const updated = app.store.getTask(original.id);
      assert.equal(updated.status, original.status);
      assert.equal(updated.pollIntervalMs, ['confirmed', 'expired'].includes(original.status) ? 30000 : 15);
      if (original.status !== 'active') assert.equal(updated.nextCheckAt, null);
    }
    assert.equal(app.store.getTask(demo.id).pollIntervalMs, 30000);
    assert.ok(Date.parse(app.store.getTask(tasks[0].id).nextCheckAt) <= now + 15);
  } finally { await app.close(); }
});

test('legacy SQLite migration changes cadence without losing task, booking or notification state', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const directory = mkdtempSync(join(tmpdir(), 'catchable-frequency-'));
  const database = join(directory, 'legacy.sqlite');
  let store;
  try {
    store = new Store(database, { now: () => now });
    store.db.prepare('UPDATE settings SET payload=? WHERE id=1').run(JSON.stringify({ pollIntervalSeconds: 30, webhookUrl: '', enginePaused: true }));
    const legacy = taskFor(now, { status: 'active', pollIntervalSeconds: 30, nextCheckAt: new Date(now + 30000).toISOString(), checkCount: 7, lastMessage: 'keep task state' });
    delete legacy.pollIntervalMs;
    const fastLegacy = { ...legacy, id: 'legacy-fast', status: 'paused', nextCheckAt: null, pollIntervalSeconds: 0.5 };
    const pendingLegacy = { ...legacy, id: 'legacy-pending', status: 'user_action_required', nextCheckAt: null };
    const modern = taskFor(now, { status: 'paused', pollIntervalMs: 7500 });
    for (const task of [legacy, fastLegacy, pendingLegacy, modern]) store.saveTask(task);
    const slot = { date: legacy.dates[0], time: '18:00', partySize: 2 };
    const attempt = store.addAttempt(pendingLegacy, slot, 'outcome_unknown', 'keep booking state', new Date(now).toISOString());
    const event = store.addEvent({ taskId: legacy.id, message: 'keep event state', createdAt: new Date(now).toISOString() });
    const notification = store.addNotification(event, 'webhook', new Date(now).toISOString());
    store.recordSlots(legacy.id, [slot]);
    store.close();
    store = new Store(database, { now: () => now });
    assert.equal(store.settings().pollIntervalMs, 1000);
    assert.equal(store.settings().enginePaused, true);
    assert.equal(Object.hasOwn(store.settings(), 'pollIntervalSeconds'), false);
    const migrated = store.getTask(legacy.id);
    assert.equal(migrated.pollIntervalMs, 1000);
    assert.equal(migrated.status, 'active');
    assert.equal(migrated.checkCount, 7);
    assert.equal(migrated.lastMessage, 'keep task state');
    assert.ok(Date.parse(migrated.nextCheckAt) <= now + 1000);
    assert.equal(store.getTask(fastLegacy.id).pollIntervalMs, 500);
    assert.equal(store.getTask(fastLegacy.id).status, 'paused');
    assert.equal(store.getTask(pendingLegacy.id).status, 'user_action_required');
    assert.equal(store.getTask(pendingLegacy.id).nextCheckAt, null);
    assert.equal(store.getTask(modern.id).pollIntervalMs, 7500);
    const migratedAttempt = store.getAttempt(attempt.id);
    assert.equal(migratedAttempt.status, 'outcome_unknown');
    assert.equal(migratedAttempt.message, 'keep booking state');
    assert.equal(migratedAttempt.taskSnapshot.pollIntervalMs, 1000);
    assert.equal(store.listEvents().find((item) => item.id === event.id).message, 'keep event state');
    assert.equal(store.listNotifications().find((item) => item.id === notification.id).status, 'queued');
    assert.deepEqual(store.recordSlots(legacy.id, [slot]), [], 'persisted availability must not be renotified after migration');
    store.close();
    store = new Store(database, { now: () => now });
    assert.equal(store.getTask(modern.id).pollIntervalMs, 7500, 'reopening a modern database must preserve explicit milliseconds');
    assert.equal(store.getTask(legacy.id).checkCount, 7);
  } finally {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmdirSync(directory);
  }
});
