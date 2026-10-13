// Only visible official reservation UI is evidence. Never read client stores,
// tokens, or hidden React state to decide whether an order was created.
import {restaurantUrl,validDate} from './domain.mjs';

export function officialReservationRoute(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['catchtable.net','www.catchtable.net'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const detail = url.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?customer\/reservation\/detail\/([A-Za-z0-9_-]+)\/?$/);
    if (detail) return {kind:'detail',reservationId:detail[1]};
    if (/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?reservation\/form\/?$/.test(url.pathname)) return {kind:'form'};
    if (/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?my-dining(?:\/scheduled)?\/?$/.test(url.pathname)) return {kind:'scheduled'};
    return null;
  } catch { return null; }
}

export const CHECKOUT_NAME = /^(?:Checkout|Check out|结账|确认预订|确认预约|预订|预约|预约申请|提交预约|请求预订|예약하기|예약 확정)$/i;
export const PAYMENT_ACTION = /^(?:Pay\b|支付|付款|결제)/i;
const PENDING = /^(?:Checking|Pending confirmation|Awaiting (?:restaurant )?confirmation|检查\.{0,3}|检查…|等待预订|等待餐厅确认|等待确认|确认中|核对中|餐厅确认中|예약 확인 중)$/i;
const CONFIRMED = /^(?:Confirmed|Reservation confirmed|Booking confirmed|预订成功|预约成功|预订完成|预约完成|已确认|确认完成|예약 완료|예약 확정)$/i;
const REJECTED = /^(?:Declined|Rejected|Canceled|Cancelled|(?:Reservation|Booking) cancel(?:led|ed)|예약 취소|예약 거절|已拒绝|被拒绝|已取消|预约已取消|预订已取消|No.show|未到店)$/i;

export function recordStatus(labels) {
  const lines = (labels || []).flatMap(value => String(value).split('\n')).map(value=>value.trim()).filter(Boolean);
  if (lines.some(value=>REJECTED.test(value))) return 'rejected';
  if (lines.some(value=>PENDING.test(value))) return 'pending_restaurant';
  if (lines.some(value=>CONFIRMED.test(value))) return 'confirmed';
  return null;
}

export function knownConfirmationNotice(snapshot) {
  if (!snapshot || snapshot.loading || snapshot.captcha) return false;
  // This published Catchtable notice contains illustrated sample times. It is
  // informational and cannot provide the actual date, time, or order status.
  return snapshot.dialogs?.filter(dialog=>
    /^(?:需要确认|Confirmation required|Request reservation|Confirmation needed)$/im.test(dialog.text || '')
    && /(?:餐厅确认|restaurant.{0,35}confirm|confirmation.{0,35}restaurant)/i.test(dialog.text || '')
    && dialog.buttons?.filter(button=>/^(?:请求|Request)$/i.test(button.text) && !button.disabled).length===1
  ).length===1;
}

export function knownSameDayNotice(snapshot,task,slot,calendarVerified) {
  if(calendarVerified!==true || !snapshot || snapshot.loading || snapshot.captcha || !validDate(slot?.date)
    || !Number.isInteger(slot?.partySize) || slot.partySize<1 || slot.partySize>12
    || !Array.isArray(snapshot.uncheckedAgreements) || snapshot.uncheckedAgreements.length
    || !Array.isArray(snapshot.missingRequiredFields) || snapshot.missingRequiredFields.length)return false;
  try {
    const actual=new URL(restaurantUrl(snapshot.url)).pathname.split('/').at(-1).toLowerCase();
    const expected=new URL(restaurantUrl(task.restaurantUrl)).pathname.split('/').at(-1).toLowerCase();
    if(actual!==expected)return false;
  }catch{return false;}
  const title='您今天想去参观吗？';
  const matching=(snapshot.dialogs || []).filter(dialog=>String(dialog.text || '').split('\n').some(line=>line.trim()===title));
  if(matching.length!==1)return false;
  const dialog=matching[0];
  if(dialog.loading || dialog.captcha || dialog.uncheckedAgreements?.length || dialog.missingRequiredFields?.length)return false;
  const lines=String(dialog.text || '').split('\n').map(line=>line.trim()).filter(Boolean);
  if(lines[0]!==title || lines.filter(line=>line===title).length!==1
    || !lines.includes('请再次检查您的日程安排')
    || !lines.includes('当天取消和未到会可能不仅会影响餐厅，还会影响其他顾客')
    || !task.restaurantName?.trim() || lines.filter(line=>line===task.restaurantName.trim()).length!==1)return false;
  const dates=lines.map(line=>line.match(/^(\d{1,2})\.(\d{1,2})\(周([一二三四五六日天])\)$/)).filter(Boolean);
  const weekday=['日','一','二','三','四','五','六'][new Date(`${slot.date}T00:00:00Z`).getUTCDay()];
  if(dates.length!==1 || Number(dates[0][1])!==Number(slot.date.slice(5,7)) || Number(dates[0][2])!==Number(slot.date.slice(8))
    || dates[0][3].replace('天','日')!==weekday)return false;
  const times=lines.map(line=>{
    const match=line.match(/^(?:(上午|下午)\s*)?(\d{1,2}):([0-5]\d)(?:\s*(AM|PM))?$/i);
    if(!match || (match[1] && match[4]))return null;
    let hour=Number(match[2]);const meridiem=match[1] || match[4]?.toUpperCase();
    if(hour>23 || (meridiem && (hour<1 || hour>12)))return null;
    if(meridiem)hour=hour%12+(['下午','PM'].includes(meridiem)?12:0);
    return `${String(hour).padStart(2,'0')}:${match[3]}`;
  }).filter(Boolean);
  const people=lines.filter(line=>/^\d{1,2}$/.test(line));
  const next=(dialog.buttons || []).filter(button=>/^(?:下一步|Next)$/i.test(button.text?.trim() || ''));
  return times.length===1 && times[0]===slot.time && people.length===1 && Number(people[0])===slot.partySize
    && next.length===1 && next[0].disabled===false;
}

export function classifyCheckout(snapshot, {conditionsVerified}) {
  const route = officialReservationRoute(snapshot?.url);
  const active = (snapshot?.buttons || []).filter(button=>!button.disabled);
  const checkout = active.filter(button=>CHECKOUT_NAME.test(button.text));
  const paid = (snapshot?.buttons || []).some(button=>PAYMENT_ACTION.test(button.text))
    || [...String(snapshot?.text || '').matchAll(/(?:Total|Deposit|合计|总计|订金|预约金|预订金|예약금)\s*[:：]?\s*(?:₩|KRW|￦|\$|USD|€|EUR|¥|CNY)?\s*(\d[\d,]*(?:\.\d+)?)/gi)].some(match=>Number(match[1].replaceAll(',',''))>0);
  const legal = snapshot?.uncheckedAgreements?.length > 0;
  const required = snapshot?.missingRequiredFields?.length > 0;
  const expired = /(?:holding.{0,20}expired|reservation time.{0,20}expired|预约.{0,12}已过期|预订.{0,12}已过期|(?:剩余时间|Remaining time)\s*0{1,2}:00)/i.test(snapshot?.text || '');
  // The official free form has a Checkout button; paid forms replace it with
  // Pay <amount>. Neither a missing amount elsewhere nor a notice proves free.
  return {conditionsVerified:conditionsVerified===true && route?.kind==='form' && !snapshot.loading && !expired && !required,
    requiresPayment:paid,requiresConsent:legal,requiresCaptcha:snapshot?.captcha===true,
    freeExplicitlyVerified:route?.kind==='form' && checkout.length===1 && !paid,
    checkoutName:checkout.length===1?checkout[0].text:null,
    blocker:expired?'holding_expired':required?'required_fields':paid?'payment':legal?'agreement':snapshot?.captcha?'captcha':null};
}

export function readBookingFlowDom() {
  const visible=element=>Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height && getComputedStyle(element).visibility!=='hidden');
  const buttons=root=>[...root.querySelectorAll('button')].filter(visible).map(element=>({text:element.innerText.trim(),disabled:element.disabled || element.getAttribute('aria-disabled')==='true'}));
  const text=document.body?.innerText || '';
  const unchecked=[...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(visible).filter(element=>element.tagName==='INPUT'?!element.checked:element.getAttribute('aria-checked')!=='true');
  const labels=element=>element.closest('label')?.innerText || element.getAttribute('aria-label') || element.parentElement?.innerText || '';
  const noticeRoots=[...document.querySelectorAll('h1,h2,h3,h4')].filter(element=>visible(element) && /^(?:需要确认|Confirmation required|Confirmation needed)$/.test(element.innerText.trim())).map(element=>{
    for(let root=element.parentElement,step=0;root && step<7;root=root.parentElement,step++)if(buttons(root).filter(button=>/^(?:请求|Request)$/i.test(button.text)).length===1)return root;
    return null;
  }).filter(Boolean);
  const candidates=[...new Set([...document.querySelectorAll('[role="dialog"], [data-state="open"]'),...noticeRoots].filter(visible))];
  const dialogRoots=candidates.filter(element=>!candidates.some(other=>other!==element && other.contains(element)));
  const phones=[...document.querySelectorAll('input[type="tel"]')].filter(visible);
  const phone=phones.length===1?phones[0]:null;
  const phoneHeading=phone?.closest('section')?.querySelector('h3');
  const phoneRequired=Boolean(phoneHeading && visible(phoneHeading)
    && /(?:电话号码|Phone (?:number|Number))/i.test(phoneHeading.innerText)
    && /\*\s*(?:必填|Required)/i.test(phoneHeading.innerText));
  const missingRequired=[...document.querySelectorAll('input[required],textarea[required],select[required],[aria-required="true"]')].filter(visible).filter(element=>!element.value?.trim()).map(element=>element.getAttribute('aria-label') || element.name || '必填信息');
  if(phoneRequired && !phone.value?.trim())missingRequired.push('电话号码');
  return {url:location.href,text:text.slice(0,40000),buttons:buttons(document),
    headings:[...document.querySelectorAll('h1,h2,h3,h4')].filter(visible).map(element=>element.innerText.trim()),
    summaries:[...document.querySelectorAll('main p')].filter(visible).map(element=>element.innerText.trim()).filter(value=>value.includes(' · ') && /\d{1,2}:\d{2}/.test(value)),
    links:[...document.querySelectorAll('a[href]')].filter(visible).map(element=>({href:element.href,text:element.innerText.trim()})),
    dialogs:dialogRoots.map(element=>({text:element.innerText,buttons:buttons(element)})),
    loading:Boolean([...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].find(visible)),
    captcha:Boolean([...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"]')].find(visible)),
    uncheckedAgreements:unchecked.filter(element=>!/(?:不再显示|Don't show again|Do not show again)/i.test(labels(element))).map(labels),
    missingRequiredFields:missingRequired,
    phoneField:phone?{required:phoneRequired,empty:!phone.value?.trim(),countryCode:phone.previousElementSibling?.innerText.trim() || ''}:null,
    cards:[...document.querySelectorAll('a[href*="/customer/reservation/detail/"]')].filter(visible).map(element=>({url:element.href,text:element.innerText,headings:[...element.querySelectorAll('h1,h2,h3,h4,h5')].map(heading=>heading.innerText.trim())}))};
}
