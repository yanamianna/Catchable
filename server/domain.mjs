import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const isoNow = () => new Date().toISOString();
export const identifier = (prefix) => `${prefix}_${randomUUID()}`;
export const TASK_LIMIT = 5;
export const TERMINAL_TASK_STATUSES = new Set(['confirmed', 'expired']);
export const ACTIVE_TASK_STATUSES = new Set(['active', 'backoff']);
export const PENDING_ATTEMPT_STATUSES = new Set(['submitting', 'outcome_unknown', 'user_action_required', 'pending_restaurant']);
export const VERIFIABLE_ATTEMPT_STATUSES = new Set(['outcome_unknown', 'user_action_required', 'pending_restaurant']);
export const BOOKING_CONTACT_DEFAULTS = Object.freeze({bookingPhoneCountryCode:'',bookingPhoneNumber:'',bookingPhoneAutoFill:false});

export function validateBookingContactSettings(input,current={}) {
  const settings={...BOOKING_CONTACT_DEFAULTS,...current,...input};
  const countryCode=settings.bookingPhoneCountryCode;
  const phoneNumber=settings.bookingPhoneNumber;
  const autoFill=settings.bookingPhoneAutoFill;
  if(typeof countryCode!=='string' || (countryCode!=='' && !/^\+[1-9]\d{0,2}$/.test(countryCode)))throw new HttpError(400,'预约电话国码须为 + 与 1—3 位数字，例如 +82。');
  if(typeof phoneNumber!=='string' || (phoneNumber!=='' && !/^\d{4,20}$/.test(phoneNumber)))throw new HttpError(400,'预约电话号码须保持字符串，并包含 4—20 位 ASCII 数字。');
  if(Boolean(countryCode)!==Boolean(phoneNumber))throw new HttpError(400,'预约电话国码与号码须成对填写，或同时留空。');
  if(typeof autoFill!=='boolean')throw new HttpError(400,'预约电话自动填写授权须为布尔值。');
  if(autoFill && (!countryCode || !phoneNumber))throw new HttpError(400,'开启自动填写前须填写有效的预约电话国码和号码。');
  return {bookingPhoneCountryCode:countryCode,bookingPhoneNumber:phoneNumber,bookingPhoneAutoFill:autoFill};
}

export function restaurantUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, '请输入有效的 Catchtable 餐厅网址。'); }
  if (url.protocol !== 'https:' || !['catchtable.net', 'www.catchtable.net'].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash
    || !/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?shop\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new HttpError(400, '仅支持 https://www.catchtable.net/shop/餐厅标识（可带语言路径），不接受其他域名或查询参数。');
  }
  return url.href.replace(/\/$/, '');
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function localDate(now = Date.now(), timezone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeDeadline(value, dates) {
  if (!value) return new Date(`${dates.at(-1)}T23:59:59+09:00`).toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDate(value.slice(0, 10)) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, '截止时间须包含时区，例如 2026-10-24T22:00:00+09:00。');
  }
  return new Date(value).toISOString();
}

export function intervalMs(value = 1000) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3600000) throw new HttpError(400, '检查间隔须为 1—3600000 毫秒的整数。');
  return value;
}

export function resolvePollInterval(input, defaultMs = 1000) {
  const milliseconds = Object.hasOwn(input, 'pollIntervalMs');
  const seconds = Object.hasOwn(input, 'pollIntervalSeconds');
  if (milliseconds && seconds) throw new HttpError(400, '请仅提供 pollIntervalMs；不能同时提供毫秒和旧秒频率字段。');
  if (milliseconds) return intervalMs(input.pollIntervalMs);
  if (seconds) {
    if (typeof input.pollIntervalSeconds !== 'number' || !Number.isFinite(input.pollIntervalSeconds)) throw new HttpError(400, '旧秒频率须为数字，转换后须为有效整数毫秒。');
    return intervalMs(input.pollIntervalSeconds * 1000);
  }
  return intervalMs(defaultMs);
}

export function migrateStoredInterval(record) {
  const { pollIntervalSeconds, ...canonical } = record;
  if (Object.hasOwn(record, 'pollIntervalMs')) {
    canonical.pollIntervalMs = intervalMs(record.pollIntervalMs);
    return canonical;
  }
  let legacyMs = 1000;
  if (pollIntervalSeconds !== undefined) {
    try { legacyMs = resolvePollInterval({ pollIntervalSeconds }); } catch { legacyMs = 1000; }
  }
  canonical.pollIntervalMs = Math.min(legacyMs, 1000);
  return canonical;
}

export function createTask(input, defaults = {}, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '任务格式不正确。');
  const name = String(input.restaurantName || '').trim();
  if (!name || name.length > 100) throw new HttpError(400, '餐厅名称须为 1—100 个字符。');
  if (!Array.isArray(input.dates) || input.dates.length < 1 || input.dates.length > 14 || input.dates.some((date) => !validDate(date))) throw new HttpError(400, '请提供 1—14 个有效预约日期。');
  const dates = [...new Set(input.dates)].sort();
  if (dates.some((date) => date < localDate(now))) throw new HttpError(400, '预约日期不能早于韩国当地今天。');
  const partySize = Number(input.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 12) throw new HttpError(400, '预约人数须为 1—12 人。');
  const timeStart = input.timeStart || '18:00';
  const timeEnd = input.timeEnd || '21:00';
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(timeStart) || !timePattern.test(timeEnd) || timeStart > timeEnd) throw new HttpError(400, '请选择有效的起止时间，结束时间不能早于开始时间。');
  const mode = input.mode || 'assist';
  if (!['notify', 'assist', 'auto'].includes(mode)) throw new HttpError(400, '预约模式须为 notify、assist 或 auto。');
  if (mode === 'auto' && input.autoConsent !== true) throw new HttpError(400, '自动模式须明确确认授权，设置 autoConsent:true。');
  const groupId = String(input.groupId || '').trim();
  if (groupId.length > 80) throw new HttpError(400, '互斥组名称最长为 80 个字符。');
  const deadline = normalizeDeadline(input.deadline, dates);
  if (Date.parse(deadline) <= now) throw new HttpError(400, '截止时间必须晚于当前时间。');
  const timestamp = new Date(now).toISOString();
  return {
    id: identifier('task'), restaurantName: name, restaurantUrl: restaurantUrl(input.restaurantUrl),
    dates, partySize, timeStart, timeEnd, mode, groupId, deadline, autoConsent: mode === 'auto',
    pollIntervalMs: resolvePollInterval(input, defaults.pollIntervalMs ?? (defaults.pollIntervalSeconds === undefined ? 1000 : migrateStoredInterval(defaults).pollIntervalMs)),
    source: 'live', status: 'paused', lastCheckedAt: null, nextCheckAt: null,
    lastCheckStartedAt: null, lastCheckDurationMs: null, effectiveIntervalMs: null,
    lastMessage: '任务已保存。点击启动后开始检查。', slots: [], checkCount: 0,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

export function matchingSlots(task, slots) {
  if (!Array.isArray(slots)) return [];
  const result = new Map();
  for (const slot of slots) {
    if (!slot || !task.dates.includes(slot.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time)
      || slot.time < task.timeStart || slot.time > task.timeEnd || slot.partySize !== task.partySize) continue;
    const safe = { date: slot.date, time: slot.time, partySize: slot.partySize };
    if (slot.seatType) safe.seatType = String(slot.seatType).slice(0, 120);
    if (slot.label) safe.label = String(slot.label).slice(0, 200);
    result.set(slotKey(safe), safe);
  }
  return [...result.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

export function slotKey(slot) {
  return JSON.stringify([slot.date, slot.time, slot.partySize, slot.seatType || '']);
}

export function safeMessage(error, fallback = '操作暂时未能完成，请查看运行记录。') {
  const message = typeof error === 'string' ? error : error?.message;
  return message ? String(message).replace(/https?:\/\/[^\s]+/g, '[网址]').slice(0, 500) : fallback;
}

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  return false;
}

export async function validateWebhookUrl(value, resolver = lookup) {
  if (!value) return { url: '', addresses: [] };
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, '通知地址须为有效 HTTPS 网址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.href.length > 2000) throw new HttpError(400, '通知地址须使用 HTTPS 默认端口，且不能包含账号密码或片段。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !hostname.includes('.')) throw new HttpError(400, '通知地址不能指向本机或内部网络。');
  let addresses;
  let deadline;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    resolver(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('DNS timeout')), 3000); }),
  ]); }
  catch { throw new HttpError(400, '无法解析通知地址，请确认网址。'); }
  finally { clearTimeout(deadline); }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new HttpError(400, '通知地址不能指向本机、内部网络或保留地址。');
  return { url: url.href, addresses };
}
