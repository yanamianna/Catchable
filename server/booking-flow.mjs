// Only visible official reservation UI is evidence. Never read client stores,
// tokens, or hidden React state to decide whether an order was created.
import {matchingSlots,restaurantUrl,validDate} from './domain.mjs';

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
    const match=line.match(/^(?:(上午|下午|晚上)\s*)?(\d{1,2}):([0-5]\d)(?:\s*(AM|PM))?$/i);
    if(!match || (match[1] && match[4]))return null;
    let hour=Number(match[2]);const meridiem=match[1] || match[4]?.toUpperCase();
    if(hour>23 || (meridiem && (hour<1 || hour>12)))return null;
    if(meridiem==='晚上' && hour===12)return null;
    if(meridiem)hour=hour%12+(['下午','晚上','PM'].includes(meridiem)?12:0);
    return `${String(hour).padStart(2,'0')}:${match[3]}`;
  }).filter(Boolean);
  const people=lines.filter(line=>/^\d{1,2}$/.test(line));
  const next=(dialog.buttons || []).filter(button=>/^(?:下一步|Next)$/i.test(button.text?.trim() || ''));
  return times.length===1 && times[0]===slot.time && people.length===1 && Number(people[0])===slot.partySize
    && next.length===1 && next[0].disabled===false;
}

const RESTAURANT_NOTICE_ROWS=Object.freeze([
  '当餐桌满座时，每桌最大使用时间为2小时。',
  '如果所有桌位都已满，客人可以被安排坐在吧台。',
  '如果您下一个预约迟到超过15分钟，可能无法提供座位。(如有变更，请提前与我们联系。)',
  '2小时内停车费3,000日元，此后每增加10分钟收费1,000日元。',
]);
const noticeText=value=>String(value || '').replace(/\s+/g,'').replaceAll('（','(').replaceAll('）',')');
const RESTAURANT_NOTICE_TEXT=noticeText(['注意事项',...RESTAURANT_NOTICE_ROWS,'请仔细阅读餐厅的注意事项',
  'Please call the store if you want to make a reservation for 9 or more persons.','Seat selection is not available.','取消','下一步'].join('\n'));

// This exact published restaurant notice describes seating, lateness and
// optional parking. It is not proof of a free checkout or permission to accept
// arbitrary legal terms, penalties, marketing or deposits.
export function knownRestaurantNotice(snapshot,task,slot,calendarVerified) {
  if(calendarVerified!==true || task?.mode!=='auto' || task?.autoConsent!==true || !snapshot || snapshot.loading || snapshot.captcha
    || !validDate(slot?.date) || !Number.isInteger(slot?.partySize) || slot.partySize<1 || slot.partySize>=9
    || !Array.isArray(task.dates) || !matchingSlots(task,[slot]).length
    || !Array.isArray(snapshot.uncheckedAgreements) || snapshot.uncheckedAgreements.length
    || !Array.isArray(snapshot.missingRequiredFields) || snapshot.missingRequiredFields.length
    || snapshot.dialogs?.length!==1 || snapshot.restaurantNotices?.length!==1)return false;
  try {
    if(new URL(restaurantUrl(snapshot.url)).pathname.split('/').at(-1)!==new URL(restaurantUrl(task.restaurantUrl)).pathname.split('/').at(-1))return false;
  }catch{return false;}
  const notice=snapshot.restaurantNotices[0];
  if(notice.heading!=='注意事项' || notice.linkCount!==0 || noticeText(notice.text)!==RESTAURANT_NOTICE_TEXT
    || noticeText(snapshot.dialogs[0].text)!==RESTAURANT_NOTICE_TEXT || notice.rows?.length!==4 || notice.buttons?.length!==6)return false;
  if(!notice.rows.every((row,index)=>noticeText(row.text)===noticeText(RESTAURANT_NOTICE_ROWS[index]) && typeof row.checked==='boolean' && row.disabled===false))return false;
  const labels=[...notice.rows.map(row=>row.text),'取消','下一步'];
  if(!notice.buttons.every((button,index)=>noticeText(button.text)===noticeText(labels[index]) && button.disabled===false))return false;
  return notice.next?.text==='下一步' && notice.next.disabled===false && typeof notice.next.active==='boolean';
}

// A toggle is issued at most once. Even if its acknowledgement times out, a
// fresh observed checked state decides whether it is safe to continue.
export async function acknowledgeRestaurantNotice(page,task,slot,calendarVerified,{snapshot}={}) {
  try {
    let current=snapshot || await page.evaluate(readBookingFlowDom);
    if(!current.restaurantNotices?.length)return null;
    if(!knownRestaurantNotice(current,task,slot,calendarVerified))return 'blocked';
    const dialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'注意事项',exact:true})});
    if(await dialog.count()!==1 || !await dialog.isVisible())return 'blocked';
    for(let index=0;index<4;index++) {
      if(!knownRestaurantNotice(current,task,slot,calendarVerified))return 'blocked';
      if(current.restaurantNotices[0].rows[index].checked)continue;
      const row=current.restaurantNotices[0].rows[index];
      const control=dialog.getByRole('button',{name:row.text,exact:true});
      if(await control.count()!==1 || !await control.isVisible() || !await control.isEnabled())return 'blocked';
      try {await control.click({timeout:5000});}catch{/* Never retry a possibly completed toggle. */}
      let next=await page.evaluate(readBookingFlowDom);
      if(next.restaurantNotices?.[0]?.rows?.[index]?.checked!==true) {
        try {
          const selected=await page.waitForFunction(label=>{
            const visible=element=>Boolean(element.getBoundingClientRect().width && element.getBoundingClientRect().height && getComputedStyle(element).visibility!=='hidden');
            const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible).filter(root=>[...root.querySelectorAll('h1,h2,h3,h4')].some(heading=>heading.innerText.trim()==='注意事项'));
            if(dialogs.length!==1)return false;
            const rows=[...dialogs[0].querySelectorAll('button')].filter(visible).filter(button=>button.innerText.trim()===label);
            return rows.length===1 && rows[0].querySelector(':scope > svg')?.classList.contains('text-[#ff3d00]');
          },row.text,{timeout:2000});
          await selected.dispose();
        }catch{return 'blocked';}
        next=await page.evaluate(readBookingFlowDom);
      }
      if(!knownRestaurantNotice(next,task,slot,calendarVerified) || next.restaurantNotices[0].rows[index].checked!==true
        || next.restaurantNotices[0].rows.some((value,other)=>other!==index && value.checked!==current.restaurantNotices[0].rows[other].checked))return 'blocked';
      current=next;
    }
    current=await page.evaluate(readBookingFlowDom);
    if(!knownRestaurantNotice(current,task,slot,calendarVerified) || !current.restaurantNotices[0].rows.every(row=>row.checked)
      || current.restaurantNotices[0].next.active!==true)return 'blocked';
    const next=dialog.getByRole('button',{name:'下一步',exact:true});
    if(await next.count()!==1 || !await next.isVisible() || !await next.isEnabled())return 'blocked';
    try {await next.click({timeout:5000});}catch{/* Its result is read, never replayed. */}
    try {await dialog.waitFor({state:'hidden',timeout:5000});}catch{return 'blocked';}
    const after=await page.evaluate(readBookingFlowDom);
    return after.restaurantNotices?.length?'blocked':'advanced';
  }catch{return 'blocked';}
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
  const restaurantNotices=dialogRoots.filter(root=>[...root.querySelectorAll('h1,h2,h3,h4')].filter(visible).some(heading=>heading.innerText.trim()==='注意事项')).map(root=>{
    const controls=[...root.querySelectorAll('button')].filter(visible);
    const rows=controls.flatMap(element=>{
      const svg=element.querySelector(':scope > svg'),label=element.querySelector(':scope > span');
      if(!svg || !label || svg.getAttribute('viewBox')!=='0 0 24 24')return [];
      const rect=svg.querySelector('rect'),path=svg.querySelector('path');
      if(!rect || !path || rect.getAttribute('x')!=='2' || rect.getAttribute('y')!=='2' || rect.getAttribute('width')!=='20'
        || rect.getAttribute('height')!=='20' || rect.getAttribute('rx')!=='6' || rect.getAttribute('fill')!=='currentColor'
        || path.getAttribute('d')!=='M7 11.803 10.476 15 17 9')return [];
      const selected=svg.classList.contains('text-[#ff3d00]'),unselected=svg.classList.contains('text-[#d5d5d5]');
      return [{text:label.innerText.trim(),checked:selected!==unselected?selected:null,disabled:element.disabled || element.getAttribute('aria-disabled')==='true'}];
    });
    const next=controls.filter(element=>element.innerText.trim()==='下一步');
    const nextButton=next.length===1?next[0]:null;
    const active=nextButton?.classList.contains('bg-[#ff3d00]') && nextButton.classList.contains('text-white');
    const inactive=nextButton?.classList.contains('bg-[#f1f1f1]') && nextButton.classList.contains('text-[#c8c8c8]');
    return {heading:'注意事项',text:root.innerText,buttons:buttons(root),rows,linkCount:root.querySelectorAll('a[href]').length,
      next:nextButton?{text:nextButton.innerText.trim(),disabled:nextButton.disabled || nextButton.getAttribute('aria-disabled')==='true',active:active!==inactive?active:null}:null};
  });
  const phones=[...document.querySelectorAll('input[type="tel"]')].filter(visible);
  const phone=phones.length===1?phones[0]:null;
  const phoneHeading=phone?.closest('section')?.querySelector('h3');
  const phoneRequired=Boolean(phoneHeading && visible(phoneHeading)
    && /(?:电话号码|Phone (?:number|Number))/i.test(phoneHeading.innerText)
    && /\*\s*(?:必填|Required)/i.test(phoneHeading.innerText));
  const nameLabel=/^(?:预约人|预订人|预约姓名|预订姓名|姓名|Full name|Guest name|Booker name|Reservation name|Name|예약자명|예약자 이름|이름)(?:\s*\*?\s*(?:必填|Required|필수))?\s*\*?$/i;
  const inputs=[...document.querySelectorAll('input')].filter(visible);
  const names=officialForm() ? inputs.filter(element=>{
    if(!['text',''].includes(element.getAttribute('type') || '') && element.type!=='text')return false;
    const explicit=[element.getAttribute('aria-label'),element.getAttribute('placeholder'),...Array.from(element.labels || [],label=>label.innerText?.trim())].filter(Boolean);
    const heading=element.closest('section')?.querySelector('h3');
    if(heading && visible(heading))explicit.push(heading.innerText.trim());
    return element.autocomplete==='name' || /^(?:full_?name|guest_?name|booker_?name|reservation_?name|name)$/i.test(element.name || '') || explicit.some(value=>nameLabel.test(value));
  }):[];
  function officialForm() {
    return location.protocol==='https:' && ['www.catchtable.net','catchtable.net'].includes(location.hostname) && !location.port
      && /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?reservation\/form\/?$/.test(location.pathname);
  }
  const choiceGroups=officialForm()?(()=>{
    const scopeSelector='section, fieldset, [role="radiogroup"]';
    const scopes=[...document.querySelectorAll(scopeSelector)];
    const answer=text=>/^(?:是|Yes|예|네)$/i.test(text.trim())?'yes':/^(?:否|No|아니오|아니요)$/i.test(text.trim())?'no':null;
    const path=(root,element)=>{if(!root.contains(element))return [];const output=[];for(let node=element;node!==root;node=node.parentElement)output.unshift([...node.parentElement.children].indexOf(node)+1);return output;};
    const controlLabel=element=>element.getAttribute('aria-label') || [...(element.labels || [])].filter(visible).map(label=>label.innerText.trim()).join(' ') || element.innerText?.trim() || '';
    const option=(root,element,kind)=>{
      const text=controlLabel(element);let selected=null,target=element;
      if(kind==='native') {
        selected=element.checked;
        if(!visible(element))target=[...(element.labels || [])].filter(label=>visible(label) && root.contains(label)).at(0) || element;
      }else if(kind==='aria')selected=['true','false'].includes(element.getAttribute('aria-checked'))?element.getAttribute('aria-checked')==='true':null;
      else {
        const circle=element.querySelector(':scope > span'),dot=circle?.querySelector(':scope > span');
        if(element.getAttribute('type')==='button' && circle && dot && ['h-[20px]','w-[20px]','rounded-full','border','bg-white'].every(value=>circle.classList.contains(value))
          && ['h-[12px]','w-[12px]','rounded-full'].every(value=>dot.classList.contains(value))) {
          const on=circle.classList.contains('border-[#ff3d00]') && dot.classList.contains('bg-[#ff3d00]');
          const off=circle.classList.contains('border-[#c4c4c4]') && dot.classList.contains('bg-[#c4c4c4]');
          selected=on!==off?on:null;
        }
      }
      return {text,value:answer(text),selected,disabled:element.matches(':disabled') || Boolean(element.closest('[aria-disabled="true"]')),
        path:path(root,target)};
    };
    return scopes.flatMap((root,scopeIndex)=>{
      if(!visible(root))return [];
      const owned=element=>element.closest(scopeSelector)===root;
      const native=[...root.querySelectorAll('input[type="radio"]')].filter(owned).filter(element=>visible(element) || [...(element.labels || [])].some(visible));
      const aria=[...root.querySelectorAll('[role="radio"]')].filter(element=>owned(element) && element.tagName!=='INPUT' && visible(element));
      const custom=[...root.querySelectorAll('button')].filter(element=>owned(element) && visible(element) && answer(element.innerText.trim()));
      const unknown=[...root.querySelectorAll('label,span,div')].filter(element=>owned(element) && visible(element) && answer(element.innerText.trim()) && ![...element.children].some(child=>answer(child.innerText?.trim() || '')));
      const sets=native.length?[...new Set(native.map(element=>element.name))].map(name=>({kind:'native',elements:native.filter(element=>element.name===name)}))
        :aria.length?[{kind:'aria',elements:aria}]:custom.length?[{kind:'custom',elements:custom}]:unknown.length?[{kind:'unknown',elements:unknown}]:[];
      return sets.flatMap(({kind,elements})=>{
        const options=elements.map(element=>option(root,element,kind));
        if(!options.some(item=>item.value))return [];
        const labelled=(root.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)).filter(element=>element && visible(element)).map(element=>element.innerText.trim()).join(' ');
        const heading=[...root.querySelectorAll('legend,h1,h2,h3,h4')].find(element=>owned(element) && visible(element));
        const directTitle=[...root.children].find(element=>visible(element) && !element.matches('button,input,[role="radio"]') && !element.querySelector('button,input,[role="radio"]') && element.innerText.trim());
        const question=(root.getAttribute('aria-label') || labelled || heading?.innerText || directTitle?.innerText || '').trim();
        const required=root.getAttribute('aria-required')==='true' || elements.some(element=>element.required || element.getAttribute('aria-required')==='true') || /\*|必填|\bRequired\b|필수/i.test(question);
        return [{question,required,kind:kind==='native' && !elements[0].name?'unknown':kind,scopeIndex,scopeText:root.innerText.trim(),options}];
      });
    });
  })():[];
  const requiredChoiceFields=choiceGroups.filter(group=>group.required && (group.options.some(option=>typeof option.selected!=='boolean') || group.options.filter(option=>option.selected).length!==1)).map(group=>group.question || '必填是／否问题');
  const missingRequired=[...document.querySelectorAll('input[required],textarea[required],select[required],[aria-required="true"]')].filter(visible).filter(element=>{
    if(element.matches('input[type="radio"]'))return ![...document.querySelectorAll('input[type="radio"]')].some(other=>other.form===element.form && other.name===element.name && other.checked);
    if(element.matches('[role="radiogroup"]'))return [...element.querySelectorAll('[role="radio"][aria-checked="true"]')].filter(visible).length!==1;
    if(element.matches('[role="radio"]'))return element.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"][aria-checked="true"]').length!==1;
    return !element.value?.trim();
  }).map(element=>names.includes(element)?'预约姓名':element.getAttribute('aria-label') || element.name || '必填信息');
  for(const name of names)if(!name.value?.trim() && /\*\s*(?:必填|Required|필수)/i.test(name.closest('section')?.querySelector('h3')?.innerText || ''))missingRequired.push('预约姓名');
  if(phoneRequired && !phone.value?.trim())missingRequired.push('电话号码');
  missingRequired.push(...requiredChoiceFields);
  return {url:location.href,text:text.slice(0,40000),buttons:buttons(document),
    headings:[...document.querySelectorAll('h1,h2,h3,h4')].filter(visible).map(element=>element.innerText.trim()),
    summaries:[...document.querySelectorAll('main p')].filter(visible).map(element=>element.innerText.trim()).filter(value=>value.includes(' · ') && /\d{1,2}:\d{2}/.test(value)),
    links:[...document.querySelectorAll('a[href]')].filter(visible).map(element=>({href:element.href,text:element.innerText.trim()})),
    dialogs:dialogRoots.map(element=>({text:element.innerText,buttons:buttons(element)})),restaurantNotices,
    loading:Boolean([...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].find(visible)),
    captcha:Boolean([...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"]')].find(visible)),
    uncheckedAgreements:unchecked.filter(element=>!/(?:不再显示|Don't show again|Do not show again)/i.test(labels(element))).map(labels),
    missingRequiredFields:[...new Set(missingRequired)],choiceGroups,requiredChoiceFields,
    nameFields:names.map(element=>({index:inputs.indexOf(element),empty:!element.value?.trim(),readOnly:Boolean(element.readOnly),disabled:Boolean(element.disabled)})),
    phoneField:phone?{required:phoneRequired,empty:!phone.value?.trim(),countryCode:phone.previousElementSibling?.innerText.trim() || ''}:null,
    cards:[...document.querySelectorAll('a[href*="/customer/reservation/detail/"]')].filter(visible).map(element=>({url:element.href,text:element.innerText,headings:[...element.querySelectorAll('h1,h2,h3,h4,h5')].map(heading=>heading.innerText.trim())}))};
}

// Only the reservation form's single explicitly labelled full-name input may
// receive the attempt's supplied contact. No profile page or saved account is edited.
export async function fillReservationName(page,snapshot,fullName) {
  if(typeof fullName!=='string' || !fullName.trim() || fullName.length>100 || /[\x00-\x1f\x7f]/.test(fullName))return 'blocked';
  if(officialReservationRoute(snapshot?.url)?.kind!=='form')return 'blocked';
  if(!snapshot.nameFields?.length)return 'absent';
  if(snapshot.nameFields.length!==1)return 'blocked';
  const field=snapshot.nameFields[0];
  if(!Number.isSafeInteger(field.index) || field.index<0)return 'blocked';
  try {
    const locator=page.locator('input:visible').nth(field.index);
    if(await locator.count()!==1 || !await locator.isVisible())return 'blocked';
    if(await locator.inputValue()===fullName.trim())return 'ready';
    if(field.readOnly || field.disabled || !await locator.isEditable())return 'blocked';
    await locator.fill(fullName.trim());
    return await locator.inputValue()===fullName.trim()?'filled':'blocked';
  }catch{return 'blocked';}
}

// Compare phone values privately, including a website's existing prefill. Only
// the current reservation form's unique, labelled telephone input is editable.
// The caller receives a state, never the actual number or country-picker text.
export async function fillReservationPhone(page,contact,{onStep=()=>{}}={}) {
  const step=value=>onStep(value);
  const digits=value=>typeof value==='string' && /^[\d\s()-]*$/.test(value)?value.replace(/[\s()-]/g,''):null;
  step('configuration');
  if(typeof contact?.countryCode!=='string' || typeof contact?.phoneNumber!=='string'
    || !/^\+[1-9]\d{0,2}$/.test(contact.countryCode) || !/^\d{4,20}$/.test(contact.phoneNumber))return 'blocked';
  try {
    if(officialReservationRoute(page.url())?.kind!=='form')return 'blocked';
    step('phone_field');
    const phone=page.locator('input[type="tel"]:visible');
    const count=await phone.count();
    if(count===0)return 'absent';
    if(count!==1 || !await phone.isVisible())return 'blocked';
    const recognised=await phone.evaluate(element=>{
      const labels=[element.getAttribute('aria-label'),element.getAttribute('placeholder'),
        ...Array.from(element.labels || [],label=>label.innerText),element.closest('section')?.querySelector('h3')?.innerText].filter(Boolean);
      return /^(?:tel|tel-national)$/.test(element.autocomplete || '')
        || /^(?:phone|phone_?number|mobile|mobile_?number|telephone|tel)$/i.test(element.name || '')
        || labels.some(label=>/(?:电话号码|手机号码|联系电话|Phone(?:\s+number)?|Telephone|Mobile(?:\s+number)?|전화번호|연락처)/i.test(label));
    });
    if(!recognised)return 'blocked';
    const country=phone.locator('xpath=preceding-sibling::div[1]');
    step('country_control');
    if(await country.count()!==1 || !await country.isVisible())return 'blocked';
    const originalCountry=(await country.innerText()).trim();
    const originalNumber=digits(await phone.inputValue());
    if(originalCountry===contact.countryCode && originalNumber===contact.phoneNumber)return 'ready';
    if(!await phone.isEditable())return 'blocked';
    if(originalCountry!==contact.countryCode) {
      await country.click();
      const search=page.getByPlaceholder(/^(?:搜索|Search)$/i);
      step('country_search');
      if(!await search.waitFor({state:'visible',timeout:5000}).then(()=>true,()=>false))return 'blocked';
      if(await search.count()!==1 || !await search.isVisible())return 'blocked';
      await search.fill(contact.countryCode);
      const code=contact.countryCode.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const option=page.getByRole('button').filter({has:page.locator('span').filter({hasText:new RegExp(`^${code}$`)})});
      step('country_option');
      if(!await option.waitFor({state:'visible',timeout:5000}).then(()=>true,()=>false))return 'blocked';
      if(await option.count()!==1 || !await option.isEnabled())return 'blocked';
      await option.click();
      step('country_close');
      if(!await search.waitFor({state:'hidden',timeout:5000}).then(()=>true,()=>false))return 'blocked';
      step('country_verify');
      if((await country.innerText()).trim()!==contact.countryCode)return 'blocked';
    }
    if(digits(await phone.inputValue())!==contact.phoneNumber)await phone.fill(contact.phoneNumber);
    step('phone_verify');
    return digits(await phone.inputValue())===contact.phoneNumber && (await country.innerText()).trim()===contact.countryCode?'filled':'blocked';
  }catch{return 'blocked';}
}
