import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createTask} from '../server/domain.mjs';

const NOW=Date.parse('2030-01-01T00:00:00Z');
const slot={date:'2030-01-02',time:'13:00',partySize:2};
function fixture(overrides={}) {
  let now=NOW;
  const store=new Store(':memory:',{now:()=>now});
  const calls={inspect:0,prepare:0,reconcile:0,continue:0};
  const adapter={inspect:async()=>{calls.inspect++;return {status:'available',slots:[slot]};},prepare:async()=>{calls.prepare++;return {status:'user_action_required',phase:'ordinary_confirmation',message:'需要普通确认。'};},
    reconcile:async()=>{calls.reconcile++;return {status:'outcome_unknown',message:'尚未核验。'};},close:async()=>{},...overrides};
  const engine=new Engine({store,adapter,now:()=>now});
  const task=(values={})=>store.saveTask({...createTask({restaurantName:'测试餐厅',restaurantUrl:'https://www.catchtable.net/shop/test_restaurant',dates:[slot.date],partySize:2,timeStart:'12:00',timeEnd:'14:00',mode:'auto',autoConsent:true,pollIntervalMs:1,...values},{},now),status:'active',nextCheckAt:new Date(now).toISOString()});
  return {store,engine,adapter,calls,task,advance:ms=>{now+=ms;},close:async()=>{await engine.stop();store.close();}};
}
const pending=(overrides={})=>({status:'pending_restaurant',reservationId:'REQ-123',slot,phase:'awaiting_restaurant',submitted:true,message:'预约申请已提交，等待餐厅确认。',...overrides});

test('login recovery continues the same unsubmitted authentication step, while a guest booking page blocks the final write',async()=>{
  const f=fixture({hasContext:true,prepare:async()=>({status:'user_action_required',phase:'authentication',submitted:false,message:'请登录。'}),
    reconcile:async()=>({status:'user_action_required',phase:'authentication',submitted:false,resumeAllowed:true,message:'无重复订单。'})});
  try {
    const task=f.task();await f.engine.checkTask(task.id);const attempt=f.store.listAttempts()[0];
    f.engine.applySession({status:'authenticated',connected:true,browserOpen:true,browserMode:'controlled'});
    f.adapter.isBookingAuthenticated=()=>false;
    f.adapter.continueAttempt=async(received,options)=>{f.calls.continue++;assert.equal(received.id,attempt.id);await options.onBeforeSubmit();throw new Error('Guest page must not reach submission');};
    await f.engine.verifyAttempt(attempt);
    assert.equal(f.calls.continue,1);assert.equal(f.store.listAttempts().length,1);
    const blocked=f.store.getAttempt(attempt.id);assert.equal(blocked.phase,'authentication');assert.equal(blocked.submitted,false);assert.equal(blocked.status,'user_action_required');
    assert.equal(f.engine.session.connected,false);assert.equal(f.engine.state().accountWriteBlocked,false);
    f.engine.applySession({status:'authenticated',connected:true,browserOpen:true,browserMode:'controlled'});
    f.adapter.isBookingAuthenticated=()=>true;
    f.adapter.continueAttempt=async(received,options)=>{await options.onBeforeSubmit();return pending();};
    await f.engine.verifyAttempt(blocked);
    assert.equal(f.store.getAttempt(attempt.id).status,'pending_restaurant');assert.equal(f.store.listAttempts().length,1);
  }finally {await f.close();}
});

test('a matching restaurant request is durable pending state and is never counted as confirmed',async()=>{
  const f=fixture({prepare:async()=>pending()});
  try {
    const task=f.task({groupId:'lunch'});const peer=f.task({groupId:'lunch'});
    await f.engine.checkTask(task.id);
    const attempt=f.store.listAttempts()[0];
    assert.equal(attempt.status,'pending_restaurant');assert.equal(attempt.reservationId,'REQ-123');assert.equal(attempt.submitted,true);
    assert.equal(attempt.phase,'awaiting_restaurant');assert.equal(attempt.verificationCount,0);assert.equal(Date.parse(attempt.nextVerificationAt)-NOW,10000);
    assert.equal(f.store.getTask(task.id).status,'awaiting_confirmation');assert.equal(f.store.stats().confirmedBookings,0);assert.equal(f.store.stats().pendingRestaurantBookings,1);
    assert.equal(f.store.getTask(peer.id).status,'active');await assert.rejects(f.engine.prepareTask(peer,slot),/同组/);
    await assert.rejects(f.engine.prepareTask(f.store.getTask(task.id),slot),/不能重复/);assert.throws(()=>f.engine.deleteTask(task.id),/待核验/);
  } finally {await f.close();}
});

test('pending without order identity or with mismatched slot remains unknown and blocks account writes',async()=>{
  for(const result of [pending({reservationId:''}),pending({slot:{...slot,partySize:3}})]) {
    const f=fixture({prepare:async()=>result});
    try {const task=f.task();await f.engine.checkTask(task.id);assert.equal(f.store.listAttempts()[0].status,'outcome_unknown');assert.equal(f.engine.state().accountWriteBlocked,true);assert.equal(f.store.stats().confirmedBookings,0);}
    finally {await f.close();}
  }
});

test('another matching reservation ID cannot confirm the original pending request',async()=>{
  const f=fixture({prepare:async()=>pending(),reconcile:async()=>({status:'confirmed',reservationId:'OTHER-456',slot,message:'另一订单已确认。'})});
  try {const task=f.task();await f.engine.checkTask(task.id);f.advance(10001);await f.engine.tick();assert.equal(f.store.listAttempts()[0].status,'pending_restaurant');assert.equal(f.store.listAttempts()[0].reservationId,'REQ-123');assert.equal(f.store.stats().confirmedBookings,0);}
  finally {await f.close();}
});

test('due read-only verification has priority over 1 ms inventory and synchronizes final confirmation',async()=>{
  const f=fixture({prepare:async()=>pending(),reconcile:async()=>{f.calls.reconcile++;return {status:'confirmed',reservationId:'REQ-123',slot,phase:'confirmed',message:'餐厅已确认。'};}});
  try {
    const waiting=f.task({groupId:'lunch'});await f.engine.checkTask(waiting.id);const peer=f.task({groupId:'lunch'});
    f.advance(10001);await f.engine.tick();
    assert.equal(f.calls.reconcile,1);assert.equal(f.calls.inspect,1,'pending verification must precede the unrelated due inventory');
    assert.equal(f.store.listAttempts()[0].verificationCount,1);assert.equal(f.store.listAttempts()[0].nextVerificationAt,null);
    assert.equal(f.store.getTask(waiting.id).status,'confirmed');assert.equal(f.store.getTask(peer.id).status,'paused');assert.equal(f.store.stats().confirmedBookings,1);
  } finally {await f.close();}
});

test('stable pending status does not resend notifications and read failure keeps the known request',async()=>{
  let failures=false;
  const f=fixture({prepare:async()=>pending(),reconcile:async()=>{if(failures)throw new Error('读取失败');return pending();}});
  try {
    const task=f.task();await f.engine.checkTask(task.id);const notifications=f.store.listNotifications().length;
    f.advance(10001);await f.engine.tick();
    assert.equal(f.store.listNotifications().length,notifications);assert.equal(f.store.listAttempts()[0].verificationCount,1);
    assert.equal(Date.parse(f.store.listAttempts()[0].nextVerificationAt)-NOW-10001,30000);
    failures=true;f.advance(30001);await f.engine.tick();
    const attempt=f.store.listAttempts()[0];assert.equal(attempt.status,'pending_restaurant');assert.equal(attempt.reservationId,'REQ-123');assert.equal(attempt.verificationFailureCount,1);
    assert.equal(f.store.getTask(task.id).status,'awaiting_confirmation');assert.match(attempt.lastVerificationMessage,/读取失败/);assert.equal(f.store.listNotifications().length,notifications);
    assert.equal(f.engine.state().accountWriteBlocked,false,'known pending is not an unknown submission');
  } finally {await f.close();}
});

test('unknown verification backs off, only reads, and cannot produce duplicate attempts',async()=>{
  const f=fixture({prepare:async()=>({status:'outcome_unknown',submitted:true,message:'响应丢失。'})});
  try {
    const task=f.task();await f.engine.checkTask(task.id);const attemptId=f.store.listAttempts()[0].id;
    for(const wait of [10001,30001,60001]){f.advance(wait);await f.engine.tick();}
    const attempt=f.store.listAttempts()[0];assert.equal(attempt.id,attemptId);assert.equal(f.store.listAttempts().length,1);assert.equal(attempt.verificationCount,3);
    assert.equal(attempt.verificationFailureCount,3);assert.equal(Date.parse(attempt.nextVerificationAt)-NOW-10001-30001-60001,120000);
    assert.equal(f.calls.inspect,1);assert.equal(f.engine.state().accountWriteBlocked,true);
  } finally {await f.close();}
});

test('global pause and individual pause stop automatic verification; existing orders survive task deadline',async()=>{
  const f=fixture({prepare:async()=>pending(),reconcile:async()=>{f.calls.reconcile++;return pending();}});
  try {
    const task=f.task({deadline:new Date(NOW+5000).toISOString()});await f.engine.checkTask(task.id);
    f.advance(10001);f.engine.globalAction('pause_all');await f.engine.tick();assert.equal(f.calls.reconcile,0);assert.equal(f.store.getTask(task.id).status,'awaiting_confirmation');
    f.engine.globalAction('resume_all');await f.engine.tick();assert.equal(f.calls.reconcile,1);
    await f.engine.taskAction(task.id,'pause');f.advance(30001);await f.engine.tick();assert.equal(f.calls.reconcile,1);assert.equal(f.store.getTask(task.id).status,'paused');
  } finally {await f.close();}
});

test('restaurant rejection ends the original request without automatic rebooking',async()=>{
  const f=fixture({prepare:async()=>pending(),reconcile:async()=>({status:'rejected',phase:'restaurant_rejected',message:'餐厅拒绝了申请。'})});
  try {
    const task=f.task();await f.engine.checkTask(task.id);f.advance(10001);await f.engine.tick();
    assert.equal(f.store.listAttempts()[0].status,'rejected');assert.equal(f.store.listAttempts()[0].nextVerificationAt,null);assert.equal(f.store.getTask(task.id).status,'paused');
    f.advance(30001);await f.engine.tick();assert.equal(f.store.listAttempts().length,1);assert.equal(f.calls.inspect,1);assert.equal(f.store.stats().confirmedBookings,0);
  } finally {await f.close();}
});

test('continue uses the original attempt and durably records the one allowed submission before clicking',async()=>{
  const f=fixture({hasContext:true});
  try {
    f.engine.applySession({status:'authenticated',browserOpen:true,browserMode:'controlled',message:'官方会话已核验。'});
    const task=f.task();await f.engine.checkTask(task.id);const before=f.store.listAttempts()[0];
    f.adapter.continueAttempt=async(attempt,{onBeforeSubmit})=>{
      assert.equal(attempt.id,before.id);await onBeforeSubmit();const recorded=f.store.getAttempt(attempt.id);
      assert.equal(recorded.status,'submitting');assert.equal(recorded.submitted,true);assert.equal(recorded.phase,'submitting');
      await assert.rejects(onBeforeSubmit(),/只能执行一次/);return pending();
    };
    await f.engine.taskAction(task.id,'continue_auto');assert.equal(f.store.listAttempts().length,1);assert.equal(f.store.listAttempts()[0].id,before.id);assert.equal(f.store.getTask(task.id).status,'awaiting_confirmation');
  } finally {await f.close();}
});

test('continue submission callback refuses a paused task and other uncertain account attempts',async()=>{
  const f=fixture({hasContext:true});
  try {
    f.engine.applySession({status:'authenticated',browserOpen:true,browserMode:'controlled',message:'官方会话已核验。'});
    const task=f.task();await f.engine.checkTask(task.id);const attempt=f.store.listAttempts()[0];
    await f.engine.taskAction(task.id,'pause');await assert.rejects(f.engine.beforeSubmit(attempt)(),/暂停或过期/);
    f.store.patchTask(task.id,{status:'user_action_required'});const peer=f.task();f.store.addAttempt(peer,slot,'outcome_unknown');
    await assert.rejects(f.engine.beforeSubmit(attempt)(),/账户另有/);assert.equal(f.store.getAttempt(attempt.id).submitted,false);
    const assist=f.task({mode:'assist',autoConsent:false});f.store.addAttempt(assist,slot,'user_action_required');await assert.rejects(f.engine.taskAction(assist.id,'continue_auto'),/明确授权/);
  } finally {await f.close();}
});

test('off-selection slots are rejected before a new attempt is persisted',async()=>{
  const f=fixture();
  try {
    const task=f.task({timeSlots:['12:00','14:00']});
    await assert.rejects(f.engine.prepareTask(task,slot),/选定.*时间/);
    assert.equal(f.store.listAttempts().length,0);assert.equal(f.calls.prepare,0);
  }finally {await f.close();}
});

test('final submit enforces both the current selection and immutable original attempt selection',async()=>{
  for(const originalTimes of [['13:00'],['14:00']]) {
    const f=fixture({hasContext:true});
    try {
      f.engine.applySession({status:'authenticated',connected:true,browserOpen:true});
      const task=f.task({timeSlots:originalTimes});
      const attempt=f.store.addAttempt(task,slot,'user_action_required');
      const currentTimes=originalTimes[0]==='13:00'?['14:00']:['13:00','14:00'];
      f.store.patchTask(task.id,{timeSlots:currentTimes});
      await assert.rejects(f.engine.beforeSubmit(attempt)(),/原预约条件不一致/);
      assert.equal(f.store.getAttempt(attempt.id).submitted,false);
    }finally {await f.close();}
  }
});

test('restart keeps submitted unknown attempts locked and schedules only read-only verification',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'catchable-confirmation-'));const path=join(dir,'state.sqlite');let store=new Store(path,{now:()=>NOW});let engine;
  try {
    const task=createTask({restaurantName:'测试餐厅',restaurantUrl:'https://www.catchtable.net/shop/test_restaurant',dates:[slot.date],partySize:2,timeStart:'12:00',timeEnd:'14:00',mode:'auto',autoConsent:true},{},NOW);
    store.saveTask({...task,status:'active',nextCheckAt:new Date(NOW).toISOString()});const attempt=store.addAttempt(task,slot);store.saveAttempt({...attempt,submitted:true});store.close();store=new Store(path,{now:()=>NOW});
    let now=NOW;let reads=0;engine=new Engine({store,now:()=>now,adapter:{reconcile:async()=>{reads++;return {status:'outcome_unknown',message:'仍未知。'};},prepare:async()=>{throw new Error('must not prepare');},inspect:async()=>{throw new Error('must not inspect');},close:async()=>{}}});
    assert.equal(store.getAttempt(attempt.id).status,'outcome_unknown');assert.equal(store.getAttempt(attempt.id).submitted,true);assert.equal(engine.state().accountWriteBlocked,true);
    now+=10001;await engine.tick();assert.equal(reads,1);assert.equal(store.listAttempts().length,1);assert.equal(store.getAttempt(attempt.id).verificationCount,1);
  } finally {if(engine)await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failed read preserves the required phone step and cannot erase its diagnosis or imply submission',async()=>{
  const f=fixture({prepare:async()=>({status:'user_action_required',phase:'required_fields',submitted:false,message:'请填写联系电话。',diagnostics:{missingRequiredFields:['电话号码']}}),
    reconcile:async()=>({status:'outcome_unknown',phase:'required_fields',submitted:false,diagnostics:{orderResponseStatus:200},message:'订单记录暂未完整读取。'})});
  try {
    const task=f.task();await f.engine.checkTask(task.id);const original=f.store.listAttempts()[0];
    await f.engine.taskAction(task.id,'reconcile');const updated=f.store.getAttempt(original.id);
    assert.equal(updated.status,'user_action_required');assert.equal(updated.phase,'required_fields');
    assert.equal(updated.submitted,false);assert.equal(updated.message,'请填写联系电话。');
    assert.deepEqual(updated.diagnostics.missingRequiredFields,['电话号码']);assert.equal(updated.diagnostics.orderResponseStatus,200);
    assert.equal(f.engine.state().accountWriteBlocked,false);assert.equal(f.store.listAttempts().length,1);
    f.store.saveAttempt({...updated,submitted:true});await f.engine.taskAction(task.id,'reconcile');
    assert.equal(f.store.getAttempt(original.id).status,'outcome_unknown');assert.equal(f.engine.state().accountWriteBlocked,true);
  }finally {await f.close();}
});

test('offline or uncertain reads preserve known pre-submit evidence and explicit continuation recovers only a verified legacy marker',async()=>{
  const legacyMessage='已打开匹配时间。请在浏览器核对套餐、条款及支付要求后完成预订。';
  const f=fixture({hasContext:false,prepare:async()=>({status:'user_action_required',phase:'before_submit',submitted:false,message:legacyMessage}),reconcile:async()=>{f.calls.reconcile++;return {status:'outcome_unknown',message:'请先连接浏览器。'};}});
  try {
    const task=f.task();await f.engine.checkTask(task.id);const original=f.store.listAttempts()[0];
    f.advance(10001);await f.engine.tick();assert.equal(f.calls.reconcile,0,'offline automatic verification must wait for a connected browser');
    await f.engine.taskAction(task.id,'reconcile');let attempt=f.store.getAttempt(original.id);
    assert.equal(attempt.status,'user_action_required');assert.equal(attempt.phase,'before_submit');assert.equal(attempt.submitted,false);assert.equal(attempt.message,legacyMessage);
    assert.equal(f.engine.state().accountWriteBlocked,false);assert.match(attempt.lastVerificationMessage,/连接浏览器/);
    f.store.saveAttempt({...attempt,status:'outcome_unknown',phase:'outcome_unknown',message:'旧读取错误覆盖了说明。'});
    for(let index=0;index<130;index++)f.store.addEvent({message:'其他运行日志。'});
    assert.equal(f.engine.legacyBeforeSubmit(f.store.getAttempt(original.id)),true,'matching durable evidence must survive the UI history limit');
    f.adapter.hasContext=true;f.engine.applySession({status:'authenticated',browserOpen:true,browserMode:'controlled',message:'官方会话已核验。'});
    f.adapter.continueAttempt=async(received)=>{assert.equal(received.legacyBeforeSubmit,true);assert.equal(received.id,original.id);return {status:'user_action_required',phase:'before_submit',submitted:false,message:legacyMessage};};
    await f.engine.taskAction(task.id,'continue_auto');assert.equal(f.store.listAttempts().length,1);
    f.store.addEvent({taskId:task.id,type:'booking_submitting',bookingId:original.id,message:'已经开始提交。',createdAt:new Date(NOW+10002).toISOString()});
    assert.equal(f.engine.legacyBeforeSubmit(f.store.getAttempt(original.id)),false);
    f.store.saveAttempt({...f.store.getAttempt(original.id),submitted:true});assert.equal(f.engine.legacyBeforeSubmit(f.store.getAttempt(original.id)),false);
  } finally {await f.close();}
});

test('a fresh explicit resume signal automatically continues the same proven-unsubmitted attempt once',async()=>{
  let continues=0;
  const before={status:'user_action_required',phase:'before_submit',submitted:false,message:'已确认尚未提交。'};
  const f=fixture({hasContext:true,prepare:async()=>before,reconcile:async()=>continues?pending():{...before,resumeAllowed:true}});
  try {
    f.engine.applySession({status:'authenticated',browserOpen:true,browserMode:'controlled',message:'官方账户已核验。'});
    const task=f.task();await f.engine.checkTask(task.id);const original=f.store.listAttempts()[0];
    f.adapter.continueAttempt=async(received,{onBeforeSubmit})=>{
      continues++;assert.equal(received.id,original.id);assert.equal(received.legacyBeforeSubmit,false);await onBeforeSubmit();
      assert.equal(f.store.getAttempt(original.id).submitted,true);return pending();
    };
    f.advance(10001);await f.engine.tick();assert.equal(continues,1);assert.equal(f.store.listAttempts().length,1);
    assert.equal(f.store.getAttempt(original.id).status,'pending_restaurant');assert.equal(f.store.getAttempt(original.id).autoContinueCount,1);
    f.advance(30001);await f.engine.tick();assert.equal(continues,1,'submitted orders remain read-only even when verified repeatedly');
  } finally {await f.close();}
});

test('unknown stage, unauthenticated session, missing context or missing resume permission never auto-continue',async()=>{
  for(const scenario of ['unknown','legacy','submitted','unauthenticated','offline','no_permission']) {
    let continues=0;
    const before={status:'user_action_required',phase:'before_submit',submitted:false,message:'已确认尚未提交。'};
    const initial=scenario==='unknown'?{...before,status:'outcome_unknown'}:scenario==='legacy'?{...before,phase:undefined}:scenario==='submitted'?{...before,submitted:true}:before;
    const f=fixture({hasContext:scenario!=='offline',prepare:async()=>initial,reconcile:async()=>({...before,resumeAllowed:scenario!=='no_permission'}),continueAttempt:async()=>{continues++;return pending();}});
    try {
      f.engine.applySession({status:scenario==='unauthenticated'?'unauthenticated':'authenticated',browserOpen:true,browserMode:'controlled',message:'测试会话。'});
      const task=f.task();await f.engine.checkTask(task.id);const original=f.store.listAttempts()[0];
      await f.engine.verifyAttempt(original);assert.equal(continues,0,scenario);assert.equal(f.store.listAttempts().length,1);
    } finally {await f.close();}
  }
});

test('explicit continuation and the final submission callback both require verified login and an open controlled context',async()=>{
  let continues=0;
  const f=fixture({hasContext:true,continueAttempt:async()=>{continues++;return pending();}});
  try {
    const task=f.task();await f.engine.checkTask(task.id);const attempt=f.store.listAttempts()[0];
    for(const scenario of ['unauthenticated','missing_context']) {
      f.engine.applySession({status:scenario==='unauthenticated'?'unauthenticated':'authenticated',browserOpen:true,browserMode:'controlled',message:'测试会话状态。'});
      f.adapter.hasContext=scenario!=='missing_context';
      await assert.rejects(f.engine.taskAction(task.id,'continue_auto'),/核验官方登录会话/);
      await assert.rejects(f.engine.beforeSubmit(attempt)(),/核验官方登录会话/);
      assert.equal(continues,0);assert.equal(f.store.getAttempt(attempt.id).submitted,false);assert.equal(f.store.listAttempts().length,1);
    }
  } finally {await f.close();}
});
