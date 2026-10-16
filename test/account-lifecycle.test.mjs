import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { AccountCoordinator } from '../server/accounts.mjs';

const NOW=Date.parse('2026-10-15T00:00:00Z'),timestamp=new Date(NOW).toISOString();
const input={restaurantName:'Lifecycle fixture',restaurantUrl:'https://www.catchtable.net/shop/lifecycle_fixture',dates:['2026-12-24'],partySize:2,timeSlots:['14:00','15:00'],mode:'notify'};
const slot={date:input.dates[0],time:'14:00',partySize:2};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const errorStatus=status=>error=>error.status===status;

async function fixture(t) {
  const store=new Store(':memory:',{now:()=>NOW}),adapters=[],removed=[],bridges=new Map();let browserCalls=0;
  const broker={ensureAccount:async id=>{if(!bridges.has(id))bridges.set(id,{setLabel(){}});},getBridge:id=>bridges.get(id),
    state:()=>({connected:true,status:'connected'}),removeAccount:async id=>{removed.push(id);bridges.delete(id);}};
  const c=await new AccountCoordinator({store,broker,dataDir:'.unused-lifecycle-fixture',now:()=>NOW,
    adapterFactory:async({account,identityVerifier})=>{
      const adapter={accountId:account.id,identityVerifier,closes:0,defaultIntegration:'extension',hasContext:false,
        close:async()=>{adapter.closes++;},getSessionStatus:async()=>{browserCalls++;throw new Error('No browser actions allowed in lifecycle fixtures.');}};
      adapters.push(adapter);return adapter;
    }}).init();
  t.after(async()=>{await c.stop();store.close();assert.equal(browserCalls,0);});
  const account=await c.createAccount({label:'Second fixture',bookingName:'Old fixture name',bookingPhoneCountryCode:'+1',bookingPhoneNumber:'2025550101',bookingPhoneAutoFill:true});
  const scoped=store.forAccount(account.id);
  const task=()=>c.createTask({...input,accountId:account.id}).task;
  return {store,c,account,scoped,task,adapters,removed};
}

test('explicit identity replacement resets runtime and old task caches while retaining immutable historical booking evidence',async t=>{
  const {store,c,account,scoped,task,adapters}=await fixture(t);
  store.bindAccountIdentity(account.id,'old-fixture-principal');
  const original=task();scoped.patchTask(original.id,{status:'active',nextCheckAt:timestamp,slots:[slot],checkCount:9},timestamp);
  const historical=scoped.addAttempt(original,slot,'confirmed','Fixture old result',timestamp);
  scoped.saveAttempt({...historical,submitted:true,reservationId:'old-fixture-order'});
  const evidence=structuredClone(scoped.getAttempt(historical.id));
  assert.equal(scoped.recordSlots(original.id,[slot]).length,1);
  const oldEngine=c.engine(account.id),oldAdapter=adapters.at(-1);
  await assert.rejects(c.accountAction(account.id,'reset_identity'),errorStatus(400));
  const response=await c.accountAction(account.id,'reset_identity',{confirm:true});
  assert.equal(response.account.enabled,true);assert.equal(response.account.settings.enginePaused,true);
  assert.equal(response.account.settings.bookingName,'');assert.equal(response.account.settings.bookingPhoneNumber,'');assert.equal(response.account.settings.bookingPhoneCountryCode,'');assert.equal(response.account.settings.bookingPhoneAutoFill,false);
  assert.equal(JSON.stringify(response).includes('Fingerprint'),false);assert.equal(store.getAccount(account.id).identityFingerprint,null);
  assert.notEqual(c.engine(account.id),oldEngine);assert.equal(oldAdapter.closes,1);assert.equal(c.engine(account.id).session.status,'closed');
  assert.equal(scoped.getTask(original.id).status,'paused');assert.equal(scoped.getTask(original.id).nextCheckAt,null);assert.deepEqual(scoped.getTask(original.id).slots,[]);
  assert.equal(scoped.getTask(original.id).checkCount,9);assert.equal(scoped.recordSlots(original.id,[slot]).length,1);
  assert.deepEqual(scoped.getAttempt(historical.id),evidence);
  const fresh=adapters.at(-1);await fresh.identityVerifier('new-fixture-principal');
  await assert.rejects(oldAdapter.identityVerifier('old-fixture-principal'),error=>error.code==='IDENTITY_MISMATCH');
  assert.equal(store.getAccount(account.id).identityFingerprint,'new-fixture-principal');assert.equal(store.getAccount(account.id).enabled,true);
  assert.deepEqual(scoped.getAttempt(historical.id).contactSnapshot,evidence.contactSnapshot);
});

test('every unresolved reservation blocks identity replacement and deletion without changing its account or evidence',async t=>{
  const {store,c,account,scoped,task,adapters}=await fixture(t);
  store.bindAccountIdentity(account.id,'pending-fixture-principal');
  const original=task(),oldEngine=c.engine(account.id),oldAdapter=adapters.at(-1);
  for(const status of ['submitting','outcome_unknown','user_action_required','pending_restaurant']) {
    const attempt=scoped.addAttempt(original,slot,status,'Unresolved fixture',timestamp);
    for(const action of ['reset_identity','delete'])await assert.rejects(c.accountAction(account.id,action,{confirm:true}),errorStatus(409));
    assert.throws(()=>store.resetAccountIdentity(account.id,timestamp),errorStatus(409));
    assert.throws(()=>store.archiveAccount(account.id,timestamp),errorStatus(409));
    assert.equal(c.engine(account.id),oldEngine);assert.equal(oldAdapter.closes,0);assert.equal(store.getAccount(account.id).enabled,true);
    assert.equal(store.getAccount(account.id).identityFingerprint,'pending-fixture-principal');
    scoped.saveAttempt({...attempt,status:'rejected'});
  }
});

test('replacement locks new account actions and pauses again after earlier queued work drains',async t=>{
  const {store,c,account,scoped,task,adapters}=await fixture(t);
  store.bindAccountIdentity(account.id,'drain-fixture-principal');
  const original=task(),oldEngine=c.engine(account.id),oldAdapter=adapters.at(-1),entered=deferred(),release=deferred();
  const work=oldEngine.enqueue(async()=>{entered.resolve();await release.promise;scoped.patchTask(original.id,{status:'active',nextCheckAt:timestamp,slots:[slot]},timestamp);});
  await entered.promise;
  const replacing=c.accountAction(account.id,'reset_identity',{confirm:true});
  assert.equal(store.getAccount(account.id).enabled,false);assert.equal(scoped.getTask(original.id).status,'paused');
  for(const operation of [()=>c.engine(account.id),()=>c.updateAccount(account.id,{label:'Should not change'}),()=>c.createTask({...input,accountId:account.id}),()=>c.engineAction('resume',account.id)])assert.throws(operation,errorStatus(423));
  await assert.rejects(c.accountAction(account.id,'enable'),errorStatus(423));
  await assert.rejects(oldAdapter.identityVerifier('late-wrong-principal'),error=>error.code==='IDENTITY_MISMATCH');
  assert.equal(store.getAccount(account.id).identityFingerprint,'drain-fixture-principal');
  assert.equal(c.state('all').accounts.length,2,'status reads remain available during a transition');
  release.resolve();await work;await replacing;
  assert.equal(scoped.getTask(original.id).status,'paused');assert.equal(scoped.getTask(original.id).nextCheckAt,null);assert.deepEqual(scoped.getTask(original.id).slots,[]);
  assert.equal(store.getAccount(account.id).settings.enginePaused,true);
});

test('an unresolved reservation appearing during drain aborts replacement and recreates a paused runtime with the original identity',async t=>{
  const {store,c,account,scoped,task}=await fixture(t);
  store.bindAccountIdentity(account.id,'original-drain-identity');
  const original=task(),oldEngine=c.engine(account.id),entered=deferred(),release=deferred();
  const work=oldEngine.enqueue(async()=>{entered.resolve();await release.promise;scoped.addAttempt(original,slot,'outcome_unknown','Late fixture attempt',timestamp);});
  await entered.promise;
  const replacing=c.accountAction(account.id,'reset_identity',{confirm:true});
  const rejected=assert.rejects(replacing,errorStatus(409));release.resolve();await work;await rejected;
  assert.equal(store.getAccount(account.id).identityFingerprint,'original-drain-identity');assert.equal(store.getAccount(account.id).enabled,false);
  assert.equal(store.getAccount(account.id).settings.bookingPhoneAutoFill,true,'failed replacement must preserve previous contact evidence/settings');
  assert.equal(scoped.listPendingAttempts().length,1);assert.notEqual(c.engine(account.id),oldEngine);assert.equal(scoped.getTask(original.id).status,'paused');
});

test('deletion retires only that runtime and keeps booking, activity and notices available in all-account history',async t=>{
  const {store,c,account,scoped,task,adapters,removed}=await fixture(t);
  store.bindAccountIdentity(account.id,'archive-fixture-principal');
  const original=task();scoped.patchTask(original.id,{status:'active',nextCheckAt:timestamp},timestamp);
  const booking=scoped.addAttempt(original,slot,'confirmed','Confirmed archive fixture',timestamp);
  const event=scoped.addEvent({taskId:original.id,source:'live',type:'slot_available',message:'Fixture activity',createdAt:timestamp});
  const notice=scoped.addNotification(event,'in_app',timestamp),queued=scoped.addNotification(event,'webhook',timestamp),oldAdapter=adapters.at(-1);
  await assert.rejects(c.accountAction(account.id,'delete'),errorStatus(400));
  assert.deepEqual(await c.accountAction(account.id,'delete',{confirm:true}),{ok:true,accountId:account.id,deleted:true});
  assert.deepEqual(removed,[account.id]);assert.equal(oldAdapter.closes,1);assert.equal(c.engines.has(account.id),false);assert.equal(c.sessionDue.has(account.id),false);
  assert.equal(store.getAccount(account.id).deletedAt,timestamp);assert.equal(store.getAccount(account.id).identityFingerprint,null);
  assert.deepEqual(store.listAccounts().map(value=>value.id),['default']);assert.equal(store.listAccounts({includeArchived:true}).length,2);
  for(const operation of [()=>c.account(account.id),()=>c.engine(account.id),()=>c.updateAccount(account.id,{label:'No resurrection'}),()=>store.bindAccountIdentity(account.id,'new')])assert.throws(operation,errorStatus(404));
  const state=c.state('all');assert.deepEqual(state.tasks,[]);assert.equal(state.stats.totalTasks,0);assert.equal(state.stats.confirmedBookings,1);
  assert.ok(state.bookings.some(record=>record.id===booking.id && record.accountLabel===account.label && record.accountArchived===true));
  assert.ok(state.events.some(record=>record.id===event.id && record.accountArchived===true));
  assert.ok(state.notifications.some(record=>record.id===notice.id && record.accountArchived===true));
  assert.equal(scoped.listNotifications().find(record=>record.id===queued.id).status,'failed');assert.equal(store.nextNotification(timestamp),null);
  assert.equal(scoped.getTask(original.id).status,'paused');assert.equal(JSON.stringify(state).includes('archive-fixture-principal'),false);
  await assert.rejects(oldAdapter.identityVerifier('archive-fixture-principal'),error=>error.code==='IDENTITY_MISMATCH');
  store.bindAccountIdentity('default','archive-fixture-principal');
  c.clearRecords('all','all');assert.deepEqual(c.state('all').bookings,[]);assert.equal(scoped.getAttempt(booking.id).id,booking.id,'clearing display preserves archived booking evidence');
});

test('default account remains compatible and archived accounts are not resurrected on restart',async t=>{
  const {store,c,account,removed}=await fixture(t);
  await assert.rejects(c.accountAction('default','delete',{confirm:true}),errorStatus(409));
  await c.accountAction(account.id,'delete',{confirm:true});
  await c.stop();
  const initialized=[];
  const restored=await new AccountCoordinator({store,broker:{ensureAccount:async id=>initialized.push(id),getBridge:()=>({setLabel(){}}),state:()=>({connected:false})},now:()=>NOW,
    adapterFactory:async()=>({defaultIntegration:'extension',close:async()=>{}})}).init();
  try {assert.deepEqual(initialized,['default']);assert.deepEqual([...restored.engines.keys()],['default']);assert.deepEqual(removed,[account.id]);}
  finally {await restored.stop();}
});
