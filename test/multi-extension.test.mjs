import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ExtensionBroker } from '../server/extension-bridge.mjs';
import { CatchtableAdapter, classifySessionSnapshots } from '../server/catchtable.mjs';
import { parseSessionEvidence, sessionIdentityFingerprint } from '../server/session-evidence.mjs';

const infoUrl='https://api.catchtable.net/api/v5/user/info?localeCode=zh-CN';
const official='https://www.catchtable.net/zh-CN/my/myMain';
const hello={type:'hello',userAgent:'Synthetic Chrome/150.0.0.0',protocolVersion:'1.3'};
const extensionOrigin=`chrome-extension://${'a'.repeat(32)}`;
async function until(predicate,timeout=5000) {
  const deadline=Date.now()+timeout;
  while(!predicate()){assert.ok(Date.now()<deadline,'isolated fixture did not settle');await delay(5);}
}
async function scratch(t) {
  const directory=await mkdtemp(join(tmpdir(),'catchable-multi-extension-fixture-'));
  t.after(async()=>{
    const absolute=resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir())+sep) && absolute.split(sep).at(-1).startsWith('catchable-multi-extension-fixture-'));
    await rm(absolute,{recursive:true,force:true});
  });
  return directory;
}
async function connect(url,pairing) {
  const socket=new WebSocket(url,['catchable',`pair.${pairing}`],{origin:extensionOrigin});
  socket.on('error',()=>{});
  await new Promise((done,failed)=>{socket.once('open',done);socket.once('error',failed);});
  return socket;
}
async function refused(url,pairing) {
  return new Promise((done,failed)=>{
    const socket=new WebSocket(url,['catchable',`pair.${pairing}`],{origin:extensionOrigin});
    socket.on('error',()=>{});
    socket.once('open',()=>{socket.terminate();failed(new Error('unexpected pairing authorization'));});
    socket.once('unexpected-response',(_,response)=>{response.resume();socket.terminate();done(response.statusCode);});
  });
}

test('50 paired extensions keep sockets, targets, response bodies and CDP endpoints isolated behind one upgrade listener',async t=>{
  const dataDir=await scratch(t);
  const broker=await new ExtensionBroker({dataDir,port:0,commandTimeoutMs:1000}).init();
  const accounts=['default',...Array.from({length:49},(_,i)=>`synthetic-${i+1}`)];
  await Promise.all(accounts.map(id=>broker.ensureAccount(id)));
  assert.equal(new Set(accounts.map(id=>broker.simplePairingInfo(id).pairingCode)).size,50);
  const server=createServer();broker.attach(server);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();await broker.close();await new Promise(done=>server.close(done));});
  assert.equal(server.listenerCount('upgrade'),1);
  const url=`ws://127.0.0.1:${server.address().port}/extension`;
  const target={targetId:'tab-10',type:'page',url:'https://www.catchtable.net/shop/synthetic',title:'Synthetic',attached:true,browserContextId:'catchable-default'};
  const labels=new Map();
  await Promise.all(accounts.map(async(id,index)=>{
    const bridge=broker.getBridge(id);bridge.setLabel(`Synthetic account ${index}`);
    const socket=await connect(url,(index%2?broker.pairingInfo(id):broker.simplePairingInfo(id)).pairingCode);sockets.push(socket);
    socket.on('message',data=>{
      const message=JSON.parse(data.toString());
      if(message.type==='hello_ack'){assert.equal(message.accountId,id);labels.set(id,message.accountLabel);return;}
      assert.equal(message.type,'command');
      socket.send(JSON.stringify({type:'result',id:message.id,result:{body:`fixture-${index}`,base64Encoded:false}}));
    });
    socket.send(JSON.stringify(hello));
    await until(()=>bridge.state().connected && labels.has(id));
    socket.send(JSON.stringify({type:'event',method:'Target.attachedToTarget',params:{sessionId:'same-session',targetInfo:target,waitingForDebugger:false}}));
    socket.send(JSON.stringify({type:'event',method:'Network.responseReceived',sessionId:'same-session',params:{requestId:'same-request',response:{url:'https://api.catchtable.net/api/v5/user/info',status:200}}}));
  }));
  await delay(25);
  const endpoints=accounts.map(id=>broker.getBridge(id).getCdpEndpoint());
  assert.equal(new Set(endpoints).size,50);
  await Promise.all(accounts.map(async(id,index)=>{
    const result=await broker.getBridge(id).requestCDP('Network.getResponseBody',{requestId:'same-request'},'same-session');
    assert.equal(result.body,`fixture-${index}`);
    assert.equal(labels.get(id),`Synthetic account ${index}`);
    assert.ok(!JSON.stringify(broker.state(id)).includes(broker.pairingInfo(id).pairingCode));
  }));
  const first=broker.getBridge('default');
  await first.close();
  await until(()=>!first.state().connected);
  assert.equal(accounts.slice(1).filter(id=>broker.state(id).connected).length,49);
  assert.equal((await broker.getBridge(accounts[1]).requestCDP('Network.getResponseBody',{requestId:'same-request'},'same-session')).body,'fixture-1');
  assert.equal(server.listenerCount('upgrade'),1);
});

test('short codes are plaintext, stable across restarts and preserve every existing legacy key',async t=>{
  const dataDir=await scratch(t);
  const legacy='synthetic_legacy_pairing_0123456789';
  await writeFile(join(dataDir,'extension-pairing.key'),`${legacy}\n`);
  const broker=await new ExtensionBroker({dataDir}).init();t.after(()=>broker.close());
  await broker.ensureAccount('second');
  const codes=new Map(['default','second'].map(id=>[id,broker.simplePairingInfo(id).pairingCode]));
  for(const [id,code] of codes){
    assert.match(code,/^\d{8}$/);
    const directory=id==='default'?dataDir:join(dataDir,'accounts',id);
    assert.equal(await readFile(join(directory,'extension-pairing.code'),'utf8'),`${code}\n`);
    assert.ok(!JSON.stringify(broker.state(id)).includes(code));
  }
  assert.notEqual(codes.get('default'),codes.get('second'));
  assert.equal(broker.pairingInfo().pairingCode,legacy);
  assert.equal(await readFile(join(dataDir,'extension-pairing.key'),'utf8'),`${legacy}\n`);
  await broker.close();
  const restarted=await new ExtensionBroker({dataDir}).init();t.after(()=>restarted.close());
  await restarted.ensureAccount('second');
  for(const [id,code] of codes)assert.equal(restarted.simplePairingInfo(id).pairingCode,code);
  assert.equal(restarted.pairingInfo().pairingCode,legacy);
});

test('short and legacy credentials route to one account and keep duplicate-connection protection',async t=>{
  const dataDir=await scratch(t);
  const broker=await new ExtensionBroker({dataDir,port:0}).init();
  await broker.ensureAccount('second');
  const server=createServer();broker.attach(server);await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const sockets=[];t.after(async()=>{for(const socket of sockets)socket.terminate();await broker.close();await new Promise(done=>server.close(done));});
  const url=`ws://127.0.0.1:${server.address().port}/extension`;
  for(const invalid of ['1234567','123456789','abcd1234'])assert.equal(await refused(url,invalid),403);
  const account='second',bridge=broker.getBridge(account),code=broker.simplePairingInfo(account).pairingCode;
  const shortSocket=await connect(url,code);sockets.push(shortSocket);
  const acknowledgements=[];shortSocket.on('message',data=>acknowledgements.push(JSON.parse(data.toString())));
  shortSocket.send(JSON.stringify(hello));await until(()=>bridge.state().connected && acknowledgements.length);
  assert.equal(acknowledgements[0].accountId,account);
  assert.equal(broker.state('default').connected,false);
  assert.equal(await refused(url,broker.pairingInfo(account).pairingCode),409);
  const other=await connect(url,broker.simplePairingInfo('default').pairingCode);sockets.push(other);other.send(JSON.stringify(hello));
  await until(()=>broker.state('default').connected);
  shortSocket.close();await until(()=>!bridge.state().connected);
  const legacySocket=await connect(url,broker.pairingInfo(account).pairingCode);sockets.push(legacySocket);legacySocket.send(JSON.stringify(hello));
  await until(()=>bridge.state().connected);
  assert.equal(await refused(url,code),409);
  assert.equal(broker.state('default').connected,true);
  assert.equal(server.listenerCount('upgrade'),1);
});

test('persisted duplicate short codes fail closed without replacing either account credential',async t=>{
  const dataDir=await scratch(t),second=join(dataDir,'accounts','second');
  await mkdir(second,{recursive:true});
  for(const directory of [dataDir,second])await writeFile(join(directory,'extension-pairing.code'),'12345678\n');
  const broker=new ExtensionBroker({dataDir});t.after(()=>broker.close());
  await assert.rejects(broker.init(),/重复/);
  for(const directory of [dataDir,second])assert.equal(await readFile(join(directory,'extension-pairing.code'),'utf8'),'12345678\n');
});

test('default uses the unchanged legacy key and account creation is explicit, concurrent-safe and confined',async t=>{
  const dataDir=await scratch(t);
  const legacy='synthetic_legacy_pairing_0123456789';
  const bytes=`${legacy}\n`;await writeFile(join(dataDir,'extension-pairing.key'),bytes);
  const broker=await new ExtensionBroker({dataDir}).init();
  t.after(()=>broker.close());
  assert.equal(broker.pairingInfo().pairingCode,legacy);
  assert.equal(await readFile(join(dataDir,'extension-pairing.key'),'utf8'),bytes);
  const [a,b]=await Promise.all([broker.ensureAccount('synthetic'),broker.ensureAccount('synthetic')]);
  assert.equal(a,b);assert.notEqual(a.pairingInfo().pairingCode,legacy);
  assert.equal((await readFile(join(dataDir,'accounts','synthetic','extension-pairing.key'),'utf8')).trim(),a.pairingInfo().pairingCode);
  assert.throws(()=>broker.getBridge('not-created'),/初始化/);
  for(const id of ['../outside','x/y','x\\y','','..'])await assert.rejects(broker.ensureAccount(id),/标识/);
  await broker.close();
  const restarted=await new ExtensionBroker({dataDir}).init();t.after(()=>restarted.close());
  assert.equal(restarted.pairingInfo().pairingCode,legacy);
  assert.equal((await restarted.ensureAccount('synthetic')).pairingInfo().pairingCode,a.pairingInfo().pairingCode);
});

class AuthPage extends EventEmitter {
  constructor(){super();this.frame={};}
  mainFrame(){return this.frame;}
  waitForResponse(){return Promise.resolve(null);}
  isClosed(){return false;}
  url(){return official;}
  evaluate(){return Promise.resolve({url:official,text:'Synthetic account',loading:false,accountEvidence:{kind:'profile',label:'Stale UI'}});}
  async info(adapter,body){
    const request={method:()=> 'GET',url:()=>infoUrl,isNavigationRequest:()=>false,frame:()=>this.frame};
    this.emit('request',request);
    this.emit('response',{url:()=>infoUrl,status:()=>200,request:()=>request,json:async()=>body});
    await adapter.authStates.get(this).pending;
  }
}

class NavigatingAuthPage extends AuthPage {
  constructor(identity,{scheduled}={}){super();this.identity=identity;this.scheduled=scheduled;this.closed=false;this.address='about:blank';}
  url(){return this.address;}
  isClosed(){return this.closed;}
  close(){this.closed=true;return Promise.resolve();}
  waitForResponse(predicate){return new Promise(done=>{const listener=response=>{if(predicate(response)){this.off('response',listener);done(response);}};this.on('response',listener);});}
  async goto(url){
    this.address=url;
    const request={method:()=> 'GET',url:()=>infoUrl,isNavigationRequest:()=>false,frame:()=>this.frame};
    this.emit('request',request);
    this.emit('response',{url:()=>infoUrl,status:()=>200,request:()=>request,json:async()=>({isLogin:true,ctUserIdentifier:this.identity,displayName:'Synthetic'}),finished:async()=>null});
    if(this.scheduled!==undefined)this.emit('response',{url:()=> 'https://api.catchtable.net/api/v6/my-dining/scheduled?page=0&size=10',status:()=>200,request:()=>({method:()=> 'GET'}),json:async()=>this.scheduled,finished:async()=>null});
  }
  evaluate(){return Promise.resolve({url:this.address,text:'Synthetic account',loading:false,accountEvidence:{kind:'profile',label:'Stale UI'},cards:[],headings:[],buttons:[],summaries:[],links:[],dialogs:[]});}
}
function bindingVerifier(accountId,owners) {
  let bound;
  return async fingerprint=>{
    if((bound && bound!==fingerprint) || (owners.has(fingerprint) && owners.get(fingerprint)!==accountId))throw Object.assign(new Error('Synthetic identity mismatch'),{code:'IDENTITY_MISMATCH'});
    bound=fingerprint;owners.set(fingerprint,accountId);
  };
}

test('official identities are stable internally; changed or duplicate identities stop only the affected adapter without disclosure',async()=>{
  const owners=new Map();
  const adapters=['a','b'].map(id=>new CatchtableAdapter({identityVerifier:bindingVerifier(id,owners)}));
  const pages=adapters.map(()=>new AuthPage());
  for(const [index,adapter] of adapters.entries()) {adapter.context={pages:()=>[pages[index]]};adapter.sessionPage=pages[index];await adapter.observeSession();}
  const body={isLogin:true,ctUserIdentifier:'synthetic-user-001',displayName:'Fixture account'};
  const digest=sessionIdentityFingerprint(infoUrl,200,body);
  assert.match(digest,/^[a-f0-9]{64}$/);
  assert.equal(sessionIdentityFingerprint(infoUrl,200,{...body,displayName:'Changed nickname'}),digest);
  assert.equal(sessionIdentityFingerprint(infoUrl,200,{isLogin:false,ctUserIdentifier:body.ctUserIdentifier}),null);
  assert.equal(sessionIdentityFingerprint('https://evil.invalid/api/v5/user/info',200,body),null);
  assert.deepEqual(parseSessionEvidence(infoUrl,200,body),{status:'authenticated',accountLabel:'Fixture account'});
  await pages[0].info(adapters[0],body);assert.equal((await adapters[0].observeSession()).status,'authenticated');
  await pages[1].info(adapters[1],body);assert.equal((await adapters[1].observeSession()).status,'identity_mismatch');
  assert.equal((await adapters[0].observeSession()).connected,true);
  await pages[0].info(adapters[0],{...body,ctUserIdentifier:'synthetic-user-002'});
  const failed=await adapters[0].observeSession();assert.equal(failed.status,'identity_mismatch');assert.equal(failed.connected,false);
  assert.ok(!JSON.stringify(failed).includes(digest));assert.ok(!JSON.stringify(failed).includes(body.ctUserIdentifier));
  adapters[0].bookingPages.set('synthetic',pages[0]);assert.equal(adapters[0].isBookingAuthenticated('synthetic'),false);
  assert.equal((await adapters[0].prepare({id:'synthetic'},{date:'2030-01-01',time:'13:00',partySize:2})).phase,'authentication');
  assert.equal(classifySessionSnapshots([{url:official,primary:true,serverAuthRequired:true,serverAuth:{status:'authenticated'}},{url:official,booking:true,serverAuthRequired:true,serverAuth:{status:'identity_mismatch'}}]).status,'identity_mismatch');
});

test('new-page verification awaits identity validation and cannot inherit the primary page identity',async()=>{
  const owners=new Map();const adapter=new CatchtableAdapter({identityVerifier:bindingVerifier('a',owners)});
  const primary=new NavigatingAuthPage('synthetic-primary');
  const pages=[primary];adapter.context={pages:()=>pages,newPage:async()=>{const page=new NavigatingAuthPage('synthetic-other');pages.push(page);return page;}};
  const result=await adapter.getSessionStatus();
  assert.equal(result.status,'identity_mismatch');assert.equal(result.connected,false);assert.equal(result.newTabVerified,undefined);
  assert.equal((await adapter.observeSession()).status,'identity_mismatch');
  assert.equal(pages[1].isClosed(),true,'only the newly created test page is closed');assert.equal(primary.isClosed(),false);
});

test('a complete matching order response remains unknown when that order page has a different authenticated identity',async()=>{
  const owners=new Map();const adapter=new CatchtableAdapter({identityVerifier:bindingVerifier('a',owners)});
  const primary=new AuthPage();adapter.sessionPage=primary;
  const task={id:'synthetic-order-task',restaurantName:'Synthetic Restaurant',restaurantUrl:'https://www.catchtable.net/shop/synthetic',dates:['2030-01-02'],partySize:2,timeStart:'13:00',timeEnd:'13:00',mode:'auto',autoConsent:true};
  const slot={date:'2030-01-02',time:'13:00',partySize:2};
  const scheduled={hasNext:false,list:[{reservationType:'DINING',reservationInfo:{reservationRef:'synthetic-order-001',visitDateTime:'2030-01-02T13:00:00+09:00',totalPersonCount:2,isConfirmationPending:false},localizedShopPreview:{alias:'synthetic',shopRef:'synthetic-shop',shopName:task.restaurantName}}]};
  let orderIdentity='synthetic-owner';const pages=[primary];
  adapter.context={on:()=>{},pages:()=>pages,newPage:async()=>{const page=new NavigatingAuthPage(orderIdentity,{scheduled});pages.push(page);return page;}};
  await adapter.observeSession();await primary.info(adapter,{isLogin:true,ctUserIdentifier:'synthetic-owner',displayName:'Synthetic'});
  const attempt={id:'synthetic-attempt',task,slot,status:'pending_restaurant',submitted:true};
  assert.equal((await adapter.reconcile(attempt)).status,'confirmed');
  orderIdentity='synthetic-other';
  const result=await adapter.reconcile(attempt);
  assert.equal(result.status,'outcome_unknown');assert.equal(result.reservationId,undefined);
  assert.equal((await adapter.observeSession()).status,'identity_mismatch');
});
