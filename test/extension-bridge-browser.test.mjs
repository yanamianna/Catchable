import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { ExtensionBridge } from '../server/extension-bridge.mjs';
import { parseSessionEvidence } from '../server/session-evidence.mjs';

const fixturePairing='fixture-browser-protocol-only-do-not-use';
const accountUrl='https://api.catchtable.net/api/v5/user/info?localeCode=zh-CN';
const pageUrl='https://www.catchtable.net/zh-CN/my/myMain';
const fakeAccount={isLogin:true,ctUserIdentifier:'fixture-account-001',name:'Fixture Account',displayName:'Fixture Account'};

function chromeEvent() {
  const listeners=[];
  return {addListener(listener){listeners.push(listener);},emit(...args){for(const listener of listeners)listener(...args);},listeners};
}

async function waitFor(predicate,timeout=5000) {
  const deadline=Date.now()+timeout;
  while(!predicate()){assert.ok(Date.now()<deadline,'isolated extension fixture timed out');await delay(10);}
}

// Exercise the shipped worker with synthetic chrome.tabs/debugger APIs backed by
// a fresh headless Chrome. Every page request is fulfilled locally, including
// the invented account JSON. No user's browser, profile, or real account is used.
test('shipped worker + Node bridge + real Playwright page produce DOM and fresh fake account evidence, preserving unrelated tabs', {timeout:45000}, async t=>{
  let nativeBrowser;
  try {nativeBrowser=await chromium.launch({channel:'chrome',headless:true});}
  catch(error){if(/Executable doesn't exist|not found|not installed/i.test(error.message)){t.skip('Official Chrome is unavailable for the isolated fixture.');return;}throw error;}
  t.after(async()=>{if(nativeBrowser.isConnected())await nativeBrowser.close();});
  const nativeContext=await nativeBrowser.newContext();
  await nativeContext.route('**/*',async route=>{
    if(route.request().url()===accountUrl){
      return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'https://www.catchtable.net','access-control-allow-credentials':'true'},body:JSON.stringify(fakeAccount)});
    }
    return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><head><title>Only local synthetic fixture</title></head><body><main><section><h4 id="account">Loading fixture</h4><button>Edit Profile</button></section></main><script>fetch('${accountUrl}',{credentials:'include'}).then(response=>response.json()).then(account=>{document.getElementById('account').textContent=account.displayName;});</script></body></html>`});
  });
  const unrelated=await nativeContext.newPage();
  const pages=new Map([[900,{id:900,page:unrelated,url:'about:blank',title:'Unrelated synthetic tab'}]]);
  const nativeSessions=new Map();
  const commands=[];
  let nextTab=1;
  const events={debuggerEvent:chromeEvent(),debuggerDetach:chromeEvent(),updated:chromeEvent(),removed:chromeEvent(),created:chromeEvent(),runtime:chromeEvent()};
  const local={},session={};
  const chrome={
    runtime:{id:'a'.repeat(32),onMessage:events.runtime},
    storage:{
      local:{async get(keys){return typeof keys==='string'?{[keys]:local[keys]}:{...keys,...local};},async set(values){Object.assign(local,values);}},
      session:{async get(keys){return typeof keys==='string'?{[keys]:session[keys]}:{...keys,...session};},async set(values){Object.assign(session,values);}},
    },
    tabs:{
      onUpdated:events.updated,onRemoved:events.removed,onCreated:events.created,
      async get(id){const tab=pages.get(id);if(!tab||tab.page.isClosed())throw new Error('Synthetic tab closed');return {id,url:tab.url,title:tab.title};},
      async create({url}){
        const page=await nativeContext.newPage();const id=nextTab++;
        const tab={id,page,url:'about:blank',title:'Synthetic assistant tab'};pages.set(id,tab);
        page.on('framenavigated',frame=>{if(frame===page.mainFrame()){tab.url=frame.url();events.updated.emit(id,{url:tab.url},{id,url:tab.url,title:tab.title});}});
        if(url!=='about:blank')await page.goto(url);
        return {id,url:tab.url,title:tab.title};
      },
      async remove(id){const tab=pages.get(id);if(tab){await tab.page.close();pages.delete(id);events.removed.emit(id);}},
      async update(id){return chrome.tabs.get(id);},
    },
    debugger:{
      onEvent:events.debuggerEvent,onDetach:events.debuggerDetach,
      async attach({tabId}){
        const tab=pages.get(tabId);assert.ok(tab && tabId!==900,'worker must never attach unrelated synthetic tab');
        const client=await nativeContext.newCDPSession(tab.page);nativeSessions.set(tabId,client);
        for(const method of [
          'Page.frameAttached','Page.frameDetached','Page.frameNavigated','Page.navigatedWithinDocument','Page.lifecycleEvent','Page.frameRequestedNavigation','Page.javascriptDialogOpening','Page.javascriptDialogClosed','Page.windowOpen','Page.screencastFrame',
          'Runtime.executionContextCreated','Runtime.executionContextDestroyed','Runtime.executionContextsCleared','Runtime.bindingCalled','Runtime.consoleAPICalled','Runtime.exceptionThrown',
          'Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.loadingFinished','Network.loadingFailed','Network.requestServedFromCache',
          'Log.entryAdded','Target.attachedToTarget','Target.detachedFromTarget','Inspector.targetCrashed','Inspector.detached',
        ])client.on(method,params=>events.debuggerEvent.emit({tabId},method,params));
      },
      async detach({tabId}){const client=nativeSessions.get(tabId);nativeSessions.delete(tabId);if(client)await client.detach();events.debuggerDetach.emit({tabId},'synthetic_expected_detach');},
      async sendCommand({tabId,sessionId},method,params){
        assert.equal(sessionId,undefined,'this single-frame fixture has no native child session');
        commands.push({tabId,method});
        const client=nativeSessions.get(tabId);if(!client)throw new Error('Synthetic debugger is detached');
        return client.send(method,params);
      },
    },
  };
  const bridge=await new ExtensionBridge({pairingCode:fixturePairing,commandTimeoutMs:8000}).init();
  const server=createServer((_,response)=>{response.writeHead(404);response.end();});bridge.attach(server);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const workerUrl=`ws://127.0.0.1:${server.address().port}/extension`;
  class LocalWorkerWebSocket extends WebSocket {
    constructor(url,protocols){assert.equal(url,'ws://127.0.0.1:4174/extension');super(workerUrl,protocols,{origin:`chrome-extension://${chrome.runtime.id}`});}
  }
  const context=vm.createContext({chrome,WebSocket:LocalWorkerWebSocket,navigator:{userAgent:'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36'},URL,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){},error(){},warn(){}}});
  vm.runInContext(await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8'),context,{filename:'isolated-service-worker-fixture.js'});
  async function message(value){return new Promise(done=>{assert.equal(events.runtime.listeners.length,1);events.runtime.listeners[0](value,{id:chrome.runtime.id},done);});}
  let remoteBrowser;
  t.after(async()=>{
    await message({type:'disconnect'}).catch(()=>{});
    if(remoteBrowser?.isConnected())await remoteBrowser.close();
    await bridge.close();await new Promise(done=>server.close(done));
    await nativeBrowser.close();
  });
  assert.equal((await message({type:'connect',pairingCode:fixturePairing})).ok,true);
  await waitFor(()=>bridge.state().connected);
  remoteBrowser=await chromium.connectOverCDP(bridge.getCdpEndpoint(),{noDefaults:true,timeout:10000});
  const remoteContext=remoteBrowser.contexts()[0];assert.ok(remoteContext);
  assert.equal(remoteContext.pages().length,0);
  const page=await remoteContext.newPage();
  const accountResponse=page.waitForResponse(response=>response.url()===accountUrl,{timeout:10000});
  await page.goto(pageUrl,{waitUntil:'domcontentloaded',timeout:10000});
  const response=await accountResponse;
  const evidence=parseSessionEvidence(response.url(),response.status(),await response.json());
  assert.deepEqual(evidence,{status:'authenticated',accountLabel:'Fixture Account'});
  await page.getByRole('heading',{name:'Fixture Account',exact:true}).waitFor({timeout:10000});
  assert.equal(await page.locator('main > section h4').innerText(),'Fixture Account');
  assert.equal(await page.evaluate(()=>new Date().getTimezoneOffset()),-540);
  await page.close();await remoteBrowser.close();
  assert.equal(unrelated.isClosed(),false);
  assert.equal(nativeBrowser.isConnected(),true);
  assert.equal(bridge.state().connected,true);
  assert.equal(commands.some(command=>command.method==='Browser.close'),false);
  assert.equal(commands.some(command=>/cookie|^Storage\./i.test(command.method)),false);
});
