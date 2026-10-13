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
const style='<style>button{margin:8px;padding:14px}[role="dialog"]{padding:24px;border:1px solid #ddd}[role="button"]{display:inline-block;width:90px;height:44px;margin:8px;padding:12px;border:1px solid #ccc}</style>';
function shopHtml(entryOnly=false,closedDates=[],confirmParty=true){return `<!doctype html><html><head><meta charset="utf-8">${style}${accountScript}</head><body><h2>${fixtureTask.restaurantName}</h2><button id="open">${entryOnly?'预订':'日期 • 时间 • 人'}</button><script>
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
async function browserFixture(t,{entryOnly=false,closedDates=[],confirmParty=true}={}){
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Seoul'});
  const trace=[];let shopNavigations=0;const calendarCommands={batches:0,legacyCellLists:0};
  context.on('page',page=>{
    const getByRole=page.getByRole.bind(page);
    page.getByRole=(role,options)=>{
      const located=getByRole(role,options);
      if(role==='dialog') {
        const last=located.last.bind(located);
        located.last=()=>{
          const dialog=last(),locator=dialog.locator.bind(dialog);
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
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://api.catchtable.net' && url.pathname==='/api/v5/user/info')return route.fulfill({status:200,contentType:'application/json',
      headers:{'Access-Control-Allow-Origin':'https://www.catchtable.net','Access-Control-Allow-Credentials':'true'},body:JSON.stringify({isLogin:true,ctUserIdentifier:'synthetic-speed-user',displayName:'Synthetic speed account'})});
    if(url.origin==='https://www.catchtable.net' && route.request().resourceType()==='document'){
      if(url.pathname==='/zh-CN/shop/speed_fixture'){shopNavigations++;return route.fulfill({status:200,contentType:'text/html',body:shopHtml(entryOnly,closedDates,confirmParty)});}
      if(url.pathname==='/zh-CN/reservation/form')return route.fulfill({status:200,contentType:'text/html',body:formHtml()});
    }
    return route.abort('blockedbyclient');
  });
  const adapter=new CatchtableAdapter();adapter.context=context;
  return {adapter,context,trace,calendarCommands,shopNavigations:()=>shopNavigations};
}

test('first matching date returns immediately and its verified monitor page enters booking without repeated navigation', {timeout:30000}, async t=>{
  const fixture=await browserFixture(t);const started=performance.now();
  const observation=await fixture.adapter.inspect(fixtureTask,{firstMatch:true});const inspectMs=Math.round(performance.now()-started);
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
