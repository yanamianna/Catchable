import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { ExtensionBridge, redactExtensionPayload } from '../server/extension-bridge.mjs';
import { createHttpServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';

const pairing = 'fixture-pairing-only-do-not-use-in-production';
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
const hello = { type:'hello', userAgent:'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36', protocolVersion:'1.3' };
const target = { targetId:'tab-1', type:'page', title:'Local fixture', url:'https://www.catchtable.net/zh-CN/my/myMain', attached:true, browserContextId:'catchable-default' };

async function until(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'offline protocol event did not arrive'); await delay(5); }
}

async function connect(url, protocols, options = {}) {
  const socket = new WebSocket(url, protocols, options);
  await new Promise((done, failed) => { socket.once('open',done);socket.once('error',failed); });
  socket.on('error',()=>{});
  return socket;
}

async function refused(url, protocols, options = {}) {
  return new Promise((done, failed) => {
    const socket = new WebSocket(url,protocols,options);
    socket.on('error',()=>{});
    socket.once('open',()=>{socket.terminate();failed(new Error('unexpected WebSocket authorization'));});
    socket.once('unexpected-response',(_,response)=>{response.resume();socket.terminate();done(response.statusCode);});
  });
}

async function fixture(t, options = {}, http = false) {
  const bridge = await new ExtensionBridge({pairingCode:pairing,commandTimeoutMs:200,...options}).init();
  let store, engine;
  const selectedIntegrations=[];
  const server = http ? (()=>{
    store=new Store(':memory:');
    engine=new Engine({store,adapter:{inspect:async()=>({status:'unknown',slots:[]}),selectIntegration:async mode=>{
      selectedIntegrations.push(mode);return {status:'closed',connected:false,browserOpen:false,browserMode:mode};
    }}});
    return createHttpServer({store,engine,extensionBridge:bridge,port:0});
  })() : createServer((_,response)=>{response.writeHead(404);response.end();});
  if (!http) bridge.attach(server);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    await bridge.close();
    await new Promise(done=>server.close(done));
    if(engine)await engine.stop();
    store?.close();
  });
  return {bridge,server,origin,store,selectedIntegrations,workerUrl:origin.replace('http:','ws:')+'/extension'};
}

async function worker(f,handler) {
  const socket=await connect(f.workerUrl,['catchable',`pair.${pairing}`],{origin:extensionOrigin});
  const commands=[];
  const result=(command,value={})=>socket.send(JSON.stringify({type:'result',id:command.id,result:value}));
  const event=(method,params,sessionId)=>socket.send(JSON.stringify({type:'event',method,params,...(sessionId?{sessionId}:{})}));
  socket.on('message',data=>{
    const command=JSON.parse(data.toString());commands.push(command);
    if(handler)handler(command,{result,event,socket});
    else if(command.method==='Target.setAutoAttach') { event('Target.attachedToTarget',{sessionId:'session-1',targetInfo:target,waitingForDebugger:false});result(command); }
    else if(command.method==='Target.getTargets')result(command,{targetInfos:[target]});
    else if(command.method==='Target.getTargetInfo')result(command,{targetInfo:{targetId:'catchable-browser',type:'browser',title:'Catchable',url:'',attached:true,browserContextId:'catchable-default'}});
    else result(command);
  });
  socket.send(JSON.stringify(hello));
  await until(()=>f.bridge.state().connected);
  return {socket,commands,result,event};
}

test('pairing is persisted locally and excluded from bridge state',async t=>{
  const root=await mkdtemp(join(tmpdir(),'catchable-extension-key-fixture-'));
  t.after(async()=>{
    const absolute=resolve(root);
    assert.ok(absolute.startsWith(`${resolve(tmpdir())}${sep}`) && absolute.split(sep).at(-1).startsWith('catchable-extension-key-fixture-'));
    await rm(absolute,{recursive:true,force:true});
  });
  const one=await new ExtensionBridge({dataDir:root}).init();
  const two=await new ExtensionBridge({dataDir:root}).init();
  assert.ok(one.pairingInfo().pairingCode===two.pairingInfo().pairingCode);
  assert.match(one.pairingInfo().pairingCode,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(one.state()).includes(one.pairingInfo().pairingCode));
  await one.close();await two.close();
});

test('extension upgrade requires exact extension origin and pairing protocol',async t=>{
  const f=await fixture(t);
  assert.equal(await refused(f.workerUrl,['catchable',`pair.${pairing}`],{origin:'https://attacker.example'}),403);
  assert.equal(await refused(f.workerUrl,['catchable','pair.wrong-fixture-secret-value'],{origin:extensionOrigin}),403);
  assert.equal(await refused(f.workerUrl,['catchable',`pair.${pairing}`],{origin:`chrome-extension://${'z'.repeat(32)}`}),403);
  const w=await worker(f);
  assert.equal(w.socket.protocol,'catchable');
  assert.equal(f.bridge.state().connected,true);
  assert.ok(!JSON.stringify(f.bridge.state()).includes(pairing));
  assert.equal(await refused(f.bridge.getCdpEndpoint(),undefined,{origin:'http://127.0.0.1:4174'}),403);
  assert.equal(await refused(f.bridge.getCdpEndpoint().replace(/\/cdp\/.+$/,'/cdp/wrong'),undefined),403);
});

test('only localhost UI can obtain pairing; GET state never exposes secrets',async t=>{
  const f=await fixture(t,{},true);
  assert.equal((await fetch(f.origin+'/api/extension/pairing')).status,403);
  assert.equal((await fetch(f.origin+'/api/extension/pairing',{headers:{origin:'https://attacker.example','sec-fetch-site':'cross-site'}})).status,403);
  const response=await fetch(f.origin+'/api/extension/pairing',{headers:{origin:f.origin,'sec-fetch-site':'same-origin'}});
  assert.equal(response.status,200);
  const info=await response.json();
  assert.ok(info.pairingCode===pairing);
  assert.ok(info.extensionPath.endsWith('extension'));
  const state=await (await fetch(f.origin+'/api/state')).json();
  assert.equal(state.extension.connected,false);
  assert.ok(!JSON.stringify(state).includes(pairing));
  assert.equal((await fetch(f.origin+'/api/extension/pairing',{headers:{referer:f.origin+'/','sec-fetch-site':'same-origin'}})).status,200);
});

test('cookie/storage/browser-close commands and unrelated navigation fail before forwarding',async t=>{
  const f=await fixture(t);const w=await worker(f);
  await f.bridge.requestCDP('Target.setAutoAttach',{autoAttach:true,flatten:true});
  const before=w.commands.length;
  for(const [method,params,session] of [
    ['Storage.getCookies',{},undefined],['Storage.setCookies',{cookies:[]},undefined],
    ['Network.getAllCookies',{},'session-1'],['Network.getCookies',{},'session-1'],
    ['Browser.close',{},undefined],['Target.createBrowserContext',{},undefined],
    ['Runtime.evaluate',{expression:'document.cookie'},'session-1'],
    ['Runtime.evaluate',{expression:'window.localStorage.getItem("anything")'},'session-1'],
    ['Page.navigate',{url:'https://attacker.example/'},'session-1'],
    ['Target.closeTarget',{targetId:'personal-tab'},undefined],
    ['Unknown.acceptEverything',{},undefined],
  ]) await assert.rejects(f.bridge.requestCDP(method,params,session));
  assert.equal(w.commands.length,before);
});

test('response body access requires an observed official response; sensitive headers are removed',async t=>{
  const f=await fixture(t);const w=await worker(f);
  await f.bridge.requestCDP('Target.setAutoAttach',{autoAttach:true,flatten:true});
  await assert.rejects(f.bridge.requestCDP('Network.getResponseBody',{requestId:'unobserved'},'session-1'));
  w.event('Network.responseReceived',{requestId:'account-fixture',response:{url:'https://api.catchtable.net/api/v5/user/info',status:200,headers:{'Set-Cookie':'synthetic-secret','Content-Type':'application/json'}}},'session-1');
  await delay(10);
  await f.bridge.requestCDP('Network.getResponseBody',{requestId:'account-fixture'},'session-1');
  w.event('Network.responseReceived',{requestId:'auth-fixture',response:{url:'https://api.catchtable.net/api/v6/auth/email/login'}},'session-1');
  await delay(10);
  await assert.rejects(f.bridge.requestCDP('Network.getResponseBody',{requestId:'auth-fixture'},'session-1'));
  const cleaned=redactExtensionPayload({request:{headers:{Cookie:'synthetic-secret',Authorization:'synthetic-secret',Accept:'application/json'},postData:'synthetic-private'},response:{headers:{'Set-Cookie':'synthetic-secret',Date:'fixture'}},associatedCookies:[{cookie:{value:'synthetic-secret'}}],statusCode:200});
  assert.deepEqual(cleaned,{request:{headers:{Accept:'application/json'}},response:{headers:{Date:'fixture'}},statusCode:200});
});

test('timeouts and disconnect fail pending commands without replaying writes',async t=>{
  const f=await fixture(t,{commandTimeoutMs:40});
  const w=await worker(f,(command,api)=>{
    if(command.method==='Target.setAutoAttach'){api.event('Target.attachedToTarget',{sessionId:'session-1',targetInfo:target,waitingForDebugger:false});api.result(command);}
  });
  await f.bridge.requestCDP('Target.setAutoAttach',{autoAttach:true});
  await assert.rejects(f.bridge.requestCDP('Input.dispatchMouseEvent',{type:'mousePressed',x:1,y:1},'session-1'),error=>error.code==='EXTENSION_COMMAND_TIMEOUT');
  assert.equal(w.commands.filter(command=>command.method==='Input.dispatchMouseEvent').length,1);
  const pending=assert.rejects(f.bridge.requestCDP('Input.dispatchMouseEvent',{type:'mouseReleased',x:1,y:1},'session-1'),error=>error.code==='EXTENSION_DISCONNECTED');
  await until(()=>w.commands.filter(command=>command.method==='Input.dispatchMouseEvent').length===2);
  w.socket.close();await pending;
  assert.equal(w.commands.filter(command=>command.method==='Input.dispatchMouseEvent').length,2);
  assert.equal(f.bridge.state().connected,false);
});

test('Playwright connectOverCDP initializes through the virtual browser and disconnects without Browser.close',async t=>{
  const f=await fixture(t);const w=await worker(f,(command,api)=>{
    if(command.method==='Target.getTargetInfo')api.result(command,{targetInfo:{targetId:'catchable-browser',type:'browser',url:'',title:'Catchable',browserContextId:'catchable-default',attached:true}});
    else api.result(command);
  });
  const browser=await chromium.connectOverCDP(f.bridge.getCdpEndpoint(),{noDefaults:true,timeout:5000});
  assert.equal(browser.contexts().length,1);
  assert.equal(browser.contexts()[0].pages().length,0);
  await browser.close();
  assert.equal(f.bridge.state().connected,true);
  assert.equal(w.commands.some(command=>command.method==='Browser.close'),false);
});

test('virtual main-frame references are translated in frame trees, execution events and page commands',async t=>{
  const f=await fixture(t);
  const w=await worker(f,(command,api)=>{
    if(command.method==='Target.setAutoAttach'){
      api.event('Target.attachedToTarget',{sessionId:'session-1',targetInfo:target,waitingForDebugger:false});api.result(command);
    }else if(command.method==='Page.getFrameTree')api.result(command,{frameTree:{frame:{id:'native-frame-1',url:target.url,loaderId:'fixture-loader'}}});
    else if(command.method==='Page.navigate')api.result(command,{frameId:'native-frame-1',loaderId:'next-fixture-loader'});
    else api.result(command);
  });
  await f.bridge.requestCDP('Target.setAutoAttach',{autoAttach:true});
  const tree=await f.bridge.requestCDP('Page.getFrameTree',{},'session-1');
  assert.equal(tree.frameTree.frame.id,'tab-1');
  await f.bridge.requestCDP('Page.createIsolatedWorld',{frameId:'tab-1',worldName:'fixture-utility'},'session-1');
  assert.equal(w.commands.at(-1).params.frameId,'native-frame-1');
  const navigation=await f.bridge.requestCDP('Page.navigate',{url:target.url,frameId:'tab-1'},'session-1');
  assert.equal(navigation.frameId,'tab-1');
  const cdp=await connect(f.bridge.getCdpEndpoint());const messages=[];
  cdp.on('message',data=>messages.push(JSON.parse(data.toString())));
  w.event('Runtime.executionContextCreated',{context:{id:1,auxData:{frameId:'native-frame-1',isDefault:true}}},'session-1');
  await until(()=>messages.length>0);
  assert.equal(messages[0].params.context.auxData.frameId,'tab-1');
});

test('HTTP server shutdown also stops the attached extension bridge',{timeout:3000},async t=>{
  const f=await fixture(t,{},true);const w=await worker(f);
  const closed=new Promise(done=>w.socket.once('close',done));
  await new Promise(done=>f.server.close(done));await closed;
  assert.equal(f.bridge.state().connected,false);
  assert.equal(f.bridge.state().status,'closed');
});

test('HTTP integration setting validates the whole request before switching execution mode',async t=>{
  const f=await fixture(t,{},true);
  const desired=f.store.settings().browserIntegration==='extension'?'dedicated':'extension';
  const post=body=>fetch(f.origin+'/api/settings',{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({browserIntegration:'arbitrary-mode'})).status,400);
  assert.equal((await post({browserIntegration:desired,browserChannel:'firefox'})).status,400);
  assert.equal((await post({browserIntegration:desired,applyToExistingTasks:'yes'})).status,400);
  assert.equal(f.selectedIntegrations.length,0);
  const response=await post({browserIntegration:desired});assert.equal(response.status,200);
  assert.equal((await response.json()).settings.browserIntegration,desired);
  assert.deepEqual(f.selectedIntegrations,[desired]);
});

test('pairing diagnostics separate origin, protocol and key rejection without exposing request data',async t=>{
  const f=await fixture(t);
  const unsafeOrigin='https://do-not-expose-fixture.example';
  const wrongPair='wrong-fixture-pairing-do-not-expose';
  assert.equal(await refused(f.workerUrl,['catchable',`pair.${pairing}`],{origin:unsafeOrigin}),403);
  assert.equal(f.bridge.state().lastIssue.code,'origin_invalid');
  assert.equal(await refused(f.workerUrl,['catchable','unexpected-format'],{origin:extensionOrigin}),403);
  assert.equal(f.bridge.state().lastIssue.code,'protocol_invalid');
  assert.equal(await refused(f.workerUrl,['catchable',`pair.${wrongPair}`],{origin:extensionOrigin}),403);
  const issue=f.bridge.state().lastIssue;
  assert.equal(issue.code,'pairing_mismatch');assert.ok(Number.isFinite(Date.parse(issue.timestamp)));
  assert.equal(await refused(f.workerUrl+'?unexpected=1',['catchable','unexpected-format'],{origin:extensionOrigin}),403);
  assert.deepEqual(f.bridge.state().lastIssue,issue,'diagnostics are limited to the exact extension path');
  const serialized=JSON.stringify(f.bridge.state());
  for(const value of [pairing,wrongPair,unsafeOrigin,extensionOrigin,'unexpected-format'])assert.ok(!serialized.includes(value));
  await worker(f);assert.equal(f.bridge.state().lastIssue,null);
  assert.equal(await refused(f.workerUrl,['catchable',`pair.${pairing}`],{origin:extensionOrigin}),409);
  assert.equal(f.bridge.state().lastIssue.code,'already_connected');
  assert.equal(f.bridge.state().connected,true);
});

test('invalid hello and hello timeout retain their cause; successful hello clears issues before a later disconnect',async t=>{
  const f=await fixture(t,{handshakeTimeoutMs:250});
  const invalid=await connect(f.workerUrl,['catchable',`pair.${pairing}`],{origin:extensionOrigin});
  const invalidClosed=new Promise(done=>invalid.once('close',done));
  invalid.send(JSON.stringify({...hello,protocolVersion:'invalid-fixture-version'}));await invalidClosed;
  assert.equal(f.bridge.state().lastIssue.code,'hello_invalid');
  const silent=await connect(f.workerUrl,['catchable',`pair.${pairing}`],{origin:extensionOrigin});
  await new Promise(done=>silent.once('close',done));
  assert.equal(f.bridge.state().lastIssue.code,'hello_timeout');
  const w=await worker(f);assert.equal(f.bridge.state().lastIssue,null);
  w.socket.close();await until(()=>!f.bridge.state().connected);
  assert.equal(f.bridge.state().lastIssue.code,'worker_disconnected');
  assert.ok(!JSON.stringify(f.bridge.state()).includes(pairing));
});
