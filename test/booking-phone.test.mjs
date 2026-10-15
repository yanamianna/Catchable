import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fillReservationPhone} from '../server/booking-flow.mjs';

const contact={countryCode:'+86',phoneNumber:'13800000000'};
const formUrl='https://www.catchtable.net/zh-CN/reservation/form';

function form({number='2025550199',country='+1',readonly=false,disabled=false,duplicate=false,recognised=true,formatted=false,noPhone=false}={}) {
  return `<!doctype html><meta charset="utf-8"><style>input{height:30px;width:220px}button,#country{padding:12px}</style>
    <main><section>${recognised?'<h3>电话号码 *必填</h3>':''}<div><div id="country">${country}</div>${noPhone?'':`<input type="tel" value="${number}" ${readonly?'readonly':''} ${disabled?'disabled':''}>`}</div></section>
    ${duplicate?'<label>Mobile number<input type="tel" value="3035550199"></label>':''}<div id="countries"></div></main>
    <script>
      window.fixtureWrites={phone:0,country:0};
      const phone=document.querySelector('input[type="tel"]');
      if(phone)phone.oninput=()=>{window.fixtureWrites.phone++;${formatted?'if(phone.value.length===11)phone.value=phone.value.slice(0,3)+"-"+phone.value.slice(3,7)+"-"+phone.value.slice(7);':''}};
      document.querySelector('#country').onclick=()=>{
        const host=document.querySelector('#countries');host.innerHTML='<section role="dialog"><input placeholder="搜索"><button><span>China</span><span>+86</span></button></section>';
        host.querySelector('button').onclick=()=>{window.fixtureWrites.country++;document.querySelector('#country').textContent='+86';host.innerHTML=''};
      };
    </script>`;
}

test('reservation phone privately replaces stale prefill and avoids repeated writes; ambiguous or readonly mismatch blocks',async t=>{
  // Browser plugin is unavailable. A fresh Edge context fulfils every document
  // locally; this fixture never uses an actual account, profile or order.
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();const page=await context.newPage();
  let fixture=form();const external=[];const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await context.route('**/*',route=>{
    if(route.request().resourceType()==='document')return route.fulfill({status:200,contentType:'text/html',body:fixture});
    external.push(route.request().url());return route.abort();
  });
  const load=async(options={},url=formUrl)=>{fixture=form(options);await page.goto(url);};
  const writes=()=>page.evaluate(()=>window.fixtureWrites);

  await t.test('existing different number and country are changed once to the attempt contact',async()=>{
    await load();const steps=[];
    assert.equal(await fillReservationPhone(page,contact,{onStep:step=>steps.push(step)}),'filled');
    assert.equal(await page.locator('input[type="tel"]').inputValue(),contact.phoneNumber);
    assert.equal(await page.locator('#country').innerText(),contact.countryCode);
    assert.deepEqual(await writes(),{phone:1,country:1});
    assert.equal(await fillReservationPhone(page,contact),'ready');
    assert.deepEqual(await writes(),{phone:1,country:1},'a re-read must not refill or reopen the country picker');
    assert.ok(!JSON.stringify(steps).includes(contact.phoneNumber));
  });
  await t.test('formatted matching input is accepted without filling',async()=>{
    await load({number:'138-0000-0000',country:'+86',readonly:true});
    assert.equal(await fillReservationPhone(page,contact),'ready');assert.deepEqual(await writes(),{phone:0,country:0});
    await load({formatted:true});
    assert.equal(await fillReservationPhone(page,contact),'filled');
    assert.equal(await fillReservationPhone(page,contact),'ready');assert.deepEqual(await writes(),{phone:1,country:1});
  });
  await t.test('readonly and disabled differences never edit the phone or country',async()=>{
    for(const flags of [{readonly:true},{disabled:true},{readonly:true,number:contact.phoneNumber,country:'+1'}]) {
      await load(flags);assert.equal(await fillReservationPhone(page,contact),'blocked');
      assert.deepEqual(await writes(),{phone:0,country:0});
    }
  });
  await t.test('duplicate and unlabelled telephone fields are not silently accepted',async()=>{
    for(const flags of [{duplicate:true},{recognised:false}]) {
      await load(flags);assert.equal(await fillReservationPhone(page,contact),'blocked');assert.deepEqual(await writes(),{phone:0,country:0});
    }
  });
  await t.test('profile pages and malformed contacts never receive prefill',async()=>{
    await load({},'https://www.catchtable.net/zh-CN/my/profile');
    assert.equal(await fillReservationPhone(page,contact),'blocked');assert.deepEqual(await writes(),{phone:0,country:0});
    await load();
    for(const invalid of [{...contact,countryCode:'+0'},{...contact,phoneNumber:'138-0000-0000'},{...contact,phoneNumber:13800000000},null])assert.equal(await fillReservationPhone(page,invalid),'blocked');
    assert.deepEqual(await writes(),{phone:0,country:0});
  });
  await t.test('forms with no phone field do not invent a field or write',async()=>{
    await load({noPhone:true});assert.equal(await fillReservationPhone(page,contact),'absent');assert.deepEqual(await writes(),{phone:0,country:0});
  });
  assert.deepEqual(external,[]);assert.deepEqual(pageErrors,[]);
});
