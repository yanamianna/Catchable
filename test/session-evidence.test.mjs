import test from 'node:test';
import assert from 'node:assert/strict';
import {isOfficialUserInfo,parseSessionEvidence} from '../server/session-evidence.mjs';
import {CatchtableAdapter,classifySessionSnapshots} from '../server/catchtable.mjs';
import {Engine} from '../server/engine.mjs';
import {Store} from '../server/store.mjs';

const url='https://api.catchtable.net/api/v5/user/info?localeCode=zh-CN';
test('only the exact normal account endpoint supplies server session evidence',()=>{
  assert.equal(isOfficialUserInfo(url),true);
  for(const value of ['http://api.catchtable.net/api/v5/user/info','https://evil.example/api/v5/user/info',`${url}&localeCode=en`,`${url}&token=private`,'https://api.catchtable.net/api/v5/shop/detail'])assert.equal(isOfficialUserInfo(value),false,value);
});
test('fresh isLogin and an identity are necessary; only the display name leaves the parser',()=>{
  assert.deepEqual(parseSessionEvidence(url,200,{isLogin:true,ctUserIdentifier:'private-fixture-id',displayName:'Fixture account',token:'unused'}),{status:'authenticated',accountLabel:'Fixture account'});
  for(const body of [{name:'Old name'},{isLogin:true},{isLogin:true,ctUserIdentifier:''},{isLogin:'true',ctUserIdentifier:'id'},{data:{isLogin:true,ctUserIdentifier:'id'}}])assert.deepEqual(parseSessionEvidence(url,200,body),{status:'unknown'});
  assert.deepEqual(parseSessionEvidence(url,200,{isLogin:false,ctUserIdentifier:'stale',name:'Old name'}),{status:'unauthenticated'});
  for(const status of [401,403])assert.deepEqual(parseSessionEvidence(url,status,null),{status:'unauthenticated'});
  assert.deepEqual(parseSessionEvidence(url,500,{isLogin:true,ctUserIdentifier:'id'}),{status:'unknown'});
});
test('a cached nickname cannot override failed or negative fresh account verification',()=>{
  const page={url:'https://www.catchtable.net/zh-CN/my/myMain',primary:true,text:'Old nickname\n编辑个人资料',accountEvidence:{kind:'profile',label:'Old nickname'},serverAuthRequired:true};
  for(const status of ['unknown','unauthenticated']) {
    const result=classifySessionSnapshots([{...page,serverAuth:{status}}]);
    assert.equal(result.status,status);assert.equal(result.connected,false);
  }
  assert.equal(classifySessionSnapshots([{...page,serverAuth:{status:'authenticated',accountLabel:'Fresh account'}}]).accountLabel,'Fresh account');
});
test('a newly opened unauthenticated booking page overrides an old authenticated account page',()=>{
  const account={url:'https://www.catchtable.net/zh-CN/my/myMain',primary:true,serverAuthRequired:true,serverAuth:{status:'authenticated',accountLabel:'Fixture'}};
  for(const status of ['unknown','unauthenticated']) {
    const booking={url:'https://www.catchtable.net/zh-CN/shop/fixture',booking:true,serverAuthRequired:true,serverAuth:{status}};
    const result=classifySessionSnapshots([account,booking]);
    assert.equal(result.status,status);assert.equal(result.connected,false);
  }
});

test('account diagnostics distinguish a guest response from a request rejected by the website',()=>{
  const page={url:'https://www.catchtable.net/zh-CN/my/myMain',primary:true,serverAuthRequired:true};
  for(const [evidenceReason,status,message] of [
    ['guest_response','unauthenticated',/200.*isLogin=false/],
    ['http_401','unauthenticated',/401/],
    ['http_403','unknown',/403.*被官网拒绝/],
  ]) {
    const result=classifySessionSnapshots([{...page,serverAuth:{status:'unauthenticated',evidenceReason}}]);
    assert.equal(result.status,status);assert.equal(result.connected,false);assert.match(result.message,message);
  }
});

test('background observation preserves a successful new-page check and clears it on failure or disconnect',async()=>{
  const checkedAt='2030-01-01T00:00:00.000Z';
  const official='https://www.catchtable.net/zh-CN/my/myMain';
  let snapshot={url:official,text:'Fixture account',accountEvidence:{kind:'profile',label:'Fixture account'}};
  const page={isClosed:()=>false,url:()=>official,evaluate:async()=>snapshot};
  const adapter=new CatchtableAdapter();
  const context={pages:()=>[page]};adapter.context=context;adapter.sessionPage=page;
  adapter.newTabAuth={status:'authenticated',checkedAt};
  const verified=await adapter.observeSession();
  assert.equal(verified.status,'authenticated');assert.equal(verified.newTabVerified,true);assert.equal(verified.newTabCheckedAt,checkedAt);
  assert.equal(verified.message,'当前账号及新页面均已通过官方会话核验，可以自动订座。');
  snapshot={url:official,text:'登录或注册'};
  const failed=await adapter.observeSession();
  assert.equal(failed.status,'unauthenticated');assert.equal(failed.newTabVerified,undefined);assert.equal(failed.newTabCheckedAt,undefined);assert.equal(adapter.newTabAuth,null);
  snapshot={url:official,text:'Fixture account',accountEvidence:{kind:'profile',label:'Fixture account'}};
  assert.equal((await adapter.observeSession()).newTabVerified,undefined,'a later account-only observation cannot inherit the old new-page success');
  adapter.newTabAuth={status:'authenticated',checkedAt};adapter.context=null;
  const disconnected=await adapter.observeSession();assert.equal(disconnected.status,'closed');assert.equal(disconnected.newTabVerified,undefined);assert.equal(adapter.newTabAuth,null);
  adapter.context=context;assert.equal((await adapter.observeSession()).newTabVerified,undefined);
});

test('engine exposes new-page verification only from the current authenticated result',async()=>{
  const store=new Store(':memory:');const engine=new Engine({store,adapter:{close:async()=>{}}});
  const checkedAt='2030-01-01T00:00:00.000Z';
  try {
    const verified=engine.applySession({status:'authenticated',newTabVerified:true,newTabCheckedAt:checkedAt});
    assert.equal(verified.newTabVerified,true);assert.equal(verified.newTabCheckedAt,checkedAt);
    const accountOnly=engine.applySession({status:'authenticated'});
    assert.equal(accountOnly.newTabVerified,undefined);assert.equal(accountOnly.newTabCheckedAt,undefined);
    for(const status of ['closed','connecting','unknown','unauthenticated']) {
      const failed=engine.applySession({status,newTabVerified:true,newTabCheckedAt:checkedAt});
      assert.equal(failed.newTabVerified,undefined);assert.equal(failed.newTabCheckedAt,undefined);
    }
    assert.equal(engine.applySession({status:'authenticated',newTabVerified:'true',newTabCheckedAt:checkedAt}).newTabVerified,undefined);
  }finally {await engine.stop();store.close();}
});
