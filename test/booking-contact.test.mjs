import test from 'node:test';
import assert from 'node:assert/strict';
import {BOOKING_CONTACT_DEFAULTS,createTask,validateBookingContactSettings} from '../server/domain.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';

const now=Date.parse('2030-01-01T00:00:00Z');
const slot={date:'2030-01-02',time:'13:00',partySize:2};
const contact={bookingPhoneCountryCode:'+82',bookingPhoneNumber:'01012345678',bookingPhoneAutoFill:true};
const taskInput={restaurantName:'餐厅',restaurantUrl:'https://www.catchtable.net/shop/test_shop',dates:[slot.date],partySize:2,timeStart:'12:00',timeEnd:'14:00',mode:'auto',autoConsent:true};

test('booking contact is explicit string data, paired, and opt-in',()=>{
  assert.deepEqual(validateBookingContactSettings({}),BOOKING_CONTACT_DEFAULTS);
  assert.deepEqual(validateBookingContactSettings(contact),contact);
  assert.equal(validateBookingContactSettings({bookingPhoneAutoFill:false},contact).bookingPhoneNumber,'01012345678');
  for(const values of [{bookingPhoneCountryCode:'+82'},{bookingPhoneNumber:'01012345678'},{...contact,bookingPhoneNumber:1012345678},{...contact,bookingPhoneCountryCode:'+0'},{...contact,bookingPhoneCountryCode:'+1234'},{...contact,bookingPhoneNumber:'010-1234-5678'},{...contact,bookingPhoneNumber:'１２３４'},{...contact,bookingPhoneNumber:'123'},{...contact,bookingPhoneNumber:'1'.repeat(21)},{bookingPhoneAutoFill:true},{...contact,bookingPhoneAutoFill:'true'}])assert.throws(()=>validateBookingContactSettings(values));
});

test('only authorised auto tasks receive current saved contact options without modifying snapshots or activity',async()=>{
  const store=new Store(':memory:',{now:()=>now});
  const received=[];
  const adapter={hasContext:true,prepare:async(task,slot,options)=>{received.push({kind:'prepare',task,options});return {status:'user_action_required',phase:'before_submit',submitted:false,message:'等待继续。'};},
    continueAttempt:async(attempt,options)=>{received.push({kind:'continue',attempt,options});return {status:'user_action_required',phase:'before_submit',submitted:false,message:'等待继续。'};},close:async()=>{}};
  const engine=new Engine({store,adapter,now:()=>now});
  try {
    assert.equal(store.settings().bookingPhoneAutoFill,false);assert.equal(store.settings().bookingPhoneCountryCode,'');
    engine.updateSettings(contact);
    const auto=store.saveTask(createTask(taskInput,{},now));store.patchTask(auto.id,{status:'active'});
    await engine.prepareTask(store.getTask(auto.id),slot);assert.deepEqual(received[0].options.bookingContact,{countryCode:'+82',phoneNumber:'01012345678'});
    const original=store.listAttempts()[0];assert.equal(Object.hasOwn(original.taskSnapshot,'bookingPhoneNumber'),false);
    engine.applySession({status:'authenticated',browserOpen:true,browserMode:'controlled',message:'已核验。'});
    engine.updateSettings({...contact,bookingPhoneNumber:'01087654321'});await engine.taskAction(auto.id,'continue_auto');
    assert.equal(received[1].attempt.id,original.id);assert.equal(received[1].options.bookingContact.phoneNumber,'01087654321');
    assert.deepEqual(received[1].attempt.taskSnapshot,original.taskSnapshot,'current contact must not alter original booking conditions');
    assert.deepEqual(engine.bookingContactOptions({...auto,mode:'assist'}),{});assert.deepEqual(engine.bookingContactOptions({...auto,autoConsent:false}),{});
    engine.updateSettings({bookingPhoneAutoFill:false});assert.deepEqual(engine.bookingContactOptions(auto),{});
    assert.ok(!JSON.stringify(store.listEvents()).includes('01012345678'));assert.ok(!JSON.stringify(store.listEvents()).includes('01087654321'));
    assert.ok(!JSON.stringify(store.listAttempts()).includes('01012345678'));assert.ok(!JSON.stringify(store.listAttempts()).includes('01087654321'));
  } finally {await engine.stop();store.close();}
});
