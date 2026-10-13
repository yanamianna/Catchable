import test from 'node:test';
import assert from 'node:assert/strict';
import { restaurantUrl } from '../server/domain.mjs';
import {
  automaticSubmissionAllowed,
  calendarLabelToDate,
  CatchtableAdapter,
  normalizeTime,
  parseAvailability,
  reservationMatches,
} from '../server/catchtable.mjs';

const task = {
  restaurantName: 'ZEST',
  restaurantUrl: 'https://www.catchtable.net/shop/zest',
  dates: ['2026-10-24', '2026-10-25'],
  partySize: 2,
  timeStart: '18:00',
  timeEnd: '21:00',
};

const snapshot = (changes = {}) => ({
  restaurantUrl: task.restaurantUrl,
  selectedDateLabel: 'October 24, 2026',
  selectedPartySize: 2,
  buttons: [{ text: '6:00 pm', disabled: false }],
  text: 'Select a time',
  loading: false,
  ...changes,
});

const slot = { date: '2026-10-24', time: '18:00', partySize: 2 };
const receipt = (changes = {}) => ({
  confirmed: true,
  reservationId: 'R-1234',
  restaurantUrl: task.restaurantUrl,
  date: slot.date,
  time: slot.time,
  partySize: slot.partySize,
  ...changes,
});

test('restaurant URL accepts only a canonical international restaurant route', () => {
  const cases = [
    ['https://www.catchtable.net/shop/zest', 'https://www.catchtable.net/shop/zest'],
    ['https://catchtable.net/shop/zest/', 'https://catchtable.net/shop/zest'],
    ['https://www.catchtable.net/en/shop/zest', 'https://www.catchtable.net/en/shop/zest'],
    ['https://www.catchtable.net/ko-KR/shop/restaurant_123', 'https://www.catchtable.net/ko-KR/shop/restaurant_123'],
  ];
  for (const [input, expected] of cases) assert.equal(restaurantUrl(input), expected, input);
});

test('restaurant URL rejects alternate origins and routes before browser navigation', () => {
  const rejected = [
    'http://www.catchtable.net/shop/zest',
    'https://www.catchtable.net.evil.example/shop/zest',
    'https://www.catchtable.net@evil.example/shop/zest',
    'https://user:password@www.catchtable.net/shop/zest',
    'https://app.catchtable.co.kr/shop/zest',
    'https://127.0.0.1/shop/zest',
    'https://[::1]/shop/zest',
    'https://www.catchtable.net:9443/shop/zest',
    'https://www.catchtable.net/shop/zest?redirect=https://evil.example',
    'https://www.catchtable.net/shop/zest#reservation',
    'https://www.catchtable.net/reservation/zest',
    'https://www.catchtable.net/shop/',
    'https://www.catchtable.net/shop/zest%2Fother',
    'https://www.catchtable.net/',
    '//www.catchtable.net/shop/zest',
    'file:///C:/Users/test.html',
    'javascript:alert(1)',
    'not a URL',
  ];
  for (const input of rejected) {
    assert.throws(() => restaurantUrl(input), (error) => error.status === 400, input);
  }
});

test('time parsing handles midnight, noon and English, Chinese and Korean meridiem', () => {
  const cases = [
    ['00:00', '00:00'], ['23:59', '23:59'], [' 18:30 ', '18:30'],
    ['12:00 AM', '00:00'], ['12:00 pm', '12:00'],
    ['6:30PM', '18:30'], ['06:30 am', '06:30'],
    ['上午 12:00', '00:00'], ['下午 12:00', '12:00'],
    ['下午6:30', '18:30'], ['6:30 下午', '18:30'],
    ['오전 12:00', '00:00'], ['오후 12:00', '12:00'],
    ['오후 6:30', '18:30'], ['6:30 오후', '18:30'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeTime(input), expected, input);
});

test('time parsing rejects ranges, labels and malformed clocks', () => {
  const rejected = [
    '', '24:00', '25:00', '18:60', '6:75 PM', '13:00 PM',
    '0:30 AM', '18:00 - 21:00', 'Opening hours 18:00',
    '下午 18:00', '오후 18:00', '18:00 AM', '18:00 remaining',
  ];
  for (const input of rejected) assert.equal(normalizeTime(input), null, input);
});

test('calendar dates preserve the explicit year and reject impossible dates', () => {
  const cases = [
    ['2026-10-24', '2026-10-24'],
    ['October 24, 2026', '2026-10-24'],
    ['2026年10月24日', '2026-10-24'],
    ['2026년 10월 24일', '2026-10-24'],
    ['February 29, 2028', '2028-02-29'],
  ];
  for (const [input, expected] of cases) assert.equal(calendarLabelToDate(input), expected, input);
  for (const input of ['', 'October 24', '2026-02-30', '2026年2月29日', '2026년 13월 1일']) {
    assert.equal(calendarLabelToDate(input), null, input);
  }
});

test('available slots are enabled time buttons tied to the selected date and party', () => {
  const result = parseAvailability(snapshot({ buttons: [
    { text: '6:00 pm', disabled: false },
    { text: '6:30 pm', disabled: true },
    { text: '2026年10月24日', disabled: false },
    { text: 'Opening hours 18:00 - 21:00', disabled: false },
  ] }), task);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.slots.map(({ date, time, partySize }) => ({ date, time, partySize })), [slot]);
});

test('date, party, restaurant and loading ambiguity never produce available slots', () => {
  const cases = [
    { selectedDateLabel: 'October 26, 2026' },
    { selectedDateLabel: '' },
    { selectedPartySize: 3 },
    { selectedPartySize: null },
    { restaurantUrl: 'https://www.catchtable.net/shop/other' },
    { restaurantUrl: 'https://evil.example/shop/zest' },
    { loading: true },
  ];
  for (const changes of cases) {
    const result = parseAvailability(snapshot(changes), task);
    assert.equal(result.status, 'unknown', JSON.stringify(changes));
    assert.deepEqual(result.slots, [], JSON.stringify(changes));
  }
});

test('an enabled calendar day or empty time list does not prove availability', () => {
  const dayOnly = parseAvailability(snapshot({ buttons: [{ text: '24', disabled: false }] }), task);
  assert.equal(dayOnly.status, 'unknown');
  assert.deepEqual(dayOnly.slots, []);
  const noTimes = parseAvailability(snapshot({ buttons: [] }), task);
  assert.equal(noTimes.status, 'unknown');
  assert.deepEqual(noTimes.slots, []);
});

test('explicit sold out is unavailable only after full date and party context validation', () => {
  const result = parseAvailability(snapshot({ buttons: [], text: 'Sold out' }), task);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.slots, []);
  const wrongDate = parseAvailability(snapshot({ buttons: [], text: 'Sold out', selectedDateLabel: 'October 26, 2026' }), task);
  assert.equal(wrongDate.status, 'unknown');
});

test('login pages are authentication failures rather than empty availability', () => {
  const result = parseAvailability(snapshot({
    selectedDateLabel: '', selectedPartySize: null, buttons: [],
    text: 'Sign in with Google. Continue with Apple. Enter your email to log in.',
  }), task);
  assert.equal(result.status, 'auth_required');
  assert.deepEqual(result.slots, []);
});

test('a booking receipt needs a confirmation, reservation number and all requested conditions', () => {
  assert.equal(reservationMatches(receipt(), task, slot), true);
  assert.equal(reservationMatches(receipt({ restaurantUrl: undefined, restaurantName: 'ZEST' }), task, slot), true);
  const rejected = [
    { confirmed: false }, { confirmed: 'true' },
    { reservationId: '' }, { reservationId: '   ' },
    { date: '2026-10-25' }, { time: '18:30' }, { partySize: 3 },
    { restaurantUrl: 'https://www.catchtable.net/shop/other' },
    { restaurantUrl: 'https://evil.example/shop/zest' },
    { restaurantUrl: undefined, restaurantName: undefined },
    { restaurantUrl: undefined, restaurantName: 'OTHER' },
    { date: undefined }, { time: undefined }, { partySize: undefined },
  ];
  for (const changes of rejected) {
    assert.equal(reservationMatches(receipt(changes), task, slot), false, JSON.stringify(changes));
  }
});

test('automatic submission requires specific authorization and verified free, fully understood conditions', () => {
  const autoTask = { mode: 'auto', autoConsent: true };
  const evidence = {
    freeExplicitlyVerified: true,
    requiresPayment: false,
    requiresConsent: false,
    requiresCaptcha: false,
    conditionsVerified: true,
  };
  assert.equal(automaticSubmissionAllowed(autoTask, evidence), true);
  for (const changes of [
    { freeExplicitlyVerified: false }, { freeExplicitlyVerified: undefined },
    { requiresPayment: true }, { requiresConsent: true }, { requiresCaptcha: true },
    { conditionsVerified: false }, { conditionsVerified: undefined },
  ]) {
    assert.equal(automaticSubmissionAllowed(autoTask, { ...evidence, ...changes }), false, JSON.stringify(changes));
  }
  for (const taskChanges of [{ mode: 'notify' }, { mode: 'assist' }, { autoConsent: false }, { autoConsent: undefined }]) {
    assert.equal(automaticSubmissionAllowed({ ...autoTask, ...taskChanges }, evidence), false, JSON.stringify(taskChanges));
  }
});

function receiptPage(text) {
  return {
    isClosed: () => false,
    locator: () => ({ all: async () => [{ isVisible: async () => true, innerText: async () => text }] }),
    goto: async () => {},
    waitForLoadState: async () => {},
    close: async () => {},
  };
}

function receiptText(restaurantName = 'ZEST', suffix = '') {
  return `${restaurantName}\nReservation confirmed\nReservation number: R-1234\nDate: 2026-10-24\nTime: 18:00\nParty size: 2\n${suffix}`;
}

test('reconcile uses the persisted task snapshot to inspect the original booking page', async () => {
  const savedTask = { ...task, id: 'task-original' };
  const attempt = { id: 'booking-original', taskId: savedTask.id, restaurantName: task.restaurantName,
    restaurantUrl: task.restaurantUrl, taskSnapshot: savedTask, slot };
  const adapter = new CatchtableAdapter();
  let fallbackPages = 0;
  adapter.context = { newPage: async () => { fallbackPages += 1; return receiptPage('No matching reservations'); } };
  adapter.bookingPages.set(savedTask.id, receiptPage(receiptText()));
  const result = await adapter.reconcile(attempt);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.reservationId, 'R-1234');
  assert.deepEqual(result.slot, slot);
  assert.equal(fallbackPages, 0, 'original page lookup must use task ID, not booking attempt ID');
});

test('a receipt from a restaurant whose name merely contains the target is not confirmed', async () => {
  const adapter = new CatchtableAdapter();
  adapter.context = { newPage: async () => receiptPage(receiptText('ZESTER')) };
  const result = await adapter.reconcile({ taskSnapshot: { ...task, id: 'task-original' },
    restaurantName: task.restaurantName, restaurantUrl: task.restaurantUrl, slot });
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.reservationId, undefined);
});

test('a reservation number with payment still required is not a completed reservation', async () => {
  const adapter = new CatchtableAdapter();
  adapter.context = { newPage: async () => receiptPage(receiptText('ZEST', 'Payment required\nPay now')) };
  const result = await adapter.reconcile({ taskSnapshot: { ...task, id: 'task-original' },
    restaurantName: task.restaurantName, restaurantUrl: task.restaurantUrl, slot });
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.reservationId, undefined);
});

test('English Booking number receipts have the same strict validation as Reservation number receipts', async () => {
  const adapter = new CatchtableAdapter();
  const text = receiptText().replace('Reservation confirmed', 'Booking confirmed').replace('Reservation number:', 'Booking number:');
  adapter.context = { newPage: async () => receiptPage(text) };
  const result = await adapter.reconcile({ taskSnapshot: { ...task, id: 'task-original' },
    restaurantName: task.restaurantName, restaurantUrl: task.restaurantUrl, slot });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.reservationId, 'R-1234');
  assert.deepEqual(result.slot, slot);
});
