import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOfficialAvailability, officialAvailabilityShop } from '../server/availability.mjs';

const date = '2026-12-24';
const shopRef = 'fixture-shop-reference';
const task = { dates: [date], partySize: 2, timeStart: '14:00', timeEnd: '15:00', timeSlots: ['14:00', '14:30', '15:00'] };
const row = extra => ({ isAvailable: true, date: '20261224', time: '1400', personCount: 2, shopRef, ...extra });
const result = (rows, state = 'OK') => ({ timeSlotState: state, timeSlotList: rows });
const normalize = value => normalizeOfficialAvailability(value, task, date, shopRef);

test('normal official shop detail binds the current alias to only its declared reference', () => {
  const alias = 'fixture_alias';
  const json = { alias, shopRef, shopName: 'Fixture', irrelevant: 'not exported' };
  for (const query of [`shopRefOrAlias=${alias}`, `localeCode=zh-CN&shopRefOrAlias=${alias}`, `shopRef=${shopRef}&localeCode=en-US`]) {
    assert.deepEqual(officialAvailabilityShop(`https://api.catchtable.net/api/v5/shop/detail?${query}`, json, alias), { alias, shopRef });
  }
  assert.equal(officialAvailabilityShop(`https://api.catchtable.net/api/v5/shop/detail?shopRefOrAlias=${alias}`, { ...json, alias: 'other' }, alias), null);
  assert.equal(officialAvailabilityShop(`https://api.catchtable.net/api/v5/shop/detail?shopRef=${shopRef}`, { ...json, shopRef: 'other' }, alias), null);
});

test('shop identity binding rejects nonexact endpoints, ambiguous queries and malformed identities', () => {
  const alias = 'fixture_alias';
  const json = { alias, shopRef };
  const base = 'https://api.catchtable.net/api/v5/shop/detail';
  const valid = `${base}?shopRefOrAlias=${alias}`;
  for (const value of [
    valid.replace('https:', 'http:'), valid.replace('api.catchtable.net', 'www.catchtable.net'), valid.replace('api.catchtable.net', 'api.catchtable.net.evil.example'),
    valid.replace('api.catchtable.net', 'user@api.catchtable.net'), valid.replace('api.catchtable.net', 'api.catchtable.net:443'),
    valid.replace('/detail?', '/detail/extra?'), `${valid}#fragment`, `${valid}#`, `${valid}&shopRefOrAlias=${alias}`, `${valid}&localeCode=zh-CN&localeCode=en-US`,
    `${valid}&shopRef=${shopRef}`, `${valid}&unrecognized=value`, `${base}?shopRefOrAlias=other`, `${base}?shopRef=other`, base,
    `${valid}&localeCode=`, `${valid}&localeCode=bad%20locale`,
  ]) assert.equal(officialAvailabilityShop(value, json, alias), null, value);
  for (const body of [null, [], {}, { alias, shopRef: '' }, { alias, shopRef: 123 }, { alias, shopRef: 'bad reference' }, { alias, shopRef: 'x'.repeat(129) }]) assert.equal(officialAvailabilityShop(valid, body, alias), null);
  for (const value of [undefined, null, '', 'bad/alias', 'x'.repeat(129)]) assert.equal(officialAvailabilityShop(valid, json, value), null);
});

test('normal official availability maps only available rows into canonical selected slots', () => {
  assert.deepEqual(normalize(result([row(), row({ time: '1430' }), row({ time: '15:00', tableType: 'R' }), row({ time: '1330' }), row({ time: '1400', isAvailable: false }), row()])), {
    status: 'available', slots: [
      { date, time: '14:00', partySize: 2 },
      { date, time: '14:30', partySize: 2 },
      { date, time: '15:00', partySize: 2, seatType: 'R' },
    ], message: '官网接口发现符合条件的空位。',
  });
});

test('official responses support strict ISO, compact full dates and requested short-date rows', () => {
  for (const value of ['2026-12-24', '20261224', '261224']) assert.equal(normalize(result([row({ date: value })])).status, 'available');
  for (const value of ['2026-02-30', '20260230', '261225', '19261224', '2026/12/24', '2026-12-24T00:00:00Z', 20261224]) assert.equal(normalize(result([row({ date: value })])).status, 'unknown');
});

test('disjoint half-hour tasks reject intervening API times while legacy minute ranges remain exact', () => {
  const disjoint = { ...task, timeSlots: ['14:00', '15:00'] };
  assert.equal(normalizeOfficialAvailability(result([row({ time: '1430' })]), disjoint, date, shopRef).status, 'unavailable');
  assert.equal(normalizeOfficialAvailability(result([row({ time: '1415' })]), disjoint, date, shopRef).status, 'unavailable');
  const { timeSlots, ...legacy } = { ...task, timeStart: '14:15', timeEnd: '14:15' };
  assert.deepEqual(normalizeOfficialAvailability(result([row({ time: '1415' }), row()]), legacy, date, shopRef).slots, [{ date, time: '14:15', partySize: 2 }]);
});

test('only explicit known states establish unavailability and inconsistent availability stays unknown', () => {
  for (const state of ['OK', 'ONLINE_DISABLED', 'PERIOD_EXCEEDED', 'DEADLINE_EXCEEDED', 'PAST_DATE', 'CLOSED_DAY', 'NOT_OPENED_YET', 'EMPTY_TIMESLOT_LIST', 'FULLY_BOOKED', 'PERSON_COUNT_OUT_OF_RANGE']) {
    assert.equal(normalize(result([], state)).status, 'unavailable');
    assert.equal(normalize(result([row({ isAvailable: false })], state)).status, 'unavailable');
    if (state !== 'OK') assert.equal(normalize(result([row()], state)).status, 'unknown');
  }
  for (const state of ['', null, false, 'SOMETHING_NEW', 'ok', { value: 'OK' }]) assert.equal(normalize(result([], state)).status, 'unknown');
});

test('foreign, missing or malformed rows never masquerade as a sold-out observation', () => {
  const invalid = [null, [], {}, row({ shopRef: 'another-shop' }), row({ personCount: 3 }), row({ personCount: '2' }), row({ date: '20261225' }), row({ isAvailable: 'false' }), row({ isAvailable: 1 }), row({ isAvailable: undefined }), row({ time: '2400' }), row({ time: '14:60' }), row({ time: 1400 }), row({ time: '2:00' })];
  for (const entry of invalid) {
    assert.equal(normalize(result([entry])).status, 'unknown');
    assert.equal(normalize(result([row(), entry])).status, 'unknown');
    assert.equal(normalize(result([entry], 'FULLY_BOOKED')).status, 'unknown');
  }
});

test('unsupported envelopes and invalid request context cannot generate empty inventory evidence', () => {
  for (const value of [undefined, null, [], {}, { timeSlotState: 'OK' }, { timeSlotState: 'OK', timeSlotList: null }, { data: result([]) }]) assert.equal(normalize(value).status, 'unknown');
  for (const invalidTask of [undefined, {}, { ...task, partySize: '2' }, { ...task, dates: ['2026-12-25'] }, { ...task, timeSlots: [] }, { ...task, timeSlots: ['14:15'] }]) {
    assert.equal(normalizeOfficialAvailability(result([]), invalidTask, date, shopRef).status, 'unknown');
  }
  assert.equal(normalizeOfficialAvailability(result([]), task, '2026-02-30', shopRef).status, 'unknown');
  assert.equal(normalizeOfficialAvailability(result([]), task, date, '').status, 'unknown');
});
