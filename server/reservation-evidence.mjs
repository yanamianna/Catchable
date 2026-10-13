import { restaurantUrl, validDate } from './domain.mjs';

const PATHS={scheduled:'/api/v6/my-dining/scheduled',reservation:'/api/v5/reservation/detail',shop:'/api/v5/shop/detail'};
const identifier=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)?value:typeof value==='number' && Number.isSafeInteger(value) && value>0?String(value):null;
const object=value=>Boolean(value && typeof value==='object' && !Array.isArray(value));
const text=value=>typeof value==='string' && value.trim() && value.trim().length<=200?value.trim():null;
const personCount=value=>typeof value==='number' && Number.isInteger(value) && value>=1 && value<=12?value:null;
const targetSlot=slot=>object(slot) && validDate(slot.date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time) && personCount(slot.partySize)!==null;

function responseUrl(value,kind) {
  let url;
  try {url=new URL(value);}catch{return null;}
  if(url.protocol!=='https:' || url.hostname!=='api.catchtable.net' || url.port || url.username || url.password || url.hash || url.pathname!==PATHS[kind])return null;
  const allowed=kind==='scheduled'?['page','size','localeCode']:kind==='reservation'?['reservationRef','localeCode']:['shopRef','localeCode'];
  for(const key of url.searchParams.keys())if(!allowed.includes(key) || url.searchParams.getAll(key).length!==1)return null;
  const locale=url.searchParams.get('localeCode');
  if(locale!==null && !/^[A-Za-z0-9_-]{1,20}$/.test(locale))return null;
  if(kind==='scheduled') {
    if(url.searchParams.get('page')!=='0' || url.searchParams.get('size')!=='10')return null;
  } else if(!identifier(url.searchParams.get(kind==='reservation'?'reservationRef':'shopRef')))return null;
  return url;
}

function taskIdentity(task) {
  try {return new URL(restaurantUrl(task.restaurantUrl)).pathname.split('/').filter(Boolean).at(-1).toLowerCase();}catch{return null;}
}

function shopFields(json) {
  if(!object(json))return null;
  const shopRef=identifier(json.shopRef);
  const alias=typeof json.alias==='string' && /^[A-Za-z0-9_-]+$/.test(json.alias)?json.alias:null;
  const shopName=text(json.shopName);
  return shopRef && alias && shopName?{shopRef,alias,shopName}:null;
}

export function parseShopResponse(value,json) {
  const url=responseUrl(value,'shop');
  const shop=shopFields(json);
  return url && shop && url.searchParams.get('shopRef')===shop.shopRef?shop:null;
}

function koreanVisit(value) {
  if(typeof value!=='string')return null;
  const match=value.match(/^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/);
  if(!match || !validDate(match[1]) || (match[4] && match[4]!=='00') || (match[5] && Number(match[5])!==0))return null;
  // Catchtable's public index_main.Se85rHHz.js, formatter It used by scheduled
  // and detail: zoned strings use dayjs(t).tz('Asia/Seoul'), while unzoned
  // strings use dayjs.tz(t,'Asia/Seoul'). Keep that explicit KST interpretation;
  // never let Date.parse infer the execution host's timezone for local strings.
  const explicit=`${match[1]}T${match[2]}:${match[3]}:${match[4] || '00'}${match[5]?`.${match[5]}`:''}${match[6] || '+09:00'}`;
  const milliseconds=Date.parse(explicit);
  if(!Number.isFinite(milliseconds))return null;
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(milliseconds)).map(part=>[part.type,part.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`,raw:value};
}

function matchesSlot(visit,count,slot) {
  return visit && slot && visit.date===slot.date && visit.time===slot.time && count===slot.partySize;
}

function result(status,id,visit,count,shop) {
  return {status,reservationId:id,slot:{date:visit.date,time:visit.time,partySize:count},restaurantEvidence:shop,
    visitDateTimeISO:visit.raw,submitted:true,phase:status==='pending_restaurant'?'awaiting_restaurant':status,
    message:status==='pending_restaurant'?'官方预约记录显示已提交申请，等待餐厅确认；尚未预约成功。':status==='confirmed'?'已通过官方预约记录核对订单号、餐厅、完整日期时间和人数。':'官方预约记录显示本次订单已取消、拒绝或未到店。'};
}

function scheduledRecord(item,task,slot,expectedId) {
  if(!object(item) || item.reservationType!=='DINING' || !object(item.reservationInfo))return null;
  const shop=shopFields(item.localizedShopPreview);
  const identity=taskIdentity(task);
  if(!shop || !identity || shop.alias.toLowerCase()!==identity)return null;
  const reservation=item.reservationInfo;
  const id=identifier(reservation.reservationRef);
  const visit=koreanVisit(reservation.visitDateTime);
  const count=personCount(reservation.totalPersonCount);
  if(!id || (expectedId && id!==identifier(expectedId)) || !matchesSlot(visit,count,slot) || typeof reservation.isConfirmationPending!=='boolean')return null;
  const negative=['isNoShow','isDeclined','isCancelled'];
  if(negative.some(key=>Object.hasOwn(reservation,key) && typeof reservation[key]!=='boolean'))return null;
  if(negative.some(key=>reservation[key]===true))return result('rejected',id,visit,count,shop);
  if(Object.hasOwn(reservation,'isVisitCompleted') && reservation.isVisitCompleted!==false)return null;
  return result(reservation.isConfirmationPending?'pending_restaurant':'confirmed',id,visit,count,shop);
}

function definitelyDifferent(item,task,slot,expectedId) {
  if(object(item) && typeof item.reservationType==='string' && item.reservationType!=='DINING')return true;
  if(!object(item))return false;
  const shop=shopFields(item.localizedShopPreview);
  const identity=taskIdentity(task);
  if(shop && identity && shop.alias.toLowerCase()!==identity)return true;
  const info=item.reservationInfo;
  if(!object(info))return false;
  const id=identifier(info.reservationRef);
  if(expectedId && id && id!==identifier(expectedId))return true;
  const visit=koreanVisit(info.visitDateTime);
  const count=personCount(info.totalPersonCount);
  return Boolean((visit && (visit.date!==slot?.date || visit.time!==slot?.time)) || (count && count!==slot?.partySize));
}

export function parseScheduledResponse(value,json,task,slot,expectedId) {
  if(!responseUrl(value,'scheduled') || !object(json) || !Array.isArray(json.list) || typeof json.hasNext!=='boolean' || !taskIdentity(task) || !targetSlot(slot)
    || (expectedId!==undefined && !identifier(expectedId)))return null;
  const records=[];
  let unrecognised=false;
  for(const item of json.list) {
    const record=scheduledRecord(item,task,slot,expectedId);
    if(record)records.push(record);
    else if(!definitelyDifferent(item,task,slot,expectedId))unrecognised=true;
  }
  return {complete:json.hasNext===false && !unrecognised,records};
}

export function parseReservationResponse(value,json,task,slot,expectedId,shopEvidence) {
  const scheduled=parseScheduledResponse(value,json,task,slot,expectedId);
  if(scheduled)return scheduled.records[0] || null;
  const url=responseUrl(value,'reservation');
  if(!url || !object(json) || !object(json.reservation) || !targetSlot(slot) || (expectedId!==undefined && !identifier(expectedId)))return null;
  const reservation=json.reservation;
  const id=identifier(reservation.reservationRef);
  const shop=shopFields(shopEvidence);
  const visit=koreanVisit(reservation.visitDateTime);
  const count=personCount(reservation.personCount);
  if(!id || url.searchParams.get('reservationRef')!==id || (expectedId && id!==identifier(expectedId)) || !shop || shop.shopRef!==identifier(reservation.shopRef)
    || shop.alias.toLowerCase()!==taskIdentity(task) || !matchesSlot(visit,count,slot))return null;
  const required=['isConfirmingReservation','isDeclined','isCancelled','isNoShow','isVisitCompleted'];
  if(required.some(key=>typeof reservation[key]!=='boolean'))return null;
  if(reservation.isNoShow || reservation.isDeclined || reservation.isCancelled)return result('rejected',id,visit,count,shop);
  if(reservation.isVisitCompleted)return null;
  return result(reservation.isConfirmingReservation?'pending_restaurant':'confirmed',id,visit,count,shop);
}
