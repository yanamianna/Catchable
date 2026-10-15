import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_SETTING_KEYS, ACTIVE_TASK_STATUSES, DEFAULT_ACCOUNT_ID, HttpError, PENDING_ATTEMPT_STATUSES, identifier, isoNow, migrateStoredInterval, slotKey, validateAccountSettings } from './domain.mjs';

export { DEFAULT_ACCOUNT_ID } from './domain.mjs';

const read = (row) => row ? JSON.parse(row.payload) : null;
export const publicAccount = account => account ? { id: account.id, label: account.label, enabled: account.enabled, settings: structuredClone(account.settings) } : null;
const contactSnapshot = settings => ({ name: settings.bookingName || '', countryCode: settings.bookingPhoneCountryCode || '', phoneNumber: settings.bookingPhoneNumber || '', autoFill: settings.bookingPhoneAutoFill === true });

export class Store {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.now = now;
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

  initializeAccounts() { return this.migrateAccounts(); }
  migrateAccounts() {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, identity_fingerprint TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS account_record_clear_watermarks (account_id TEXT NOT NULL, kind TEXT NOT NULL, cutoff_rowid INTEGER NOT NULL, PRIMARY KEY(account_id,kind));`);
      const first = !this.db.prepare('SELECT id FROM accounts WHERE id=?').get(DEFAULT_ACCOUNT_ID);
      if (first) {
        const legacy = this.settings();
        const settings = validateAccountSettings(Object.fromEntries(ACCOUNT_SETTING_KEYS.filter(key => key !== 'enginePaused' && Object.hasOwn(legacy, key)).map(key => [key, legacy[key]])));
        const account = { id: DEFAULT_ACCOUNT_ID, label: '默认账号', enabled: true, settings, identityFingerprint: null };
        this.db.prepare('INSERT INTO accounts(id,payload,identity_fingerprint) VALUES (?,?,NULL)').run(account.id, JSON.stringify(account));
        this.saveSettings({ enginePaused: true });
      }
      for (const table of ['tasks', 'events', 'attempts', 'notifications', 'slots']) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some(column => column.name === 'account_id')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default'`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS account_task_due ON tasks(account_id,status,next_check_at);
        CREATE INDEX IF NOT EXISTS account_attempt_state ON attempts(account_id,status);
        CREATE INDEX IF NOT EXISTS account_events ON events(account_id,created_at);
        CREATE INDEX IF NOT EXISTS account_notification_due ON notifications(account_id,status,next_attempt_at);`);
      const account = this.getAccount(DEFAULT_ACCOUNT_ID);
      for (const table of ['tasks', 'events', 'notifications', 'attempts']) {
        const rows = this.db.prepare(`SELECT id,payload,account_id FROM ${table} WHERE json_extract(payload,'$.accountId') IS NULL`).all();
        const update = this.db.prepare(`UPDATE ${table} SET payload=? WHERE id=?`);
        for (const row of rows) {
          const record = { ...read(row), accountId: row.account_id };
          if (table === 'attempts') {
            if (record.taskSnapshot) record.taskSnapshot = { ...record.taskSnapshot, accountId: row.account_id };
            record.contactSnapshot ??= contactSnapshot(account.settings);
            record.accountIdentityFingerprint ??= null;
            if (PENDING_ATTEMPT_STATUSES.has(record.status) && record.submitted !== true && !record.accountIdentityFingerprint) record.legacyIdentityUnverified = true;
          }
          update.run(JSON.stringify(record), row.id);
        }
      }
      if (first) this.db.prepare('INSERT OR IGNORE INTO account_record_clear_watermarks(account_id,kind,cutoff_rowid) SELECT ?,kind,cutoff_rowid FROM record_clear_watermarks').run(DEFAULT_ACCOUNT_ID);
    });
    return this.getAccount(DEFAULT_ACCOUNT_ID);
  }

  #accountsReady() {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get()) throw new HttpError(409, '请先初始化多账号存储。');
  }
  listAccounts() {
    this.#accountsReady();
    return this.db.prepare('SELECT payload FROM accounts ORDER BY rowid').all().map(read).map(publicAccount);
  }
  getAccount(id) {
    this.#accountsReady();
    return read(this.db.prepare('SELECT payload FROM accounts WHERE id=?').get(id));
  }
  createAccount(input = {}) {
    this.#accountsReady();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['label', 'enabled', 'settings'].includes(key))) throw new HttpError(400, '账号参数无效。');
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw new HttpError(400, '账号名称须为 1—80 个字符的单行文字。');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, '账号启用状态须为布尔值。');
    const account = { id: identifier('account'), label, enabled: input.enabled ?? true, settings: validateAccountSettings(input.settings), identityFingerprint: null };
    this.db.prepare('INSERT INTO accounts(id,payload,identity_fingerprint) VALUES (?,?,NULL)').run(account.id, JSON.stringify(account));
    return account;
  }
  updateAccount(id, changes = {}) {
    const account = this.getAccount(id);
    if (!account) throw new HttpError(404, '找不到该账号。');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !['label', 'enabled', 'settings'].includes(key))) throw new HttpError(400, '账号参数无效。');
    let label = account.label;
    if (Object.hasOwn(changes, 'label')) {
      if (typeof changes.label !== 'string' || !(label = changes.label.trim()) || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw new HttpError(400, '账号名称须为 1—80 个字符的单行文字。');
    }
    if (changes.enabled !== undefined && typeof changes.enabled !== 'boolean') throw new HttpError(400, '账号启用状态须为布尔值。');
    const updated = { ...account, label, enabled: changes.enabled ?? account.enabled, settings: validateAccountSettings(changes.settings, account.settings) };
    this.db.prepare('UPDATE accounts SET payload=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }
  bindAccountIdentity(id, fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint.trim() || fingerprint.length > 256 || /\s/.test(fingerprint)) throw new HttpError(400, '账号身份核验值无效。');
    return this.transaction(() => {
      const account = this.getAccount(id);
      if (!account) throw new HttpError(404, '找不到该账号。');
      if (account.identityFingerprint && account.identityFingerprint !== fingerprint) throw new HttpError(409, '该账号已绑定另一身份，请使用独立账号配置。');
      if (this.db.prepare('SELECT id FROM accounts WHERE identity_fingerprint=? AND id<>?').get(fingerprint, id)) throw new HttpError(409, '该官网账号已经绑定其他账号配置。');
      const updated = { ...account, identityFingerprint: fingerprint };
      this.db.prepare('UPDATE accounts SET payload=?,identity_fingerprint=? WHERE id=?').run(JSON.stringify(updated), fingerprint, id);
      return updated;
    });
  }
  forAccount(id) {
    if (!this.getAccount(id)) throw new HttpError(404, '找不到该账号。');
    return new AccountStore(this, id);
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

class AccountStore {
  #root;
  #db;
  constructor(root, accountId) {
    this.#root = root;
    this.#db = root.db;
    Object.defineProperty(this, 'accountId', { value: accountId, enumerable: true });
  }
  #scope(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new HttpError(400, '记录格式无效。');
    if (record.accountId !== undefined && record.accountId !== this.accountId) throw new HttpError(409, '不能变更记录所属账号。');
    return { ...record, accountId: this.accountId };
  }
  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) throw new HttpError(404, '找不到该账号的任务。');
    return task;
  }
  #checkReference(table, id) {
    if (!id) return;
    const row = this.#db.prepare(`SELECT account_id FROM ${table} WHERE id=?`).get(id);
    if (row && row.account_id !== this.accountId) throw new HttpError(409, '记录引用不属于当前账号。');
  }
  getAccount() { return this.#root.getAccount(this.accountId); }
  transaction(fn) { return this.#root.transaction(fn); }
  close() {} // The application owns the shared SQLite connection.

  settings() {
    const global = this.#root.settings();
    const account = this.getAccount();
    return { ...global, ...account.settings, enginePaused: global.enginePaused === true || account.settings.enginePaused === true || !account.enabled };
  }
  saveSettings(changes) {
    const scoped = {}, global = {};
    for (const [key, value] of Object.entries(changes)) {
      if (ACCOUNT_SETTING_KEYS.includes(key)) scoped[key] = value;
      else if (key === 'webhookUrl') global[key] = value;
      else throw new HttpError(400, '包含不支持的账号设置。');
    }
    // Validate everything before either account or global settings are written.
    validateAccountSettings(scoped, this.getAccount().settings);
    if (Object.keys(scoped).length) this.#root.updateAccount(this.accountId, { settings: scoped });
    if (Object.keys(global).length) this.#root.saveSettings(global);
    return this.settings();
  }

  getTask(id) { return read(this.#db.prepare('SELECT payload FROM tasks WHERE id=? AND account_id=?').get(id, this.accountId)); }
  listTasks() { return this.#db.prepare('SELECT payload FROM tasks WHERE account_id=? ORDER BY updated_at DESC').all(this.accountId).map(read); }
  saveTask(task) {
    const scoped = this.#scope(task);
    this.#checkReference('tasks', scoped.id);
    this.#db.prepare('INSERT INTO tasks(id,payload,source,status,next_check_at,updated_at,account_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,source=excluded.source,status=excluded.status,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at WHERE tasks.account_id=excluded.account_id')
      .run(scoped.id, JSON.stringify(scoped), scoped.source, scoped.status, scoped.nextCheckAt, scoped.updatedAt, this.accountId);
    return scoped;
  }
  patchTask(id, changes, now = isoNow()) {
    const task = this.getTask(id);
    if (!task) return null;
    if (changes.id !== undefined && changes.id !== id) throw new HttpError(409, '不能变更任务编号。');
    return this.saveTask({ ...task, ...changes, updatedAt: now });
  }
  deleteTask(id) {
    if (!this.getTask(id)) return false;
    this.transaction(() => {
      this.#db.prepare('DELETE FROM slots WHERE task_id=? AND account_id=?').run(id, this.accountId);
      this.#db.prepare('DELETE FROM tasks WHERE id=? AND account_id=?').run(id, this.accountId);
    });
    return true;
  }

  addEvent(input) {
    const scoped = this.#scope(input);
    this.#checkReference('tasks', scoped.taskId);
    this.#checkReference('attempts', scoped.bookingId);
    const { taskId = null, source = 'live', type = 'info', level = 'info', message, slot = null, ...rest } = scoped;
    const event = { id: identifier('event'), taskId, source, type, level, message, slot, ...rest, createdAt: rest.createdAt || isoNow() };
    this.#db.prepare('INSERT INTO events(id,payload,created_at,account_id) VALUES (?,?,?,?)').run(event.id, JSON.stringify(event), event.createdAt, this.accountId);
    return event;
  }
  listEvents(limit = 120) {
    return this.#db.prepare("SELECT payload FROM events WHERE account_id=? AND rowid>COALESCE((SELECT cutoff_rowid FROM account_record_clear_watermarks WHERE account_id=? AND kind='events'),0) ORDER BY created_at DESC,rowid DESC LIMIT ?").all(this.accountId, this.accountId, limit).map(read);
  }
  eventsForBooking(bookingId) { return this.#db.prepare("SELECT payload FROM events WHERE account_id=? AND json_extract(payload,'$.bookingId')=? ORDER BY created_at,rowid").all(this.accountId, bookingId).map(read); }
  clearRecords(kind) {
    if (!['events', 'notifications', 'bookings', 'all'].includes(kind)) throw new TypeError('无效的记录类型。');
    return this.transaction(() => {
      const cleared = { events: 0, notifications: 0, bookings: 0 };
      for (const table of ['events', 'notifications']) {
        if (kind !== 'all' && kind !== table) continue;
        const previous = this.#db.prepare('SELECT cutoff_rowid FROM account_record_clear_watermarks WHERE account_id=? AND kind=?').get(this.accountId, table)?.cutoff_rowid || 0;
        cleared[table] = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account_id=? AND rowid>?`).get(this.accountId, previous).count;
        const cutoff = this.#db.prepare(`SELECT COALESCE(MAX(rowid),0) AS cutoff FROM ${table} WHERE account_id=?`).get(this.accountId).cutoff;
        this.#db.prepare('INSERT INTO account_record_clear_watermarks(account_id,kind,cutoff_rowid) VALUES (?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET cutoff_rowid=excluded.cutoff_rowid').run(this.accountId, table, cutoff);
      }
      if (kind === 'all' || kind === 'bookings') cleared.bookings = this.#db.prepare("INSERT OR IGNORE INTO hidden_bookings(attempt_id) SELECT id FROM attempts WHERE account_id=? AND status IN ('confirmed','rejected')").run(this.accountId).changes;
      return cleared;
    });
  }

  recordSlots(taskId, slots, { observedDates = null } = {}) {
    this.#requireTask(taskId);
    const old = this.#db.prepare('SELECT slot_key,present,generation FROM slots WHERE task_id=? AND account_id=?').all(taskId, this.accountId);
    const oldMap = new Map(old.map(row => [row.slot_key, row]));
    if (observedDates === null) this.#db.prepare('UPDATE slots SET present=0 WHERE task_id=? AND account_id=?').run(taskId, this.accountId);
    else {
      const reset = this.#db.prepare('UPDATE slots SET present=0 WHERE task_id=? AND account_id=? AND slot_key=?');
      for (const previous of old) if (observedDates.includes(JSON.parse(previous.slot_key)[0])) reset.run(taskId, this.accountId, previous.slot_key);
    }
    const statement = this.#db.prepare('INSERT INTO slots(task_id,slot_key,present,generation,account_id) VALUES (?,?,1,?,?) ON CONFLICT(task_id,slot_key) DO UPDATE SET present=1,generation=excluded.generation WHERE slots.account_id=excluded.account_id');
    const fresh = [];
    for (const slot of slots) {
      const key = slotKey(slot), previous = oldMap.get(key);
      const generation = (previous?.generation || 0) + (previous?.present ? 0 : 1);
      statement.run(taskId, key, generation, this.accountId);
      if (!previous?.present) fresh.push({ slot, generation, eventKey: `${taskId}:${key}:${generation}` });
    }
    return fresh;
  }

  addNotification(event, channel = 'in_app', now = isoNow()) {
    this.#scope(event);
    const existing = read(this.#db.prepare('SELECT payload FROM events WHERE id=? AND account_id=?').get(event.id, this.accountId));
    if (!existing) throw new HttpError(404, '找不到该账号的通知事件。');
    const notification = { id: identifier('notice'), accountId: this.accountId, eventId: existing.id, eventType: existing.type, taskId: existing.taskId, source: existing.source,
      channel, status: channel === 'in_app' ? 'visible' : 'queued', attempts: 0, message: existing.message, slot: existing.slot, restaurantUrl: existing.restaurantUrl || null,
      nextAttemptAt: channel === 'in_app' ? null : now, createdAt: now, updatedAt: now, lastError: null, acceptedAt: null };
    this.#db.prepare('INSERT OR IGNORE INTO notifications(id,event_id,channel,payload,status,next_attempt_at,created_at,account_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(notification.id, notification.eventId, channel, JSON.stringify(notification), notification.status, notification.nextAttemptAt, notification.createdAt, this.accountId);
    return notification;
  }
  saveNotification(notification) {
    const scoped = this.#scope(notification);
    const existing = read(this.#db.prepare('SELECT payload FROM notifications WHERE id=? AND account_id=?').get(scoped.id, this.accountId));
    if (!existing) throw new HttpError(404, '找不到该账号的通知。');
    if (scoped.eventId !== existing.eventId || scoped.channel !== existing.channel || scoped.taskId !== existing.taskId || scoped.source !== existing.source) throw new HttpError(409, '不能变更通知归属。');
    this.#db.prepare('UPDATE notifications SET payload=?,status=?,next_attempt_at=? WHERE id=? AND account_id=?').run(JSON.stringify(scoped), scoped.status, scoped.nextAttemptAt, scoped.id, this.accountId);
    return scoped;
  }
  listNotifications(limit = 120) {
    return this.#db.prepare("SELECT payload FROM notifications WHERE account_id=? AND rowid>COALESCE((SELECT cutoff_rowid FROM account_record_clear_watermarks WHERE account_id=? AND kind='notifications'),0) ORDER BY created_at DESC,rowid DESC LIMIT ?").all(this.accountId, this.accountId, limit).map(read);
  }
  nextNotification(now = isoNow()) { return read(this.#db.prepare("SELECT payload FROM notifications WHERE account_id=? AND status='queued' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 1").get(this.accountId, now)); }

  addAttempt(task, slot, status = 'submitting', message = '正在提交；结果确认前不会重复提交。', now = isoNow()) {
    this.#scope(task);
    const current = this.#requireTask(task.id), account = this.getAccount();
    const attempt = { id: identifier('booking'), accountId: this.accountId, taskId: current.id, source: current.source,
      restaurantName: current.restaurantName, restaurantUrl: current.restaurantUrl, groupId: current.groupId, slot,
      status, message, reservationId: null, phase: status, submitted: false, nextVerificationAt: null, verificationCount: 0, verificationFailureCount: 0,
      lastVerifiedAt: null, lastVerificationMessage: null, createdAt: now, updatedAt: now, taskSnapshot: structuredClone(current),
      contactSnapshot: contactSnapshot(account.settings), accountIdentityFingerprint: account.identityFingerprint || null };
    this.#db.prepare('INSERT INTO attempts(id,task_id,payload,status,created_at,account_id) VALUES (?,?,?,?,?,?)').run(attempt.id, current.id, JSON.stringify(attempt), status, now, this.accountId);
    return attempt;
  }
  getAttempt(id) { return read(this.#db.prepare('SELECT payload FROM attempts WHERE id=? AND account_id=?').get(id, this.accountId)); }
  saveAttempt(attempt) {
    const scoped = this.#scope(attempt), existing = this.getAttempt(scoped.id);
    if (!existing) throw new HttpError(404, '找不到该账号的预约尝试。');
    if (scoped.taskId !== existing.taskId || scoped.source !== existing.source
      || JSON.stringify(scoped.contactSnapshot) !== JSON.stringify(existing.contactSnapshot)
      || scoped.accountIdentityFingerprint !== existing.accountIdentityFingerprint
      || scoped.legacyIdentityUnverified !== existing.legacyIdentityUnverified
      || (scoped.taskSnapshot?.accountId !== undefined && scoped.taskSnapshot.accountId !== this.accountId)
      || (scoped.taskSnapshot?.id !== undefined && scoped.taskSnapshot.id !== existing.taskId)) throw new HttpError(409, '不能变更预约归属、联系人快照或账号身份。');
    const saved = { ...scoped, taskSnapshot: existing.taskSnapshot, contactSnapshot: existing.contactSnapshot, accountIdentityFingerprint: existing.accountIdentityFingerprint };
    this.#db.prepare('UPDATE attempts SET payload=?,status=? WHERE id=? AND account_id=?').run(JSON.stringify(saved), saved.status, saved.id, this.accountId);
    return saved;
  }
  listAttempts(limit = 120) { return this.#db.prepare('SELECT payload FROM attempts WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(this.accountId, limit).map(read); }
  listVisibleAttempts(limit = 120) { return this.#db.prepare("SELECT payload FROM attempts WHERE account_id=? AND (status NOT IN ('confirmed','rejected') OR id NOT IN (SELECT attempt_id FROM hidden_bookings)) ORDER BY created_at DESC,rowid DESC LIMIT ?").all(this.accountId, limit).map(read); }
  listPendingAttempts() { return this.#db.prepare("SELECT payload FROM attempts WHERE account_id=? AND status IN ('submitting','outcome_unknown','user_action_required','pending_restaurant') ORDER BY created_at,rowid").all(this.accountId).map(read); }
  attemptsForTask(taskId) { return this.#db.prepare('SELECT payload FROM attempts WHERE task_id=? AND account_id=? ORDER BY created_at DESC,rowid DESC').all(taskId, this.accountId).map(read); }
  hasUncertainLiveAttempt() {
    return this.#db.prepare("SELECT payload FROM attempts WHERE account_id=? AND status IN ('submitting','outcome_unknown','user_action_required')").all(this.accountId).map(read)
      .some(attempt => attempt.source === 'live' && (['submitting', 'outcome_unknown'].includes(attempt.status) || (attempt.submitted === true && !attempt.reservationId)));
  }
  recover(now = isoNow()) {
    const submitting = this.#db.prepare("SELECT payload FROM attempts WHERE account_id=? AND status='submitting'").all(this.accountId).map(read);
    this.transaction(() => {
      for (const attempt of submitting) {
        this.saveAttempt({ ...attempt, status: 'outcome_unknown', phase: 'outcome_unknown', nextVerificationAt: null, message: '程序在提交期间停止。请先核验已有预约，系统不会自动重试提交。', updatedAt: now });
        if (this.getTask(attempt.taskId)) this.patchTask(attempt.taskId, { status: 'user_action_required', nextCheckAt: null, lastMessage: '上次提交结果不明，请核验预约结果。' }, now);
        this.addEvent({ taskId: attempt.taskId, source: attempt.source, type: 'recovery', level: 'warning', message: '恢复了一条结果不明的提交；新预订已阻止，等待核验。', createdAt: now });
      }
    });
    return submitting.length;
  }
  stats() {
    const tasks = this.listTasks(), bookings = this.listAttempts(10000);
    return {
      totalTasks: tasks.filter(task => task.source === 'live').length,
      activeTasks: tasks.filter(task => task.source === 'live' && ['active', 'backoff'].includes(task.status)).length,
      availableEvents: this.#db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE account_id=? AND rowid>COALESCE((SELECT cutoff_rowid FROM account_record_clear_watermarks WHERE account_id=? AND kind='notifications'),0) AND channel='in_app' AND json_extract(payload,'$.source')='live' AND json_extract(payload,'$.eventType')='slot_available'").get(this.accountId, this.accountId).count,
      confirmedBookings: bookings.filter(booking => booking.source === 'live' && booking.status === 'confirmed').length,
      pendingRestaurantBookings: bookings.filter(booking => booking.source === 'live' && booking.status === 'pending_restaurant').length,
      demoBookings: bookings.filter(booking => booking.source === 'demo' && booking.status === 'confirmed').length,
      totalChecks: tasks.filter(task => task.source === 'live').reduce((sum, task) => sum + task.checkCount, 0),
      pendingNotifications: this.#db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE account_id=? AND status='queued'").get(this.accountId).count,
    };
  }
}
