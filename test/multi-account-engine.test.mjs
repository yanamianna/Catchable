import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { AccountCoordinator } from '../server/accounts.mjs';

const now=()=>Date.parse('2026-10-15T00:00:00Z');
const input={restaurantName:'Synthetic Restaurant',restaurantUrl:'https://www.catchtable.net/shop/synthetic',dates:['2026-10-24'],partySize:2,timeStart:'18:00',timeEnd:'20:00',mode:'notify',pollIntervalMs:1000};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(predicate,timeout=5000) {
  const deadline=Date.now()+timeout;
  while(!predicate()) {if(Date.now()>deadline)throw new Error('Timed out waiting for isolated fixture');await new Promise(r=>setTimeout(r,10));}
}

test('50 accounts inspect concurrently; a slow account cannot block others and one account remains serial',async()=>{
  const store=new Store(':memory:');store.initializeAccounts();
  for(let i=1;i<50;i++)store.createAccount({label:`Synthetic ${i}`});
  const gates=new Map(),entered=new Map(),busy=new Set();
  const coordinator=await new AccountCoordinator({store,now,dataDir:'.unused-fixture',adapterFactory:async({account})=>{
    gates.set(account.id,deferred());
    return {hasContext:true,defaultIntegration:'extension',inspect:async()=>{
      assert.equal(busy.has(account.id),false,'one account must not overlap its own pages');busy.add(account.id);
      entered.set(account.id,(entered.get(account.id)||0)+1);
      await gates.get(account.id).promise;busy.delete(account.id);
      return {status:'unavailable',slots:[],complete:true};
    },close:async()=>{}};
  }}).init();
  try {
    for(const account of store.listAccounts()) {
      const {task}=coordinator.createTask({...input,accountId:account.id});
      await coordinator.engine(account.id).taskAction(task.id,'start');
    }
    const extra=coordinator.createTask({...input,accountId:'default'}).task;
    await coordinator.engine('default').taskAction(extra.id,'start');
    coordinator.engineAction('resume','all');coordinator.start();
    await until(()=>entered.size===50);
    assert.equal(entered.get('default'),1);
    for(const [id,gate] of gates)if(id!=='default')gate.resolve();
    await until(()=>store.listTasks().filter(task=>task.accountId!=='default'&&task.checkCount===1).length===49);
    assert.equal(store.forAccount('default').listTasks().reduce((sum,task)=>sum+task.checkCount,0),0);
    gates.get('default').resolve();
    await until(()=>entered.get('default')===2);
    assert.equal(coordinator.state().accounts.length,50);
    assert.equal(coordinator.state().engine.accountCount,50);
  }finally {for(const gate of gates.values())gate.resolve();await coordinator.stop();store.close();}
});

test('contacts are frozen at attempt creation and account uncertainty does not block another account',async()=>{
  const store=new Store(':memory:');store.initializeAccounts();
  const second=store.createAccount({label:'Second',settings:{bookingName:'Second Name',bookingPhoneCountryCode:'+82',bookingPhoneNumber:'100000002',bookingPhoneAutoFill:true}});
  const root=await new AccountCoordinator({store,now,dataDir:'.unused-fixture',adapterFactory:async()=>({hasContext:true,defaultIntegration:'extension',prepare:async()=>({status:'user_action_required',submitted:false}),close:async()=>{}})}).init();
  try {
    const firstTask=root.createTask({...input,accountId:'default',mode:'auto',autoConsent:true}).task;
    const task=root.createTask({...input,accountId:second.id,mode:'auto',autoConsent:true}).task;
    const slot={date:'2026-10-24',time:'18:00',partySize:2};
    store.forAccount('default').addAttempt(firstTask,slot,'outcome_unknown');
    assert.equal(store.forAccount(second.id).hasUncertainLiveAttempt(),false);
    const attempt=store.forAccount(second.id).addAttempt(task,slot,'user_action_required');
    root.updateAccount(second.id,{bookingName:'Changed',bookingPhoneCountryCode:'+82',bookingPhoneNumber:'100000099',bookingPhoneAutoFill:true});
    assert.deepEqual(root.engine(second.id).bookingContactOptions(task,attempt).bookingContact,{countryCode:'+82',phoneNumber:'100000002',fullName:'Second Name'});
    assert.throws(()=>root.taskEngine(task.id,'default'),/不属于/);
    assert.equal(JSON.stringify(root.state()).includes('accountIdentityFingerprint'),false);
    root.engineAction('resume','all');root.engineAction('pause',second.id);
    assert.equal(root.engine(second.id).state().paused,true);
    assert.equal(root.engine('default').state().paused,false);
  }finally {await root.stop();store.close();}
});

test('50 automatic accounts keep contacts, same-named groups and durable submissions isolated',async()=>{
  const store=new Store(':memory:');store.initializeAccounts();
  for(let i=1;i<50;i++)store.createAccount({label:`Synthetic ${i}`});
  const expected=new Map(),seen=new Map(),gate=deferred();
  let index=0;
  for(const account of store.listAccounts()) {
    const contact={fullName:`Synthetic Name ${index}`,countryCode:'+82',phoneNumber:`10000${String(index).padStart(4,'0')}`};
    expected.set(account.id,contact);index++;
    store.updateAccount(account.id,{settings:{bookingName:contact.fullName,bookingPhoneCountryCode:contact.countryCode,bookingPhoneNumber:contact.phoneNumber,bookingPhoneAutoFill:true}});
    store.bindAccountIdentity(account.id,`synthetic-identity-${account.id}`);
  }
  const coordinator=await new AccountCoordinator({store,now,dataDir:'.unused-fixture',adapterFactory:async({account})=>({
    hasContext:true,defaultIntegration:'extension',
    inspect:async()=>({status:'available',complete:false,observedDates:input.dates,slots:[{date:input.dates[0],time:'18:00',partySize:2}]}),
    prepare:async(task,slot,{bookingContact,onBeforeSubmit})=>{
      assert.equal(task.accountId,account.id);assert.deepEqual(bookingContact,expected.get(account.id));
      seen.set(account.id,bookingContact);await gate.promise;await onBeforeSubmit();
      const attempt=store.forAccount(account.id).attemptsForTask(task.id)[0];assert.equal(attempt.submitted,true);
      return {status:'confirmed',reservationId:`synthetic-${account.id}`,slot};
    },close:async()=>{}
  })}).init();
  const pending=[];
  try {
    coordinator.engineAction('resume','all');
    for(const account of store.listAccounts()) {
      const engine=coordinator.engine(account.id);engine.applySession({status:'authenticated',connected:true,browserOpen:true});
      const task=coordinator.createTask({...input,accountId:account.id,mode:'auto',autoConsent:true,groupId:'same-group-name'}).task;
      store.forAccount(account.id).patchTask(task.id,{status:'active'});
      pending.push(engine.enqueue(()=>engine.checkTask(task.id)));
    }
    await until(()=>seen.size===50);gate.resolve();await Promise.all(pending);
    assert.equal(store.listAttempts().filter(attempt=>attempt.status==='confirmed').length,50);
    assert.equal(new Set(store.listAttempts().map(attempt=>attempt.accountId)).size,50);
  }finally {gate.resolve();await Promise.allSettled(pending);await coordinator.stop();store.close();}
});
