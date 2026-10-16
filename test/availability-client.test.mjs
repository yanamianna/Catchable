import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readOfficialAvailabilityQuery } from '../server/availability-client.mjs';

const build='20261015000000';
const input={alias:'fixture_shop',shopRef:'fixture-shop-reference',date:'2026-12-24',partySize:2,visitTime:'1400'};
const row={date:'2026-12-24',time:'1430',personCount:2,shopRef:input.shopRef,isAvailable:true,tableType:''};
const clean={timeSlotState:'OK',timeSlotList:[row]};
const moduleUrl=(name,version=build)=>`https://www.catchtable.net/static/appjs/prod/${version}/build/${name}.js`;
const clientModule=`export const V={post:async(url,body,config)=>{
  window.fixtureCalls.push({url,body,headers:config.headers,timeout:config.timeout,signal:config.signal instanceof AbortSignal,aborted:config.signal.aborted});
  if(window.fixture.awaitAbort)return new Promise((_,reject)=>config.signal.addEventListener('abort',()=>{window.abortedCalls=(window.abortedCalls||0)+1;reject(new DOMException('fixture canceled','AbortError'));},{once:true}));
  if(window.fixture.errorStatus)throw {response:{status:window.fixture.errorStatus},message:'private-auth-message',authorization:'private-auth-value'};
  return {data:window.fixture.response};
}};`;
const encoderModule=`export const t=input=>{window.encoderCalls.push(input);return {fixtureEncoded:true,normalParameters:input}};`;

async function pageFixture(t,browser,{url='https://www.catchtable.net/zh-CN/shop/fixture_shop',encoderBuild=build,response=clean,errorStatus,duplicateClient=false}={}) {
  const context=await browser.newContext();t.after(()=>context.close());
  const clientUrl=moduleUrl('locale.util_fixture');
  const encoderUrl=moduleUrl('apiDataEncrypt.util_fixture',encoderBuild);
  const secondClient=moduleUrl('locale.util_second');
  const loaded=[];const blocked=[];
  await context.route('**/*',async route=>{
    const requestUrl=route.request().url();
    if(requestUrl===url)return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><script>window.fixture=${JSON.stringify({response,errorStatus})};window.fixtureCalls=[];window.encoderCalls=[];</script><script type="module">import '${clientUrl}';import '${encoderUrl}';${duplicateClient?`import '${secondClient}';`:''}window.fixtureReady=true;</script>`});
    if([clientUrl,secondClient].includes(requestUrl)){loaded.push(requestUrl);return route.fulfill({status:200,contentType:'text/javascript',body:clientModule});}
    if(requestUrl===encoderUrl){loaded.push(requestUrl);return route.fulfill({status:200,contentType:'text/javascript',body:encoderModule});}
    blocked.push(requestUrl);return route.abort('blockedbyclient');
  });
  const page=await context.newPage();await page.goto(url);await page.waitForFunction(()=>window.fixtureReady===true);
  return {page,loaded,blocked,calls:()=>page.evaluate(()=>window.fixtureCalls)};
}

test('official availability helper uses only loaded site modules and a fixed read-only route',{timeout:60000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  await t.test('cold dates use the original encoder and client with a bounded abortable request',async t=>{
    const f=await pageFixture(t,browser);
    // Chrome can report an actually loaded module as "other" on the live site.
    await f.page.evaluate(()=>{
      const entries=performance.getEntriesByType.bind(performance);
      Object.defineProperty(performance,'getEntriesByType',{value:type=>entries(type).map(entry=>entry.name.includes('/locale.util_')?{name:entry.name,initiatorType:'other'}:entry)});
    });
    assert.deepEqual(await f.page.evaluate(readOfficialAvailabilityQuery,input),{kind:'result',data:clean});
    assert.deepEqual(await f.page.evaluate(()=>window.encoderCalls),[{shopRef:input.shopRef,searchDate:input.date,visitTime:'1400',personCount:2}]);
    assert.deepEqual(await f.calls(),[{url:'/api/v5/shop/timeslot-enc',body:{fixtureEncoded:true,normalParameters:{shopRef:input.shopRef,searchDate:input.date,visitTime:'1400',personCount:2}},headers:{shopRef:input.shopRef},timeout:10000,signal:true,aborted:false}]);
    assert.equal(f.loaded.length,2);assert.deepEqual(f.blocked,[]);
  });
  await t.test('wrong aliases, invalid input and mismatched loaded builds cannot issue a query',async t=>{
    const f=await pageFixture(t,browser);
    for(const changes of [{alias:'other_shop'},{date:'2026-02-30'},{partySize:0},{visitTime:'2400'},{visitTime:'14:00'},{url:'https://other.example/'}]) {
      assert.deepEqual(await f.page.evaluate(readOfficialAvailabilityQuery,{...input,...changes}),{kind:'unsupported'});
    }
    assert.deepEqual(await f.calls(),[]);
    const mismatched=await pageFixture(t,browser,{encoderBuild:'20261014000000'});
    assert.deepEqual(await mismatched.page.evaluate(readOfficialAvailabilityQuery,input),{kind:'unsupported'});assert.deepEqual(await mismatched.calls(),[]);
    const ambiguous=await pageFixture(t,browser,{duplicateClient:true});
    assert.deepEqual(await ambiguous.page.evaluate(readOfficialAvailabilityQuery,input),{kind:'unsupported'});assert.deepEqual(await ambiguous.calls(),[]);
  });
  await t.test('only inventory fields leave the page and oversized responses are rejected',async t=>{
    const f=await pageFixture(t,browser,{response:{...clean,resp2:'private-token',authorization:'private-token',timeSlotList:[{...row,resp2:'private-token',headers:{cookie:'private-token'}}]}});
    const result=await f.page.evaluate(readOfficialAvailabilityQuery,input);
    assert.deepEqual(result,{kind:'result',data:clean});assert.equal(JSON.stringify(result).includes('private-token'),false);
    await f.page.evaluate(value=>{window.fixture.response={timeSlotState:'OK',timeSlotList:Array(501).fill(value)};},row);
    assert.deepEqual(await f.page.evaluate(readOfficialAvailabilityQuery,input),{kind:'error'});
  });
  await t.test('HTTP failures return only safe status and never trigger automatic retries',async t=>{
    for(const errorStatus of [401,403,429,500]) {
      const f=await pageFixture(t,browser,{errorStatus});
      const result=await f.page.evaluate(readOfficialAvailabilityQuery,input);
      assert.deepEqual(result,{kind:errorStatus===401?'auth_required':'error',httpStatus:errorStatus});
      assert.equal((await f.calls()).length,1);assert.equal(JSON.stringify(result).includes('private-auth'),false);
    }
  });
  await t.test('timeout aborts the original request and settles without starting another query',async t=>{
    const f=await pageFixture(t,browser);
    await f.page.evaluate(()=>{
      window.fixture.awaitAbort=true;
      const nativeTimeout=window.setTimeout.bind(window);
      window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===10000?20:delay,...args);
    });
    assert.deepEqual(await f.page.evaluate(readOfficialAvailabilityQuery,input),{kind:'error'});
    assert.equal(await f.page.evaluate(()=>window.abortedCalls),1);assert.equal((await f.calls()).length,1);
  });
});
