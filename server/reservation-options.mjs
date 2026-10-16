import {officialReservationRoute,readBookingFlowDom} from './booking-flow.mjs';

const SCOPE='section, fieldset, [role="radiogroup"]';
const protectedQuestion=/(?:条款|协议|隐私|个人信息|第三方|营销|广告|付款|支付|订金|预约金|预订金|取消政策|取消费用|取消条款|\b(?:terms|conditions|privacy|consent|agreement|marketing|advertising|payment|deposit|cancellation|fees?)\b|personal\s+(?:data|information)|third.party|약관|개인정보|마케팅|광고|결제|예약금|취소\s*(?:정책|수수료))/i;
const validPath=value=>Array.isArray(value) && value.length>0 && value.length<=20 && value.every(index=>Number.isSafeInteger(index) && index>0 && index<1000);
const answer=value=>/^(?:是|Yes|예|네)$/i.test(value.trim())?'yes':/^(?:否|No|아니오|아니요)$/i.test(value.trim())?'no':null;
const normalized=value=>String(value || '').replace(/\s+/g,' ').trim();
const blocked=(reason,retryable=false)=>({status:'blocked',reason,retryable});

// Only explicit paired radio questions participate. Consent checkboxes and
// legal, financial or marketing questions do not inherit the No authorization.
export function reservationChoiceState(snapshot) {
  if(officialReservationRoute(snapshot?.url)?.kind!=='form')return blocked('当前不是官方预约表单。');
  if(snapshot.loading || snapshot.captcha)return blocked('预约表单仍在加载或需要验证。',snapshot.loading===true && !snapshot.captcha);
  const groups=snapshot.choiceGroups;
  if(groups===undefined)return {status:'absent',answered:0};
  if(!Array.isArray(groups))return blocked('尚未完整读取表单问题。');
  if(!groups.length)return {status:'absent',answered:0};
  if(groups.length>16)return blocked('表单问题过多，无法准确逐项核对。');
  const questions=new Set();let pending=null,answered=0;
  for(const group of groups) {
    if(!group || typeof group!=='object')return blocked('问题选项结构尚不能唯一识别。');
    if(typeof group.question!=='string' || !group.question.trim() || group.question.length>500)return blocked('无法准确识别是／否问题的标题。');
    const question=group.question.replace(/\s+/g,' ').trim();
    if(questions.has(question))return blocked('出现重复的问题标题，无法确认选项归属。');
    questions.add(question);
    if(protectedQuestion.test(`${question}\n${group.scopeText || ''}`))return blocked('出现条款、支付或营销问题，未自动修改。');
    if(!['native','aria','custom'].includes(group.kind) || !Number.isSafeInteger(group.scopeIndex) || group.scopeIndex<0 || group.scopeIndex>10000
      || !Array.isArray(group.options) || group.options.length!==2 || group.options.some(option=>!option || typeof option!=='object'))return blocked('问题选项结构尚不能唯一识别。');
    const yes=group.options.filter(option=>option.value==='yes'),no=group.options.filter(option=>option.value==='no');
    if(yes.length!==1 || no.length!==1)return blocked('问题中不是唯一的一组是／否选项。');
    if(group.options.some(option=>typeof option.text!=='string' || answer(option.text)!==option.value || typeof option.selected!=='boolean' || typeof option.disabled!=='boolean' || !validPath(option.path))
      || group.options.filter(option=>option.selected).length>1)return blocked('选项的当前状态尚不能准确核对。');
    if(no[0].selected){answered++;continue;}
    if(no[0].disabled)return blocked('问题的“否”选项当前不可操作。',true);
    pending ||= {group,option:no[0]};
  }
  return pending?{status:'pending',...pending,answered}:{status:'ready',answered};
}

export async function answerReservationNoChoices(page,{snapshot}={}) {
  let changed=0;
  try {
    let current=snapshot || await page.evaluate(readBookingFlowDom);
    for(let step=0;step<17;step++) {
      const state=reservationChoiceState(current);
      if(state.status==='blocked')return state;
      if(state.status!=='pending')return {status:changed?'filled':state.status,answered:state.answered};
      const {group,option}=state;
      const scope=page.locator(SCOPE).nth(group.scopeIndex);
      const control=scope.locator(`:scope${option.path.map(index=>` > :nth-child(${index})`).join('')}`);
      if(await scope.count()!==1 || !await scope.isVisible() || await control.count()!==1 || !await control.isVisible() || !await control.isEnabled())return blocked('问题的“否”选项已变化或不可操作。',true);
      if(typeof group.scopeText!=='string' || normalized(await scope.innerText())!==normalized(group.scopeText))return blocked('问题内容发生变化，未操作其他问题的选项。',true);
      const actual=await control.evaluate(element=>element.getAttribute('aria-label') || (element.matches('input[type="radio"]')?[...(element.labels || [])].filter(label=>label.getBoundingClientRect().width && label.getBoundingClientRect().height && getComputedStyle(label).visibility!=='hidden').map(label=>label.innerText.trim()).join(' '):element.innerText.trim()));
      if(normalized(actual)!==normalized(option.text))return blocked('问题的“否”选项已发生变化。',true);
      try {await control.click({timeout:5000});}catch{/* Read the result once; never replay a possibly completed answer. */}
      const selectedNo=value=>{
        const same=value.choiceGroups?.filter(value=>value.question===group.question);
        return same?.length===1 && same[0].kind===group.kind && same[0].options?.filter(value=>value.value==='no' && value.selected===true).length===1
          && same[0].options.every(value=>value.value==='no' || value.selected===false);
      };
      let after=await page.evaluate(readBookingFlowDom);
      if(!selectedNo(after)) {
        try {
          const selected=await page.waitForFunction(({scopeIndex,path,kind})=>{
            let element=document.querySelectorAll('section, fieldset, [role="radiogroup"]')[scopeIndex];
            for(const index of path)element=element?.children[index-1];
            if(!element)return false;
            if(kind==='native')return (element.matches('input[type="radio"]')?element:element.control)?.checked===true;
            if(kind==='aria')return element.getAttribute('aria-checked')==='true';
            const circle=element.querySelector(':scope > span'),dot=circle?.querySelector(':scope > span');
            return Boolean(circle?.classList.contains('border-[#ff3d00]') && dot?.classList.contains('bg-[#ff3d00]'));
          },{scopeIndex:group.scopeIndex,path:option.path,kind:group.kind},{timeout:2000});
          await selected.dispose();
        }catch{return blocked('尚未确认“否”已选中，未重复点击。',true);}
        after=await page.evaluate(readBookingFlowDom);
      }
      if(!selectedNo(after))return blocked('尚未确认“否”已选中，未重复点击。',true);
      if(reservationChoiceState(after).status==='blocked')return reservationChoiceState(after);
      for(const previous of current.choiceGroups.filter(value=>value.options.some(option=>option.value==='no' && option.selected))) {
        const same=after.choiceGroups.filter(value=>value.question===previous.question);
        if(same.length!==1 || !same[0].options.some(option=>option.value==='no' && option.selected))return blocked('其他问题的答案发生变化，已停止自动处理。');
      }
      changed++;current=after;
    }
    return blocked('问题反复变化，已停止自动处理。');
  }catch{return blocked('表单问题暂时不能准确核对，未继续结账。',true);}
}
