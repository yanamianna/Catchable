import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CatchtableAdapter } from '../server/catchtable.mjs';

const task={id:'overhead-task',restaurantName:'Overhead fixture',restaurantUrl:'https://www.catchtable.net/shop/overhead_fixture',dates:['2030-01-02'],partySize:2,timeStart:'13:00',timeEnd:'14:00',mode:'auto',autoConsent:true};
const slot={date:'2030-01-02',time:'13:00',partySize:2};
const attempt={id:'overhead-attempt',task,slot,status:'user_action_required',phase:'before_submit',submitted:false};
const form={url:'https://www.catchtable.net/zh-CN/reservation/form',headings:[task.restaurantName],summaries:['2030-01-02 · 13:00 · 2人'],text:'Fixture agreement',buttons:[],dialogs:[],cards:[],links:[],loading:false,uncheckedAgreements:['Fixture agreement'],missingRequiredFields:[]};

class OrderPage extends EventEmitter {
  constructor({receipt=false}={}){super();this.receipt=receipt;this.closed=false;this.address='about:blank';}
  isClosed(){return this.closed;}
  async close(){this.closed=true;}
  url(){return this.address;}
  waitForResponse(predicate){return new Promise(resolve=>{const listener=response=>{if(predicate(response)){this.off('response',listener);resolve(response);}};this.on('response',listener);});}
  async goto(url){
    this.address=url;
    this.emit('response',{url:()=>url.includes('/detail/')?'https://api.catchtable.net/api/v5/reservation/detail?reservationRef=OVERHEAD-ORDER':'https://api.catchtable.net/api/v6/my-dining/scheduled?page=0&size=10',status:()=>200,json:async()=>url.includes('/detail/')?{}:{hasNext:false,list:[]},finished:async()=>null});
  }
  async evaluate(){return this.receipt?{url:this.address,text:`${task.restaurantName}\nDate: 2030-01-02\nTime: 13:00\nParty size: 2 people\nConfirmed`,statusLabels:['Confirmed'],loading:false,captcha:false}:{url:this.address,text:'No reservations',cards:[],headings:[],buttons:[],summaries:[],links:[],dialogs:[],loading:false};}
}
function fixture(){
  const adapter=new CatchtableAdapter();let pages=0,prepares=0,domReads=0,orderReads=0;
  const flowPage=Object.assign(new EventEmitter(),{isClosed:()=>false,evaluate:async()=>{domReads++;return {...form};},getByRole:()=>({count:async()=>0})});
  const context={on(){},newPage:async()=>{pages++;const page=new OrderPage();const goto=page.goto.bind(page);page.goto=async url=>{orderReads++;return goto(url);};return page;}};
  adapter.context=context;adapter.bookingPages.set(task.id,flowPage);adapter.bookingFlows.set(task.id,{page:flowPage,slot:{...slot},calendarVerified:true});
  adapter.prepare=async()=>{prepares++;return {status:'user_action_required',phase:'before_submit',submitted:false};};
  return {adapter,flowPage,context,get pages(){return pages;},get prepares(){return prepares;},get domReads(){return domReads;},get orderReads(){return orderReads;}};
}

test('immediate continuation reuses only one fresh complete negative check and reads each flow step once',async()=>{
  const f=fixture();
  assert.equal((await f.adapter.reconcile(attempt)).resumeAllowed,true);
  assert.equal(f.pages,1);
  const before=f.domReads;
  const continued=await f.adapter.continueAttempt(attempt);
  assert.equal(continued.phase,'agreement');assert.equal(continued.submitted,false);
  assert.equal(f.pages,1,'no second order-page load for this same fresh continuation');
  assert.equal(f.domReads-before,2,'one continuation condition snapshot and one shared receipt/step snapshot');
  await f.adapter.continueAttempt(attempt);
  assert.equal(f.pages,1,'the existing order tab is reused');
  assert.equal(f.orderReads,2,'the negative check is consumed once and the reused order page loads a fresh official response');
});

test('changed attempt, slot, context or expired proof requires another official order read',async()=>{
  for(const change of ['attempt','slot','context','age']) {
    const f=fixture();await f.adapter.reconcile(attempt);
    let next=attempt;
    if(change==='attempt')next={...attempt,id:'different-attempt'};
    if(change==='slot')next={...attempt,slot:{...slot,time:'14:00'}};
    if(change==='context')f.adapter.context={...f.context};
    const originalNow=Date.now;
    try {
      if(change==='age')Date.now=()=>originalNow()+6000;
      await f.adapter.continueAttempt(next);
    }finally {Date.now=originalNow;}
    assert.equal(f.orderReads,2,change);
    assert.equal(f.pages,change==='context'?2:1,change);
  }
});

test('complete matching order receipt does not wait for a shop response that the site did not request',async()=>{
  const adapter=new CatchtableAdapter();let closes=0;
  const page=new OrderPage({receipt:true});page.close=async()=>{closes++;};
  adapter.context={on(){},newPage:async()=>page};
  const result=await adapter.reconcile({...attempt,status:'pending_restaurant',submitted:true,reservationId:'OVERHEAD-ORDER'});
  assert.equal(result.status,'confirmed');assert.equal(result.reservationId,'OVERHEAD-ORDER');assert.equal(closes,0);
  await adapter.releaseTask(task.id);assert.equal(closes,1,'a completed task releases its dedicated read-only order page');
});

test('repeated order verification reuses its own tab, cancels unused listeners and preserves the pending form',async()=>{
  const f=fixture();
  for(let index=0;index<3;index++)assert.equal((await f.adapter.reconcile(attempt)).resumeAllowed,true);
  const page=f.adapter.readOnlyPages.get('shared').page;
  assert.equal(f.pages,1);assert.equal(f.orderReads,3,'each verification reloads official evidence');
  assert.equal(f.adapter.bookingPages.get(task.id),f.flowPage);assert.equal(f.prepares,0);
  assert.equal(page.listenerCount('response'),0);assert.equal(page.listenerCount('close'),0);
  await page.close();
  assert.equal((await f.adapter.reconcile(attempt)).resumeAllowed,true);
  assert.equal(f.pages,2,'a closed helper is recreated once');assert.equal(f.orderReads,4);
  assert.equal(f.adapter.bookingPages.get(task.id),f.flowPage);
});

test('task release clears task-owned maps and closes a shared task page once, preserving login and unrelated pages',async()=>{
  const adapter=new CatchtableAdapter();let closes=0,loginCloses=0,otherCloses=0;
  const owned={isClosed:()=>false,close:async()=>{closes++;}};
  adapter.sessionPage={close:async()=>{loginCloses++;}};
  const other={close:async()=>{otherCloses++;}};
  adapter.watchPages.set(task.id,owned);adapter.bookingPages.set(task.id,owned);adapter.bookingFlows.set(task.id,{page:owned});adapter.inspections.set(task.id,{});
  adapter.watchPages.set('other-task',other);
  const releasing=adapter.releaseTask(task.id);
  assert.equal(adapter.watchPages.has(task.id),false,'map removal precedes asynchronous close');
  await releasing;await adapter.releaseTask(task.id);
  assert.equal(closes,1);assert.equal(loginCloses,0);assert.equal(otherCloses,0);
  assert.equal(adapter.bookingPages.size,0);assert.equal(adapter.bookingFlows.size,0);assert.equal(adapter.inspections.size,0);assert.equal(adapter.watchPages.get('other-task'),other);
});
