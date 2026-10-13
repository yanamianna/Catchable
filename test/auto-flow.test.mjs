import test from 'node:test';
import assert from 'node:assert/strict';
import { CatchtableAdapter, formConditionsVerified, parseOfficialBookingRecord } from '../server/catchtable.mjs';

const task = { id: 'fixture-task', restaurantName: 'Fixture Restaurant', restaurantUrl: 'https://www.catchtable.net/shop/fixture', dates: ['2026-10-13'], partySize: 2, timeStart: '13:00', timeEnd: '13:00', mode: 'auto', autoConsent: true };
const slot = { date: '2026-10-13', time: '13:00', partySize: 2 };
const form = (changes = {}) => ({ url: 'https://www.catchtable.net/zh-CN/reservation/form', headings: ['Fixture Restaurant'], summaries: ['10.13 (Tue) · 13:00 · 2人'], ...changes });
const record = (changes = {}) => ({ url: 'https://www.catchtable.net/zh-CN/customer/reservation/detail/FIXTURE-ORDER', text: 'Fixture Restaurant\nDate: 2026-10-13\nTime: 13:00\nParty size: 2 people\nConfirmed', statusLabels: ['Confirmed'], loading: false, captcha: false, ...changes });

test('shortened official form date requires verified calendar selection from the same flow', () => {
  assert.equal(formConditionsVerified(form(), task, slot, false), false);
  assert.equal(formConditionsVerified(form(), task, slot, true), true);
  assert.equal(formConditionsVerified(form({ summaries: ['2026-10-13 · 13:00 · 2人'] }), task, slot, false), true);
  for (const changes of [
    { summaries: ['11.13 (Tue) · 13:00 · 2人'] },
    { summaries: ['10.14 (Wed) · 13:00 · 2人'] },
    { summaries: ['10.13 (Tue) · 14:00 · 2人'] },
    { summaries: ['10.13 (Tue) · 13:00 · 3人'] },
    { headings: ['Other Restaurant'] },
    { summaries: ['10.13 (Tue) · 13:00 · 2人', '10.14 (Wed) · 13:00 · 2人'] },
    { url: 'https://evil.example/reservation/form' },
  ]) assert.equal(formConditionsVerified(form(changes), task, slot, true), false, JSON.stringify(changes));
});

test('official order requires a full date and matching restaurant, time and party size', () => {
  assert.equal(parseOfficialBookingRecord(record(), task, slot).status, 'confirmed');
  for (const changes of [
    { text: 'Fixture Restaurant\nDate: 10.13\nTime: 13:00\nParty size: 2 people\nConfirmed' },
    { text: 'Other Restaurant\nDate: 2026-10-13\nTime: 13:00\nParty size: 2 people\nConfirmed' },
    { text: 'Fixture Restaurant\nDate: 2026-10-14\nTime: 13:00\nParty size: 2 people\nConfirmed' },
    { text: 'Fixture Restaurant\nDate: 2026-10-13\nTime: 14:00\nParty size: 2 people\nConfirmed' },
    { text: 'Fixture Restaurant\nDate: 2026-10-13\nTime: 13:00\nParty size: 3 people\nConfirmed' },
    { loading: true }, { captcha: true },
  ]) assert.equal(parseOfficialBookingRecord(record(changes), task, slot), null, JSON.stringify(changes));
});

test('informational form samples cannot become order receipts', () => {
  const sample = record({ url: form().url, text: '需要确认\nFixture Restaurant\n示例 Date: 2026-10-13\nTime: 13:00\nParty size: 2 people\nConfirmed' });
  assert.equal(parseOfficialBookingRecord(sample, task, slot), null);
  assert.equal(parseOfficialBookingRecord(record({ url: 'https://evil.example/customer/reservation/detail/FIXTURE-ORDER' }), task, slot), null);
});

test('matching order detail keeps pending separate and cancellation takes priority', () => {
  const pending = parseOfficialBookingRecord(record({ statusLabels: ['Checking', 'Confirmed'] }), task, slot);
  assert.equal(pending.status, 'pending_restaurant');
  assert.equal(pending.reservationId, 'FIXTURE-ORDER');
  assert.equal(pending.submitted, true);
  assert.equal(parseOfficialBookingRecord(record({ statusLabels: ['Booking canceled', 'Confirmed'] }), task, slot).status, 'rejected');
});

test('submitted, unknown and identified original attempts only reconcile without preparing a new attempt', async () => {
  const adapter = new CatchtableAdapter();
  adapter.context = {};
  let reconciled = 0;
  let beforeSubmission = 0;
  adapter.reconcile = async attempt => { reconciled += 1; return { status: 'outcome_unknown', reservationId: attempt.reservationId }; };
  adapter.prepare = async () => { throw new Error('a new preparation must not occur'); };
  const attempts = [
    { status: 'user_action_required', phase: 'before_submit', submitted: true },
    { status: 'outcome_unknown', phase: 'before_submit', submitted: false },
    { status: 'pending_restaurant', phase: 'awaiting_restaurant', submitted: false, reservationId: 'FIXTURE-ORDER' },
    { status: 'user_action_required', phase: 'submitted', submitted: false },
  ];
  for (const attempt of attempts) {
    const result = await adapter.continueAttempt({ id: 'fixture-attempt', taskSnapshot: task, slot, ...attempt }, { onBeforeSubmit: async () => { beforeSubmission += 1; } });
    assert.equal(result.status, 'outcome_unknown');
  }
  assert.equal(reconciled, attempts.length);
  assert.equal(beforeSubmission, 0);
});
