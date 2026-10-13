import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { initializeSessionRestorePreferences, launchManualBrowser, probeProfileOccupancy, probeProfileWindow } from '../server/browser-launch.mjs';
import { CatchtableAdapter } from '../server/catchtable.mjs';
import { createTask } from '../server/domain.mjs';
import { Engine } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';

const accountUrl = 'https://www.catchtable.net/zh-CN/my/myMain';

function removeCreatedProfileFixture(profileDir) {
  const target = resolve(profileDir);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.match(basename(target), /^catchable-(?:channel|window|preferences)-/);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test('fresh dedicated profiles receive the supported persisted session restore preference',async()=>{
  const profileDir=mkdtempSync(join(tmpdir(),'catchable-preferences-'));
  try {
    assert.deepEqual(await initializeSessionRestorePreferences({profileDir}),{initialized:true});
    const preferencesPath=join(profileDir,'Default','Preferences');
    const bytes=readFileSync(preferencesPath);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')),{session:{restore_on_startup:1}});
    assert.deepEqual(await initializeSessionRestorePreferences({profileDir}),{initialized:false});
    assert.deepEqual(readFileSync(preferencesPath),bytes);
  }finally {removeCreatedProfileFixture(profileDir);}
});

test('existing preferences remain byte-for-byte unchanged without parsing or merging',async()=>{
  const profileDir=mkdtempSync(join(tmpdir(),'catchable-preferences-'));
  try {
    mkdirSync(join(profileDir,'Default'));
    const preferencesPath=join(profileDir,'Default','Preferences');
    const fixtureBytes=Buffer.from([0,255,34,123,125,10]);
    writeFileSync(preferencesPath,fixtureBytes);
    assert.deepEqual(await initializeSessionRestorePreferences({profileDir}),{initialized:false});
    assert.deepEqual(readFileSync(preferencesPath),fixtureBytes);
  }finally {removeCreatedProfileFixture(profileDir);}
});

test('an explicitly selected Chrome uses only Chrome official paths and ordinary dedicated-profile arguments',async()=>{
  const profileDir=mkdtempSync(join(tmpdir(),'catchable-channel-'));
  const probes=[];const spawned=[];
  try {
    const result=await launchManualBrowser({profileDir,channel:'chrome',platform:'win32',env:{ProgramFiles:'C:/Fixture/Program Files',LOCALAPPDATA:'C:/Fixture/Local'},
      accessFile:async path=>{probes.push(path);},windowProbe:async()=>({status:'visible',ownerCount:1,visibleWindowCount:1}),spawnBrowser:(executable,args,options)=>{
        assert.deepEqual(JSON.parse(readFileSync(join(profileDir,'Default','Preferences'),'utf8')),{session:{restore_on_startup:1}},'restore preferences must exist before the first browser process is created');
        spawned.push({executable,args,options});const child=new EventEmitter();child.pid=123;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
      }});
    assert.equal(result.browserName,'Google Chrome');assert.equal(result.channel,'chrome');assert.equal(result.processId,123);
    assert.ok(probes.every(path=>path.endsWith('chrome.exe')));assert.equal(spawned.length,1);assert.ok(spawned[0].executable.endsWith('chrome.exe'));
    assert.deepEqual(spawned[0].args,[`--user-data-dir=${resolve(profileDir)}`,'--restore-last-session','--new-window',accountUrl]);
    assert.equal(spawned[0].options.shell,false);assert.equal(spawned[0].options.windowsHide,false);
    assert.ok(!spawned[0].args.some(value=>/automation|remote-debug|disable-security/i.test(value)));
  }finally {removeCreatedProfileFixture(profileDir);}
});

test('a window probe inspects only the selected dedicated profile and returns visibility metadata',async()=>{
  const profileDir=resolve('fixture dedicated profile','王 岩');let command;
  const observed=await probeProfileWindow({profileDir,channel:'chrome',platform:'win32',timeoutMs:700,env:{TASK_TEST:'1'},
    runCommand:async(executable,args,options)=>{command={executable,args,options};return {stdout:JSON.stringify({status:'visible',ownerCount:2,visibleWindowCount:1,windowTitle:'must not escape',commandLine:'must not escape'})};}});
  assert.deepEqual(observed,{status:'visible',ownerCount:2,visibleWindowCount:1});
  assert.equal(command.executable,'powershell.exe');assert.equal(command.options.windowsHide,true);assert.equal(command.options.shell,false);
  assert.equal(command.options.timeout,700);assert.equal(command.options.env.CATCHABLE_WINDOW_PROBE_TARGET,profileDir);
  assert.equal(command.options.env.CATCHABLE_WINDOW_PROBE_BROWSER,'chrome.exe');assert.equal(command.args.join(' ').includes(profileDir),false);
  assert.equal(command.args.join(' ').includes('MainWindowTitle'),false);
  for(const output of ['not JSON',JSON.stringify({status:'visible',ownerCount:0,visibleWindowCount:1}),JSON.stringify({status:'visible',ownerCount:1,visibleWindowCount:0}),JSON.stringify({status:'not_visible',ownerCount:1,visibleWindowCount:1})]) {
    assert.deepEqual(await probeProfileWindow({profileDir,channel:'chrome',platform:'win32',runCommand:async()=>({stdout:output})}),{status:'unknown',ownerCount:0,visibleWindowCount:0});
  }
  assert.deepEqual(await probeProfileWindow({profileDir,channel:'chrome',platform:'win32',runCommand:async()=>{throw new Error('Probe fixture unavailable');}}),{status:'unknown',ownerCount:0,visibleWindowCount:0});
});

async function fakeManualLaunch({observations,exitCode,exitSignal,probeThrows=false}) {
  const profileDir=mkdtempSync(join(tmpdir(),'catchable-window-'));
  let elapsed=0;let calls=0;let unrefs=0;const child=new EventEmitter();child.pid=456;child.unref=()=>{unrefs++;};
  try {
    const result=await launchManualBrowser({profileDir,channel:'chrome',platform:'win32',env:{ProgramFiles:'C:/Fixture/Program Files'},
      accessFile:async()=>{},now:()=>elapsed,wait:async ms=>{elapsed+=ms;},windowTimeoutMs:450,
      spawnBrowser:()=>{queueMicrotask(()=>{child.emit('spawn');if(exitCode!==undefined || exitSignal)child.emit('exit',exitCode ?? null,exitSignal ?? null);});return child;},
      windowProbe:async options=>{assert.equal(options.profileDir,resolve(profileDir));assert.equal(options.channel,'chrome');assert.ok(options.timeoutMs>0 && options.timeoutMs<=450);calls++;if(probeThrows)throw new Error('Probe fixture unavailable');return observations[Math.min(calls-1,observations.length-1)];},
    });
    return {result,elapsed,calls,unrefs};
  }finally {assert.equal(unrefs,1,'neither failed nor forwarded launches are killed; only detach the process handle');removeCreatedProfileFixture(profileDir);}
}

test('manual launch waits for a visible dedicated window and accepts a successful existing-instance forward',async()=>{
  const hidden={status:'not_visible',ownerCount:1,visibleWindowCount:0};const visible={status:'visible',ownerCount:1,visibleWindowCount:1};
  const fresh=await fakeManualLaunch({observations:[hidden,visible]});
  assert.equal(fresh.calls,2);assert.equal(fresh.elapsed,150);assert.equal(fresh.result.channel,'chrome');
  const forwarded=await fakeManualLaunch({observations:[visible],exitCode:0});
  assert.equal(forwarded.calls,1);assert.equal(forwarded.result.browserName,'Google Chrome');
});

test('spawn success alone never claims that the login window opened',async()=>{
  const hidden={status:'not_visible',ownerCount:1,visibleWindowCount:0};
  await assert.rejects(fakeManualLaunch({observations:[hidden]}),error=>error.code==='MANUAL_WINDOW_NOT_VISIBLE' && /未显示专用登录窗口/.test(error.message));
  await assert.rejects(fakeManualLaunch({observations:[hidden],exitCode:0}),error=>error.code==='MANUAL_WINDOW_NOT_VISIBLE');
  await assert.rejects(fakeManualLaunch({observations:[hidden],exitCode:7}),error=>error.code==='MANUAL_LAUNCH_FAILED' && /提前退出/.test(error.message));
  await assert.rejects(fakeManualLaunch({observations:[hidden],exitSignal:'SIGTERM'}),error=>error.code==='MANUAL_LAUNCH_FAILED');
  await assert.rejects(fakeManualLaunch({observations:[{status:'unknown',ownerCount:0,visibleWindowCount:0}]}),error=>error.code==='MANUAL_WINDOW_PROBE_FAILED');
  await assert.rejects(fakeManualLaunch({observations:[],probeThrows:true}),error=>error.code==='MANUAL_WINDOW_PROBE_FAILED');
});

test('a missing explicitly selected browser never falls back to an installed alternative',async()=>{
  const profileDir=mkdtempSync(join(tmpdir(),'catchable-channel-'));
  try {
    for(const channel of ['chrome','msedge']) {
      const probes=[];let spawned=0;const selectedExe=channel==='chrome'?'chrome.exe':'msedge.exe';
      await assert.rejects(launchManualBrowser({profileDir,channel,platform:'win32',env:{ProgramFiles:'C:/Fixture/Program Files',LOCALAPPDATA:'C:/Fixture/Local'},
        accessFile:async path=>{probes.push(path);if(path.endsWith(selectedExe))throw new Error('Selected fixture browser not installed');},
        spawnBrowser:()=>{spawned++;throw new Error('An alternative browser must never be started');}}),channel==='chrome'?/已选择的 Google Chrome/:/已选择的 Microsoft Edge/);
      assert.ok(probes.length>0);assert.ok(probes.every(path=>path.endsWith(selectedExe)));assert.equal(spawned,0);
    }
    let probed=0;
    await assert.rejects(launchManualBrowser({profileDir,channel:'unsupported',platform:'win32',accessFile:async()=>{probed++;}}),/chrome 或 msedge/);
    assert.equal(probed,0);
  }finally {removeCreatedProfileFixture(profileDir);}
});

function pageFixture({ initialUrl = 'about:blank', failNavigation = false, account = false } = {}) {
  let currentUrl = initialUrl;
  let closed = false;
  const state = { visits: [], closeCalls: 0, frontCalls: 0 };
  return { state,
    isClosed: () => closed,
    url: () => currentUrl,
    goto: async (url) => {
      state.visits.push(url);
      if (failNavigation) throw new Error('Local fixture navigation failed');
      currentUrl = url;
    },
    evaluate: async () => ({ url: currentUrl, text: account && currentUrl === accountUrl ? 'Fixture account\nEdit Profile' : 'Public page',
      accountEvidence: account && currentUrl === accountUrl ? { kind: 'profile', label: 'Fixture account' } : null }),
    bringToFront: async () => { state.frontCalls += 1; },
    close: async () => { state.closeCalls += 1; closed = true; },
  };
}

function contextFixture(initialPages = [], newPageFactory = () => pageFixture({ account: true })) {
  const allPages = [...initialPages];
  const state = { newPageCalls: 0, closeCalls: 0 };
  const handlers = new Map();
  return { state, allPages,
    pages: () => allPages.filter((page) => !page.isClosed()),
    newPage: async () => { state.newPageCalls += 1; const page = newPageFactory(); allPages.push(page); return page; },
    setDefaultTimeout: () => {},
    on: (event, handler) => handlers.set(event, handler),
    close: async () => { state.closeCalls += 1; handlers.get('close')?.(); },
  };
}

async function withAdapter(options, run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'catchable-connection-'));
  const adapter = new CatchtableAdapter({ dataDir, ...options });
  try { await run(adapter, dataDir); }
  finally {
    await adapter.close();
    try { rmdirSync(join(dataDir, 'browser-profile')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(dataDir);
  }
}

test('profile probing returns only occupancy metadata and keeps the profile path out of shell code', async () => {
  let command;
  const profileDir = resolve('fixture dedicated profile', '王 岩');
  const result = await probeProfileOccupancy({ profileDir, platform: 'win32', env: { TASK_TEST: '1' },
    runCommand: async (executable, args, options) => {
      command = { executable, args, options };
      return { stdout: JSON.stringify({ status: 'in_use', ownerCount: 2, browserName: 'Microsoft Edge', commandLine: 'must not escape the probe' }) };
    },
  });
  assert.deepEqual(result, { status: 'in_use', ownerCount: 2, browserName: 'Microsoft Edge' });
  assert.equal(command.executable, 'powershell.exe');
  assert.equal(command.options.shell, false);
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.env.CATCHABLE_PROFILE_PROBE_TARGET, profileDir);
  assert.equal(command.args.join(' ').includes(profileDir), false);
});

test('failed or inconsistent profile probes remain unknown instead of claiming that the profile is free', async () => {
  for (const output of [
    'not JSON', JSON.stringify({ status: 'free', ownerCount: 1 }),
    JSON.stringify({ status: 'in_use', ownerCount: 0 }),
    JSON.stringify({ status: 'free', ownerCount: -1 }),
    JSON.stringify({ status: 'free', ownerCount: 0.5 }),
  ]) {
    const result = await probeProfileOccupancy({ profileDir: resolve('fixture profile'), platform: 'win32',
      runCommand: async () => ({ stdout: output }) });
    assert.deepEqual(result, { status: 'unknown', ownerCount: 0 });
  }
  assert.deepEqual(await probeProfileOccupancy({ profileDir: resolve('fixture profile'), platform: 'win32',
    runCommand: async () => { throw new Error('Local process-probe fixture failure'); } }), { status: 'unknown', ownerCount: 0 });
});

test('an occupied manual profile blocks repeated checks before any controlled launch or new page', async () => {
  let launches = 0;
  const probes = [];
  const context = contextFixture([pageFixture()]);
  await withAdapter({ profileOccupancyProbe: async (options) => { probes.push(options); return { status: 'in_use', ownerCount: 1, browserName: 'Microsoft Edge' }; },
    contextFactory: async () => { launches += 1; return context; } }, async (adapter, dataDir) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await adapter.getSessionStatus();
      assert.equal(result.status, 'profile_in_use');
      assert.equal(result.connected, false);
      assert.match(result.message, /关闭整个专用/);
      assert.match(result.message, /about:blank/);
      assert.match(result.message, /无需退出/);
    }
    const controlled = await adapter.openSession({ mode: 'controlled' });
    assert.equal(controlled.status, 'profile_in_use');
    assert.equal(launches, 0);
    assert.equal(context.state.newPageCalls, 0);
    assert.equal(context.state.closeCalls, 0, 'occupancy checks do not close an existing browser');
    assert.equal(adapter.context, null);
    assert.equal(probes.length, 3);
    assert.ok(probes.every(({ profileDir }) => profileDir === join(dataDir, 'browser-profile')));
  });
});

test('after the owner releases the profile, the initial blank page is reused to verify the account', async () => {
  let occupied = true;
  let launches = 0;
  const initial = pageFixture({ account: true });
  const context = contextFixture([initial]);
  await withAdapter({ profileOccupancyProbe: async () => ({ status: occupied ? 'in_use' : 'free', ownerCount: occupied ? 1 : 0 }),
    contextFactory: async () => { launches += 1; return context; } }, async (adapter) => {
    assert.equal((await adapter.getSessionStatus()).status, 'profile_in_use');
    occupied = false;
    const connected = await adapter.getSessionStatus();
    assert.equal(connected.status, 'authenticated');
    assert.equal(connected.connected, true);
    assert.equal(launches, 1);
    assert.equal(context.state.newPageCalls, 0);
    assert.equal(adapter.sessionPage, initial);
    assert.deepEqual(initial.state.visits, [accountUrl]);
    assert.equal(initial.state.closeCalls, 0);
  });
});

test('session-page reuse excludes monitor and booking pages even when they are blank', async () => {
  const monitor = pageFixture();
  const booking = pageFixture();
  const initial = pageFixture({ account: true });
  const context = contextFixture([monitor, booking, initial]);
  await withAdapter({ contextFactory: async () => context }, async (adapter) => {
    adapter.context = context;
    adapter.watchPages.set('monitor-fixture', monitor);
    adapter.bookingPages.set('booking-fixture', booking);
    const result = await adapter.openSession({ mode: 'controlled' });
    assert.equal(result.status, 'authenticated');
    assert.equal(adapter.sessionPage, initial);
    assert.equal(context.state.newPageCalls, 0);
    assert.deepEqual(monitor.state.visits, []);
    assert.deepEqual(booking.state.visits, []);
    assert.equal(monitor.state.closeCalls, 0);
    assert.equal(booking.state.closeCalls, 0);
  });
});

test('failed navigation cleans only the attempted blank page and cannot accumulate blank tabs', async () => {
  const monitor = pageFixture({ initialUrl: 'https://www.catchtable.net/shop/zest_seoul' });
  const initial = pageFixture({ failNavigation: true });
  const context = contextFixture([monitor, initial], () => pageFixture({ failNavigation: true }));
  let launches = 0;
  await withAdapter({ profileOccupancyProbe: async () => ({ status: 'free', ownerCount: 0 }),
    contextFactory: async () => { launches += 1; return context; } }, async (adapter) => {
    adapter.watchPages.set('monitor-fixture', monitor);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await adapter.getSessionStatus().catch(() => ({ status: 'unknown', connected: false }));
      assert.equal(result.connected, false);
      assert.equal(adapter.sessionPage, null);
      assert.deepEqual(context.pages(), [monitor]);
    }
    assert.equal(launches, 1, 'a navigation failure does not restart the same live context');
    assert.equal(context.state.newPageCalls, 1, 'the first attempt reused the launch-created blank');
    assert.equal(initial.state.closeCalls, 1);
    assert.ok(context.allPages.slice(1).every((page) => page.state.closeCalls === 1));
    assert.deepEqual(monitor.state.visits, []);
    assert.equal(monitor.state.closeCalls, 0);
    assert.equal(context.state.closeCalls, 0);
  });
});

test('an unknown occupancy result prevents launch without claiming authentication', async () => {
  let launches = 0;
  await withAdapter({ profileOccupancyProbe: async () => ({ status: 'unknown', ownerCount: 0 }),
    contextFactory: async () => { launches += 1; return contextFixture(); } }, async (adapter) => {
    adapter.browserMode = 'manual';
    adapter.lastSession = { status: 'manual_login', connected: false, browserOpen: true, browserMode: 'manual' };
    const result = await adapter.getSessionStatus();
    assert.equal(result.status, 'unknown');
    assert.equal(result.connected, false);
    assert.match(result.message, /无法确认/);
    assert.equal(launches, 0);
    assert.equal(adapter.context, null);
  });
});

test('the engine preserves task states when the cached connection reports profile_in_use', async () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const store = new Store(':memory:', { now: () => now });
  const engine = new Engine({ store, now: () => now, adapter: {
    getSessionStatus: async () => ({ status: 'profile_in_use', connected: false, browserOpen: true, browserMode: 'manual',
      message: 'Fixture profile occupied', guidance: ['Close the dedicated fixture window'], checkedAt: new Date(now).toISOString() }), close: async () => {},
  } });
  const tasks = ['paused', 'auth_required', 'user_action_required'].map((status) => ({ ...createTask({
    restaurantName: 'Fixture restaurant', restaurantUrl: 'https://www.catchtable.net/shop/local_fixture',
    dates: ['2030-01-02'], partySize: 2, timeStart: '18:00', timeEnd: '20:00', mode: 'notify',
    deadline: new Date(now + 60000).toISOString(),
  }, {}, now), status, resumeAfterAuth: status === 'auth_required' }));
  for (const task of tasks) store.saveTask(task);
  try {
    const result = await engine.sessionAction('check');
    assert.equal(result.session.status, 'profile_in_use');
    assert.equal(result.session.connected, false);
    for (const task of tasks) assert.deepEqual(store.getTask(task.id), task);
  } finally { await engine.stop(); store.close(); }
});
