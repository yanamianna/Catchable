import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReservationResponse,parseScheduledResponse,parseShopResponse} from '../server/reservation-evidence.mjs';

const task={restaurantName:'Fixture Restaurant',restaurantUrl:'https://www.catchtable.net/zh-CN/shop/fixture_shop'};
const slot={date:'2026-10-13',time:'13:00',partySize:2};
const id='fixture-order-001';
const shop={shopRef:'fixture-shop-001',alias:'fixture_shop',shopName:'Fixture Restaurant'};
const scheduledUrl='https://api.catchtable.net/api/v6/my-dining/scheduled?page=0&size=10&localeCode=ZH_CN';
const detailUrl=`https://api.catchtable.net/api/v5/reservation/detail?reservationRef=${id}&localeCode=ZH_CN`;
const shopUrl=`https://api.catchtable.net/api/v5/shop/detail?shopRef=${shop.shopRef}`;
const item=(changes={})=>({reservationType:'DINING',reservationInfo:{reservationRef:id,visitDateTime:'2026-10-13T13:00:00+09:00',totalPersonCount:2,isConfirmationPending:true,...changes},localizedShopPreview:{...shop}});
const detail=(changes={})=>({reservation:{reservationRef:id,shopRef:shop.shopRef,visitDateTime:'2026-10-13T13:00:00+09:00',personCount:2,isConfirmingReservation:true,isDeclined:false,isCancelled:false,isNoShow:false,isVisitCompleted:false,...changes}});
// Artificial fixtures follow only the publicly documented UI bundle property access;
// none of these references represents an actual account or reservation.

test('scheduled direct-envelope evidence identifies a genuine pending request without inventing a confirmation',()=>{
  const response={list:[item()],hasNext:false};
  const parsed=parseScheduledResponse(scheduledUrl,response,task,slot);
  assert.equal(parsed.complete,true);assert.equal(parsed.records[0].status,'pending_restaurant');assert.equal(parsed.records[0].reservationId,id);
  assert.deepEqual(parsed.records[0].restaurantEvidence,shop);assert.deepEqual(parsed.records[0].slot,slot);
  assert.equal(parsed.records[0].visitDateTimeISO,'2026-10-13T13:00:00+09:00');assert.equal(parsed.records[0].submitted,true);
  assert.equal(parseReservationResponse(scheduledUrl,response,task,slot,id).status,'pending_restaurant');
  assert.equal(parseReservationResponse(scheduledUrl,{list:[item({isConfirmationPending:false})],hasNext:false},task,slot,id).status,'confirmed');
});

test('only the exact HTTPS official API origin, allowed path and unambiguous query are parsed',()=>{
  for(const url of [scheduledUrl.replace('https:','http:'),scheduledUrl.replace('api.catchtable.net','api.catchtable.net.evil.example'),scheduledUrl.replace('api.catchtable.net','www.catchtable.net'),scheduledUrl.replace('/api/v6/','/api/v5/'),`${scheduledUrl}&page=0`,`${scheduledUrl}&token=secret`,`${scheduledUrl}#fragment`,scheduledUrl.replace('api.catchtable.net','u:p@api.catchtable.net'),scheduledUrl.replace('page=0','page=1'),scheduledUrl.replace('size=10','size=100')])assert.equal(parseScheduledResponse(url,{list:[item()],hasNext:false},task,slot),null,url);
  assert.equal(parseScheduledResponse(scheduledUrl,{data:{list:[item()],hasNext:false}},task,slot),null);
});

test('complete local datetime follows the official KST formatter; explicit UTC is converted to Seoul',()=>{
  const utc=parseReservationResponse(scheduledUrl,{list:[item({visitDateTime:'2026-10-13T04:00:00.000Z'})],hasNext:false},task,slot);
  assert.deepEqual(utc.slot,slot);
  for(const value of ['2026-10-13T13:00','2026-10-13T13:00:00','2026-10-13 13:00:00','2026-10-13 13:00:00.000'])assert.deepEqual(parseReservationResponse(scheduledUrl,{list:[item({visitDateTime:value})],hasNext:false},task,slot).slot,slot,value);
  for(const value of [null,'10-13 13:00','2026-02-30T13:00:00','2026-10-13T25:00:00','2026-10-13T13:61:00','2026-10-13T14:00:00','2026-02-30T13:00:00+09:00','2025-10-13T13:00:00+09:00','2026-10-13T13:00:30+09:00','2026-10-13T13:00:00.123+09:00'])assert.equal(parseReservationResponse(scheduledUrl,{list:[item({visitDateTime:value})],hasNext:false},task,slot),null,value);
  const midnight={...slot,date:'2026-10-14',time:'00:00'};
  assert.deepEqual(parseReservationResponse(scheduledUrl,{list:[item({visitDateTime:'2026-10-13T15:00:00Z'})],hasNext:false},task,midnight).slot,midnight);
});

test('wrong restaurant, party size, original reference or missing status cannot be inferred from task data',()=>{
  for(const changed of [item({totalPersonCount:3}),item({reservationRef:'different-order'}),item({isConfirmationPending:undefined}),item({isConfirmationPending:'false'}),{...item(),localizedShopPreview:{...shop,alias:'different_shop'}},{...item(),localizedShopPreview:{shopName:task.restaurantName}}])assert.equal(parseReservationResponse(scheduledUrl,{list:[changed],hasNext:false},task,slot,id),null);
  const uppercase={...item(),localizedShopPreview:{...shop,alias:'FIXTURE_SHOP'}};
  assert.equal(parseReservationResponse(scheduledUrl,{list:[uppercase],hasNext:false},task,slot).status,'pending_restaurant');
});

test('an empty list is complete only for a fully recognised first page; pagination or malformed candidates prevent absence claims',()=>{
  assert.deepEqual(parseScheduledResponse(scheduledUrl,{list:[],hasNext:false},task,slot),{complete:true,records:[]});
  assert.deepEqual(parseScheduledResponse(scheduledUrl,{list:[],hasNext:true},task,slot),{complete:false,records:[]});
  assert.equal(parseScheduledResponse(scheduledUrl,{list:[item({isConfirmationPending:undefined})],hasNext:false},task,slot).complete,false);
  assert.equal(parseScheduledResponse(scheduledUrl,{list:[{}],hasNext:false},task,slot).complete,false);
  assert.equal(parseScheduledResponse(scheduledUrl,{list:[{reservationType:'WAITING'}],hasNext:false},task,slot).complete,true);
  assert.equal(parseScheduledResponse(scheduledUrl,{list:[{...item(),localizedShopPreview:{...shop,alias:'different_shop'}}],hasNext:false},task,slot).complete,true);
  assert.equal(parseScheduledResponse(scheduledUrl,{list:[],hasNext:undefined},task,slot),null);
});

test('detail needs separately observed shop evidence bound to the actual shopRef and original reservationRef',()=>{
  const observedShop=parseShopResponse(shopUrl,shop);
  assert.deepEqual(observedShop,shop);
  assert.equal(parseReservationResponse(detailUrl,detail(),task,slot,id,observedShop).status,'pending_restaurant');
  assert.equal(parseReservationResponse(detailUrl,detail({isConfirmingReservation:false}),task,slot,id,observedShop).status,'confirmed');
  for(const evidence of [undefined,{...shop,shopRef:'another-shop'},{...shop,alias:'another_shop'},{shopRef:shop.shopRef,shopName:task.restaurantName}])assert.equal(parseReservationResponse(detailUrl,detail(),task,slot,id,evidence),null);
  assert.equal(parseReservationResponse(detailUrl,detail(),task,slot,'different-order',shop),null);
  assert.equal(parseReservationResponse(detailUrl.replace(id,'different-order'),detail(),task,slot,id,shop),null);
  assert.equal(parseShopResponse(shopUrl,{data:shop}),null);
  assert.equal(parseShopResponse(shopUrl,{...shop,shopRef:'another-shop'}),null);
});

test('cancel, decline and no-show override a pending flag; missing booleans or completed visits remain unverified',()=>{
  for(const flag of ['isCancelled','isDeclined','isNoShow']) {
    assert.equal(parseReservationResponse(detailUrl,detail({[flag]:true}),task,slot,id,shop).status,'rejected');
    const list=parseScheduledResponse(scheduledUrl,{list:[item({[flag]:true})],hasNext:false},task,slot);
    assert.equal(list.records[0].status,'rejected','negative records must remain visible to prevent duplicates');
  }
  for(const flag of ['isConfirmingReservation','isCancelled','isDeclined','isNoShow','isVisitCompleted'])assert.equal(parseReservationResponse(detailUrl,detail({[flag]:undefined}),task,slot,id,shop),null);
  assert.equal(parseReservationResponse(detailUrl,detail({isConfirmingReservation:false,isVisitCompleted:true}),task,slot,id,shop),null);
  assert.equal(parseReservationResponse(detailUrl,{data:{reservation:detail().reservation}},task,slot,id,shop),null);
});
