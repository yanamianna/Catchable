import test from 'node:test';
import assert from 'node:assert/strict';
import {answerReservationNoChoices,reservationChoiceState} from '../server/reservation-options.mjs';

const form='https://www.catchtable.net/zh-CN/reservation/form';
function group(question='饮食限制或过敏 *必填',{kind='custom',scopeIndex=0,selected=null,labels=['是','否']}={}) {
  return {question,required:true,kind,scopeIndex,scopeText:`${question}\n${labels.join('\n')}`,options:labels.map((text,index)=>({text,value:index?'no':'yes',selected:selected===index,disabled:false,path:[2,index+1]}))};
}
const snapshot=(groups=[])=>({url:form,loading:false,captcha:false,choiceGroups:groups});

test('explicit paired questions support observed Chinese, English and Korean labels and all three radio states',()=>{
  for(const labels of [['是','否'],['Yes','No'],['예','아니오'],['네','아니요']])for(const kind of ['custom','native','aria']) {
    const unanswered=reservationChoiceState(snapshot([group('Allergies *Required',{kind,labels})]));
    assert.equal(unanswered.status,'pending');assert.equal(unanswered.option.text,labels[1]);
    assert.equal(reservationChoiceState(snapshot([group('Allergies *Required',{kind,labels,selected:0})])).status,'pending');
    assert.deepEqual(reservationChoiceState(snapshot([group('Allergies *Required',{kind,labels,selected:1})])),{status:'ready',answered:1});
  }
  assert.deepEqual(reservationChoiceState(snapshot()),{status:'absent',answered:0});
  assert.deepEqual(reservationChoiceState({url:form}),{status:'absent',answered:0});
});

test('unknown, multiple No, invalid current states and duplicate question scopes are blocked',()=>{
  const variants=[
    value=>value.kind='unknown',value=>value.question='',value=>value.scopeIndex=-1,
    value=>value.options.push({...value.options[1]}),value=>value.options[0].value='no',
    value=>value.options[1].text='付款',value=>value.options[1].selected=null,
    value=>{value.options[0].selected=true;value.options[1].selected=true;},
    value=>value.options[1].path=[0],value=>value.options[1].path=['2'],
  ];
  for(const mutate of variants){const value=group();mutate(value);const result=reservationChoiceState(snapshot([value]));assert.equal(result.status,'blocked');assert.equal(result.retryable,false);}
  assert.equal(reservationChoiceState(snapshot([group(),group()])).status,'blocked');
  assert.equal(reservationChoiceState(snapshot([null])).status,'blocked');
  const malformed=group();malformed.options[0]=null;
  assert.equal(reservationChoiceState(snapshot([malformed])).status,'blocked');
  const disabled=group();disabled.options[1].disabled=true;
  assert.equal(reservationChoiceState(snapshot([disabled])).retryable,true);
});

test('No authorization never applies to legal, payment, cancellation, privacy or marketing questions',()=>{
  for(const question of ['同意新的取消条款','支付预约金','Terms and conditions','Consent to marketing','개인정보 제공 동의','취소 수수료','Third-party personal information']) {
    const result=reservationChoiceState(snapshot([group(question)]));
    assert.equal(result.status,'blocked',question);assert.equal(result.retryable,false);
  }
  const value=group();value.scopeText+='\n同意向第三方提供个人信息';
  assert.equal(reservationChoiceState(snapshot([value])).status,'blocked');
  assert.equal(reservationChoiceState({...snapshot([group()]),url:'https://evil.test/reservation/form'}).status,'blocked');
});

function fakePage(groups,{timeout=false,noChange=false,moved=false}={}) {
  let current=snapshot(structuredClone(groups));const clicks=[];
  const scope=index=>({count:async()=>1,isVisible:async()=>true,innerText:async()=>moved?'Another question':current.choiceGroups[index].scopeText,
    locator:path=>({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,evaluate:async()=>current.choiceGroups[index].options[1].text,
      async click(){clicks.push({index,path});if(!noChange)current.choiceGroups[index].options.forEach(option=>option.selected=option.value==='no');if(timeout)throw new Error('ack timeout');}})});
  return {clicks,locator:()=>({nth:scope}),evaluate:async()=>structuredClone(current),waitForFunction:async()=>{throw new Error('state not observed');}};
}

test('multiple questions are scoped independently, retain existing No and change authorized Yes to No once',async()=>{
  const groups=[group('Allergies *Required',{selected:1}),group('Birthday visit?',{scopeIndex:1,selected:0}),group('Children present?',{scopeIndex:2})];
  const page=fakePage(groups);
  assert.deepEqual(await answerReservationNoChoices(page),{status:'filled',answered:3});
  assert.deepEqual(page.clicks.map(value=>value.index),[1,2]);
  const ready=fakePage([group('Allergies *Required',{selected:1})]);
  assert.deepEqual(await answerReservationNoChoices(ready),{status:'ready',answered:1});assert.deepEqual(ready.clicks,[]);
  const absent=fakePage([]);assert.deepEqual(await answerReservationNoChoices(absent),{status:'absent',answered:0});
});

test('a completed click whose ACK timed out is not replayed, and unproved or moved controls pause safely',async()=>{
  const page=fakePage([group()],{timeout:true});
  assert.deepEqual(await answerReservationNoChoices(page),{status:'filled',answered:1});assert.equal(page.clicks.length,1);
  const unchanged=fakePage([group()],{timeout:true,noChange:true});
  const result=await answerReservationNoChoices(unchanged);assert.equal(result.status,'blocked');assert.equal(result.retryable,true);assert.equal(unchanged.clicks.length,1);
  const moved=fakePage([group()],{moved:true});
  assert.equal((await answerReservationNoChoices(moved)).status,'blocked');assert.deepEqual(moved.clicks,[]);
});

test('an existing snapshot with no questions adds no DOM reads or actions',async()=>{
  const page={evaluate:async()=>{throw new Error('unexpected extra DOM read');}};
  assert.deepEqual(await answerReservationNoChoices(page,{snapshot:{url:form}}),{status:'absent',answered:0});
});
