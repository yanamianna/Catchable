import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckout, knownConfirmationNotice, knownSameDayNotice, officialReservationRoute, recordStatus } from '../server/booking-flow.mjs';

const form = (changes = {}) => ({
  url: 'https://www.catchtable.net/zh-CN/reservation/form', text: 'Total: ₩0',
  buttons: [{ text: 'Checkout', disabled: false }], uncheckedAgreements: [], missingRequiredFields: [],
  loading: false, captcha: false, ...changes,
});
const canAuto = result => result.conditionsVerified && result.freeExplicitlyVerified
  && !result.requiresPayment && !result.requiresConsent && !result.requiresCaptcha;

const noticeTask={restaurantName:'taechogalbi',restaurantUrl:'https://www.catchtable.net/zh-CN/shop/taechogalbi'};
const noticeSlot={date:'2026-10-13',time:'13:00',partySize:2};
const sameDayText='您今天想去参观吗？\n请再次检查您的日程安排\ntaechogalbi\nMeat • Hongdae\n10.13(周二)\n下午 1:00\n2\n当天取消和未到会可能不仅会影响餐厅，还会影响其他顾客\n取消\n下一步';
const sameDay=(changes={})=>form({url:noticeTask.restaurantUrl,dialogs:[{text:sameDayText,buttons:[{text:'取消',disabled:false},{text:'下一步',disabled:false}]}],...changes});

test('known same-day informational Next binds its card to the verified full calendar context',()=>{
  assert.equal(knownSameDayNotice(sameDay(),noticeTask,noticeSlot,true),true);
  const english={...sameDay().dialogs[0],text:sameDayText.replace('下午 1:00','1:00 PM'),buttons:[{text:'Next',disabled:false}]};
  assert.equal(knownSameDayNotice(sameDay({dialogs:[english]}),noticeTask,noticeSlot,true),true);
  for(const text of [sameDayText.replace('taechogalbi','taechogalbi Another'),sameDayText.replace('10.13(周二)','10.14(周三)'),sameDayText.replace('下午 1:00','上午 1:00'),sameDayText.replace('\n2\n','\n3\n'),sameDayText.replace('请再次检查您的日程安排','未知提示'),sameDayText.replace('当天取消和未到会可能不仅会影响餐厅，还会影响其他顾客','请接受新条款')]) {
    assert.equal(knownSameDayNotice(sameDay({dialogs:[{...sameDay().dialogs[0],text}]}),noticeTask,noticeSlot,true),false,text);
  }
});

test('ambiguous, unchecked or unverified same-day notices cannot advance by borrowing the outer page data',()=>{
  const dialog=(changes={})=>sameDay({text:sameDayText,dialogs:[{...sameDay().dialogs[0],...changes}]});
  const blocked=[
    sameDay({url:'https://www.catchtable.net.evil.example/shop/taechogalbi'}),sameDay({url:'https://www.catchtable.net/shop/another'}),
    sameDay({loading:true}),sameDay({captcha:true}),sameDay({uncheckedAgreements:['同意条款']}),sameDay({missingRequiredFields:['姓名']}),
    sameDay({dialogs:[...sameDay().dialogs,...sameDay().dialogs]}),
    dialog({buttons:[{text:'下一步',disabled:true}]}),dialog({buttons:[{text:'下一步',disabled:false},{text:'Next',disabled:false}]}),
    dialog({text:sameDayText.replace('下午 1:00','')}),dialog({text:sameDayText.replace('\n2\n','\n')}),
    dialog({text:`外层时间\n${sameDayText}`}),dialog({text:`${sameDayText}\n14:00`}),dialog({text:`${sameDayText}\n3`}),
  ];
  for(const snapshot of blocked)assert.equal(knownSameDayNotice(snapshot,noticeTask,noticeSlot,true),false,JSON.stringify(snapshot));
  for(const context of [false,undefined,1,'true'])assert.equal(knownSameDayNotice(sameDay(),noticeTask,noticeSlot,context),false);
});

test('official reservation routes require the exact HTTPS Catchtable origin', () => {
  assert.deepEqual(officialReservationRoute('https://www.catchtable.net/customer/reservation/detail/order_123'), { kind: 'detail', reservationId: 'order_123' });
  assert.deepEqual(officialReservationRoute(form().url), { kind: 'form' });
  for (const url of [
    'https://evil.example/customer/reservation/detail/order_123',
    'https://www.catchtable.net.evil.example/reservation/form',
    'https://www.catchtable.net@evil.example/reservation/form',
    'https://user:password@www.catchtable.net/reservation/form',
    'http://www.catchtable.net/reservation/form',
    'https://www.catchtable.net:4443/reservation/form',
  ]) {
    assert.equal(officialReservationRoute(url), null, url);
    assert.equal(canAuto(classifyCheckout(form({ url }), { conditionsVerified: true })), false, url);
  }
});

test('informational confirmation notice is not an order receipt', () => {
  const snapshot = form({ text: '需要确认\n餐厅确认后才可用餐\n图示时间 12:00', buttons: [], dialogs: [{ text: '需要确认\n餐厅确认后才可用餐\n图示时间 12:00', buttons: [{ text: '请求', disabled: false }] }] });
  assert.equal(knownConfirmationNotice(snapshot), true);
  assert.equal(officialReservationRoute(snapshot.url).kind, 'form');
  assert.equal(recordStatus(['需要确认', '图示时间 12:00']), null);
  assert.equal(canAuto(classifyCheckout(snapshot, { conditionsVerified: false })), false);
  assert.equal(knownConfirmationNotice({ ...snapshot, captcha: true }), false);
  assert.equal(knownConfirmationNotice({ ...snapshot, dialogs: [...snapshot.dialogs, ...snapshot.dialogs] }), false);
});

test('restaurant pending has priority over a stale confirmed label', () => {
  for (const label of ['Checking', 'Pending confirmation', '等待餐厅确认', '确认中']) assert.equal(recordStatus(['Confirmed', label]), 'pending_restaurant', label);
});

test('cancellation and rejection always take priority over pending and confirmed', () => {
  for (const label of ['Declined', 'Rejected', 'Cancelled', 'Canceled', 'Reservation cancelled', '已取消', '已拒绝']) assert.equal(recordStatus(['Confirmed', 'Checking', label]), 'rejected', label);
});

for (const label of ['Reservation canceled', 'Booking canceled', 'Booking cancelled']) {
  test(`full cancellation state ${label} cannot be confirmed`, () => {
    assert.equal(recordStatus(['Confirmed', 'Checking', label]), 'rejected');
  });
}

test('only a verified active free checkout is eligible for automatic confirmation', () => {
  assert.equal(canAuto(classifyCheckout(form(), { conditionsVerified: true })), true);
  for (const snapshot of [
    form({ loading: true }), form({ captcha: true }),
    form({ uncheckedAgreements: ['同意新的取消条款'] }),
    form({ missingRequiredFields: ['预约人姓名'] }),
    form({ text: '预约席位已过期' }), form({ text: 'Holding time has expired' }),
    form({ buttons: [{ text: 'Checkout', disabled: true }] }),
    form({ buttons: [{ text: 'Checkout', disabled: false }, { text: 'Checkout', disabled: false }] }),
    form({ buttons: [{ text: 'Checkout', disabled: false }, { text: 'Pay ₩10,000', disabled: true }] }),
  ]) assert.equal(canAuto(classifyCheckout(snapshot, { conditionsVerified: true })), false, JSON.stringify(snapshot));
  assert.equal(canAuto(classifyCheckout(form(), { conditionsVerified: false })), false);
});

for (const text of ['Total: ₩20,000', 'Deposit: KRW 10,000', '订金: ￦10000']) {
  test(`positive checkout amount is blocked: ${text}`, () => {
    const result = classifyCheckout(form({ text }), { conditionsVerified: true });
    assert.equal(result.requiresPayment, true);
    assert.equal(canAuto(result), false);
  });
}

for (const text of ['Deposit: 20,000 KRW', '예약금: 10,000원', 'Total: $10', 'Total: $0.50']) {
  test(`positive checkout amount cannot be mistaken for free: ${text}`, () => {
    const result = classifyCheckout(form({ text }), { conditionsVerified: true });
    assert.equal(canAuto(result), false, JSON.stringify(result));
  });
}

for (const text of ['剩余时间 00:00', 'Remaining time 00:00']) {
  test(`zero remaining hold timer blocks checkout: ${text}`, () => {
    assert.equal(canAuto(classifyCheckout(form({ text }), { conditionsVerified: true })), false);
  });
}
