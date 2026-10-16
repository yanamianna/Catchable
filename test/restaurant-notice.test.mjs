import test from 'node:test';
import assert from 'node:assert/strict';
import {acknowledgeRestaurantNotice,knownRestaurantNotice} from '../server/booking-flow.mjs';

const rows=[
  '当餐桌满座时，每桌最大使用时间为2小时。',
  '如果所有桌位都已满，客人可以被安排坐在吧台。',
  '如果您下一个预约迟到超过15分钟，可能无法提供座位。(如有变更，请提前与我们联系。)',
  '2小时内停车费3,000日元，此后每增加10分钟收费1,000日元。',
];
const task={restaurantUrl:'https://www.catchtable.net/zh-CN/shop/restaurant',mode:'auto',autoConsent:true,
  dates:['2026-10-19'],partySize:2,timeStart:'18:00',timeEnd:'19:00',timeSlots:['18:00','19:00']};
const slot={date:'2026-10-19',time:'18:00',partySize:2};
function snapshot(checked=[false,false,false,false]) {
  const text=['注意事项',...rows,'请仔细阅读餐厅的注意事项',
    'Please call the store if you want to make a reservation for 9 or more persons.','Seat selection is not available.','取消','下一步'].join('\n');
  const buttons=[...rows,'取消','下一步'].map(text=>({text,disabled:false}));
  return {url:task.restaurantUrl,loading:false,captcha:false,uncheckedAgreements:[],missingRequiredFields:[],dialogs:[{text,buttons}],
    restaurantNotices:[{heading:'注意事项',text,buttons,rows:rows.map((text,index)=>({text,checked:checked[index],disabled:false})),linkCount:0,
      next:{text:'下一步',disabled:false,active:checked.every(Boolean)}}]};
}

test('only the exact verified restaurant seating and parking notice is acknowledged',()=>{
  assert.equal(knownRestaurantNotice(snapshot(),task,slot,true),true);
  assert.equal(knownRestaurantNotice(snapshot([true,false,true,false]),task,slot,true),true);
  assert.equal(knownRestaurantNotice(snapshot([true,true,true,true]),task,slot,true),true);
  const wrapped=snapshot();wrapped.dialogs[0].text=wrapped.dialogs[0].text.replaceAll('(', '（').replaceAll(')', '）');
  wrapped.restaurantNotices[0].text=wrapped.dialogs[0].text.replaceAll(' ', '\n');
  assert.equal(knownRestaurantNotice(wrapped,task,slot,true),true);
});

test('unknown clauses, deposits, paid cancellation and outside agreements cannot borrow this notice authorization',()=>{
  for(const extra of ['同意支付预约金10,000韩元','取消预约将收取费用','同意接收营销信息','同意向第三方提供资料','未知餐厅要求']) {
    const value=snapshot();value.restaurantNotices[0].text+=`\n${extra}`;value.dialogs[0].text+=`\n${extra}`;
    assert.equal(knownRestaurantNotice(value,task,slot,true),false,extra);
  }
  const variants=[
    value=>value.restaurantNotices[0].rows[0].checked=null,
    value=>value.restaurantNotices[0].rows[0].disabled=true,
    value=>value.restaurantNotices[0].rows[0].text='同意新的取消条款',
    value=>value.restaurantNotices[0].rows.push({text:'其他',checked:false,disabled:false}),
    value=>value.restaurantNotices[0].next.active=null,
    value=>value.restaurantNotices[0].next.disabled=true,
    value=>value.restaurantNotices[0].buttons.push({text:'下一步',disabled:false}),
    value=>value.restaurantNotices[0].linkCount=1,
    value=>value.restaurantNotices.push(structuredClone(value.restaurantNotices[0])),
    value=>value.dialogs.push(structuredClone(value.dialogs[0])),
    value=>value.uncheckedAgreements.push('同意条款'),
    value=>value.missingRequiredFields.push('姓名'),
    value=>value.captcha=true,
    value=>value.loading=true,
    value=>value.url='https://www.catchtable.net/shop/different',
    value=>value.url='https://www.catchtable.net.evil.test/shop/restaurant',
  ];
  for(const mutate of variants){const value=snapshot();mutate(value);assert.equal(knownRestaurantNotice(value,task,slot,true),false);}
});

test('notice authorization retains exact task, calendar, party and selected-time boundaries',()=>{
  for(const altered of [{...task,mode:'assist'},{...task,autoConsent:false},{...task,dates:['2026-10-20']},
    {...task,partySize:3},{...task,timeSlots:['19:00']}, {...task,timeSlots:['18:15']}]) {
    assert.equal(knownRestaurantNotice(snapshot(),altered,slot,true),false);
  }
  assert.equal(knownRestaurantNotice(snapshot(),task,{...slot,time:'18:30'},true),false);
  assert.equal(knownRestaurantNotice(snapshot(),{...task,partySize:9},{...slot,partySize:9},true),false);
  for(const verified of [false,undefined,'true'])assert.equal(knownRestaurantNotice(snapshot(),task,slot,verified),false);
});

function fakePage({checked=[false,false,false,false],toggleTimeout=false,nextTimeout=false,noToggle=false,greyNext=false}={}) {
  let current=snapshot(checked);const clicks=[];
  const control=name=>({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,async click(){
    clicks.push(name);const index=rows.indexOf(name);
    if(index>=0){
      if(!noToggle)current.restaurantNotices[0].rows[index].checked=!current.restaurantNotices[0].rows[index].checked;
      current.restaurantNotices[0].next.active=!greyNext && current.restaurantNotices[0].rows.every(row=>row.checked);
      if(toggleTimeout)throw new Error('acknowledgement timed out');
    }else {current={...current,restaurantNotices:[],dialogs:[]};if(nextTimeout)throw new Error('acknowledgement timed out');}
  }});
  const dialog={filter(){return this;},count:async()=>1,isVisible:async()=>true,getByRole:(_role,{name})=>control(name),
    waitFor:async()=>{if(current.restaurantNotices.length)throw new Error('notice still visible');}};
  return {clicks,getByRole:()=>dialog,evaluate:async()=>structuredClone(current),waitForFunction:async()=>{throw new Error('unobserved checkbox state');}};
}

test('checked rows are retained and only a proved active Next advances the notice',async()=>{
  const page=fakePage({checked:[true,false,true,false]});
  assert.equal(await acknowledgeRestaurantNotice(page,task,slot,true),'advanced');
  assert.deepEqual(page.clicks,[rows[1],rows[3],'下一步']);
  const grey=fakePage({greyNext:true});
  assert.equal(await acknowledgeRestaurantNotice(grey,task,slot,true),'blocked');
  assert.deepEqual(grey.clicks,rows);
});

test('ambiguous toggle and Next acknowledgements are read once and never replayed',async()=>{
  const page=fakePage({toggleTimeout:true,nextTimeout:true});
  assert.equal(await acknowledgeRestaurantNotice(page,task,slot,true),'advanced');
  assert.deepEqual(page.clicks,[...rows,'下一步']);
  const failed=fakePage({noToggle:true,toggleTimeout:true});
  assert.equal(await acknowledgeRestaurantNotice(failed,task,slot,true),'blocked');
  assert.deepEqual(failed.clicks,[rows[0]]);
  const rejected=fakePage();
  assert.equal(await acknowledgeRestaurantNotice(rejected,{...task,autoConsent:false},slot,true),'blocked');
  assert.deepEqual(rejected.clicks,[]);
});
