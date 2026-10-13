import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CatchtableAdapter, classifySessionSnapshots } from '../server/catchtable.mjs';
import { ordinaryBrowserArguments } from '../server/browser-launch.mjs';
import { parseRestaurantSnapshot } from '../server/restaurant.mjs';
import { createTask } from '../server/domain.mjs';
import { Engine } from '../server/engine.mjs';
import { createHttpServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

const officialRestaurantUrl = 'https://www.catchtable.net/zh-CN/shop/zest_seoul';
const checkedAt = '2030-01-01T00:00:00.000Z';
// Read from the public ZEST page on 2026-10-12. The page has no JSON-LD;
// its meta description describes the whole service, not this restaurant.
const publicRestaurant = {
  url: officialRestaurantUrl,
  canonicalUrl: officialRestaurantUrl,
  title: 'ZEST - Cheongdam-dong, Gangnam-gu, Seoul, Korea - 餐厅预订与预约，菜单与价格，评价与照片 - CATCHTABLE',
  headings: [{ level: 2, text: 'ZEST' }, { level: 2, text: '제스트' }, { level: 2, text: "如果您喜欢'ZEST'" }],
  description: '通过CATCHTABLE发现韩国顶级餐厅——这是一款提供实时菜单、评论和预订情况的第一号预约应用，一站式服务体验。',
  jsonLd: [],
  text: '清潭 • 鸡尾酒/威士忌\nZEST\n제스트\n4.8\n(715)\n₩20,000~₩60,000\n今日（周一） • 18:30 - 凌晨02:00点\n日期 • 时间 • 人\n24\n周六\n25\n周日\n预订',
};

function memoryApp(adapter, now = () => Date.parse(checkedAt)) {
  const store = new Store(':memory:', { now });
  const engine = new Engine({ store, adapter, now });
  return { store, engine, async close() { await engine.stop(); store.close(); } };
}

function newTask(now = Date.parse(checkedAt), changes = {}) {
  return { ...createTask({ restaurantName: 'ZEST', restaurantUrl: officialRestaurantUrl,
    dates: ['2030-01-02'], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'notify',
    pollIntervalMs: 1000, deadline: new Date(now + 60000).toISOString() }, {}, now), ...changes };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('the actual public heading supplies the name without inventing restaurant-specific metadata', () => {
  const restaurant = parseRestaurantSnapshot(publicRestaurant, 'https://www.catchtable.net/shop/zest_seoul', Date.parse(checkedAt));
  assert.equal(restaurant.restaurantName, 'ZEST');
  assert.equal(restaurant.restaurantUrl, officialRestaurantUrl);
  assert.equal(restaurant.source, 'catchtable_public');
  assert.equal(restaurant.verifiedAt, checkedAt);
  assert.equal(restaurant.description, undefined);
  assert.equal(restaurant.rating, undefined, 'unlabelled body numbers must not be guessed as structured metadata');
  assert.equal(restaurant.priceSummary, undefined);
  assert.deepEqual(restaurant.requiredFields, [], 'public details do not establish booking-form requirements');
  assert.ok(restaurant.bookingNotes.some((note) => /核对|确认/.test(note)));
});

test('a restaurant name is never inferred from a slug, generic headings or another restaurant identity', () => {
  const rejected = [
    { ...publicRestaurant, headings: [{ level: 1, text: 'CATCHTABLE' }], title: 'CATCHTABLE', text: '' },
    { ...publicRestaurant, url: 'https://evil.example/shop/zest_seoul' },
    { ...publicRestaurant, url: 'https://www.catchtable.net/shop/another_restaurant' },
    { ...publicRestaurant, canonicalUrl: 'https://evil.example/shop/zest_seoul' },
    { ...publicRestaurant, canonicalUrl: 'https://www.catchtable.net/shop/another_restaurant' },
  ];
  for (const snapshot of rejected) {
    assert.throws(() => parseRestaurantSnapshot(snapshot, officialRestaurantUrl), (error) => error.status === 502);
  }
  const recommendation = parseRestaurantSnapshot({ ...publicRestaurant,
    jsonLd: [{ '@type': 'Restaurant', name: 'Another restaurant', url: 'https://www.catchtable.net/shop/another_restaurant' }] }, officialRestaurantUrl);
  assert.equal(recommendation.restaurantName, 'ZEST');
  const unlinkedRecommendation = parseRestaurantSnapshot({ ...publicRestaurant,
    jsonLd: [{ '@type': 'Restaurant', name: 'Another restaurant', address: 'Another restaurant address' }] }, officialRestaurantUrl);
  assert.equal(unlinkedRecommendation.restaurantName, 'ZEST');
  assert.equal(unlinkedRecommendation.address, undefined, 'unlinked recommendation metadata cannot describe the target restaurant');
});

test('verified structured public metadata is retained and defaults remain separate from booking requirements', () => {
  const restaurant = parseRestaurantSnapshot({ ...publicRestaurant, jsonLd: [{ '@type': 'Restaurant', url: officialRestaurantUrl,
    name: 'ZEST', description: 'Public restaurant description', servesCuisine: ['Cocktails', 'Whisky'],
    address: { streetAddress: 'Local fixture address', addressLocality: 'Seoul', addressCountry: 'KR' },
    aggregateRating: { ratingValue: 4.8, reviewCount: 715 }, priceRange: '₩20,000~₩60,000', telephone: '+82-local-fixture' }] }, officialRestaurantUrl);
  assert.equal(restaurant.description, 'Public restaurant description');
  assert.equal(restaurant.rating, 4.8);
  assert.equal(restaurant.reviewCount, 715);
  assert.equal(restaurant.priceSummary, '₩20,000~₩60,000');
  assert.equal(restaurant.category, 'Cocktails · Whisky');
  assert.match(restaurant.address, /Local fixture address/);
  assert.deepEqual(restaurant.requiredFields, []);
  assert.equal(restaurant.defaults.partySize, 2);
});

test('main restaurant fields and information-page details stay attached to the same restaurant', () => {
  const home = { ...publicRestaurant, fields: { category: '清潭 • 鸡尾酒/威士忌', priceSummary: '₩20,000~₩60,000', rating: 4.8, reviewCount: 716 } };
  const information = { url: `${officialRestaurantUrl}/info`, restaurantName: 'ZEST', description: '可持续的精致饮品',
    address: 'Fixture public address, Seoul', phone: '+82-2-0000-0000', bookingNotes: ['Fixture official booking notice'] };
  const matched = parseRestaurantSnapshot({ ...home, information }, officialRestaurantUrl);
  assert.equal(matched.restaurantName, 'ZEST');
  assert.equal(matched.category, home.fields.category);
  assert.equal(matched.priceSummary, home.fields.priceSummary);
  assert.equal(matched.rating, 4.8);
  assert.equal(matched.reviewCount, 716);
  assert.equal(matched.description, information.description);
  assert.equal(matched.address, information.address);
  assert.equal(matched.phone, information.phone);
  assert.ok(matched.bookingNotes.includes(information.bookingNotes[0]));
  assert.deepEqual(matched.requiredFields, []);
  for (const changes of [
    { url: 'https://evil.example/zh-CN/shop/zest_seoul/info' },
    { url: 'https://www.catchtable.net/zh-CN/shop/another_restaurant/info' },
    { url: `${officialRestaurantUrl}/menus` },
    { restaurantName: 'Another restaurant' },
  ]) {
    const mismatched = parseRestaurantSnapshot({ ...home, information: { ...information, ...changes } }, officialRestaurantUrl);
    assert.equal(mismatched.restaurantName, 'ZEST');
    assert.equal(mismatched.address, undefined);
    assert.equal(mismatched.phone, undefined);
    assert.equal(mismatched.description, undefined);
    assert.equal(mismatched.bookingNotes.includes(information.bookingNotes[0]), false);
    assert.equal(mismatched.rating, 4.8, 'unrelated information cannot replace verified main-page metadata');
  }
});

test('restaurant resolution rejects hostile origins and invalid slugs before creating a network context', async () => {
  let createdContexts = 0;
  const adapter = new CatchtableAdapter({ publicContextFactory: async () => { createdContexts += 1; throw new Error('Unexpected network context'); } });
  for (const url of [
    'http://www.catchtable.net/shop/zest_seoul', 'https://www.catchtable.net.evil.example/shop/zest_seoul',
    'https://www.catchtable.net@evil.example/shop/zest_seoul', 'https://user:password@www.catchtable.net/shop/zest_seoul',
    'https://127.0.0.1/shop/zest_seoul', 'file:///C:/fixture.html',
    'https://www.catchtable.net/shop/zest%2Fother', 'https://www.catchtable.net/shop/zest/other',
    'https://www.catchtable.net/shop/', 'https://www.catchtable.net/shop/zest_seoul?redirect=https://evil.example',
  ]) {
    await assert.rejects(() => adapter.resolveRestaurant(url), (error) => error.status === 400, url);
  }
  assert.equal(createdContexts, 0);
});

test('restaurant resolution uses an isolated public context and closes it after success or a mismatched page', async () => {
  for (const invalid of [false, true]) {
    const visits = [];
    let closed = 0;
    const context = { newPage: async () => ({
      goto: async (url) => visits.push(url),
      locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
      evaluate: async () => invalid ? { ...publicRestaurant, url: 'https://evil.example/shop/zest_seoul' } : publicRestaurant,
    }), close: async () => { closed += 1; } };
    const adapter = new CatchtableAdapter({ publicContextFactory: async () => context,
      contextFactory: async () => { throw new Error('Restaurant lookup must not read the login profile'); } });
    if (invalid) await assert.rejects(() => adapter.resolveRestaurant(officialRestaurantUrl), (error) => error.status === 502);
    else assert.equal((await adapter.resolveRestaurant(officialRestaurantUrl)).restaurantName, 'ZEST');
    assert.deepEqual(visits, [officialRestaurantUrl]);
    assert.equal(closed, 1);
    assert.equal(adapter.context, null);
  }
});

test('generic dining and reservation text cannot establish a logged-in session', () => {
  for (const text of ['我的用餐\n我的预约\n预订', 'My Dining\nReservation\nUpcoming bookings', '예약\nMy Dining']) {
    const result = classifySessionSnapshots([{ url: 'https://www.catchtable.net/zh-CN/my-dining', text }], { checkedAt });
    assert.equal(result.connected, false, text);
    assert.equal(result.status, 'unknown', text);
    assert.equal(result.checkedAt, checkedAt);
  }
  assert.equal(classifySessionSnapshots([], { browserOpen: false }).status, 'closed');
  assert.equal(classifySessionSnapshots([], { browserMode: 'manual' }).status, 'manual_login');
});

test('only explicit official account evidence establishes authentication', () => {
  for (const kind of ['logout', 'profile', 'account_menu']) {
    const result = classifySessionSnapshots([{ url: 'https://www.catchtable.net/zh-CN/my-dining', text: 'My Dining',
      accountEvidence: { kind, label: 'Fixture account' } }], { checkedAt });
    assert.equal(result.status, 'authenticated');
    assert.equal(result.connected, true);
    assert.equal(result.accountLabel, 'Fixture account');
  }
  for (const url of ['http://www.catchtable.net/zh-CN/my-dining', 'https://www.catchtable.net.evil.example/my-dining', 'https://user@www.catchtable.net/my-dining']) {
    const result = classifySessionSnapshots([{ url, text: 'Log out', accountEvidence: { kind: 'logout' } }]);
    assert.equal(result.connected, false, url);
  }
  const loading = classifySessionSnapshots([{ url: officialRestaurantUrl, text: 'Log out', loading: true, accountEvidence: { kind: 'logout' } }]);
  assert.equal(loading.connected, false);
  const login = classifySessionSnapshots([{ url: 'https://www.catchtable.net/zh-CN/login', text: '登录或注册' }]);
  assert.equal(login.status, 'unauthenticated');
});

test('a rejected Google popup overrides older official account evidence regardless of page order', () => {
  const official = { url: 'https://www.catchtable.net/zh-CN/my-dining', text: 'My Dining', accountEvidence: { kind: 'logout' } };
  const popup = { url: 'https://accounts.google.com/signin/rejected', text: 'This browser or app may not be secure' };
  for (const snapshots of [[official, popup], [popup, official]]) {
    const result = classifySessionSnapshots(snapshots, { checkedAt });
    assert.equal(result.status, 'oauth_blocked');
    assert.equal(result.connected, false);
    assert.ok(result.guidance.some((item) => /普通|电子邮件/.test(item)));
  }
  assert.equal(classifySessionSnapshots([{ url: 'https://accounts.google.com/signin', text: 'Sign in' }]).connected, false);
});

test('fresh login-required evidence on the primary session page cannot be overruled by an old account tab', () => {
  const oldAccount = { url: 'https://www.catchtable.net/zh-CN/my/myMain', text: 'Fixture old account', accountEvidence: { kind: 'profile' } };
  const freshLogin = { url: 'https://www.catchtable.net/zh-CN/my-dining', text: '登录或注册', primary: true };
  for (const snapshots of [[oldAccount, freshLogin], [freshLogin, oldAccount]]) {
    const result = classifySessionSnapshots(snapshots, { checkedAt });
    assert.equal(result.status, 'unauthenticated');
    assert.equal(result.connected, false);
  }
});

test('ordinary manual-browser arguments use a dedicated profile without automation or debugging flags', () => {
  const dedicated = resolve('local-fixture', 'browser-profile');
  const args = ordinaryBrowserArguments(dedicated, 'https://www.catchtable.net/zh-CN/my-dining');
  assert.ok(args.includes(`--user-data-dir=${dedicated}`));
  assert.ok(args.includes('--restore-last-session'));
  assert.ok(args.includes('--new-window'));
  assert.equal(args.at(-1), 'https://www.catchtable.net/zh-CN/my-dining');
  assert.equal(args.some((arg) => /remote-debug|enable-automation|AutomationControlled|stealth|no-sandbox|disable-web-security|profile-directory/i.test(arg)), false);
});

test('manual login uses the application profile and an occupied profile returns a clear handoff rather than authentication', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'catchable-interaction-'));
  let launched;
  let controlledLaunches = 0;
  const adapter = new CatchtableAdapter({ dataDir,
    manualBrowserLauncher: async (options) => { launched = options; return { browserName: 'Microsoft Edge', processId: 1234 }; },
    contextFactory: async () => { controlledLaunches += 1; throw new Error('Dedicated profile is in use by the manual window'); },
  });
  try {
    const opened = await adapter.openSession({ mode: 'manual' });
    assert.equal(opened.status, 'manual_login');
    assert.equal(opened.connected, false);
    assert.equal(opened.browserOpen, true);
    assert.equal(controlledLaunches, 0, 'manual login does not launch an automated browser');
    assert.equal(resolve(launched.profileDir), resolve(dataDir, 'browser-profile'));
    assert.equal(launched.url, 'https://www.catchtable.net/zh-CN/my/myMain');
    const locked = await adapter.getSessionStatus();
    assert.equal(locked.status, 'manual_login');
    assert.equal(locked.connected, false);
    assert.match(locked.message, /关闭.*专用/);
    assert.ok(locked.guidance.some((item) => /关闭/.test(item)));
    assert.equal(adapter.context, null);
    assert.equal(controlledLaunches, 1);
  } finally {
    await adapter.close();
    try { rmdirSync(join(dataDir, 'browser-profile')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(dataDir);
  }
});

test('background session status reads existing pages and Google popups without navigation or new pages', async () => {
  let navigations = 0;
  let createdPages = 0;
  const snapshots = [
    { url: officialRestaurantUrl, text: '日期 • 时间 • 人\nZEST\nMy Dining', loading: true },
    { url: 'https://accounts.google.com/signin/rejected', text: 'This browser or app may not be secure' },
  ];
  const pages = snapshots.map((snapshot) => ({ isClosed: () => false, url: () => snapshot.url,
    goto: async () => { navigations += 1; }, evaluate: async () => snapshot }));
  const adapter = new CatchtableAdapter();
  adapter.context = { pages: () => pages, newPage: async () => { createdPages += 1; throw new Error('Status must not create a tab'); } };
  adapter.sessionPage = pages[0];
  adapter.watchPages.set('watch-fixture', pages[0]);
  const result = await adapter.getSessionStatus();
  assert.equal(result.status, 'oauth_blocked');
  assert.equal(result.connected, false);
  assert.equal(navigations, 0);
  assert.equal(createdPages, 0);
  assert.equal(adapter.watchPages.get('watch-fixture'), pages[0]);
});

test('background observation of an unknown official page remains read only', async () => {
  let navigations = 0;
  let newPages = 0;
  const watchPage = { isClosed: () => false, url: () => officialRestaurantUrl,
    goto: async () => { navigations += 1; },
    evaluate: async () => ({ url: officialRestaurantUrl, text: 'ZEST\nMy Dining\nReservation' }) };
  const adapter = new CatchtableAdapter();
  adapter.context = { pages: () => [watchPage], newPage: async () => { newPages += 1; throw new Error('Unexpected new tab'); } };
  adapter.watchPages.set('watch-fixture', watchPage);
  const result = await adapter.observeSession();
  assert.equal(result.status, 'unknown');
  assert.equal(result.connected, false);
  assert.equal(navigations, 0);
  assert.equal(newPages, 0);
  assert.equal(adapter.watchPages.get('watch-fixture'), watchPage);
});

test('GET state returns cached session data and never checks or opens a browser', async () => {
  let statusCalls = 0;
  let openCalls = 0;
  const app = memoryApp({ getSessionStatus: async () => { statusCalls += 1; throw new Error('Unexpected session probe'); },
    openSession: async () => { openCalls += 1; throw new Error('Unexpected browser launch'); }, close: async () => {} });
  app.engine.session = { status: 'manual_login', connected: false, browserOpen: true, browserMode: 'manual', checkedAt, message: 'Cached fixture', guidance: [] };
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/state' }, (res) => {
          let text = ''; res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject); req.end();
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.session.message, 'Cached fixture');
      assert.equal(response.body.session.checkedAt, checkedAt);
    }
    assert.equal(statusCalls, 0);
    assert.equal(openCalls, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); await app.close(); }
});

test('successful session checks restore only authentication-paused tasks that were previously active', async () => {
  let authenticated = false;
  const app = memoryApp({ getSessionStatus: async () => ({ status: authenticated ? 'authenticated' : 'unknown', connected: authenticated,
    browserOpen: true, browserMode: 'controlled', checkedAt, guidance: [], message: 'Local session fixture' }), close: async () => {} });
  const states = [
    { status: 'auth_required', resumeAfterAuth: true },
    { status: 'auth_required', resumeAfterAuth: false },
    { status: 'paused', resumeAfterAuth: false },
    { status: 'user_action_required', resumeAfterAuth: false },
  ];
  const tasks = states.map((changes) => newTask(undefined, changes));
  for (const task of tasks) app.store.saveTask(task);
  try {
    await app.engine.sessionAction('check');
    for (const task of tasks) assert.equal(app.store.getTask(task.id).status, task.status);
    authenticated = true;
    await app.engine.sessionAction('check');
    assert.equal(app.store.getTask(tasks[0].id).status, 'active');
    assert.equal(app.store.getTask(tasks[0].id).resumeAfterAuth, false);
    for (const task of tasks.slice(1)) {
      assert.equal(app.store.getTask(task.id).status, task.status);
      assert.equal(app.store.getTask(task.id).nextCheckAt, null);
    }
  } finally { await app.close(); }
});

test('a queued session check waits for the current monitor observation and preserves a manually paused task', async () => {
  const started = deferred();
  const release = deferred();
  let sessionCalls = 0;
  const app = memoryApp({
    inspect: async () => { started.resolve(); await release.promise; return { status: 'auth_required', slots: [], message: 'Fixture login required' }; },
    getSessionStatus: async () => { sessionCalls += 1; return { status: 'authenticated', connected: true, browserOpen: true, browserMode: 'controlled', checkedAt, guidance: [], message: 'Fixture signed in' }; },
    close: async () => {},
  });
  const task = newTask();
  app.store.saveTask(task);
  try {
    const check = app.engine.taskAction(task.id, 'check');
    await started.promise;
    const status = app.engine.sessionAction('check');
    await delay(5);
    assert.equal(sessionCalls, 0, 'session checks must not interrupt the browser worker');
    release.resolve();
    await check;
    await status;
    assert.equal(sessionCalls, 1);
    assert.equal(app.store.getTask(task.id).status, 'paused');
    assert.equal(app.store.getTask(task.id).nextCheckAt, null);
    assert.equal(app.store.getTask(task.id).resumeAfterAuth, false);
  } finally { release.resolve(); await app.close(); }
});

test('background session refresh skips the busy worker and updates cache only after it becomes idle', async () => {
  const started = deferred();
  const release = deferred();
  let observations = 0;
  const app = memoryApp({ hasContext: true,
    inspect: async () => { started.resolve(); await release.promise; return { status: 'unavailable', slots: [] }; },
    observeSession: async () => { observations += 1; return { status: 'unknown', connected: false, browserOpen: true,
      browserMode: 'controlled', checkedAt, guidance: [], message: 'Read-only cached fixture' }; }, close: async () => {},
  });
  const task = newTask();
  app.store.saveTask(task);
  try {
    const check = app.engine.taskAction(task.id, 'check');
    await started.promise;
    await app.engine.refreshSession();
    assert.equal(observations, 0, 'background refresh must not contend with a monitor interaction');
    release.resolve();
    await check;
    await app.engine.tail;
    await app.engine.refreshSession();
    assert.equal(observations, 1);
    assert.equal(app.engine.session.message, 'Read-only cached fixture');
    assert.equal(app.store.getTask(task.id).status, 'paused');
  } finally { release.resolve(); await app.close(); }
});
