import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACTIVE_TASK_STATUSES, identifier, isoNow, migrateStoredInterval, slotKey } from './domain.mjs';

const read = (row) => row ? JSON.parse(row.payload) : null;

export class Store {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, next_check_at TEXT, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_due ON tasks(status, next_check_at);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempt_state ON attempts(status);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, channel TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at TEXT, created_at TEXT NOT NULL, UNIQUE(event_id, channel));
      CREATE TABLE IF NOT EXISTS slots (task_id TEXT NOT NULL, slot_key TEXT NOT NULL, present INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id, slot_key));
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS record_clear_watermarks (kind TEXT PRIMARY KEY, cutoff_rowid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hidden_bookings (attempt_id TEXT PRIMARY KEY);
    `);
    this.db.prepare('INSERT OR IGNORE INTO settings (id, payload) VALUES (1, ?)').run(JSON.stringify({ pollIntervalMs: 1000, webhookUrl: '', enginePaused: false }));
    this.migrateIntervals(now());
    this.migrateNotificationTypes();
  }

  migrateNotificationTypes() {
    this.transaction(()=>{
      const records=this.db.prepare("SELECT n.id,n.payload,e.payload AS event_payload FROM notifications n JOIN events e ON e.id=n.event_id WHERE json_extract(n.payload,'$.eventType') IS NULL").all();
      for(const record of records){
        const notification=read(record); const event=JSON.parse(record.event_payload);
        if(typeof event.type==='string')this.db.prepare('UPDATE notifications SET payload=? WHERE id=?').run(JSON.stringify({...notification,eventType:event.type}),record.id);
      }
    });
  }

  migrateIntervals(now = Date.now()) {
    this.transaction(() => {
      const settings = migrateStoredInterval(this.settings());
      this.db.prepare('UPDATE settings SET payload = ? WHERE id = 1').run(JSON.stringify(settings));
      for (const original of this.listTasks()) {
        const legacy = !Object.hasOwn(original, 'pollIntervalMs');
        const task = migrateStoredInterval(original);
        if (legacy && ACTIVE_TASK_STATUSES.has(task.status)) {
          const earliest = now + (task.status === 'backoff' ? Math.max(1000, task.pollIntervalMs) : task.pollIntervalMs);
          if (!task.nextCheckAt || Date.parse(task.nextCheckAt) > earliest) task.nextCheckAt = new Date(earliest).toISOString();
        }
        if (JSON.stringify(task) !== JSON.stringify(original)) this.saveTask(task);
      }
      for (const attempt of this.listAttempts(1000000)) {
        if (attempt.taskSnapshot && Object.hasOwn(attempt.taskSnapshot, 'pollIntervalSeconds')) this.saveAttempt({ ...attempt, taskSnapshot: migrateStoredInterval(attempt.taskSnapshot) });
      }
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getTask(id) { return read(this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id)); }
  listTasks() { return this.db.prepare('SELECT payload FROM tasks ORDER BY updated_at DESC').all().map(read); }
  saveTask(task) {
    this.db.prepare('INSERT INTO tasks (id,payload,source,status,next_check_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,source=excluded.source,status=excluded.status,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at')
      .run(task.id, JSON.stringify(task), task.source, task.status, task.nextCheckAt, task.updatedAt);
    return task;
  }
  patchTask(id, changes, now = isoNow()) {
    const task = this.getTask(id);
    if (!task) return null;
    return this.saveTask({ ...task, ...changes, updatedAt: now });
  }
  deleteTask(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM slots WHERE task_id = ?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    });
  }

  settings() { return read(this.db.prepare('SELECT payload FROM settings WHERE id = 1').get()); }
  saveSettings(changes) {
    const settings = { ...this.settings(), ...changes };
    this.db.prepare('UPDATE settings SET payload = ? WHERE id = 1').run(JSON.stringify(settings));
    return settings;
  }

  addEvent({ taskId = null, source = 'live', type = 'info', level = 'info', message, slot = null, ...rest }) {
    const event = { id: identifier('event'), taskId, source, type, level, message, slot, ...rest, createdAt: rest.createdAt || isoNow() };
    this.db.prepare('INSERT INTO events (id,payload,created_at) VALUES (?,?,?)').run(event.id, JSON.stringify(event), event.createdAt);
    return event;
  }
  listEvents(limit = 120) { return this.db.prepare("SELECT payload FROM events WHERE rowid > COALESCE((SELECT cutoff_rowid FROM record_clear_watermarks WHERE kind='events'),0) ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit).map(read); }
  eventsForBooking(bookingId) { return this.db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.bookingId')=? ORDER BY created_at,rowid").all(bookingId).map(read); }

  clearRecords(kind) {
    if (!['events', 'notifications', 'bookings', 'all'].includes(kind)) throw new TypeError('无效的记录类型。');
    return this.transaction(() => {
      const cleared = { events: 0, notifications: 0, bookings: 0 };
      // Keep events and notifications for submission evidence, delivery and
      // deduplication; clearing only moves their persisted display boundary.
      for (const table of ['events', 'notifications']) {
        if (kind !== 'all' && kind !== table) continue;
        const previous = this.db.prepare('SELECT cutoff_rowid FROM record_clear_watermarks WHERE kind=?').get(table)?.cutoff_rowid || 0;
        cleared[table] = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE rowid > ?`).get(previous).count;
        const cutoff = this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS cutoff FROM ${table}`).get().cutoff;
        this.db.prepare('INSERT INTO record_clear_watermarks(kind,cutoff_rowid) VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET cutoff_rowid=excluded.cutoff_rowid').run(table, cutoff);
      }
      if (kind === 'all' || kind === 'bookings') {
        // Unresolved attempts must stay visible. Never remove their identity,
        // snapshots, order references or the engine's account write guards.
        cleared.bookings = this.db.prepare("INSERT OR IGNORE INTO hidden_bookings(attempt_id) SELECT id FROM attempts WHERE status IN ('confirmed','rejected')").run().changes;
      }
      return cleared;
    });
  }

  recordSlots(taskId, slots, { observedDates = null } = {}) {
    const old = this.db.prepare('SELECT slot_key,present,generation FROM slots WHERE task_id = ?').all(taskId);
    const oldMap = new Map(old.map((row) => [row.slot_key, row]));
    if (observedDates === null) this.db.prepare('UPDATE slots SET present = 0 WHERE task_id = ?').run(taskId);
    else {
      const reset = this.db.prepare('UPDATE slots SET present = 0 WHERE task_id = ? AND slot_key = ?');
      for (const previous of old) if (observedDates.includes(JSON.parse(previous.slot_key)[0])) reset.run(taskId, previous.slot_key);
    }
    const statement = this.db.prepare('INSERT INTO slots (task_id,slot_key,present,generation) VALUES (?,?,1,?) ON CONFLICT(task_id,slot_key) DO UPDATE SET present=1,generation=excluded.generation');
    const fresh = [];
    for (const slot of slots) {
      const key = slotKey(slot);
      const previous = oldMap.get(key);
      const generation = (previous?.generation || 0) + (previous?.present ? 0 : 1);
      statement.run(taskId, key, generation);
      if (!previous?.present) fresh.push({ slot, generation, eventKey: `${taskId}:${key}:${generation}` });
    }
    return fresh;
  }

  addNotification(event, channel = 'in_app', now = isoNow()) {
    const notification = {
      id: identifier('notice'), eventId: event.id, eventType: event.type, taskId: event.taskId, source: event.source,
      channel, status: channel === 'in_app' ? 'visible' : 'queued', attempts: 0,
      message: event.message, slot: event.slot, restaurantUrl: event.restaurantUrl || null,
      nextAttemptAt: channel === 'in_app' ? null : now, createdAt: now, updatedAt: now,
      lastError: null, acceptedAt: null,
    };
    this.db.prepare('INSERT OR IGNORE INTO notifications (id,event_id,channel,payload,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(notification.id, notification.eventId, channel, JSON.stringify(notification), notification.status, notification.nextAttemptAt, notification.createdAt);
    return notification;
  }
  saveNotification(notification) {
    this.db.prepare('UPDATE notifications SET payload=?,status=?,next_attempt_at=? WHERE id=?')
      .run(JSON.stringify(notification), notification.status, notification.nextAttemptAt, notification.id);
    return notification;
  }
  listNotifications(limit = 120) { return this.db.prepare("SELECT payload FROM notifications WHERE rowid > COALESCE((SELECT cutoff_rowid FROM record_clear_watermarks WHERE kind='notifications'),0) ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit).map(read); }
  nextNotification(now = isoNow()) {
    return read(this.db.prepare("SELECT payload FROM notifications WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 1").get(now));
  }

  addAttempt(task, slot, status = 'submitting', message = '正在提交；结果确认前不会重复提交。', now = isoNow()) {
    const attempt = { id: identifier('booking'), taskId: task.id, source: task.source, restaurantName: task.restaurantName, restaurantUrl: task.restaurantUrl, groupId: task.groupId,
      slot, status, message, reservationId: null, phase:status, submitted:false, nextVerificationAt:null, verificationCount:0, verificationFailureCount:0,
      lastVerifiedAt:null,lastVerificationMessage:null,createdAt: now, updatedAt: now, taskSnapshot: task };
    this.db.prepare('INSERT INTO attempts (id,task_id,payload,status,created_at) VALUES (?,?,?,?,?)').run(attempt.id, task.id, JSON.stringify(attempt), status, now);
    return attempt;
  }
  getAttempt(id) { return read(this.db.prepare('SELECT payload FROM attempts WHERE id = ?').get(id)); }
  saveAttempt(attempt) {
    this.db.prepare('UPDATE attempts SET payload=?,status=? WHERE id=?').run(JSON.stringify(attempt), attempt.status, attempt.id);
    return attempt;
  }
  listAttempts(limit = 120) { return this.db.prepare('SELECT payload FROM attempts ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit).map(read); }
  listVisibleAttempts(limit = 120) { return this.db.prepare("SELECT payload FROM attempts WHERE status NOT IN ('confirmed','rejected') OR id NOT IN (SELECT attempt_id FROM hidden_bookings) ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit).map(read); }
  listPendingAttempts() { return this.db.prepare("SELECT payload FROM attempts WHERE status IN ('submitting','outcome_unknown','user_action_required','pending_restaurant') ORDER BY created_at,rowid").all().map(read); }
  attemptsForTask(taskId) { return this.db.prepare('SELECT payload FROM attempts WHERE task_id = ? ORDER BY created_at DESC,rowid DESC').all(taskId).map(read); }
  hasUncertainLiveAttempt() {
    return this.db.prepare("SELECT payload FROM attempts WHERE status IN ('submitting','outcome_unknown','user_action_required')").all().map(read).some((attempt) => attempt.source === 'live'
      && (['submitting','outcome_unknown'].includes(attempt.status) || (attempt.submitted===true && !attempt.reservationId)));
  }

  recover(now = isoNow()) {
    const submitting = this.db.prepare("SELECT payload FROM attempts WHERE status = 'submitting'").all().map(read);
    this.transaction(() => {
      for (const attempt of submitting) {
        this.saveAttempt({ ...attempt, status: 'outcome_unknown', phase:'outcome_unknown', nextVerificationAt:null, message: '程序在提交期间停止。请先核验已有预约，系统不会自动重试提交。', updatedAt: now });
        if (this.getTask(attempt.taskId)) this.patchTask(attempt.taskId, { status: 'user_action_required', nextCheckAt: null, lastMessage: '上次提交结果不明，请核验预约结果。' }, now);
        this.addEvent({ taskId: attempt.taskId, source: attempt.source, type: 'recovery', level: 'warning', message: '恢复了一条结果不明的提交；新预订已阻止，等待核验。', createdAt: now });
      }
    });
    return submitting.length;
  }

  stats() {
    const tasks = this.listTasks();
    const bookings = this.listAttempts(10000);
    return {
      totalTasks: tasks.filter((task) => task.source === 'live').length,
      activeTasks: tasks.filter((task) => task.source === 'live' && ['active', 'backoff'].includes(task.status)).length,
      availableEvents: this.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE rowid > COALESCE((SELECT cutoff_rowid FROM record_clear_watermarks WHERE kind='notifications'),0) AND channel='in_app' AND json_extract(payload,'$.source')='live' AND json_extract(payload,'$.eventType')='slot_available'").get().count,
      confirmedBookings: bookings.filter((booking) => booking.source === 'live' && booking.status === 'confirmed').length,
      pendingRestaurantBookings: bookings.filter((booking) => booking.source === 'live' && booking.status === 'pending_restaurant').length,
      demoBookings: bookings.filter((booking) => booking.source === 'demo' && booking.status === 'confirmed').length,
      totalChecks: tasks.filter((task) => task.source === 'live').reduce((sum, task) => sum + task.checkCount, 0),
      pendingNotifications: this.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE status='queued'").get().count,
    };
  }
  close() { this.db.close(); }
}
