import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, matchingSlots, taskTimeMatches, taskTimeSlots } from '../server/domain.mjs';
import { DEFAULT_ACCOUNT_ID, Store } from '../server/store.mjs';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const DATE = '2026-12-24';
const input = extra => ({ restaurantName: 'Time fixture', restaurantUrl: 'https://www.catchtable.net/shop/fixture', dates: [DATE], partySize: 2, mode: 'notify', ...extra });
const slot = (time, extra = {}) => ({ date: DATE, time, partySize: 2, ...extra });

test('half-hour selection normalizes duplicates and derives canonical inclusive bounds without mutating input', () => {
  const selection = ['15:00', '14:00', '14:30', '14:00'];
  const task = createTask(input({ timeSlots: selection, timeStart: '20:00', timeEnd: '10:00' }), {}, NOW);
  assert.deepEqual(selection, ['15:00', '14:00', '14:30', '14:00']);
  assert.deepEqual(task.timeSlots, ['14:00', '14:30', '15:00']);
  assert.notEqual(task.timeSlots, selection);
  assert.equal(task.timeStart, '14:00');
  assert.equal(task.timeEnd, '15:00');
  assert.deepEqual(matchingSlots(task, ['13:30', '14:00', '14:30', '15:00', '15:30'].map(time => slot(time))), ['14:00', '14:30', '15:00'].map(time => slot(time)));
});

test('disjoint selected times never accept intermediate or off-grid availability', () => {
  const task = createTask(input({ timeSlots: ['15:00', '14:00'] }), {}, NOW);
  assert.equal(taskTimeMatches(task, '14:00'), true);
  assert.equal(taskTimeMatches(task, '15:00'), true);
  assert.equal(taskTimeMatches(task, '14:30'), false);
  assert.equal(taskTimeMatches(task, '14:15'), false);
  assert.deepEqual(matchingSlots(task, [slot('15:00'), slot('14:30'), slot('14:15'), slot('14:00'), slot('14:00'), slot('14:00', { date: '2026-12-25' }), slot('15:00', { partySize: 3 })]), [slot('14:00'), slot('15:00')]);
});

test('explicit half-hour tasks accept a single time and all 48 daily times', () => {
  const single = createTask(input({ timeSlots: ['00:00'] }), {}, NOW);
  assert.equal(single.timeStart, '00:00');
  assert.equal(single.timeEnd, '00:00');
  assert.equal(taskTimeMatches(single, '00:00'), true);
  assert.equal(taskTimeMatches(single, '00:30'), false);
  const daily = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);
  const full = createTask(input({ timeSlots: daily.toReversed() }), {}, NOW);
  assert.deepEqual(full.timeSlots, daily);
  assert.equal(full.timeStart, '00:00');
  assert.equal(full.timeEnd, '23:30');
});

test('invalid explicit selections reject instead of silently using range defaults', () => {
  for (const value of [undefined, null, '', '14:00', {}, [], ['14:15'], ['24:00'], ['12:60'], ['2:00'], ['14:00', 14], ['14:00', null], [new String('14:00')], Array(49).fill('14:00'), new Array(2)]) {
    assert.throws(() => createTask(input({ timeSlots: value, timeStart: '14:00', timeEnd: '15:00' }), {}, NOW), error => error.status === 400 && /半小时/.test(error.message));
  }
  for (const value of [undefined, null, false, [], ['14:00', '14:15'], ['14:00', null], new Array(2)]) {
    const malformed = { timeSlots: value, timeStart: '14:00', timeEnd: '15:00' };
    assert.equal(taskTimeMatches(malformed, '14:00'), false);
    assert.deepEqual(taskTimeSlots(malformed), []);
  }
});

test('legacy tasks keep arbitrary-minute range matching and retain no explicit selection', () => {
  const task = createTask(input({ timeStart: '14:15', timeEnd: '15:15' }), {}, NOW);
  assert.equal(Object.hasOwn(task, 'timeSlots'), false);
  assert.equal(taskTimeSlots(task), null);
  assert.equal(taskTimeMatches(task, '14:15'), true);
  assert.equal(taskTimeMatches(task, '15:15'), true);
  assert.equal(taskTimeMatches(task, '14:14'), false);
  assert.equal(taskTimeMatches(task, '15:16'), false);
  assert.equal(taskTimeMatches(task, '25:00'), false);
  assert.deepEqual(matchingSlots(task, [slot('14:00'), slot('14:15'), slot('14:30'), slot('15:15'), slot('15:30')]), [slot('14:15'), slot('14:30'), slot('15:15')]);
});

test('account tasks and immutable booking snapshots preserve exact selected times', () => {
  const root = new Store(':memory:', { now: () => NOW });
  try {
    root.initializeAccounts();
    const store = root.forAccount(DEFAULT_ACCOUNT_ID);
    const task = store.saveTask(createTask(input({ timeSlots: ['15:00', '14:00'] }), {}, NOW));
    const attempt = store.addAttempt(task, slot('14:00'), 'user_action_required', 'Fixture pending', new Date(NOW).toISOString());
    assert.deepEqual(store.getTask(task.id).timeSlots, ['14:00', '15:00']);
    assert.deepEqual(attempt.taskSnapshot.timeSlots, ['14:00', '15:00']);
    store.saveTask({ ...task, timeSlots: ['14:30'], timeStart: '14:30', timeEnd: '14:30' });
    store.saveAttempt({ ...attempt, taskSnapshot: { ...attempt.taskSnapshot, timeSlots: ['14:30'] } });
    const persisted = store.getAttempt(attempt.id);
    assert.deepEqual(persisted.taskSnapshot.timeSlots, ['14:00', '15:00']);
    assert.equal(taskTimeMatches(persisted.taskSnapshot, '14:30'), false);
  } finally { root.close(); }
});
