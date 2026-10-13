import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CatchtableAdapter} from '../server/catchtable.mjs';
import {Engine} from '../server/engine.mjs';
import {Store} from '../server/store.mjs';

test('manual login and controlled launch bind to one selected Chrome and its isolated application profile',async()=>{
  const root=mkdtempSync(join(tmpdir(),'catchable-browser-binding-'));
  const calls=[];
  const context={pages:()=>[],on:()=>{},close:async()=>{},newPage:async()=>{throw new Error('No navigation needed in this binding fixture');}};
  const adapter=new CatchtableAdapter({dataDir:root,browserChannel:'chrome',profileOccupancyProbe:async()=>({status:'free',ownerCount:0}),
    manualBrowserLauncher:async input=>{calls.push({kind:'manual',...input});return {browserName:'Google Chrome',channel:'chrome'};},
    contextFactory:async input=>{calls.push({kind:'controlled',...input});return context;}});
  try {
    const opened=await adapter.openSession();assert.equal(opened.browserName,'Google Chrome');assert.equal(opened.profileLabel,'Chrome 专用会话');
    await adapter.getSessionStatus().catch(()=>{});
    assert.equal(calls.length,2);assert.equal(calls[0].channel,'chrome');assert.equal(calls[1].channel,'chrome');
    assert.equal(calls[0].profileDir,join(root,'browser-profiles','chrome'));assert.equal(calls[0].profileDir,calls[1].profileDir);
    await adapter.selectBrowser('msedge');assert.equal(adapter.profileDir,join(root,'browser-profile'));
    assert.notEqual(adapter.profileDir,calls[0].profileDir);
  }finally {
    await adapter.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+ '\\'));rmSync(root,{recursive:true,force:true});
  }
});
test('selected browser is restored from settings after a server restart and switching never resumes a paused engine',async()=>{
  const store=new Store(':memory:');store.saveSettings({browserChannel:'chrome',enginePaused:true});
  const first=new CatchtableAdapter({dataDir:'fixture-browser-settings'});
  const engine=new Engine({store,adapter:first});
  try {
    assert.equal(first.browserChannel,'chrome');assert.equal(engine.session.browserName,'Google Chrome');
    await engine.changeBrowser('msedge');assert.equal(store.settings().browserChannel,'msedge');assert.equal(store.settings().enginePaused,true);
    assert.equal(engine.session.connected,false);
    const restored=new CatchtableAdapter({dataDir:'fixture-browser-settings'});
    const restarted=new Engine({store,adapter:restored});assert.equal(restored.browserChannel,'msedge');await restarted.stop();
  }finally {await engine.stop();store.close();}
});

test('a started browser without a visible window is not reported as a ready login window',async()=>{
  const adapter=new CatchtableAdapter({dataDir:'fixture-browser-settings',browserChannel:'chrome',
    manualBrowserLauncher:async()=>{throw Object.assign(new Error('Chrome 进程已创建，但没有显示登录窗口。'),{code:'MANUAL_WINDOW_NOT_VISIBLE'});}});
  const result=await adapter.openSession();
  assert.equal(result.status,'closed');
  assert.equal(result.connected,false);
  assert.equal(result.browserOpen,false);
  assert.equal(result.browserName,'Google Chrome');
  assert.match(result.message,/没有显示登录窗口/);
  assert.match(result.guidance.join(' '),/没有确认到可见登录窗口/);
  assert.doesNotMatch(result.message,/已打开/);
});
