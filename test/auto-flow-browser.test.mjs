import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CatchtableAdapter } from '../server/catchtable.mjs';
import { answerReservationNoChoices } from '../server/reservation-options.mjs';

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
const noticeRows=[
  '当餐桌满座时，每桌最大使用时间为2小时。',
  '如果所有桌位都已满，客人可以被安排坐在吧台。',
  '如果您下一个预约迟到超过15分钟，可能无法提供座位。(如有变更，请提前与我们联系。)',
  '2小时内停车费3,000日元，此后每增加10分钟收费1,000日元。',
];
function restaurantNoticeHtml(){return `<section role="dialog" aria-modal="true"><div><h2>注意事项</h2></div><div><div>${noticeRows.map((text,index)=>`<button type="button" class="flex items-start gap-[10px]" data-fixture-notice-row="${index}" style="display:flex;align-items:flex-start;gap:10px"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="h-[20px] w-[20px] shrink-0 text-[${index===0?'#ff3d00':'#d5d5d5'}]" style="width:20px;height:20px;color:${index===0?'#ff3d00':'#d5d5d5'}"><rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor"></rect><path d="M7 11.803 10.476 15 17 9" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg><span class="text-left text-[14px] text-black leading-[20px]">${text}</span></button>`).join('')}</div><div><span>请仔细阅读餐厅的注意事项</span><p>Please call the store if you want to make a reservation for 9 or more persons.\n\nSeat selection is not available. </p></div><div><button type="button">取消</button><button type="button" id="restaurant-notice-next" class="h-[48px] rounded-[6px] bg-[#f1f1f1] text-[#c8c8c8] border border-solid border-[#f1f1f1]"><span class="font-bold text-[14px]">下一步</span></button></div></div></section>`;}
const questionConfigs=[{question:'饮食限制或过敏',selected:null},{question:'是否需要儿童座椅',selected:'no'},{question:'是否庆祝特别日子',selected:'yes'}];
function questionGroupsHtml(configs=questionConfigs){return configs.map(({question,selected=null,duplicateNo=false,unknown=false},index)=>`<section class="flex flex-col gap-[16px] px-[20px]" data-fixture-question="${index}"><span class="font-bold text-[18px] leading-[150%]"><span>${question}</span><span class="ml-[4px] whitespace-nowrap text-[#ff3d00] text-[12px]"><span class="font-bold">*</span><span class="ml-[2px] font-normal">必填</span></span></span><div class="flex flex-col">${['yes','no',...(duplicateNo?['no']:[])].map(value=>`<button type="button" class="flex flex-1 items-center gap-[8px] py-[8px] text-left" data-fixture-choice="${value}" style="display:flex;align-items:center;gap:8px"><span class="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full border bg-white border-[${selected===value?'#ff3d00':'#c4c4c4'}]" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:1px solid ${selected===value?'#ff3d00':'#c4c4c4'};border-radius:50%"><span class="h-[12px] w-[12px] rounded-full bg-[${unknown?'#888888':selected===value?'#ff3d00':'#c4c4c4'}]" style="display:block;width:12px;height:12px;background:${unknown?'#888888':selected===value?'#ff3d00':'#c4c4c4'};border-radius:50%"></span></span><span class="text-[14px]">${value==='yes'?'是':'否'}</span></button>`).join('')}</div>${selected==='yes'?'<textarea placeholder="请填写相关说明">Unsubmitted fixture detail</textarea>':''}</section>`).join('');}
function installQuestionControls(root,onChange,track){
  for(const section of root.querySelectorAll('[data-fixture-question]'))for(const button of section.querySelectorAll('[data-fixture-choice]'))button.onclick=async()=>{
    const value=button.dataset.fixtureChoice;
    for(const option of section.querySelectorAll('[data-fixture-choice]')){
      const color=option===button?'#ff3d00':'#c4c4c4',outer=option.firstElementChild,inner=outer.firstElementChild;
      outer.setAttribute('class','flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full border bg-white border-['+color+']');outer.style.borderColor=color;
      inner.setAttribute('class','h-[12px] w-[12px] rounded-full bg-['+color+']');inner.style.backgroundColor=color;
    }
    if(value==='no')section.querySelector('textarea')?.remove();
    onChange();await track('question:'+value+':'+section.dataset.fixtureQuestion);
  };
}

function shopHtml(pauseNoticeOnce=false) {
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
          document.querySelector('#request').onclick=async()=>{
            await window.fixtureTrack('notice-request');
            host.innerHTML=${JSON.stringify(restaurantNoticeHtml())};
            const checked=[true,false,false,false],next=host.querySelector('#restaurant-notice-next');let pausedNoticeClick=false;
            for(const button of host.querySelectorAll('[data-fixture-notice-row]'))button.onclick=async()=>{
              const index=Number(button.dataset.fixtureNoticeRow);
              if(${pauseNoticeOnce} && index===2 && !pausedNoticeClick){pausedNoticeClick=true;await window.fixtureTrack('restaurant-notice-click-blocked');return;}
              checked[index]=!checked[index];
              const icon=button.querySelector('svg'),color=checked[index]?'#ff3d00':'#d5d5d5';
              icon.setAttribute('class','h-[20px] w-[20px] shrink-0 text-['+color+']');icon.style.color=color;
              if(checked.every(Boolean))next.className='h-[48px] rounded-[6px] bg-[#ff3d00] text-white';
              await window.fixtureTrack('restaurant-notice-row:'+index);
            };
            next.onclick=async()=>{if(!checked.every(Boolean))throw new Error('Next clicked before every restaurant notice was checked');await window.fixtureTrack('restaurant-notice-next');setTimeout(()=>location.assign('/zh-CN/reservation/form'),30)};
          };
        };
      };
    };
  </script></body></html>`;
}
function formHtml(emptyName=false,questionMode='none') {
  return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><main><h2>${task.restaurantName}</h2><p>10.13 (Tue) · 13:00 · 2人</p><p>Total: ₩0</p><label>预约人<input required value="${emptyName?'':'Offline Fixture'}" /></label><div id="questions">${questionMode==='static'?questionGroupsHtml():''}</div><section><h3>电话号码<span>*必填</span></h3><div><div id="country"><span>+1</span></div><input type="tel" /></div></section><div id="countries"></div><button id="checkout"${questionMode==='none'?' disabled':''} class="h-[48px] rounded-[6px] bg-[#f1f1f1] text-[#c8c8c8]">Checkout</button></main><script>
    document.querySelector('label input').oninput=async()=>{await window.fixtureTrack('name-filled')};
    const phone=document.querySelector('input[type="tel"]');
    const country=document.querySelector('#country');
    const questionMode=${JSON.stringify(questionMode)},questionHost=document.querySelector('#questions'),checkout=document.querySelector('#checkout');let lateChoices=false,expectedQuestionCount=3;
    const updateCheckout=()=>{const sections=[...questionHost.querySelectorAll('[data-fixture-question]')];const ready=Boolean(phone.value.trim())&&(questionMode==='none'&&!lateChoices||sections.length===expectedQuestionCount&&sections.every(section=>section.querySelector('[data-fixture-choice="no"] > span > span').classList.contains('bg-[#ff3d00]')));checkout.disabled=questionMode==='none'&&!lateChoices&&!ready;checkout.className=ready?'h-[48px] rounded-[6px] bg-[#ff3d00] text-white':'h-[48px] rounded-[6px] bg-[#f1f1f1] text-[#c8c8c8]';return ready;};
    const installQuestions=()=>{(${installQuestionControls.toString()})(questionHost,updateCheckout,event=>window.fixtureTrack(event));};
    installQuestions();
    window.fixtureInsertLateQuestion=async()=>{const holder=document.createElement('div');holder.innerHTML=${JSON.stringify(questionGroupsHtml([{question:'是否需要额外餐具',selected:'yes'}]))};const section=holder.firstElementChild;section.dataset.fixtureQuestion='3';questionHost.append(section);lateChoices=true;expectedQuestionCount=questionHost.children.length;installQuestions();updateCheckout();await window.fixtureTrack('late-question-inserted');};
    country.onclick=async()=>{
      await window.fixtureTrack('country-open');
      const host=document.querySelector('#countries');host.innerHTML='<section role="dialog"><input type="text" required placeholder="搜索" /><button type="button"><span>China</span><span>+86</span></button></section>';
      host.querySelector('button').onclick=async()=>{await window.fixtureTrack('country-select');country.querySelector('span').textContent='+86';host.querySelector('input').value='';setTimeout(()=>{host.innerHTML=''},300)};
    };
    phone.oninput=async()=>{await window.fixtureTrack('phone-filled');if(questionMode==='after_phone'&&!questionHost.children.length){questionHost.innerHTML=${JSON.stringify(questionGroupsHtml())};installQuestions();}updateCheckout();};
    checkout.onclick=async()=>{if(!updateCheckout())throw new Error('Checkout clicked before all required No answers and phone were ready');await window.fixtureTrack('checkout-click',{phone:phone.value,country:country.innerText});await fetch('https://api.catchtable.net/api/v5/reservation/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixture:true})});location.assign('${detailPath}')};
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

async function offlineBrowserFlow(t,{fullContact=false,resumeFromNotice=false,lateQuestionRace=false}={}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Seoul' });
  const trace = []; const external = []; const pageErrors = [];
  let persisted = false; let persistCount = 0; let createCount = 0; let pending = true;
  let signedIn=true;let submittedContact=null;
  let simulatedLostClickAcknowledgement=false,lateQuestionInserted=false;
  await context.exposeBinding('fixtureTrack', (_source, event, contact) => { trace.push(event);if(event==='checkout-click')submittedContact=contact; });
  context.on('page', page => {
    page.on('pageerror', error => pageErrors.push(error.message));
    if(lateQuestionRace) {
      const evaluate=page.evaluate.bind(page);
      page.evaluate=async (fn,arg)=>{
        const value=await evaluate(fn,arg);
        if(!lateQuestionInserted && fn?.name==='readBookingFlowDom' && value?.url?.endsWith('/reservation/form')
          && value.missingRequiredFields?.length===0 && value.buttons?.some(button=>button.text==='Checkout'&&!button.disabled)) {
          lateQuestionInserted=true;
          await evaluate(()=>window.fixtureInsertLateQuestion());
        }
        return value;
      };
    }
    const locator=page.locator.bind(page);
    page.locator=(selector,options)=>{
      const result=locator(selector,options);
      if(selector==='button:visible' && !fullContact) {
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
      const html = url.pathname === '/zh-CN/shop/offline_fixture' ? shopHtml(resumeFromNotice) : url.pathname === '/zh-CN/reservation/form' ? formHtml(fullContact,fullContact?resumeFromNotice?'after_phone':'static':'none') : url.pathname === detailPath ? detailHtml() : url.pathname === '/zh-CN/my-dining/scheduled' ? scheduledHtml() : `<!doctype html><head>${css}</head><main><section><h4>Old cached nickname</h4><button>Edit Profile</button></section></main>`;
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    external.push(request.url()); return route.abort('blockedbyclient');
  });
  const identities=new Set();let identityChecks=0;
  const adapter = new CatchtableAdapter({identityVerifier:async fingerprint=>{assert.match(fingerprint,/^[a-f0-9]{64}$/);identities.add(fingerprint);identityChecks++;assert.equal(identities.size,1);}}); adapter.context = context;
  const onBeforeSubmit=async()=>{
    if(lateQuestionRace) {
      assert.equal(lateQuestionInserted,true);
      const answered=await adapter.bookingPages.get(task.id).evaluate(()=>document.querySelector('[data-fixture-question="3"] [data-fixture-choice="no"] > span > span')?.classList.contains('bg-[#ff3d00]'));
      assert.equal(answered,true,'the new required Yes/No question must be No before entering the durable submission boundary');
    }
    trace.push('persist');persistCount+=1;persisted=true;
  };
  const bookingContact={countryCode:'+86',phoneNumber:'13800000000',fullName:'Offline Authorized Guest'};
  const initial=await adapter.prepare(task,slot,{onBeforeSubmit,...(fullContact?{bookingContact}:{})});
  let result=initial;
  if(resumeFromNotice) {
    assert.equal(initial.status,'user_action_required');assert.equal(initial.phase,'before_submit');assert.equal(initial.submitted,false);
    assert.equal(createCount,0);assert.equal(persistCount,0);assert.equal(trace.filter(value=>value==='restaurant-notice-row:1').length,1);
    const originalPage=adapter.bookingPages.get(task.id);
    result=await adapter.continueAttempt({id:'offline-notice-attempt',taskSnapshot:task,slot,status:initial.status,phase:initial.phase,submitted:false},{onBeforeSubmit,bookingContact});
    assert.equal(adapter.bookingPages.get(task.id),originalPage);assert.equal(trace.filter(value=>value==='restaurant-notice-click-blocked').length,1);
    assert.ok(trace.indexOf('scheduled-read')<trace.indexOf('restaurant-notice-row:2'),'pending notice continuation requires complete negative order evidence before further interaction');
  } else if(!fullContact) {
    assert.equal(initial.status,'user_action_required');assert.equal(initial.phase,'required_fields');
    assert.equal(initial.submitted,false);assert.deepEqual(initial.diagnostics.missingRequiredFields,['电话号码']);
    assert.equal(createCount,0);assert.equal(persistCount,0,'an empty mandatory phone must not reach the write boundary');
    assert.equal(simulatedLostClickAcknowledgement,true,'an already opened next step must survive a lost slot-click acknowledgement');
    await adapter.bookingPages.get(task.id).locator('input[type="tel"]').evaluate(element=>{element.value='2025550199';});
    result=await adapter.continueAttempt({id:'offline-attempt',taskSnapshot:task,slot,status:initial.status,phase:initial.phase,submitted:false},{onBeforeSubmit,bookingContact});
  }
  assert.equal(result.status, 'pending_restaurant', JSON.stringify({ result, trace, pageErrors }));
  assert.equal(result.reservationId, id);
  assert.equal(persistCount, 1); assert.equal(createCount, 1);
  assert.deepEqual(submittedContact,{country:'+86',phone:'13800000000'},'an existing website prefill must not override the original attempt contact');
  for (const event of ['calendar-filter-slot', 'main-slot-open', 'promo-later', 'same-day-next', 'notice-request', 'restaurant-notice-row:1', 'restaurant-notice-row:2', 'restaurant-notice-row:3', 'restaurant-notice-next', 'name-filled', 'country-open', 'country-select', 'phone-filled', 'checkout-click']) assert.equal(trace.filter(value => value === event).length, 1, event);
  assert.equal(trace.filter(value=>value==='restaurant-notice-row:0').length,0,'a checkbox already selected by the website must not be unticked');
  for(const index of [1,2,3])assert.ok(trace.indexOf('restaurant-notice-row:'+index)<trace.indexOf('restaurant-notice-next'));
  assert.ok(trace.indexOf('restaurant-notice-next')<trace.indexOf('persist'),'the informational next step is separate from the durable final write barrier');
  if(!fullContact || resumeFromNotice)assert.ok(trace.indexOf('scheduled-read')<trace.indexOf('persist'),'a complete prior negative order check must precede continuation submission');
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
  if(fullContact || lateQuestionRace) {
    if(fullContact) {
      assert.equal(trace.filter(value=>value==='question:no:0').length,1,'an unanswered required group is answered No once');
      assert.equal(trace.filter(value=>value==='question:no:1').length,0,'an existing No is not selected again');
      assert.equal(trace.filter(value=>value==='question:no:2').length,1,'an existing Yes changes to No once');
    }
    if(lateQuestionRace) {
      assert.equal(trace.filter(value=>value==='late-question-inserted').length,1);assert.equal(trace.filter(value=>value==='question:no:3').length,1);
      assert.ok(trace.indexOf('late-question-inserted')<trace.indexOf('question:no:3'));assert.ok(trace.indexOf('question:no:3')<trace.indexOf('persist'));
    }
    assert.equal(trace.some(value=>value.startsWith('question:yes:')),false);
    for(const index of fullContact?[0,2]:[]) {
      assert.ok(trace.indexOf('question:no:'+index)<trace.indexOf('persist'));
      if(resumeFromNotice)assert.ok(trace.indexOf('phone-filled')<trace.indexOf('question:no:'+index),'questions appearing after phone input must also be completed');
    }
    assert.equal(simulatedLostClickAcknowledgement,!fullContact);
    assert.equal(trace.filter(value=>value==='calendar-open').length,1,'known notices plus contact prefill must finish in one bounded initial prepare');
    assert.deepEqual(external,[]);assert.deepEqual(pageErrors,[]);return;
  }
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
}

test('offline browser completes calendar, custom restaurant notices and one persisted free request, then verifies the same order',{timeout:60000},t=>offlineBrowserFlow(t));
test('one automatic prepare passes custom notices and empty name/phone fields before exactly one durable free submit',{timeout:60000},t=>offlineBrowserFlow(t,{fullContact:true}));
test('a pending partially checked notice resumes in the original page only after a complete negative order check',{timeout:60000},t=>offlineBrowserFlow(t,{fullContact:true,resumeFromNotice:true}));
test('a required question appearing after the ready checkout snapshot is answered No before the durable submission boundary',{timeout:60000},t=>offlineBrowserFlow(t,{lateQuestionRace:true}));

test('required custom yes/no groups choose only their scoped No and reject ambiguous or unknown controls without interaction',{timeout:30000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage();let fixture='';const external=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{
    if(route.request().resourceType()==='document')return route.fulfill({status:200,contentType:'text/html',body:fixture});
    external.push(route.request().url());return route.abort();
  });
  const load=async configs=>{
    fixture=`<!doctype html><meta charset="utf-8"><style>button{padding:12px;margin:8px}section{margin:12px}</style><main>${questionGroupsHtml(configs)}<button id="unrelated-no">否</button></main><script>window.fixtureChoiceClicks=[];document.querySelector('#unrelated-no').onclick=()=>window.fixtureChoiceClicks.push('unrelated-no');(${installQuestionControls.toString()})(document.querySelector('main'),()=>{},event=>window.fixtureChoiceClicks.push(event));</script>`;
    await page.goto('https://www.catchtable.net/zh-CN/reservation/form');
  };
  const clicks=()=>page.evaluate(()=>window.fixtureChoiceClicks);
  await load([]);assert.equal((await answerReservationNoChoices(page)).status,'absent');assert.deepEqual(await clicks(),[]);
  await load();assert.equal((await answerReservationNoChoices(page)).status,'filled');
  assert.deepEqual(await clicks(),['question:no:0','question:no:2']);
  assert.equal((await answerReservationNoChoices(page)).status,'ready');assert.deepEqual(await clicks(),['question:no:0','question:no:2']);
  for(const configs of [
    [{question:'饮食限制或过敏',duplicateNo:true}],
    [{question:'饮食限制或过敏',unknown:true}],
    [{question:'饮食限制或过敏'},{question:'是否需要儿童座椅',duplicateNo:true}],
  ]) {
    await load(configs);assert.equal((await answerReservationNoChoices(page)).status,'blocked');assert.deepEqual(await clicks(),[],'a malformed or ambiguous group must never borrow another group or the unrelated No');
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
});
