import { matchingSlots, taskTimeSlots, validDate } from './domain.mjs';

const UNAVAILABLE_MESSAGES = new Map([
  ['ONLINE_DISABLED', '该餐厅暂不支持在线预约。'],
  ['PERIOD_EXCEEDED', '所选日期超出可预约范围。'],
  ['DEADLINE_EXCEEDED', '所选日期已超过预约截止时间。'],
  ['PAST_DATE', '所选日期已过。'],
  ['CLOSED_DAY', '餐厅在所选日期不营业。'],
  ['NOT_OPENED_YET', '餐厅尚未开放所选日期的预约。'],
  ['EMPTY_TIMESLOT_LIST', '所选日期暂无可预约时段。'],
  ['FULLY_BOOKED', '所选日期暂无空位。'],
  ['PERSON_COUNT_OUT_OF_RANGE', '用餐人数超出餐厅可预约范围。'],
]);
const unknown = () => ({ status: 'unknown', slots: [], message: '暂时无法确认官网空位数据。' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SHOP_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

export function officialAvailabilityShop(value, json, alias) {
  if (typeof value !== 'string' || !value.startsWith('https://api.catchtable.net/') || value.includes('#')
    || typeof alias !== 'string' || !SHOP_IDENTIFIER.test(alias) || !object(json) || json.alias !== alias
    || typeof json.shopRef !== 'string' || !SHOP_IDENTIFIER.test(json.shopRef)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://api.catchtable.net' || url.username || url.password || url.port || url.hash
      || url.pathname !== '/api/v5/shop/detail') return null;
    for (const key of url.searchParams.keys()) {
      if (!['localeCode', 'shopRefOrAlias', 'shopRef'].includes(key) || url.searchParams.getAll(key).length !== 1) return null;
    }
    const locale = url.searchParams.get('localeCode');
    if (locale !== null && !/^[A-Za-z0-9_-]{1,20}$/.test(locale)) return null;
    const byAlias = url.searchParams.get('shopRefOrAlias');
    const byReference = url.searchParams.get('shopRef');
    if (byAlias !== null ? byReference !== null || byAlias !== alias : byReference !== json.shopRef) return null;
    return { alias, shopRef: json.shopRef };
  } catch { return null; }
}

function responseDate(value, expected) {
  if (typeof value !== 'string') return null;
  let date = value;
  if (/^\d{8}$/.test(value)) date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  // The normal site renders YYMMDD rows. Resolve their century only against
  // the explicitly requested full date, never against the current clock.
  else if (/^\d{6}$/.test(value)) date = value === expected.replaceAll('-', '').slice(2) ? expected : '';
  return validDate(date) ? date : null;
}

function responseTime(value) {
  if (typeof value !== 'string') return null;
  const time = /^\d{4}$/.test(value) ? `${value.slice(0, 2)}:${value.slice(2)}` : value;
  return TIME_PATTERN.test(time) ? time : null;
}

export function normalizeOfficialAvailability(result, task, date, shopRef) {
  if (!object(result) || !object(task) || !validDate(date) || !Array.isArray(task.dates) || !task.dates.includes(date)
    || !Number.isInteger(task.partySize) || task.partySize < 1 || typeof shopRef !== 'string' || !shopRef
    || !Array.isArray(result.timeSlotList)
    || (result.timeSlotState !== 'OK' && !UNAVAILABLE_MESSAGES.has(result.timeSlotState))) return unknown();
  const selected = taskTimeSlots(task);
  if (selected !== null ? selected.length === 0 : !TIME_PATTERN.test(task.timeStart) || !TIME_PATTERN.test(task.timeEnd) || task.timeStart > task.timeEnd) return unknown();
  const candidates = [];
  for (const row of result.timeSlotList) {
    if (!object(row) || typeof row.isAvailable !== 'boolean' || row.shopRef !== shopRef
      || responseDate(row.date, date) !== date || row.personCount !== task.partySize) return unknown();
    const time = responseTime(row.time);
    if (!time) return unknown();
    if (row.isAvailable) {
      if (result.timeSlotState !== 'OK') return unknown();
      candidates.push({ date, time, partySize: row.personCount, ...(typeof row.tableType === 'string' && row.tableType ? { seatType: row.tableType } : {}) });
    }
  }
  const slots = matchingSlots(task, candidates);
  return slots.length ? { status: 'available', slots, message: '官网接口发现符合条件的空位。' }
    : { status: 'unavailable', slots: [], message: UNAVAILABLE_MESSAGES.get(result.timeSlotState) || '所选时间暂无符合条件的空位。' };
}
