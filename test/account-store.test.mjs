import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store, DEFAULT_ACCOUNT_ID, publicAccount } from '../server/store.mjs';
import { createTask, validateAccountSettings } from '../server/domain.mjs';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const timestamp = new Date(NOW).toISOString();
const slot = { date: '2026-12-24', time: '19:00', partySize: 2 };
const errorStatus = expected => error => error.status === expected;
const taskInput = { restaurantName: 'Fixture restaurant', restaurantUrl: 'https://www.catchtable.net/shop/fixture', dates: [slot.date], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'auto', autoConsent: true, groupId: 'same-label-across-accounts' };

function makeTask(store, extra = {}) { return store.saveTask({ ...createTask(taskInput, store.settings(), NOW), ...extra }); }
function message(store, task, extra = {}) {
  const event = store.addEvent({ taskId: task.id, source: task.source, type: 'slot_available', message: 'Fixture message', createdAt: timestamp, ...extra });
  const notification = store.addNotification(event, 'in_app', timestamp);
  return { event, notification };
}
function accountsFixture() {
  const root = new Store(':memory:', { now: () => NOW });
  root.initializeAccounts();
  const accountA = root.createAccount({ label: 'Profile A' });
  const accountB = root.createAccount({ label: 'Profile B' });
  return { root, accountA, accountB, a: root.forAccount(accountA.id), b: root.forAccount(accountB.id) };
}

test('accounts are opt-in; legacy migration retains IDs, snapshots, slots and cleared display boundaries durably', () => {
  const directory = mkdtempSync(join(tmpdir(), 'catchable-account-store-fixture-'));
  const database = join(directory, 'fixture.sqlite');
  let root;
  try {
    root = new Store(database, { now: () => NOW });
    assert.equal(root.db.prepare("SELECT name FROM sqlite_master WHERE name='accounts'").get(), undefined);
    assert.throws(() => root.forAccount(DEFAULT_ACCOUNT_ID), errorStatus(409));
    root.saveSettings({ enginePaused: false, bookingName: 'Legacy fixture', bookingPhoneCountryCode: '+1', bookingPhoneNumber: '2025550101', bookingPhoneAutoFill: true, browserIntegration: 'dedicated', browserChannel: 'msedge', pollIntervalMs: 5 });
    const task = makeTask(root);
    const unknown = root.addAttempt(task, slot, 'outcome_unknown', 'Fixture unknown', timestamp);
    const confirmed = root.addAttempt(task, slot, 'confirmed', 'Fixture confirmed', timestamp);
    root.saveAttempt({ ...confirmed, reservationId: 'fixture-order', submitted: true });
    const { event } = message(root, task, { bookingId: unknown.id });
    root.addNotification(event, 'webhook', timestamp);
    const fresh = root.recordSlots(task.id, [slot]);
    assert.equal(fresh[0].generation, 1);
    assert.deepEqual(root.clearRecords('all'), { events: 1, notifications: 2, bookings: 1 });
    assert.equal(Object.hasOwn(root.getTask(task.id), 'accountId'), false);

    const account = root.initializeAccounts();
    assert.equal(account.id, DEFAULT_ACCOUNT_ID);
    assert.equal(account.enabled, true);
    assert.equal(account.settings.enginePaused, false);
    assert.equal(root.settings().enginePaused, true);
    assert.equal(account.settings.bookingName, 'Legacy fixture');
    assert.equal(account.settings.pollIntervalMs, 5);
    const scoped = root.forAccount(DEFAULT_ACCOUNT_ID);
    assert.equal(scoped.getTask(task.id).accountId, DEFAULT_ACCOUNT_ID);
    assert.equal(scoped.getAttempt(unknown.id).status, 'outcome_unknown');
    assert.equal(scoped.getAttempt(unknown.id).taskSnapshot.accountId, DEFAULT_ACCOUNT_ID);
    assert.deepEqual(scoped.getAttempt(unknown.id).contactSnapshot, { name: 'Legacy fixture', countryCode: '+1', phoneNumber: '2025550101', autoFill: true });
    assert.equal(scoped.getAttempt(unknown.id).accountIdentityFingerprint, null);
    assert.equal(scoped.getAttempt(unknown.id).legacyIdentityUnverified, true);
    assert.throws(() => scoped.saveAttempt({ ...scoped.getAttempt(unknown.id), legacyIdentityUnverified: false }), errorStatus(409));
    assert.equal(scoped.getAttempt(confirmed.id).reservationId, 'fixture-order');
    assert.deepEqual(scoped.listEvents(), []);
    assert.deepEqual(scoped.listNotifications(), []);
    assert.deepEqual(scoped.listVisibleAttempts().map(attempt => attempt.id), [unknown.id]);
    assert.equal(scoped.eventsForBooking(unknown.id)[0].id, event.id);
    assert.equal(scoped.nextNotification(timestamp).eventId, event.id);
    assert.deepEqual(scoped.recordSlots(task.id, [slot]), []);
    root.saveSettings({ enginePaused: false });
    root.initializeAccounts();
    assert.equal(root.settings().enginePaused, false, 'idempotent migration must not pause the application again');
    root.close();
    root = new Store(database, { now: () => NOW });
    root.migrateAccounts();
    const reopened = root.forAccount(DEFAULT_ACCOUNT_ID);
    assert.equal(root.settings().enginePaused, false);
    assert.equal(reopened.hasUncertainLiveAttempt(), true);
    assert.equal(reopened.getAttempt(unknown.id).legacyIdentityUnverified, true);
    assert.equal(reopened.getAttempt(confirmed.id).reservationId, 'fixture-order');
    assert.deepEqual(reopened.listEvents(), []);
    assert.deepEqual(reopened.listNotifications(), []);
    assert.equal(reopened.listVisibleAttempts().length, 1);
    assert.deepEqual(reopened.clearRecords('all'), { events: 0, notifications: 0, bookings: 0 });
    reopened.close();
    assert.equal(root.getTask(task.id).id, task.id, 'closing an account facade cannot close shared SQLite');
  } finally {
    root?.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.split(sep).at(-1).startsWith('catchable-account-store-fixture-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('scoped SQL applies account filtering before limits, including history, pending locks and notification delivery', () => {
  const { root, a, b } = accountsFixture();
  try {
    const taskA = makeTask(a), taskB = makeTask(b);
    const pendingA = a.addAttempt(taskA, slot, 'outcome_unknown');
    const { event: eventA, notification: noticeA } = message(a, taskA, { bookingId: pendingA.id });
    const queuedA = a.addNotification(eventA, 'webhook', timestamp);
    for (let index = 0; index < 140; index++) {
      b.addAttempt(taskB, slot, 'confirmed');
      message(b, taskB);
    }
    const { event: eventB } = message(b, taskB);
    b.addNotification(eventB, 'webhook', timestamp);
    assert.deepEqual(a.listTasks().map(task => task.id), [taskA.id]);
    assert.deepEqual(a.listEvents(1), [eventA]);
    assert.deepEqual(a.listNotifications(1), [queuedA]);
    assert.equal(a.listNotifications().some(notice => notice.id === noticeA.id), true);
    assert.deepEqual(a.listAttempts(1), [pendingA]);
    assert.deepEqual(a.listVisibleAttempts(1), [pendingA]);
    assert.deepEqual(a.listPendingAttempts(), [pendingA]);
    assert.equal(a.hasUncertainLiveAttempt(), true);
    assert.equal(b.hasUncertainLiveAttempt(), false);
    assert.equal(b.attemptsForTask(taskA.id).length, 0);
    assert.equal(a.stats().confirmedBookings, 0);
    assert.equal(b.stats().confirmedBookings, 140);
    assert.equal(a.stats().availableEvents, 1);
    assert.equal(a.stats().pendingNotifications, 1);
    assert.deepEqual(a.nextNotification(timestamp), queuedA);
    assert.equal(b.nextNotification(timestamp).eventId, eventB.id);
    assert.deepEqual(b.eventsForBooking(pendingA.id), []);
  } finally { root.close(); }
});

test('foreign IDs and forged account ownership cannot read, reassign or mutate another account', () => {
  const { root, a, b, accountA, accountB } = accountsFixture();
  try {
    const taskA = makeTask(a), taskB = makeTask(b);
    const attemptB = b.addAttempt(taskB, slot, 'outcome_unknown');
    const { event: eventB, notification: noticeB } = message(b, taskB);
    assert.equal(a.getTask(taskB.id), null);
    assert.equal(a.getAttempt(attemptB.id), null);
    assert.equal(a.patchTask(taskB.id, { status: 'confirmed' }), null);
    assert.equal(a.deleteTask(taskB.id), false);
    assert.throws(() => a.saveTask(taskB), errorStatus(409));
    assert.throws(() => a.saveTask({ ...taskB, accountId: accountA.id }), errorStatus(409));
    assert.throws(() => a.patchTask(taskA.id, { accountId: accountB.id }), errorStatus(409));
    assert.throws(() => a.recordSlots(taskB.id, [slot]), errorStatus(404));
    assert.throws(() => a.saveAttempt({ ...attemptB, accountId: accountA.id }), errorStatus(404));
    assert.throws(() => a.addAttempt({ ...taskB, accountId: accountA.id }, slot), errorStatus(404));
    assert.throws(() => a.addEvent({ taskId: taskB.id, message: 'Cross-account fixture' }), errorStatus(409));
    assert.throws(() => a.addEvent({ bookingId: attemptB.id, message: 'Cross-account fixture' }), errorStatus(409));
    assert.throws(() => a.addNotification({ ...eventB, accountId: accountA.id }), errorStatus(404));
    assert.throws(() => a.saveNotification({ ...noticeB, accountId: accountA.id }), errorStatus(404));
    assert.equal(b.getTask(taskB.id).status, 'paused');
    assert.deepEqual(b.getAttempt(attemptB.id), attemptB);
    assert.deepEqual(b.listNotifications(), [noticeB]);
  } finally { root.close(); }
});

test('recovery, hidden history, clear watermarks and slot deduplication remain account-local', () => {
  const { root, a, b } = accountsFixture();
  try {
    const taskA = makeTask(a), taskB = makeTask(b);
    const pendingA = a.addAttempt(taskA, slot, 'submitting');
    const pendingB = b.addAttempt(taskB, slot, 'submitting');
    a.addAttempt(taskA, slot, 'confirmed');
    b.addAttempt(taskB, slot, 'confirmed');
    const { event: eventA } = message(a, taskA, { bookingId: pendingA.id });
    const { notification: noticeB } = message(b, taskB);
    const queuedA = a.addNotification(eventA, 'webhook', timestamp);
    assert.equal(a.recordSlots(taskA.id, [slot]).length, 1);
    assert.equal(b.recordSlots(taskB.id, [slot]).length, 1);
    assert.equal(a.recover(timestamp), 1);
    assert.equal(a.getAttempt(pendingA.id).status, 'outcome_unknown');
    assert.equal(b.getAttempt(pendingB.id).status, 'submitting');
    assert.equal(b.listEvents().length, 1);
    assert.equal(a.clearRecords('all').bookings, 1);
    assert.deepEqual(a.listEvents(), []);
    assert.deepEqual(a.listNotifications(), []);
    assert.equal(a.listVisibleAttempts().length, 1);
    assert.equal(b.listVisibleAttempts().length, 2);
    assert.deepEqual(b.listNotifications(), [noticeB]);
    assert.equal(a.stats().availableEvents, 0);
    assert.equal(b.stats().availableEvents, 1);
    assert.equal(a.hasUncertainLiveAttempt(), true);
    assert.deepEqual(a.recordSlots(taskA.id, [slot]), []);
    assert.deepEqual(b.recordSlots(taskB.id, [slot]), []);
    assert.deepEqual(a.nextNotification(timestamp), queuedA);
    a.addNotification(eventA, 'webhook', timestamp);
    assert.equal(a.stats().pendingNotifications, 1);
    assert.equal(a.eventsForBooking(pendingA.id)[0].id, eventA.id);
    assert.deepEqual(a.clearRecords('all'), { events: 0, notifications: 0, bookings: 0 });
    const fresh = message(a, taskA);
    assert.deepEqual(a.listEvents(), [fresh.event]);
    assert.equal(a.stats().availableEvents, 1);
    a.clearRecords('events');
    assert.equal(a.stats().availableEvents, 1);
    assert.equal(b.listEvents().length, 1);
  } finally { root.close(); }
});

test('account settings, enabled state and local pause never overwrite another account or global pause', () => {
  const { root, a, b, accountA, accountB } = accountsFixture();
  try {
    assert.equal(a.settings().enginePaused, true);
    root.saveSettings({ enginePaused: false });
    assert.equal(a.settings().enginePaused, false);
    a.saveSettings({ bookingName: 'A fixture', bookingPhoneCountryCode: '+1', bookingPhoneNumber: '2025550101', bookingPhoneAutoFill: true, pollIntervalMs: 1, enginePaused: true });
    assert.equal(a.settings().enginePaused, true);
    assert.equal(b.settings().enginePaused, false);
    assert.equal(root.settings().enginePaused, false);
    assert.equal(root.getAccount(accountA.id).settings.pollIntervalMs, 1);
    assert.equal(b.settings().bookingName, '');
    assert.equal(b.settings().bookingPhoneAutoFill, false);
    assert.equal(b.settings().pollIntervalMs, 1000);
    root.updateAccount(accountB.id, { enabled: false });
    assert.equal(b.settings().enginePaused, true);
    root.updateAccount(accountB.id, { enabled: true });
    root.saveSettings({ enginePaused: true });
    a.saveSettings({ enginePaused: false });
    assert.equal(a.settings().enginePaused, true, 'an account cannot lift the global submission pause');
    assert.equal(root.getAccount(accountA.id).settings.enginePaused, false);
    a.saveSettings({ webhookUrl: 'https://example.invalid/fixture-webhook' });
    assert.equal(b.settings().webhookUrl, 'https://example.invalid/fixture-webhook');
    const before = root.getAccount(accountA.id);
    assert.throws(() => a.saveSettings({ bookingPhoneNumber: 'not-digits', webhookUrl: '' }), errorStatus(400));
    assert.deepEqual(root.getAccount(accountA.id), before);
    assert.equal(root.settings().webhookUrl, 'https://example.invalid/fixture-webhook');
    assert.throws(() => validateAccountSettings({ bookingName: 'line\nbreak' }), errorStatus(400));
    assert.throws(() => validateAccountSettings({ bookingName: 'x'.repeat(101) }), errorStatus(400));
    assert.throws(() => validateAccountSettings({ bookingPhoneAutoFill: true }), errorStatus(400));
    assert.throws(() => root.createAccount({ label: 'Invalid', settings: { pollIntervalMs: 0 } }), errorStatus(400));
  } finally { root.close(); }
});

test('identity binding is unique and internal; attempt identity and contact snapshots remain immutable', () => {
  const { root, a, b, accountA, accountB } = accountsFixture();
  try {
    root.bindAccountIdentity(accountA.id, 'fixture-identity-A');
    assert.equal(root.bindAccountIdentity(accountA.id, 'fixture-identity-A').identityFingerprint, 'fixture-identity-A');
    assert.throws(() => root.bindAccountIdentity(accountB.id, 'fixture-identity-A'), errorStatus(409));
    assert.throws(() => root.bindAccountIdentity(accountA.id, 'different-fixture'), errorStatus(409));
    assert.throws(() => root.updateAccount(accountA.id, { identityFingerprint: 'forged-fixture' }), errorStatus(400));
    assert.ok(root.listAccounts().every(account => !Object.hasOwn(account, 'identityFingerprint')));
    assert.equal(JSON.stringify(publicAccount(root.getAccount(accountA.id))).includes('fixture-identity-A'), false);
    a.saveSettings({ bookingName: 'Before fixture', bookingPhoneCountryCode: '+1', bookingPhoneNumber: '2025550101', bookingPhoneAutoFill: true });
    const task = makeTask(a), attempt = a.addAttempt(task, slot, 'user_action_required');
    assert.deepEqual(attempt.contactSnapshot, { name: 'Before fixture', countryCode: '+1', phoneNumber: '2025550101', autoFill: true });
    assert.equal(attempt.accountIdentityFingerprint, 'fixture-identity-A');
    a.saveSettings({ bookingName: 'After fixture', bookingPhoneCountryCode: '+1', bookingPhoneNumber: '2025550102', bookingPhoneAutoFill: false });
    assert.deepEqual(a.getAttempt(attempt.id), attempt);
    const next = a.addAttempt(task, slot, 'rejected');
    assert.deepEqual(next.contactSnapshot, { name: 'After fixture', countryCode: '+1', phoneNumber: '2025550102', autoFill: false });
    assert.throws(() => a.saveAttempt({ ...attempt, accountIdentityFingerprint: 'forged-fixture' }), errorStatus(409));
    assert.throws(() => a.saveAttempt({ ...attempt, contactSnapshot: next.contactSnapshot }), errorStatus(409));
    assert.throws(() => a.saveAttempt({ ...attempt, taskSnapshot: { ...attempt.taskSnapshot, accountId: accountB.id } }), errorStatus(409));
    assert.throws(() => a.saveAttempt({ ...attempt, accountId: accountB.id }), errorStatus(409));
    a.saveAttempt({ ...attempt, status: 'outcome_unknown' });
    assert.equal(a.getAttempt(attempt.id).accountIdentityFingerprint, 'fixture-identity-A');
    assert.deepEqual(a.getAttempt(attempt.id).contactSnapshot, attempt.contactSnapshot);
    assert.equal(b.listAttempts().length, 0);
  } finally { root.close(); }
});

test('shared SQLite transactions roll back account writes without affecting other scopes', () => {
  const { root, a, b } = accountsFixture();
  try {
    const taskA = makeTask(a), taskB = makeTask(b);
    message(b, taskB);
    assert.throws(() => a.transaction(() => {
      message(a, taskA);
      a.addAttempt(taskA, slot);
      throw new Error('Fixture rollback');
    }), /Fixture rollback/);
    assert.deepEqual(a.listEvents(), []);
    assert.deepEqual(a.listNotifications(), []);
    assert.deepEqual(a.listAttempts(), []);
    assert.equal(b.listEvents().length, 1);
    assert.equal(b.listNotifications().length, 1);
  } finally { root.close(); }
});

test('50 registered enabled accounts retain independent settings, five-task histories and same-named groups', () => {
  const root = new Store(':memory:', { now: () => NOW });
  try {
    root.initializeAccounts();
    const accounts = [root.getAccount(DEFAULT_ACCOUNT_ID), ...Array.from({ length: 49 }, (_, index) => root.createAccount({ label: `Fixture profile ${index + 2}` }))];
    for (const [index, account] of accounts.entries()) {
      assert.equal(account.enabled, true);
      assert.equal(account.settings.bookingName, '');
      assert.equal(account.settings.bookingPhoneAutoFill, false);
      root.bindAccountIdentity(account.id, `fixture-principal-${index}`);
      const store = root.forAccount(account.id);
      store.saveSettings({ pollIntervalMs: index + 1 });
      for (let count = 0; count < 5; count++) {
        const task = makeTask(store);
        store.addAttempt(task, slot, index === 0 ? 'outcome_unknown' : 'confirmed');
        message(store, task);
      }
    }
    assert.equal(root.listAccounts().length, 50);
    assert.equal(root.listTasks().length, 250);
    for (const [index, account] of accounts.entries()) {
      const store = root.forAccount(account.id);
      assert.equal(store.listTasks().length, 5);
      assert.equal(store.listEvents().length, 5);
      assert.equal(store.listNotifications().length, 5);
      assert.equal(store.listAttempts().length, 5);
      assert.equal(store.stats().availableEvents, 5);
      assert.equal(store.settings().pollIntervalMs, index + 1);
      assert.equal(store.hasUncertainLiveAttempt(), index === 0);
      assert.ok(store.listAttempts().every(attempt => attempt.accountId === account.id && attempt.groupId === taskInput.groupId));
      store.close();
    }
    assert.equal(root.db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count, 250);
  } finally { root.close(); }
});
