import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createTask} from '../server/domain.mjs';

const now=Date.parse('2030-01-01T00:00:00Z');
function fixture() {
  const root=new Store(':memory:',{now:()=>now});root.initializeAccounts();
  const account=root.createAccount({label:'Synthetic identity fixture'});
  root.bindAccountIdentity(account.id,'synthetic-original-identity');
  root.saveSettings({enginePaused:false});
  const store=root.forAccount(account.id);store.saveSettings({enginePaused:false});
  const task=store.saveTask({...createTask({restaurantName:'Fixture',restaurantUrl:'https://www.catchtable.net/shop/fixture',dates:['2030-01-02'],partySize:2,timeStart:'14:00',timeEnd:'15:00',mode:'auto',autoConsent:true},{},now),accountId:account.id,status:'active'});
  const slot={date:'2030-01-02',time:'14:00',partySize:2};
  const attempt=store.addAttempt(task,slot,'user_action_required');
  store.saveAttempt({...attempt,phase:'before_submit'});
  let identity='synthetic-original-identity';
  const originalAccount=store.getAccount.bind(store);
  store.getAccount=()=>({...originalAccount(),identityFingerprint:identity});
  let reads=0,continuations=0;
  const adapter={hasContext:true,isBookingAuthenticated:()=>true,
    reconcile:async()=>{reads++;return {status:'user_action_required',submitted:false,phase:'before_submit',resumeAllowed:true};},
    continueAttempt:async()=>{continuations++;return {status:'user_action_required',submitted:false,phase:'before_submit'};},close:async()=>{}};
  const engine=new Engine({store,adapter,now:()=>now});engine.applySession({status:'authenticated',browserOpen:true});
  return {root,store,engine,task,attempt:store.getAttempt(attempt.id),changeIdentity:()=>{identity='synthetic-replacement-identity';},counts:()=>({reads,continuations}),close:async()=>{await engine.stop();root.close();}};
}

test('an old attempt cannot be queried, continued or submitted through a replacement account identity',async()=>{
  const f=fixture();
  try {
    f.changeIdentity();
    await assert.rejects(f.engine.beforeSubmit(f.attempt)(),/更换前/);
    await assert.rejects(f.engine.continueAutoTask(f.task),/更换前/);
    assert.equal(f.engine.automaticContinuationAllowed(f.attempt,{status:'user_action_required',phase:'before_submit',submitted:false,resumeAllowed:true}),false);
    await f.engine.verifyAttempt(f.attempt);
    assert.deepEqual(f.counts(),{reads:0,continuations:0});
    const saved=f.store.getAttempt(f.attempt.id);
    assert.equal(saved.status,'user_action_required');assert.equal(saved.submitted,false);
    assert.match(saved.lastVerificationMessage,/更换前/);
    assert.equal(saved.accountIdentityFingerprint,'synthetic-original-identity');
  }finally {await f.close();}
});

test('the original identity still passes the durable submission guard without changing its snapshot',async()=>{
  const f=fixture();
  try {
    await f.engine.beforeSubmit(f.attempt)();
    const saved=f.store.getAttempt(f.attempt.id);
    assert.equal(saved.status,'submitting');assert.equal(saved.submitted,true);
    assert.equal(saved.accountIdentityFingerprint,'synthetic-original-identity');
    assert.deepEqual(saved.contactSnapshot,f.attempt.contactSnapshot);
  }finally {await f.close();}
});
