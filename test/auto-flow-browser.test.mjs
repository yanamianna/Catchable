import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CatchtableAdapter } from '../server/catchtable.mjs';

// Browser plugin is not separately provided in this session. Use the installed
// Edge channel in a fresh headless context. Every HTTP request is fulfilled or
// aborted locally; no actual account, reservation, browser profile or API is used.
const task = { id: 'offline-browser-task', restaurantName: 'Offline Fixture Restaurant', restaurantUrl: 'https://www.catchtable.net/shop/offline_fixture', dates: ['2026-10-13'], partySize: 2, timeStart: '13:00', timeEnd: '13:00', mode: 'auto', autoConsent: true };
const slot = { date: '2026-10-13', time: '13:00', partySize: 2 };
const id = 'offline-fixture-order-001';
const shop = { shopRef: 'offline-fixture-shop-001', alias: 'offline_fixture', shopName: task.restaurantName };
const detailPath = `/zh-CN/customer/reservation/detail/${id}`;
const apiDetail = `https://api.catchtable.net/api/v5/reservation/detail?reservationRef=${id}&localeCode=ZH_CN`;
const apiShop = `https://api.catchtable.net/api/v5/shop/detail?shopRef=${shop.shopRef}`;
const css = '<style>body{font:16px Arial;padding:24px}button{padding:12px;margin:8px} [role="dialog"]{padding:20px;border:1px solid #ccc} [role="button"]{width:90px;height:50px;padding:8px;border:1px solid #ddd;display:inline-block}[hidden]{display:none!important}</style><script>fetch("https://api.catchtable.net/api/v5/user/info?localeCode=zh-CN",{credentials:"include"})</script>';

function shopHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><main><h2>${task.restaurantName}</h2><button id="open">日期 • 时间 • 人</button><button id="main-slot" hidden aria-label="2026-10-13 13:00 request">下午 1:00</button><div id="notice-host"></div></main><script>
    const mainSlot=document.querySelector('#main-slot');
    document.querySelector('#open').onclick=async()=>{
      await window.fixtureTrack('calendar-open');mainSlot.hidden=true;
      const calendar=document.createElement('div');calendar.setAttribute('role','dialog');
      calendar.innerHTML='<button class="rounded-full" aria-pressed="false">2</button><div role="button" aria-label="2026年10月13日" aria-pressed="false">13</div><button id="filter-slot">下午1:00</button>';
      calendar.querySelector('button.rounded-full').onclick=async(event)=>{event.currentTarget.setAttribute('aria-pressed','true');await window.fixtureTrack('party-selected')};
      calendar.querySelector('[role="button"]').onclick=async(event)=>{event.currentTarget.setAttribute('aria-pressed','true');await window.fixtureTrack('date-selected')};
      calendar.querySelector('#filter-slot').onclick=async()=>{await window.fixtureTrack('calendar-filter-slot');calendar.remove();mainSlot.hidden=false};document.body.append(calendar);
    };
    mainSlot.onclick=async()=>{
      await window.fixtureTrack('main-slot-open');mainSlot.hidden=true;
      const host=document.querySelector('#notice-host');
      host.innerHTML='<div style="position:fixed;inset:0;z-index:999;display:grid;place-items:center;background:rgba(0,0,0,.35)"><div style="padding:24px;background:white"><div><h2>在App中体验更佳</h2><p>离线 App 推广卡片</p></div><button id="promo-close" aria-label="close">×</button><button id="promo-later">稍后</button><button id="promo-app">使用App继续</button></div></div>';
      host.querySelector('#promo-close').onclick=async()=>{await window.fixtureTrack('promo-close')};
      host.querySelector('#promo-app').onclick=async()=>{await window.fixtureTrack('promo-app')};
      host.querySelector('#promo-later').onclick=async()=>{
        await window.fixtureTrack('promo-later');
        host.innerHTML='<section role="dialog"><h2>您今天想去参观吗？</h2><p>请再次检查您的日程安排</p><h3>${task.restaurantName}</h3><p>Meat • Hongdae</p><p>10.13(周二)</p><p>下午 1:00</p><p>2</p><p>当天取消和未到会可能不仅会影响餐厅，还会影响其他顾客</p><button>取消</button><button id="same-day-next">下一步</button></section>';
        document.querySelector('#same-day-next').onclick=async()=>{
          await window.fixtureTrack('same-day-next');
          host.innerHTML='<section role="dialog"><div><h2>需要确认</h2><p>餐厅确认后才会完成预约。此处时间为信息样例。</p><button id="request">请求</button></div></section>';
          document.querySelector('#request').onclick=async()=>{await window.fixtureTrack('notice-request');location.assign('/zh-CN/reservation/form')};
        };
      };
    };
  </script></body></html>`;
}
function formHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><main><h2>${task.restaurantName}</h2><p>10.13 (Tue) · 13:00 · 2人</p><p>Total: ₩0</p><label>预约人<input required value="Offline Fixture" /></label><section><h3>电话号码<span>*必填</span></h3><div><div id="country"><span>+1</span></div><input type="tel" /></div></section><div id="countries"></div><button id="checkout" disabled>Checkout</button></main><script>
    document.querySelector('label input').oninput=async()=>{await window.fixtureTrack('name-filled')};
    const phone=document.querySelector('input[type="tel"]');
    const country=document.querySelector('#country');
    country.onclick=async()=>{
      await window.fixtureTrack('country-open');
      const host=document.querySelector('#countries');host.innerHTML='<section role="dialog"><input type="text" required placeholder="搜索" /><button type="button"><span>China</span><span>+86</span></button></section>';
      host.querySelector('button').onclick=async()=>{await window.fixtureTrack('country-select');country.querySelector('span').textContent='+86';host.querySelector('input').value='';setTimeout(()=>{host.innerHTML=''},300)};
    };
    phone.oninput=async()=>{await window.fixtureTrack('phone-filled');document.querySelector('#checkout').disabled=!phone.value.trim()};
    document.querySelector('#checkout').onclick=async()=>{await window.fixtureTrack('checkout-click',{phone:phone.value,country:country.innerText});await fetch('https://api.catchtable.net/api/v5/reservation/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixture:true})});location.assign('${detailPath}')};
  </script></body></html>`;
}
function detailHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><main><h2>${task.restaurantName}</h2><p>2026-10-13</p><p>Time: 13:00</p><p>Party size: 2 people</p><h3 id="status">Loading</h3></main><script>
    Promise.all([fetch('${apiDetail}').then(r=>r.json()),fetch('${apiShop}').then(r=>r.json())]).then(([detail])=>{document.querySelector('#status').textContent=detail.reservation.isConfirmingReservation?'Checking':'Confirmed'});
  </script></body></html>`;
}
function scheduledHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><main>Offline scheduled records</main><script>fetch('https://api.catchtable.net/api/v6/my-dining/scheduled?page=0&size=10&localeCode=ZH_CN').then(r=>r.json()).then(()=>window.fixtureTrack('scheduled-read'));</script></body></html>`;
}

test('offline browser completes calendar filter, visible-text shop slot, nested notice and one persisted free request, then verifies the same order', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Seoul' });
  const trace = []; const external = []; const pageErrors = [];
  let persisted = false; let persistCount = 0; let createCount = 0; let pending = true;
  let signedIn=true;let submittedContact=null;
  let simulatedLostClickAcknowledgement=false;
  await context.exposeBinding('fixtureTrack', (_source, event, contact) => { trace.push(event);if(event==='checkout-click')submittedContact=contact; });
  context.on('page', page => {
    page.on('pageerror', error => pageErrors.push(error.message));
    const locator=page.locator.bind(page);
    page.locator=(selector,options)=>{
      const result=locator(selector,options);
      if(selector==='button:visible') {
        const filter=result.filter.bind(result);
        result.filter=options=>{
          const selected=filter(options),click=selected.click.bind(selected);
          selected.click=async options=>{
            await click(options);
            if(!simulatedLostClickAcknowledgement) {
              simulatedLostClickAcknowledgement=true;
              throw new Error('locator.click: Timeout after the actual informational modal opened');
            }
          };
          return selected;
        };
      }
      return result;
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (url.origin === 'https://api.catchtable.net') {
      if(url.pathname==='/api/v5/user/info')return route.fulfill({status:200,contentType:'application/json',headers:{...cors,'Access-Control-Allow-Origin':'https://www.catchtable.net','Access-Control-Allow-Credentials':'true'},body:JSON.stringify(signedIn?{isLogin:true,ctUserIdentifier:'offline-user',displayName:'Offline Fixture User'}:{isLogin:false})});
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === '/api/v5/reservation/create') {
        trace.push('api-create'); createCount += 1;
        assert.equal(persisted, true, 'persistent callback must finish before submission reaches the server');
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ reservationRef: id }) });
      }
      if (url.pathname === '/api/v5/reservation/detail') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ reservation: { reservationRef: id, shopRef: shop.shopRef, visitDateTime: '2026-10-13T13:00:00+09:00', personCount: 2, isConfirmingReservation: pending, isDeclined: false, isCancelled: false, isNoShow: false, isVisitCompleted: false } }) });
      if (url.pathname === '/api/v5/shop/detail') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(shop) });
      if (url.pathname === '/api/v6/my-dining/scheduled') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ list: createCount ? [{ reservationType: 'DINING', reservationInfo: { reservationRef: id, visitDateTime: '2026-10-13T13:00:00+09:00', totalPersonCount: 2, isConfirmationPending: pending }, localizedShopPreview: shop }] : [], hasNext: false }) });
    }
    if (url.origin === 'https://www.catchtable.net' && request.resourceType() === 'document') {
      const html = url.pathname === '/zh-CN/shop/offline_fixture' ? shopHtml() : url.pathname === '/zh-CN/reservation/form' ? formHtml() : url.pathname === detailPath ? detailHtml() : url.pathname === '/zh-CN/my-dining/scheduled' ? scheduledHtml() : `<!doctype html><head>${css}</head><main><section><h4>Old cached nickname</h4><button>Edit Profile</button></section></main>`;
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    external.push(request.url()); return route.abort('blockedbyclient');
  });
  const identities=new Set();let identityChecks=0;
  const adapter = new CatchtableAdapter({identityVerifier:async fingerprint=>{assert.match(fingerprint,/^[a-f0-9]{64}$/);identities.add(fingerprint);identityChecks++;assert.equal(identities.size,1);}}); adapter.context = context;
  const onBeforeSubmit=async()=>{trace.push('persist');persistCount+=1;persisted=true;};
  const initial=await adapter.prepare(task,slot,{onBeforeSubmit});
  assert.equal(initial.status,'user_action_required');assert.equal(initial.phase,'required_fields');
  assert.equal(initial.submitted,false);assert.deepEqual(initial.diagnostics.missingRequiredFields,['电话号码']);
  assert.equal(createCount,0);assert.equal(persistCount,0,'an empty mandatory phone must not reach the write boundary');
  assert.equal(simulatedLostClickAcknowledgement,true,'an already opened next step must survive a lost slot-click acknowledgement');
  await adapter.bookingPages.get(task.id).locator('input[type="tel"]').evaluate(element=>{element.value='2025550199';});
  const result = await adapter.continueAttempt({id:'offline-attempt',taskSnapshot:task,slot,status:initial.status,phase:initial.phase,submitted:false},
    {onBeforeSubmit,bookingContact:{countryCode:'+86',phoneNumber:'13800000000',fullName:'Offline Authorized Guest'}});
  assert.equal(result.status, 'pending_restaurant', JSON.stringify({ result, trace, pageErrors }));
  assert.equal(result.reservationId, id);
  assert.equal(persistCount, 1); assert.equal(createCount, 1);
  assert.deepEqual(submittedContact,{country:'+86',phone:'13800000000'},'an existing website prefill must not override the original attempt contact');
  for (const event of ['calendar-filter-slot', 'main-slot-open', 'promo-later', 'same-day-next', 'notice-request', 'name-filled', 'country-open', 'country-select', 'phone-filled', 'checkout-click']) assert.equal(trace.filter(value => value === event).length, 1, event);
  assert.ok(identityChecks>=3,'booking form and independent official order pages each validate the bound account identity');
  assert.ok(!JSON.stringify(result).includes('Offline Authorized Guest'));
  assert.equal(trace.filter(value => value === 'promo-close' || value === 'promo-app').length, 0, 'only the scoped Later button may dismiss the promo');
  assert.ok(trace.indexOf('calendar-filter-slot') < trace.indexOf('main-slot-open'));
  assert.ok(trace.indexOf('main-slot-open') < trace.indexOf('notice-request'));
  assert.ok(trace.indexOf('main-slot-open') < trace.indexOf('promo-later'));
  assert.ok(trace.indexOf('promo-later') < trace.indexOf('notice-request'));
  assert.ok(trace.indexOf('promo-later') < trace.indexOf('same-day-next'));
  assert.ok(trace.indexOf('same-day-next') < trace.indexOf('notice-request'));
  assert.ok(trace.indexOf('persist') < trace.indexOf('checkout-click'));
  assert.ok(trace.indexOf('checkout-click') < trace.indexOf('api-create'));
  pending = false;
  const confirmed = await adapter.reconcile({ id: 'offline-attempt', taskSnapshot: task, slot, status: 'pending_restaurant', submitted: true, reservationId: id });
  assert.equal(confirmed.status, 'confirmed', 'periodic verification must read the later official state instead of returning cached pending');
  assert.equal(confirmed.reservationId, id); assert.equal(createCount, 1, 'verification must never create or click Checkout again');
  signedIn=false;
  const guest=await adapter.prepare(task,slot,{onBeforeSubmit,bookingContact:{countryCode:'+86',phoneNumber:'13800000000'}});
  assert.equal(guest.phase,'authentication');assert.equal(guest.submitted,false);
  assert.equal(createCount,1,'a cached successful account cannot authorize an unauthenticated new booking document');
  const verifier=new CatchtableAdapter();verifier.context=context;
  signedIn=true;
  const good=await verifier.getSessionStatus();assert.equal(good.status,'authenticated');assert.equal(good.newTabVerified,true);
  signedIn=false;
  const expired=await verifier.getSessionStatus();assert.equal(expired.status,'unauthenticated');assert.equal(expired.connected,false);
  assert.equal(createCount,1,'connection checks and expired cached nicknames must remain read only');
  assert.deepEqual(external, []); assert.deepEqual(pageErrors, []);
});
