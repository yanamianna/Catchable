import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Engine } from '../server/engine.mjs';
import { createHttpServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

async function fixture(run) {
  const store = new Store(':memory:');
  let adapterCalls = 0;
  const blocked = async () => { adapterCalls += 1; throw new Error('HTTP boundary tests must not access a browser.'); };
  const adapter = { inspect: blocked, prepare: blocked, reconcile: blocked, openSession: blocked, getSessionStatus: blocked, close: async () => {} };
  const engine = new Engine({ store, adapter, now: () => Date.parse('2026-10-12T00:00:00Z') });
  const server = createHttpServer({ store, engine });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
  const mutationHeaders = { origin, 'content-type': 'application/json' };
  try {
    await run({ store, engine, port, origin, send, mutationHeaders });
    assert.equal(adapterCalls, 0, 'boundary tests must remain isolated from browser and booking actions');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await engine.stop();
    store.close();
  }
}

const taskInput = {
  restaurantName: 'ZEST', restaurantUrl: 'https://www.catchtable.net/shop/zest',
  dates: ['2026-10-24'], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'assist',
};

test('local health and state are readable without starting browser work', () => fixture(async ({ send }) => {
  const health = await send('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  const state = await send('/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.tasks, []);
  assert.equal(state.json.session.connected, false);
  assert.equal(state.headers['access-control-allow-origin'], undefined);
}));

test('untrusted Host headers cannot read or mutate the local API', () => fixture(async ({ send, mutationHeaders }) => {
  for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1:1']) {
    assert.equal((await send('/api/state', { headers: { host } })).status, 403, host);
    assert.equal((await send('/api/tasks', { method: 'POST', headers: { ...mutationHeaders, host }, body: taskInput })).status, 403, host);
  }
}));

test('mutations require an exact local Origin and refuse cross-site browser requests', () => fixture(async ({ send, mutationHeaders, origin, store }) => {
  for (const originValue of [undefined, 'null', 'https://evil.example', `${origin}.evil.example`, `${origin}/`, 'http://127.0.0.1:1']) {
    const headers = { 'content-type': 'application/json' };
    if (originValue !== undefined) headers.origin = originValue;
    const response = await send('/api/tasks', { method: 'POST', headers, body: taskInput });
    assert.equal(response.status, 403, String(originValue));
  }
  const crossSite = await send('/api/tasks', { method: 'POST', headers: { ...mutationHeaders, 'sec-fetch-site': 'cross-site' }, body: taskInput });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(store.listTasks(), []);
}));

test('API writes reject form submissions, invalid JSON and oversized bodies', () => fixture(async ({ send, origin, mutationHeaders, store }) => {
  for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
    const headers = { origin };
    if (contentType !== undefined) headers['content-type'] = contentType;
    assert.equal((await send('/api/tasks', { method: 'POST', headers, body: taskInput })).status, 415, String(contentType));
  }
  for (const body of ['{broken', '[]', 'null', 'true']) {
    assert.equal((await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body })).status, 400, body);
  }
  assert.equal((await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body: { data: 'x'.repeat(70000) } })).status, 413);
  assert.deepEqual(store.listTasks(), []);
}));

test('valid local writes create paused tasks and DELETE has the same origin boundary', () => fixture(async ({ send, port, mutationHeaders, store }) => {
  const created = await send('/api/tasks', { method: 'POST', headers: { ...mutationHeaders, origin: `http://localhost:${port}` }, body: taskInput });
  assert.equal(created.status, 201);
  assert.equal(created.json.task.status, 'paused');
  assert.equal(created.json.task.source, 'live');
  const path = `/api/tasks/${created.json.task.id}`;
  assert.equal((await send(path, { method: 'DELETE', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status, 403);
  assert.equal(store.listTasks().length, 1);
  const deleted = await send(path, { method: 'DELETE', headers: mutationHeaders });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);
  assert.deepEqual(store.listTasks(), []);
}));

test('automatic mode requires explicit consent before a task can be saved', () => fixture(async ({ send, mutationHeaders, store }) => {
  const refused = await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body: { ...taskInput, mode: 'auto' } });
  assert.equal(refused.status, 400);
  assert.deepEqual(store.listTasks(), []);
  const saved = await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body: { ...taskInput, mode: 'auto', autoConsent: true } });
  assert.equal(saved.status, 201);
  assert.equal(saved.json.task.status, 'paused');
}));

test('phone prefill settings are accepted through the local API and invalid pairs cannot overwrite them', () => fixture(async ({send,mutationHeaders,store}) => {
  const contact={bookingPhoneCountryCode:'+86',bookingPhoneNumber:'13800000000',bookingPhoneAutoFill:true};
  const saved=await send('/api/settings',{method:'POST',headers:mutationHeaders,body:contact});
  assert.equal(saved.status,200);
  for(const key of Object.keys(contact))assert.equal(saved.json.settings[key],contact[key]);
  const invalid=await send('/api/settings',{method:'POST',headers:mutationHeaders,body:{bookingPhoneNumber:''}});
  assert.equal(invalid.status,400);
  assert.equal(store.settings().bookingPhoneNumber,contact.bookingPhoneNumber);
  assert.equal(JSON.stringify(store.listEvents()).includes(contact.bookingPhoneNumber),false);
}));

test('settings refuse local-network webhooks without making a network request', () => fixture(async ({ send, mutationHeaders, store }) => {
  for (const webhookUrl of ['https://127.0.0.1/hook', 'https://localhost/hook', 'https://10.0.0.1/hook', 'file:///C:/hook']) {
    const response = await send('/api/settings', { method: 'POST', headers: mutationHeaders, body: { webhookUrl } });
    assert.equal(response.status, 400, webhookUrl);
  }
  assert.equal(store.settings().webhookUrl, '');
  const valid = await send('/api/settings', { method: 'POST', headers: mutationHeaders, body: { pollIntervalSeconds: 60, webhookUrl: '' } });
  assert.equal(valid.status, 200);
  assert.equal(valid.json.settings.pollIntervalMs, 60000);
  assert.equal(Object.hasOwn(valid.json.settings, 'pollIntervalSeconds'), false);
}));

test('millisecond API settings support 1 ms and reject ambiguous units', () => fixture(async ({ send, mutationHeaders }) => {
  const fastest = await send('/api/settings', { method: 'POST', headers: mutationHeaders, body: { pollIntervalMs: 1 } });
  assert.equal(fastest.status, 200);
  assert.equal(fastest.json.settings.pollIntervalMs, 1);
  for (const body of [{ pollIntervalMs: 1000, pollIntervalSeconds: 1 }, { pollIntervalMs: 0 }, { pollIntervalMs: 1.5 }, { pollIntervalMs: '1' }, { pollIntervalSeconds: 0.0001 }]) {
    assert.equal((await send('/api/settings', { method: 'POST', headers: mutationHeaders, body })).status, 400);
    assert.equal((await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body: { ...taskInput, ...body } })).status, 400);
  }
  const created = await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body: { ...taskInput, pollIntervalSeconds: 0.001 } });
  assert.equal(created.status, 201);
  assert.equal(created.json.task.pollIntervalMs, 1);
  assert.equal(Object.hasOwn(created.json.task, 'pollIntervalSeconds'), false);
}));

test('applying a setting updates existing real tasks without starting them or changing pending states', () => fixture(async ({ send, mutationHeaders, store, engine }) => {
  const created = await send('/api/tasks', { method: 'POST', headers: mutationHeaders, body: { ...taskInput, pollIntervalMs: 250 } });
  const task = created.json.task;
  store.patchTask(task.id, { status: 'user_action_required' });
  store.addAttempt(store.getTask(task.id), { date: task.dates[0], time: '19:00', partySize: 2 }, 'outcome_unknown');
  const applied = await send('/api/settings', { method: 'POST', headers: mutationHeaders, body: { pollIntervalMs: 1, applyToExistingTasks: true } });
  assert.equal(applied.status, 200);
  assert.equal(store.getTask(task.id).pollIntervalMs, 1);
  assert.equal(store.getTask(task.id).status, 'user_action_required');
  assert.equal(engine.state().accountWriteBlocked, true);
  assert.equal(store.listAttempts()[0].status, 'outcome_unknown');
  assert.equal((await send('/api/settings', { method: 'POST', headers: mutationHeaders, body: { pollIntervalMs: 10, applyToExistingTasks: 'true' } })).status, 400);
  assert.equal(store.getTask(task.id).pollIntervalMs, 1);
}));
