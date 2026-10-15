import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../server/store.mjs';
import { createTask } from '../server/domain.mjs';
import { backupBeforeAccounts } from '../server/upgrade.mjs';

function removeFixture(directory) {
  const target = resolve(directory);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.split(sep).at(-1).startsWith('catchable-upgrade-fixture-'));
  rmSync(target, { recursive: true, force: true });
}

test('upgrade snapshots committed SQLite WAL and pairing file before migration, then skips subsequent backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'catchable-upgrade-fixture-'));
  let store, snapshot;
  try {
    const NOW = Date.parse('2026-10-15T00:00:00Z');
    const database = join(directory, 'catchtable.sqlite');
    store = new Store(database, { now: () => NOW });
    store.db.exec('PRAGMA wal_autocheckpoint=0');
    const task = store.saveTask(createTask({ restaurantName: 'Upgrade fixture', restaurantUrl: 'https://www.catchtable.net/shop/upgrade_fixture', dates: ['2026-12-24'], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'notify' }, store.settings(), NOW));
    const attempt = store.addAttempt(task, { date: task.dates[0], time: '19:00', partySize: 2 }, 'outcome_unknown');
    const event = store.addEvent({ taskId: task.id, bookingId: attempt.id, type: 'slot_available', message: 'Committed WAL fixture' });
    store.addNotification(event, 'webhook');
    store.recordSlots(task.id, [attempt.slot]);
    const fixturePairing = 'fixture-only-pairing-data-not-a-real-secret';
    writeFileSync(join(directory, 'extension-pairing.key'), fixturePairing);
    assert.ok(statSync(`${database}-wal`).size > 0);
    const backup = await backupBeforeAccounts(directory);
    assert.ok(backup.startsWith(join(directory, 'backups')));
    snapshot = new DatabaseSync(join(backup, 'catchtable.sqlite'), { readOnly: true });
    assert.deepEqual(JSON.parse(snapshot.prepare('SELECT payload FROM tasks WHERE id=?').get(task.id).payload), task);
    assert.deepEqual(JSON.parse(snapshot.prepare('SELECT payload FROM attempts WHERE id=?').get(attempt.id).payload), attempt);
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM slots').get().count, 1);
    assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='accounts'").get(), undefined);
    assert.equal(readFileSync(join(backup, 'extension-pairing.key'), 'utf8'), fixturePairing);
    const manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'));
    assert.equal(manifest.version, 'single-account-v1');
    assert.equal(JSON.stringify(manifest).includes(fixturePairing), false);
    store.initializeAccounts();
    assert.equal(store.settings().enginePaused, true);
    assert.equal(store.forAccount('default').getAttempt(attempt.id).status, 'outcome_unknown');
    assert.equal(await backupBeforeAccounts(directory), null);
    assert.equal(readdirSync(join(directory, 'backups')).length, 1);
    assert.equal(JSON.parse(snapshot.prepare('SELECT payload FROM attempts WHERE id=?').get(attempt.id).payload).accountId, undefined);
  } finally { snapshot?.close(); store?.close(); removeFixture(directory); }
});

test('a fresh installation without a database does not create an upgrade backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'catchable-upgrade-fixture-'));
  try { assert.equal(await backupBeforeAccounts(directory), null); assert.deepEqual(readdirSync(directory), []); }
  finally { removeFixture(directory); }
});
