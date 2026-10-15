import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';
import { createTask } from '../server/domain.mjs';

const INITIAL=Date.parse('2030-01-01T00:00:00Z');
const slot={date:'2030-01-02',time:'18:00',partySize:2};
function fixture(adapter={}) {
  let now=INITIAL;
  const store=new Store(':memory:',{now:()=>now});
  const engine=new Engine({store,now:()=>now,adapter:{inspect:async()=>({status:'unavailable',slots:[]}),...adapter}});
  const task=(changes={})=>store.saveTask({...createTask({restaurantName:'Offline Fixture',restaurantUrl:'https://www.catchtable.net/shop/offline',dates:[slot.date],partySize:2,timeStart:'18:00',timeEnd:'20:00',mode:'notify',pollIntervalMs:1},{},now),status:'active',nextCheckAt:new Date(now).toISOString(),...changes});
  return {store,engine,task,advance:milliseconds=>{now+=milliseconds;},async close(){await engine.stop();store.close();}};
}

test('repeated unchanged inventory keeps all metrics but coalesces routine logs; changes and manual checks are retained',async()=>{
  let available=false;
  const f=fixture({inspect:async()=>({status:available?'available':'unavailable',slots:available?[slot]:[]})});
  try {
    const task=f.task();
    for(let index=0;index<200;index++){await f.engine.checkTask(task.id);f.advance(1);}
    assert.equal(f.store.getTask(task.id).checkCount,200);
    assert.equal(f.store.listEvents(1000).filter(event=>event.type==='checked').length,1,'200 unchanged observations previously wrote 200 routine rows');
    f.advance(30000);await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents(1000).filter(event=>event.type==='checked').length,2,'retain a periodic diagnostic summary');
    available=true;await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents(1000).filter(event=>event.type==='checked').length,3);
    assert.equal(f.store.listNotifications().filter(notice=>notice.eventType==='slot_available').length,1);
    await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents(1000).filter(event=>event.type==='checked').length,3);
    available=false;await f.engine.checkTask(task.id);
    assert.equal(f.store.listEvents(1000).filter(event=>event.type==='checked').length,4,'availability disappearance is a meaningful change');
    await f.engine.checkTask(task.id,{manual:true});
    assert.equal(f.store.listEvents(1000).filter(event=>event.type==='checked').length,5,'explicit checks always retain their event');
  }finally {await f.close();}
});

test('one scheduler pass reads tasks and pending attempts once without checking an expired task',async()=>{
  let inspections=0;
  const f=fixture({inspect:async()=>{inspections++;return {status:'unavailable',slots:[]};}});
  try {
    const expired=f.task({deadline:new Date(INITIAL-1).toISOString()});
    const waiting=f.task({mode:'auto',autoConsent:true,status:'user_action_required',nextCheckAt:null});
    f.store.addAttempt(waiting,slot,'user_action_required');
    const counts={tasks:0,attempts:0};
    for(const [method,key] of [['listTasks','tasks'],['listPendingAttempts','attempts']]) {
      const original=f.store[method].bind(f.store);f.store[method]=(...args)=>{counts[key]++;return original(...args);};
    }
    await f.engine.tick();
    assert.deepEqual(counts,{tasks:1,attempts:1});
    assert.equal(inspections,0);assert.equal(f.store.getTask(expired.id).status,'expired');
    counts.tasks=0;counts.attempts=0;f.engine.schedulerActive=true;f.engine.schedule();
    assert.deepEqual(counts,{tasks:1,attempts:1});
  }finally {await f.close();}
});

test('terminal outcomes release task pages but pending orders and reusable active retries retain them',async()=>{
  const released=[];
  const f=fixture({releaseTask:async id=>{released.push(id);}});
  try {
    const pendingTask=f.task({mode:'auto',autoConsent:true});
    const pending=f.store.addAttempt(pendingTask,slot,'submitting');
    f.engine.finishAttempt(pending,{status:'pending_restaurant',slot,reservationId:'OFFLINE-PENDING'});
    await Promise.resolve();await Promise.resolve();
    assert.deepEqual(released,[],'pending order keeps its original form and evidence');
    f.engine.finishAttempt(f.store.getAttempt(pending.id),{status:'confirmed',slot,reservationId:'OFFLINE-PENDING'},{verification:true});
    const retryTask=f.task({mode:'auto',autoConsent:true});
    f.engine.finishAttempt(f.store.addAttempt(retryTask,slot,'submitting'),{status:'rejected',submitted:false});
    const rejectedTask=f.task({mode:'auto',autoConsent:true});
    f.engine.finishAttempt(f.store.addAttempt(rejectedTask,slot,'submitting'),{status:'rejected',submitted:true});
    const expired=f.task({deadline:new Date(INITIAL-1).toISOString()});
    const deleted=f.task({status:'paused',nextCheckAt:null});f.engine.deleteTask(deleted.id);
    await f.engine.tick();
    await Promise.allSettled([...f.engine.resourceCleanups]);
    assert.deepEqual(new Set(released),new Set([pendingTask.id,rejectedTask.id,expired.id,deleted.id]));
    assert.equal(f.store.getTask(retryTask.id).status,'active');
    assert.equal(f.store.getAttempt(pending.id).status,'confirmed','cleanup retains persistent order evidence');
  }finally {await f.close();}
});

test('stop waits for outstanding page cleanup before closing the adapter',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let cleaned=false;let closed=false;
  const f=fixture({releaseTask:async()=>{await gate;cleaned=true;},close:async()=>{assert.equal(cleaned,true);closed=true;}});
  try {
    f.engine.deleteTask(f.task({status:'paused',nextCheckAt:null}).id);
    const stopping=f.engine.stop();await Promise.resolve();await Promise.resolve();assert.equal(closed,false);
    release();await stopping;assert.equal(closed,true);
  }finally {release();await f.close();}
});
