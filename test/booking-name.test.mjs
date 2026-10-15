import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillReservationName, readBookingFlowDom } from '../server/booking-flow.mjs';

const formUrl='https://www.catchtable.net/zh-CN/reservation/form';
function fixture(initial='',editable=true) {
  let value=initial;const fills=[];
  const locator={count:async()=>1,isVisible:async()=>true,inputValue:async()=>value,isEditable:async()=>editable,fill:async next=>{fills.push(next);value=next;}};
  const page={locator:selector=>{assert.equal(selector,'input:visible');return {nth:index=>{assert.equal(index,0);return locator;}};}};
  return {page,fills,value:()=>value,snapshot:{url:formUrl,nameFields:[{index:0,empty:!initial,readOnly:!editable,disabled:false}]}};
}

test('each reservation receives only its supplied snapshot name and never another account contact',async()=>{
  const a=fixture(),b=fixture();
  assert.equal(await fillReservationName(a.page,a.snapshot,'Synthetic Guest A'),'filled');
  assert.equal(await fillReservationName(b.page,b.snapshot,'Synthetic Guest B'),'filled');
  assert.equal(a.value(),'Synthetic Guest A');assert.equal(b.value(),'Synthetic Guest B');
  assert.deepEqual(a.fills,['Synthetic Guest A']);assert.deepEqual(b.fills,['Synthetic Guest B']);
  assert.equal(await fillReservationName(a.page,a.snapshot,'Synthetic Guest A'),'ready');assert.equal(a.fills.length,1);
});

test('ambiguous, readonly, disabled and non-reservation name fields never receive a write',async()=>{
  const f=fixture('Fixed account name',false);
  assert.equal(await fillReservationName(f.page,f.snapshot,'Different guest'),'blocked');
  assert.equal(await fillReservationName(f.page,f.snapshot,'Fixed account name'),'ready');
  assert.equal(await fillReservationName(f.page,{...f.snapshot,nameFields:[...f.snapshot.nameFields,...f.snapshot.nameFields]},'Different guest'),'blocked');
  assert.equal(await fillReservationName(f.page,{...f.snapshot,url:'https://www.catchtable.net/zh-CN/my/profile'},'Different guest'),'blocked');
  assert.equal(await fillReservationName(f.page,{...f.snapshot,url:'https://evil.invalid/reservation/form'},'Different guest'),'blocked');
  assert.equal(await fillReservationName(f.page,{...f.snapshot,nameFields:[]},'Different guest'),'absent');
  for(const name of ['',100,'A\nB','x'.repeat(101)])assert.equal(await fillReservationName(f.page,f.snapshot,name),'blocked');
  assert.deepEqual(f.fills,[]);
});

test('visible form DOM identifies a unique full-name field without exporting its contents or selecting phone/profile fields',async t=>{
  // Fresh headless context, all traffic fulfilled/aborted locally; no account,
  // browser profile, real identity or remote reservation is accessed.
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();const page=await context.newPage();
  await context.route('**/*',route=>route.request().resourceType()==='document'?route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>input{height:30px;width:200px}</style><main><section><h3>预约人姓名 *必填</h3><label>Full name<input autocomplete="name" value="Synthetic hidden fixture value"></label></section><section><h3>电话号码 *必填</h3><div><div>+82</div><input type="tel"></div></section></main>'}):route.abort());
  await page.goto(formUrl);
  let snapshot=await page.evaluate(readBookingFlowDom);
  assert.deepEqual(snapshot.nameFields,[{index:0,empty:false,readOnly:false,disabled:false}]);
  assert.ok(!JSON.stringify(snapshot.nameFields).includes('Synthetic hidden fixture value'));
  assert.equal(await fillReservationName(page,snapshot,'Synthetic frozen guest'),'filled');
  assert.equal(await page.locator('input[autocomplete="name"]').inputValue(),'Synthetic frozen guest');
  assert.equal(await page.locator('input[type="tel"]').inputValue(),'');
  await page.locator('input[autocomplete="name"]').fill('');snapshot=await page.evaluate(readBookingFlowDom);
  assert.ok(snapshot.missingRequiredFields.includes('预约姓名'));
  await page.locator('input[autocomplete="name"]').evaluate(element=>{element.readOnly=true;});snapshot=await page.evaluate(readBookingFlowDom);
  assert.equal(await fillReservationName(page,snapshot,'Synthetic frozen guest'),'blocked');
  await page.goto('https://www.catchtable.net/zh-CN/my/profile');
  assert.deepEqual((await page.evaluate(readBookingFlowDom)).nameFields,[]);
});
