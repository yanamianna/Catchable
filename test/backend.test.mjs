import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { createTask, matchingSlots, normalizeDeadline, publicAddress, resolvePollInterval, validateWebhookUrl } from '../server/domain.mjs';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const input = (overrides = {}) => ({ restaurantName: '测试餐厅', restaurantUrl: 'https://www.catchtable.net/shop/test_restaurant', dates: ['2026-10-24'], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'notify', ...overrides });
const slot = { date: '2026-10-24', time: '19:00', partySize: 2 };
function fixture(overrides = {}) {
  const store = new Store(':memory:');
  let now = NOW;
  const adapter = { inspect: async () => ({ status: 'unavailable', slots: [] }), prepare: async () => ({ status: 'user_action_required', message: '请完成预约。' }), reconcile: async () => ({ status: 'outcome_unknown', message: '仍不明确。' }), openSession: async () => ({ connected: true, message: '浏览器已打开。' }), getSessionStatus: async () => ({ connected: true, message: '会话已连接。' }), close: async () => {}, ...overrides };
  const engine = new Engine({ store, adapter, now: () => now });
  const makeTask = (values = {}) => store.saveTask({ ...createTask(input(values), store.settings(), now), status: 'active', nextCheckAt: new Date(now).toISOString() });
  return { store, engine, adapter, makeTask, advance: (ms) => { now += ms; }, close: async () => { await engine.stop(); store.close(); } };
}

test('task validation enforces explicit auto consent, strict dates, party size, and restaurant URL', () => {
  assert.throws(() => createTask(input({ mode: 'auto' }), {}, NOW), /明确确认授权/);
  assert.throws(() => createTask(input({ dates: ['2026-02-30'] }), {}, NOW), /有效预约日期/);
  assert.throws(() => createTask(input({ partySize: 13 }), {}, NOW), /1—12/);
  assert.throws(() => createTask(input({ restaurantUrl: 'https://www.catchtable.net.evil.org/shop/test' }), {}, NOW));
  assert.throws(() => createTask(input({ pollIntervalMs: 0 }), {}, NOW));
  const task = createTask(input(), {}, NOW);
  assert.equal(task.status, 'paused');
  assert.equal(task.pollIntervalMs, 1000);
  assert.equal(Object.hasOwn(task, 'pollIntervalSeconds'), false);
  assert.equal(task.deadline, '2026-10-24T14:59:59.000Z');
  assert.equal(normalizeDeadline('2026-10-24T22:00:00+09:00', task.dates), '2026-10-24T13:00:00.000Z');
  assert.throws(() => normalizeDeadline('2026-10-24T22:00', task.dates), /包含时区/);
});

test('millisecond intervals accept 1 ms, convert the legacy field and reject ambiguous or illegal inputs', () => {
  assert.equal(resolvePollInterval({ pollIntervalMs: 1 }), 1);
  assert.equal(resolvePollInterval({ pollIntervalSeconds: 0.001 }), 1);
  assert.equal(resolvePollInterval({ pollIntervalSeconds: 30 }), 30000);
  assert.equal(resolvePollInterval({}), 1000);
  for (const value of [0, -1, 1.5, 3600001, '1', null, true, NaN]) assert.throws(() => resolvePollInterval({ pollIntervalMs: value }));
  for (const value of [0, -1, 0.0001, 3601, '1', null, true, NaN]) assert.throws(() => resolvePollInterval({ pollIntervalSeconds: value }));
  assert.throws(() => resolvePollInterval({ pollIntervalMs: 1000, pollIntervalSeconds: 1 }), /同时提供/);
});

test('slot matching rejects incorrect date, time or party size', () => {
  const task = createTask(input(), {}, NOW);
  const matches = matchingSlots(task, [slot, { ...slot, partySize: 3 }, { ...slot, date: '2026-10-25' }, { ...slot, time: '21:00' }, slot, { ...slot, time: '25:00' }]);
  assert.deepEqual(matches, [slot]);
});

test('failed observations preserve availability and cannot manufacture a fresh notification', async () => {
  let count = 0;
  const f = fixture({ inspect: async () => ++count === 2 ? { status: 'unknown', message: '加载失败。' } : { status: 'available', slots: [slot] } });
  try {
    const task = f.makeTask();
    await f.engine.checkTask(task.id);
    await f.engine.checkTask(task.id);
    assert.deepEqual(f.store.getTask(task.id).slots, [slot]);
    assert.equal(f.store.getTask(task.id).lastObservationStatus, 'unknown');
    await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents().filter((event) => event.type === 'slot_available').length, 1);
    assert.equal(f.store.listNotifications().length, 1);
  } finally { await f.close(); }
});

test('only a valid disappearance allows the same slot to be notified again', async () => {
  let count = 0;
  const f = fixture({ inspect: async () => ++count === 2 ? { status: 'unavailable', slots: [] } : { status: 'available', slots: [slot] } });
  try {
    const task = f.makeTask();
    await f.engine.checkTask(task.id);
    await f.engine.checkTask(task.id);
    await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents().filter((event) => event.type === 'slot_available').length, 2);
  } finally { await f.close(); }
});

test('time label formatting cannot duplicate a slot and totals survive truncated activity history', async () => {
  let count = 0;
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [{ ...slot, label: ++count === 1 ? '下午 7:00' : '下午7:00' }] }) });
  try {
    const task = f.makeTask();
    await f.engine.checkTask(task.id);
    await f.engine.checkTask(task.id);
    assert.equal(f.store.stats().availableEvents, 1);
    for (let index=0; index<130; index++) f.engine.event(task, 'checked', '常规检查记录');
    assert.equal(f.store.listEvents().length, 120);
    assert.equal(f.store.stats().availableEvents, 1);
  } finally { await f.close(); }
});

test('partial multi-date observation preserves unread dates and does not invent reappearance', async () => {
  let count = 0;
  const second = { ...slot, date: '2026-10-25' };
  const f = fixture({ inspect: async () => {
    count++;
    if (count === 1 || count === 3) return { status: 'available', slots: [slot, second], complete: true };
    return { status: 'available', slots: [second], complete: false, observedDates: ['2026-10-25'], message: '第一天无法读取。' };
  } });
  try {
    const task = f.makeTask({ dates: ['2026-10-24', '2026-10-25'] });
    await f.engine.checkTask(task.id);
    await f.engine.checkTask(task.id);
    assert.equal(f.store.getTask(task.id).slots.length, 2);
    assert.equal(f.store.getTask(task.id).lastObservationComplete, false);
    await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents().filter((event) => event.type === 'slot_available').length, 2);
  } finally { await f.close(); }
});

test('assisted mode records a match without submitting until explicitly handed off', async () => {
  let writes = 0;
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }), prepare: async () => { writes++; return { status: 'user_action_required', message: '需要官方页面确认。' }; } });
  try {
    const task = f.makeTask({ mode: 'assist' });
    await f.engine.checkTask(task.id);
    assert.equal(writes, 0);
    assert.equal(f.store.getTask(task.id).status, 'user_action_required');
    await f.engine.taskAction(task.id, 'handoff');
    assert.equal(writes, 1);
    assert.equal(f.store.listAttempts()[0].status, 'user_action_required');
    await assert.rejects(f.engine.taskAction(task.id, 'handoff'), /不能重复提交/);
    assert.equal(writes, 1);
  } finally { await f.close(); }
});

test('submitting is durably recorded before calling the adapter', async () => {
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }) });
  f.adapter.prepare = async () => {
    assert.equal(f.store.listAttempts()[0].status, 'submitting');
    return { status: 'rejected', message: '空位被别人抢先预订。' };
  };
  try {
    const task = f.makeTask({ mode: 'auto', autoConsent: true });
    await f.engine.checkTask(task.id);
    assert.equal(f.store.getTask(task.id).status, 'active');
    assert.equal(f.store.listAttempts()[0].status, 'rejected');
  } finally { await f.close(); }
});

test('a failed booking leaves the group active; a verified booking pauses its peers', async () => {
  let count = 0;
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }), prepare: async () => ++count === 1 ? { status: 'rejected' } : { status: 'confirmed', reservationId: 'R-123', slot } });
  try {
    const a = f.makeTask({ mode: 'auto', autoConsent: true, groupId: 'dinner' });
    const b = f.makeTask({ groupId: 'dinner' });
    await f.engine.checkTask(a.id);
    assert.equal(f.store.getTask(b.id).status, 'active');
    await f.engine.checkTask(a.id);
    assert.equal(f.store.getTask(a.id).status, 'confirmed');
    assert.equal(f.store.getTask(b.id).status, 'paused');
    assert.equal(f.store.stats().confirmedBookings, 1);
  } finally { await f.close(); }
});

test('unknown submission prevents new writes until reconciliation establishes a result', async () => {
  let writes = 0;
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }), prepare: async () => { writes++; throw new Error('响应丢失'); }, reconcile: async () => ({ status: 'confirmed', reservationId: 'R-456', slot }) });
  try {
    const task = f.makeTask({ mode: 'auto', autoConsent: true });
    const other = f.makeTask({ mode: 'auto', autoConsent: true });
    await f.engine.checkTask(task.id);
    assert.equal(f.engine.state().accountWriteBlocked, true);
    await assert.rejects(f.engine.prepareTask(other, slot), /新预订已阻止/);
    assert.equal(writes, 1);
    await f.engine.taskAction(task.id, 'reconcile');
    assert.equal(f.store.getTask(task.id).status, 'confirmed');
    assert.equal(f.engine.state().accountWriteBlocked, false);
  } finally { await f.close(); }
});

test('pending assisted checkout blocks group peers but continues observation', async () => {
  let writes = 0;
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }), prepare: async () => { writes++; return { status: 'user_action_required', message: '请完成官方确认。' }; } });
  try {
    const first = f.makeTask({ mode: 'assist', groupId: 'dinner' });
    const second = f.makeTask({ mode: 'auto', autoConsent: true, groupId: 'dinner' });
    await f.engine.checkTask(first.id);
    await f.engine.taskAction(first.id, 'handoff');
    await f.engine.checkTask(second.id);
    assert.equal(writes, 1);
    assert.equal(f.store.getTask(second.id).status, 'active');
    assert.equal(f.store.getTask(second.id).checkCount, 1);
    await assert.rejects(f.engine.taskAction(second.id, 'handoff'), /同组/);
    assert.throws(() => f.engine.deleteTask(first.id), /待核验/);
  } finally { await f.close(); }
});

test('manual no-reservation resolution requires explicit confirmation and never submits again', async () => {
  let writes = 0;
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }), prepare: async () => { writes++; return { status: 'outcome_unknown', message: '响应丢失。' }; } });
  try {
    const task = f.makeTask({ mode: 'auto', autoConsent: true });
    await f.engine.checkTask(task.id);
    await assert.rejects(f.engine.taskAction(task.id, 'abandon'), /明确确认/);
    await assert.rejects(f.engine.taskAction(task.id, 'abandon', { noReservationConfirmed: 'true' }), /明确确认/);
    assert.equal(f.engine.state().accountWriteBlocked, true);
    const result = await f.engine.taskAction(task.id, 'abandon', { noReservationConfirmed: true });
    assert.equal(result.task.status, 'paused');
    assert.equal(f.engine.state().accountWriteBlocked, false);
    assert.equal(f.store.listAttempts()[0].status, 'rejected');
    assert.equal(f.store.listAttempts()[0].resolutionOrigin, 'user');
    assert.equal(writes, 1);
    assert.ok(f.store.listEvents().some((event) => event.type === 'booking_abandoned' && event.resolutionOrigin === 'user'));
    assert.doesNotThrow(() => f.engine.deleteTask(task.id));
  } finally { await f.close(); }
});

test('a confirmation without reservation evidence stays outcome_unknown', async () => {
  const f = fixture({ inspect: async () => ({ status: 'available', slots: [slot] }), prepare: async () => ({ status: 'confirmed', message: '完成了' }) });
  try {
    const task = f.makeTask({ mode: 'auto', autoConsent: true });
    await f.engine.checkTask(task.id);
    assert.equal(f.store.listAttempts()[0].status, 'outcome_unknown');
    assert.equal(f.store.stats().confirmedBookings, 0);
  } finally { await f.close(); }
});

test('restart converts submitting to outcome_unknown and preserves notification deduplication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'catchtable-backend-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  let engine;
  try {
    const task = createTask(input({ mode: 'auto', autoConsent: true }), {}, NOW);
    store.saveTask({ ...task, status: 'active', nextCheckAt: new Date(NOW).toISOString() });
    store.addAttempt(task, slot, 'submitting', '尚未收到结果', new Date(NOW).toISOString());
    store.recordSlots(task.id, [slot]);
    store.close();
    store = new Store(path);
    engine = new Engine({ store, adapter: { close: async () => {} }, now: () => NOW });
    assert.equal(store.listAttempts()[0].status, 'outcome_unknown');
    assert.equal(store.getTask(task.id).status, 'user_action_required');
    assert.equal(engine.state().accountWriteBlocked, true);
    assert.equal(store.recordSlots(task.id, [slot]).length, 0);
    await assert.rejects(engine.taskAction(task.id, 'start'), /先核验/);
  } finally {
    if (engine) await engine.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each due task is selected fairly and deadlines stop future checks', async () => {
  const seen = [];
  const f = fixture({ inspect: async (task) => { seen.push(task.id); return { status: 'unavailable', slots: [] }; } });
  try {
    const tasks = Array.from({ length: 5 }, (_, index) => f.makeTask({ restaurantName: `餐厅 ${index}` }));
    for (let index = 0; index < 5; index++) { await f.engine.tick(); f.advance(10); }
    assert.deepEqual(new Set(seen), new Set(tasks.map((task) => task.id)));
    f.advance(30000);
    for (let index = 0; index < 5; index++) { await f.engine.tick(); f.advance(10); }
    assert.equal(seen.length, 10);
    f.store.patchTask(tasks[0].id, { deadline: new Date(NOW).toISOString() });
    await f.engine.tick();
    assert.equal(f.store.getTask(tasks[0].id).status, 'expired');
  } finally { await f.close(); }
});

test('authentication expiry resumes only tasks that were running', async () => {
  const f = fixture({ inspect: async () => ({ status: 'auth_required', message: '请登录' }),
    getSessionStatus: async () => ({ status: 'authenticated', connected: true, browserOpen: true, browserMode: 'controlled', message: '会话已连接。' }) });
  try {
    const task = f.makeTask();
    const paused = f.makeTask();
    f.store.patchTask(paused.id, { status: 'paused', nextCheckAt: null });
    await f.engine.checkTask(task.id);
    await f.engine.checkTask(paused.id, { manual: true });
    assert.equal(f.store.getTask(task.id).status, 'auth_required');
    await f.engine.sessionAction('check');
    assert.equal(f.store.getTask(task.id).status, 'active');
    assert.equal(f.store.getTask(paused.id).status, 'paused');
  } finally { await f.close(); }
});

test('pausing a task while observation runs prevents automatic submission', async () => {
  let release;
  let writes = 0;
  const f = fixture({ inspect: () => new Promise((resolve) => { release = resolve; }), prepare: async () => { writes++; return { status: 'rejected' }; } });
  try {
    const task = f.makeTask({ mode: 'auto', autoConsent: true });
    const check = f.engine.checkTask(task.id);
    await f.engine.taskAction(task.id, 'pause');
    release({ status: 'available', slots: [slot] });
    await check;
    assert.equal(writes, 0);
    assert.equal(f.store.getTask(task.id).status, 'paused');
  } finally { await f.close(); }
});

test('notification retries are finite and acceptance is explicitly distinct from delivery', async () => {
  const f = fixture();
  try {
    let failed = true;
    f.engine.deliverWebhook = async () => { if (failed) throw new Error('offline'); };
    f.store.saveSettings({ webhookUrl: 'https://notifications.example.org/hooks/test' });
    const task = f.makeTask();
    f.engine.notify(task, 'slot_available', '测试提醒', { slot });
    for (let index = 0; index < 5; index++) { await f.engine.deliverOneNotification(); f.advance(600001); }
    const failedNotice = f.store.listNotifications().find((notice) => notice.channel === 'webhook');
    assert.equal(failedNotice.attempts, 5);
    assert.equal(failedNotice.status, 'failed');
    assert.equal(f.store.listNotifications().find((notice) => notice.channel === 'in_app').status, 'visible');
    failed = false;
    f.engine.notify(task, 'test', '第二条提醒');
    await f.engine.deliverOneNotification();
    assert.equal(f.store.listNotifications().find((notice) => notice.message === '第二条提醒' && notice.channel === 'webhook').status, 'accepted');
  } finally { await f.close(); }
});

test('demo is isolated, exercises rejection and recovery, and cannot create live success statistics', async () => {
  let externalCalls = 0;
  const f = fixture({ inspect: async () => { externalCalls++; throw new Error('must not run'); }, prepare: async () => { externalCalls++; throw new Error('must not run'); } });
  try {
    const result = await f.engine.runDemo();
    assert.equal(externalCalls, 0);
    assert.equal(result.task.source, 'demo');
    assert.equal(result.task.status, 'confirmed');
    assert.equal(f.store.stats().confirmedBookings, 0);
    assert.equal(f.store.stats().demoBookings, 1);
    assert.equal(f.store.listAttempts().length, 2);
    assert.ok(f.store.listEvents().some((event) => event.type === 'booking_rejected'));
    assert.ok(f.store.listEvents().some((event) => event.type === 'booking_outcome_unknown'));
    assert.ok(f.store.listEvents().every((event) => event.source === 'demo'));
  } finally { await f.close(); }
});

test('webhooks reject private, metadata and reserved addresses including DNS aliases', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.18.0.1', '192.168.1.2', '100.64.0.1', '::1', 'fd12::abcd']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(validateWebhookUrl('https://localhost/hook'), /内部网络/);
  await assert.rejects(validateWebhookUrl('https://evil.example.com/hook', async () => [{ address: '127.0.0.1', family: 4 }]), /内部网络/);
  const result = await validateWebhookUrl('https://hooks.example.com/hook', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(result.url, 'https://hooks.example.com/hook');
});
