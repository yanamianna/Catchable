import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {connectExtensionContext} from '../server/extension-context.mjs';
import {CatchtableAdapter} from '../server/catchtable.mjs';
import {Engine} from '../server/engine.mjs';
import {Store} from '../server/store.mjs';

function page() {
  const events=new EventEmitter();let closed=false;
  return {on:(...args)=>events.on(...args),isClosed:()=>closed,setDefaultTimeout:()=>{},
    close:async()=>{closed=true;events.emit('close');}};
}

test('the extension context exposes and closes only controller-created tabs, never personal pages or the default context',async()=>{
  const personal=page();const owned=page();let defaultClose=0;let transportClose=0;
  const browserEvents=new EventEmitter();
  const rawContext={pages:()=>[personal,owned],newPage:async()=>owned,close:async()=>{defaultClose++;}};
  const browser={contexts:()=>[rawContext],on:(...args)=>browserEvents.on(...args),close:async()=>{transportClose++;browserEvents.emit('disconnected');}};
  const bridge={state:()=>({connected:true}),getCdpEndpoint:()=> 'ws://127.0.0.1/isolated-fixture'};
  const browserType={connectOverCDP:async(endpoint,options)=>{assert.equal(endpoint,'ws://127.0.0.1/isolated-fixture');assert.equal(options.noDefaults,true);return browser;}};
  const context=await connectExtensionContext({bridge,browserType});
  assert.deepEqual(context.pages(),[]);
  await context.newPage();assert.deepEqual(context.pages(),[owned]);
  await context.close();await context.close();
  assert.equal(owned.isClosed(),true);assert.equal(personal.isClosed(),false);assert.equal(defaultClose,0);assert.equal(transportClose,1);
});

test('an extension disconnect stops new tab creation and clears the connected context',async()=>{
  const browserEvents=new EventEmitter();let newPages=0;let closes=0;
  const browser={contexts:()=>[{newPage:async()=>{newPages++;return page();}}],on:(...args)=>browserEvents.on(...args),close:async()=>{}};
  const context=await connectExtensionContext({bridge:{state:()=>({connected:true}),getCdpEndpoint:()=> 'ws://127.0.0.1/fixture'},browserType:{connectOverCDP:async()=>browser}});
  context.on('close',()=>{closes++;});browserEvents.emit('disconnected');
  await assert.rejects(context.newPage(),/已断开/);assert.equal(newPages,0);assert.equal(closes,1);assert.deepEqual(context.pages(),[]);
  await assert.rejects(connectExtensionContext({bridge:{state:()=>({connected:false})}}),/尚未连接/);
});

test('connection failures never expose the private local CDP endpoint in application messages',async()=>{
  await assert.rejects(connectExtensionContext({bridge:{state:()=>({connected:true}),getCdpEndpoint:()=> 'ws://127.0.0.1/cdp/private-fixture-key'},
    browserType:{connectOverCDP:async()=>{throw new Error('connection failed ws://127.0.0.1/cdp/private-fixture-key');}}}),
    error=>/连接未完成/.test(error.message) && !error.message.includes('private-fixture-key') && !error.message.includes('ws://'));
});

test('extension mode never launches another browser or asks the user to close Chrome, and preserves paused tasks',async()=>{
  let launched=0;let probed=0;
  const bridge={state:()=>({connected:false})};
  const adapter=new CatchtableAdapter({extensionBridge:bridge,
    manualBrowserLauncher:async()=>{launched++;},profileOccupancyProbe:async()=>{probed++;}});
  const store=new Store(':memory:');store.saveSettings({enginePaused:true});
  const engine=new Engine({store,adapter});
  try {
    assert.equal(store.settings().browserIntegration,'extension');assert.equal(engine.session.browserMode,'extension');
    const opened=await engine.sessionAction('open',{mode:'manual'});
    assert.equal(opened.session.connected,false);assert.match(opened.session.message,/扩展尚未连接/);
    assert.equal(opened.session.profileLabel,'当前 Chrome 登录资料');assert.equal(opened.session.browserMode,'extension');
    assert.equal(launched,0);assert.equal(probed,0);assert.equal(store.settings().enginePaused,true);
    assert.doesNotMatch(opened.session.guidance.join(' '),/关闭.*Chrome|关闭.*窗口/);
  }finally {await engine.stop();store.close();}
});
