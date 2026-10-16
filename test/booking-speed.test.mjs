import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CatchtableAdapter } from '../server/catchtable.mjs';
import { Engine } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';
import { createTask } from '../server/domain.mjs';

const fixtureTask={id:'speed-fixture',restaurantName:'Speed Fixture Restaurant',restaurantUrl:'https://www.catchtable.net/shop/speed_fixture',
  dates:['2026-10-24','2026-10-25','2026-10-26'],partySize:2,timeStart:'13:00',timeEnd:'14:00',mode:'auto',autoConsent:true};
const accountScript='<script>fetch("https://api.catchtable.net/api/v5/user/info?localeCode=zh-CN",{credentials:"include"})</script>';
const moduleBase='/static/appjs/prod/20261014100630/build/';
const fixtureShopRef='fixture-shop-ref';
const apiScript=`<script type="module">import '${moduleBase}locale.util_fixture.js';import '${moduleBase}apiDataEncrypt.util_fixture.js';fetch('https://api.catchtable.net/api/v5/shop/detail?localeCode=zh-CN&shopRefOrAlias=speed_fixture')</script>`;
const style='<style>button{margin:8px;padding:14px}[role="dialog"]{padding:24px;border:1px solid #ddd}[role="button"]{display:inline-block;width:90px;height:44px;margin:8px;padding:12px;border:1px solid #ccc}</style>';
function shopHtml(entryOnly=false,closedDates=[],confirmParty=true,apiMode=false,coveredEntry=false){return `<!doctype html><html><head><meta charset="utf-8">${style}${accountScript}${apiMode?apiScript:''}</head><body><h2>${fixtureTask.restaurantName}</h2><button id="open"${coveredEntry?' style="position:fixed;left:12px;bottom:12px;z-index:1"':''}>${entryOnly?'预订':'日期 • 时间 • 人'}</button>${coveredEntry?'<div id="entry-cover" style="position:fixed;left:0;right:0;bottom:0;height:110px;z-index:9999;background:#eee" aria-hidden="true"></div>':''}<script>
  document.querySelector('#open').onclick=async()=>{
    await window.fixtureTrack('calendar-open');
    const dialog=document.createElement('section');dialog.setAttribute('role','dialog');
    dialog.innerHTML='<button class="rounded-full" aria-pressed="false">2</button>${[...closedDates,...fixtureTask.dates].map(date=>`<div role="button" aria-label="${date.slice(0,4)}年${Number(date.slice(5,7))}月${Number(date.slice(8))}日" aria-pressed="false" ${closedDates.includes(date)?'aria-disabled="true"':''} data-date="${date}">${Number(date.slice(8))}</div>`).join('')}<button id="time">13:00</button>';
    dialog.querySelector('button.rounded-full').onclick=async event=>{${confirmParty?"event.currentTarget.setAttribute('aria-pressed','true');":''}await window.fixtureTrack('party-selected')};
    for(const cell of dialog.querySelectorAll('[data-date]'))cell.onclick=async event=>{
      for(const item of dialog.querySelectorAll('[data-date]'))item.setAttribute('aria-pressed','false');
      event.currentTarget.setAttribute('aria-pressed','true');window.fixtureDate=event.currentTarget.dataset.date;await window.fixtureTrack('date:'+window.fixtureDate);
    };
    dialog.querySelector('#time').onclick=async()=>{await window.fixtureTrack('filter-slot');location.assign('/zh-CN/reservation/form')};
    document.body.append(dialog);
  };
</script></body></html>`;}
function formHtml(){return `<!doctype html><html><head><meta charset="utf-8">${style}${accountScript}</head><body><main><h2>${fixtureTask.restaurantName}</h2><p>2026-10-24 · 13:00 · 2 人</p><p>Total: ₩0</p><label><input type="checkbox">Fixture binding terms that require manual approval</label><button>Checkout</button></main></body></html>`;}

// Every request is fulfilled or aborted locally in a fresh headless context.
// The fixture stops at unchecked binding terms and cannot create an order.
async function browserFixture(t,{entryOnly=false,closedDates=[],confirmParty=true,apiMode=false,coveredEntry=false,detailDelayMs=0}={}){
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Seoul'});
  const trace=[],apiRequests=[];let shopNavigations=0,snapshotReads=0,activations=0,apiStatus=200,apiTimes=['1300','1330','1400'];const calendarCommands={batches:0,legacyCellLists:0};
  context.on('page',page=>{
    const bringToFront=page.bringToFront.bind(page);
    page.bringToFront=async()=>{activations++;return bringToFront();};
    const getByRole=page.getByRole.bind(page);
    page.getByRole=(role,options)=>{
      const located=getByRole(role,options);
      if(role==='dialog') {
        const last=located.last.bind(located);
        located.last=()=>{
          const dialog=last(),locator=dialog.locator.bind(dialog),evaluate=dialog.evaluate.bind(dialog);
          dialog.evaluate=(...args)=>{snapshotReads++;return evaluate(...args);};
          dialog.locator=(selector,options)=>{
            const cells=locator(selector,options);
            if(selector==='[role="button"][aria-label], [role="checkbox"][aria-label]') {
              const evaluateAll=cells.evaluateAll.bind(cells),all=cells.all.bind(cells);
              cells.evaluateAll=(...args)=>{calendarCommands.batches++;return evaluateAll(...args);};
              cells.all=(...args)=>{calendarCommands.legacyCellLists++;return all(...args);};
            }
            return cells;
          };
          return dialog;
        };
      }
      return located;
    };
  });
  await context.exposeBinding('fixtureTrack',(_source,value)=>trace.push(value));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://api.catchtable.net' && url.pathname==='/api/v5/user/info')return route.fulfill({status:200,contentType:'application/json',
      headers:{'Access-Control-Allow-Origin':'https://www.catchtable.net','Access-Control-Allow-Credentials':'true'},body:JSON.stringify({isLogin:true,ctUserIdentifier:'synthetic-speed-user',displayName:'Synthetic speed account'})});
    if(apiMode && url.origin==='https://api.catchtable.net' && url.pathname==='/api/v5/shop/detail'){
      if(detailDelayMs)await new Promise(done=>setTimeout(done,detailDelayMs));
      return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'https://www.catchtable.net'},body:JSON.stringify({alias:'speed_fixture',shopRef:fixtureShopRef})});
    }
    if(apiMode && url.origin==='https://www.catchtable.net' && url.pathname===`${moduleBase}apiDataEncrypt.util_fixture.js`)return route.fulfill({status:200,contentType:'text/javascript',body:'export const t=value=>value;'});
    if(apiMode && url.origin==='https://www.catchtable.net' && url.pathname===`${moduleBase}locale.util_fixture.js`)return route.fulfill({status:200,contentType:'text/javascript',body:apiMode==='unsupported'?'export const V={};':`export const V={post:async(path,body,options={})=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:JSON.stringify(body),signal:options.signal});if(!response.ok){const error=new Error('Fixture query failed');error.response={status:response.status};throw error;}return {data:await response.json()};}};`});
    if(apiMode && url.origin==='https://www.catchtable.net' && url.pathname==='/api/v5/shop/timeslot-enc' && route.request().method()==='POST'){
      const body=route.request().postDataJSON();apiRequests.push(body);
      assert.equal(route.request().headers().shopref,fixtureShopRef);
      return route.fulfill({status:apiStatus,contentType:'application/json',body:JSON.stringify(apiStatus===200?{timeSlotState:'OK',timeSlotList:apiTimes.map(time=>({date:body.searchDate,time,personCount:body.personCount,shopRef:fixtureShopRef,isAvailable:true,tableType:''}))}:{message:'Synthetic rate limit'})});
    }
    if(url.origin==='https://www.catchtable.net' && route.request().resourceType()==='document'){
      if(url.pathname==='/zh-CN/shop/speed_fixture'){shopNavigations++;return route.fulfill({status:200,contentType:'text/html',body:shopHtml(entryOnly,closedDates,confirmParty,apiMode,coveredEntry)});}
      if(url.pathname==='/zh-CN/reservation/form')return route.fulfill({status:200,contentType:'text/html',body:formHtml()});
    }
    return route.abort('blockedbyclient');
  });
  const adapter=new CatchtableAdapter();adapter.context=context;
  return {adapter,context,trace,calendarCommands,apiRequests,shopNavigations:()=>shopNavigations,snapshotReads:()=>snapshotReads,activations:()=>activations,setApiStatus:value=>{apiStatus=value;},setApiTimes:value=>{apiTimes=value;}};
}

test('official day queries filter selected half-hours and warm checks avoid calendar work while retrieving fresh inventory', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t,{apiMode:true});
  const task={...fixtureTask,timeSlots:['13:00','14:00']};
  const first=await fixture.adapter.inspect(task,{firstMatch:false});
  assert.equal(first.status,'available',first.message);assert.equal(first.checkSource,'api');assert.equal(first.complete,true);
  assert.deepEqual(first.slots.map(slot=>slot.time),['13:00','14:00','13:00','14:00','13:00','14:00']);
  assert.deepEqual(fixture.apiRequests.map(request=>request.searchDate),task.dates);
  assert.ok(fixture.apiRequests.every(request=>request.shopRef===fixtureShopRef && request.personCount===2 && request.visitTime==='1300'));
  assert.deepEqual(fixture.calendarCommands,{batches:0,legacyCellLists:0});assert.equal(fixture.snapshotReads(),0);
  assert.deepEqual(fixture.trace,[]);
  const monitored=fixture.adapter.watchPages.get(task.id);
  fixture.setApiTimes(['1330']);
  const second=await fixture.adapter.inspect(task,{firstMatch:false});
  assert.equal(second.status,'unavailable',second.message);assert.equal(second.checkSource,'api');assert.deepEqual(second.slots,[]);
  assert.deepEqual(second.observedDates,task.dates);assert.equal(fixture.apiRequests.length,6,'each warm date must make a fresh query');
  assert.equal(fixture.adapter.watchPages.get(task.id),monitored);assert.equal(fixture.shopNavigations(),1);
  assert.equal(fixture.activations(),0,'cold and warm inventory checks must stay in the background');
  assert.deepEqual(fixture.trace,[]);assert.equal(fixture.snapshotReads(),0);assert.equal(fixture.calendarCommands.batches,0);
});

test('the first API match skips later dates and reuses the authenticated page for the verified booking selection', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t,{apiMode:true});
  const task={...fixtureTask,timeSlots:['13:00','14:00']};
  const observation=await fixture.adapter.inspect(task,{firstMatch:true});
  assert.equal(observation.status,'available',observation.message);assert.equal(observation.checkSource,'api');assert.equal(observation.complete,false);
  assert.deepEqual(observation.observedDates,[task.dates[0]]);assert.equal(fixture.apiRequests.length,1);
  assert.equal(fixture.adapter.inspections.get(task.id).kind,'api');assert.equal(fixture.adapter.inspections.get(task.id).dialog,null);assert.ok(observation.inspectionId);
  assert.deepEqual(fixture.trace,[],'read-only inventory discovery must not open the booking calendar');
  const monitored=fixture.adapter.watchPages.get(task.id);let writes=0;
  const prepared=await fixture.adapter.prepare(task,observation.slots[0],{inspectionId:observation.inspectionId,onBeforeSubmit:async()=>{writes++;}});
  assert.equal(prepared.status,'user_action_required');assert.equal(prepared.phase,'agreement');assert.equal(writes,0);
  assert.equal(fixture.adapter.bookingPages.get(task.id),monitored);assert.equal(fixture.shopNavigations(),1);assert.equal(fixture.context.pages().length,1);
  for(const value of ['calendar-open','party-selected','date:2026-10-24','filter-slot'])assert.equal(fixture.trace.filter(event=>event===value).length,1,value);
});

test('an API rate limit preserves unknown inventory with backoff instead of immediately scanning the page', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t,{apiMode:true});
  const task={...fixtureTask,dates:[fixtureTask.dates[0]],timeSlots:['13:00','14:00']};
  assert.equal((await fixture.adapter.inspect(task,{firstMatch:false})).status,'available');
  fixture.setApiStatus(429);
  const observation=await fixture.adapter.inspect(task,{firstMatch:false});
  assert.equal(observation.status,'unknown');assert.equal(observation.checkSource,'api');assert.equal(observation.retryAfterMs,30000);
  assert.deepEqual(observation.slots,[]);assert.deepEqual(observation.observedDates,[]);assert.equal(observation.complete,false);
  assert.equal(fixture.apiRequests.length,2);assert.equal(fixture.shopNavigations(),1);
  assert.deepEqual(fixture.trace,[]);assert.equal(fixture.snapshotReads(),0);assert.equal(fixture.calendarCommands.batches,0);
});

test('a covered footer reservation button cannot block a ready official inventory query', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t,{entryOnly:true,coveredEntry:true,apiMode:true,detailDelayMs:100});
  const task={...fixtureTask,dates:[fixtureTask.dates[0]],timeSlots:['13:00','14:00']};
  const observation=await fixture.adapter.inspect(task,{firstMatch:false});
  assert.equal(observation.status,'available',observation.message);assert.equal(observation.checkSource,'api');assert.equal(observation.complete,true);
  assert.deepEqual(observation.slots.map(slot=>slot.time),['13:00','14:00']);assert.equal(fixture.apiRequests.length,1);
  assert.deepEqual(fixture.trace,[]);assert.equal(fixture.snapshotReads(),0);assert.equal(fixture.calendarCommands.batches,0);assert.equal(fixture.shopNavigations(),1);
  const page=fixture.adapter.watchPages.get(task.id);
  assert.equal(await page.evaluate(()=>{const rect=document.querySelector('#open').getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.id;}),'entry-cover','the old calendar-first click would really be intercepted');
});

test('an unsupported official client falls back to the existing verified calendar instead of guessing inventory', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t,{apiMode:'unsupported'});
  const observation=await fixture.adapter.inspect({...fixtureTask,timeSlots:['13:00','14:00']},{firstMatch:true});
  assert.equal(observation.status,'available',observation.message);assert.notEqual(observation.checkSource,'api');
  assert.equal(fixture.apiRequests.length,0);assert.equal(fixture.shopNavigations(),1);
  assert.deepEqual(fixture.trace,['calendar-open','party-selected','date:2026-10-24']);
  assert.equal(fixture.calendarCommands.batches,1);assert.equal(fixture.snapshotReads(),1);assert.equal(fixture.trace.includes('filter-slot'),false);
});

test('first matching date returns immediately and its verified monitor page enters booking without repeated navigation', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t);const started=performance.now();
  const observation=await fixture.adapter.inspect(fixtureTask,{firstMatch:true});const inspectMs=Math.round(performance.now()-started);
  assert.equal(fixture.activations(),0,'read-only monitoring must not activate the browser tab');
  assert.equal(observation.status,'available',observation.message);assert.equal(observation.complete,false);
  assert.deepEqual(observation.observedDates,['2026-10-24']);assert.ok(observation.inspectionId);
  assert.deepEqual(fixture.trace.filter(value=>value.startsWith('date:')),['date:2026-10-24']);
  assert.deepEqual(fixture.calendarCommands,{batches:1,legacyCellLists:0});
  const monitored=fixture.adapter.watchPages.get(fixtureTask.id);let writes=0;const preparedAt=performance.now();
  const result=await fixture.adapter.prepare(fixtureTask,observation.slots[0],{inspectionId:observation.inspectionId,onBeforeSubmit:async()=>{writes++;}});
  const prepareMs=Math.round(performance.now()-preparedAt);
  assert.equal(result.status,'user_action_required');assert.equal(result.phase,'agreement');assert.equal(writes,0);
  assert.equal(fixture.adapter.bookingPages.get(fixtureTask.id),monitored);assert.equal(fixture.adapter.watchPages.has(fixtureTask.id),false);
  assert.equal(fixture.shopNavigations(),1);assert.equal(fixture.context.pages().length,1);
  for(const value of ['calendar-open','party-selected','date:2026-10-24','filter-slot'])assert.equal(fixture.trace.filter(event=>event===value).length,1,value);
  t.diagnostic(JSON.stringify({inspectMs,prepareMs,shopNavigations:fixture.shopNavigations(),calendarOpens:1,partySelections:1,dateSelections:1,calendarBatchReads:fixture.calendarCommands.batches,reusedMonitorPage:true}));
});

test('a restaurant with only its footer reservation entry opens the calendar without creating an order', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t,{entryOnly:true});
  const observation=await fixture.adapter.inspect(fixtureTask,{firstMatch:true});
  assert.equal(observation.status,'available',observation.message);
  assert.deepEqual(observation.observedDates,['2026-10-24']);
  assert.equal(fixture.trace.filter(event=>event==='calendar-open').length,1);
  assert.equal(fixture.shopNavigations(),1);
  assert.equal(fixture.trace.includes('filter-slot'),false,'inspection must stop before choosing a reservation time');
});

test('closed monitored days are verified in one batch and skipped before the first available date', {timeout:30000}, async t=>{
  const closedDates=['2026-10-14','2026-10-15','2026-10-16','2026-10-17'];
  const fixture=await browserFixture(t,{closedDates});
  const observation=await fixture.adapter.inspect({...fixtureTask,dates:[...closedDates,...fixtureTask.dates]},{firstMatch:true});
  assert.equal(observation.status,'available',observation.message);
  assert.deepEqual(observation.observedDates,[...closedDates,'2026-10-24']);
  assert.equal(fixture.calendarCommands.batches,1);
  assert.deepEqual(fixture.trace.filter(value=>value.startsWith('date:')),['date:2026-10-24']);
  assert.equal(observation.complete,false);
});

test('all disabled days cannot be reported unavailable until the actual selected party is verified', {timeout:30000}, async t=>{
  const closedDates=['2026-10-14','2026-10-15'];
  const task={...fixtureTask,dates:closedDates};
  for(const confirmParty of [false,true]) {
    const fixture=await browserFixture(t,{closedDates,confirmParty});
    const observation=await fixture.adapter.inspect(task,{firstMatch:true});
    assert.equal(observation.status,confirmParty?'unavailable':'unknown',observation.message);
    assert.equal(observation.complete===true,confirmParty);
    assert.deepEqual(observation.slots,[]);
    assert.equal(fixture.calendarCommands.batches,1);
    assert.equal(fixture.trace.some(value=>value.startsWith('date:')),false);
    if(confirmParty)assert.deepEqual(observation.observedDates,closedDates);
  }
});

test('a changed calendar selection invalidates same-page reuse and requires the original fresh verification', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t);
  const observation=await fixture.adapter.inspect(fixtureTask,{firstMatch:true});
  const monitored=fixture.adapter.watchPages.get(fixtureTask.id);
  await monitored.evaluate(()=>document.querySelector('button.rounded-full').setAttribute('aria-pressed','false'));
  const result=await fixture.adapter.prepare(fixtureTask,observation.slots[0],{inspectionId:observation.inspectionId,onBeforeSubmit:async()=>assert.fail('Fixture binding terms must block submission')});
  assert.equal(result.phase,'agreement');assert.notEqual(fixture.adapter.bookingPages.get(fixtureTask.id),monitored);
  assert.equal(fixture.shopNavigations(),2);assert.equal(fixture.trace.filter(value=>value==='calendar-open').length,2);
  assert.equal(fixture.trace.filter(value=>value==='party-selected').length,2);
});

test('changing selected time slots invalidates the otherwise fresh monitor proof', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t);
  const selectedTask={...fixtureTask,timeSlots:['13:00','14:00']};
  const observation=await fixture.adapter.inspect(selectedTask,{firstMatch:true});
  const monitored=fixture.adapter.watchPages.get(fixtureTask.id);
  const changedTask={...selectedTask,timeSlots:['13:00','13:30','14:00']};
  const result=await fixture.adapter.prepare(changedTask,observation.slots[0],{inspectionId:observation.inspectionId,onBeforeSubmit:async()=>assert.fail('fixture terms must block submission')});
  assert.equal(result.phase,'agreement');
  assert.notEqual(fixture.adapter.bookingPages.get(fixtureTask.id),monitored);
  assert.equal(fixture.shopNavigations(),2,'a proof from a different time selection must not skip fresh calendar checks');
});

test('automatic partial checks forward the current inspection and never book a historical unobserved slot',async()=>{
  const now=Date.parse('2026-10-12T08:00:00Z');const store=new Store(':memory:');let observationSlots=[];let writes=0;
  const fresh={date:'2026-10-25',time:'13:00',partySize:2};const old={...fresh,date:'2026-10-24'};
  const adapter={hasContext:true,inspect:async(_task,options)=>{assert.equal(options.firstMatch,true);return {status:observationSlots.length?'available':'unavailable',slots:observationSlots,complete:false,observedDates:[fresh.date],inspectionId:'current-inspection-fixture'};},
    prepare:async(task,slot,options)=>{writes++;assert.equal(slot.date,fresh.date);assert.equal(options.inspectionId,'current-inspection-fixture');assert.equal(typeof options.onBeforeSubmit,'function');
      assert.equal(store.attemptsForTask(task.id).length,1,'an attempt must already be durable before handoff');return {status:'user_action_required',submitted:false,phase:'agreement'};},close:async()=>{}};
  const engine=new Engine({store,adapter,now:()=>now});
  try {
    const task=store.saveTask({...createTask({...fixtureTask,id:undefined,dates:[old.date,fresh.date]},store.settings(),now),status:'active',slots:[old]});
    engine.applySession({status:'authenticated',browserOpen:true});
    await engine.checkTask(task.id);assert.equal(writes,0);assert.equal(store.getTask(task.id).slots[0].date,old.date);
    observationSlots=[fresh];await engine.checkTask(task.id);assert.equal(writes,1);
    assert.deepEqual(store.getTask(task.id).slots.map(slot=>slot.date),[old.date,fresh.date]);
    assert.equal(store.attemptsForTask(task.id)[0].slot.date,fresh.date);
  }finally {await engine.stop();store.close();}
});
