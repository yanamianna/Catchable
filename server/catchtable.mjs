import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpError, restaurantUrl, safeMessage } from './domain.mjs';
import { BrowserProfileInUseError, initializeSessionRestorePreferences, launchManualBrowser, probeProfileOccupancy } from './browser-launch.mjs';
import { parseRestaurantSnapshot, readRestaurantSnapshot, readRestaurantInformationSnapshot } from './restaurant.mjs';
import { officialReservationRoute, recordStatus, knownConfirmationNotice, knownSameDayNotice, CHECKOUT_NAME, classifyCheckout, readBookingFlowDom, fillReservationName, fillReservationPhone } from './booking-flow.mjs';
import { parseReservationResponse, parseScheduledResponse, parseShopResponse } from './reservation-evidence.mjs';
import { isOfficialUserInfo, parseSessionEvidence, sessionIdentityFingerprint } from './session-evidence.mjs';
import { connectExtensionContext } from './extension-context.mjs';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const CHINESE_MONTHS = ['一','二','三','四','五','六','七','八','九','十','十一','十二'];
const AUTH = /登录或注册|使用谷歌账号登录|Sign in with Google|Continue with Apple|log in|로그인/i;
const SOLD_OUT = /已满员|已满|此日期不提供在线预订|Sold out|No available times|Fully booked|예약 마감|예약 가능한 시간이 없습니다/i;
const MANUAL_GUIDANCE = ['点击「打开普通登录窗口」，在普通专用浏览器中完成官方登录，可选择电子邮件或 Google。', '登录完成后关闭这个专用浏览器的所有窗口，再点击「连接并核验登录」。', '其他个人浏览器窗口可以保留；系统不会关闭或读取个人浏览器资料。'];
const EXTENSION_GUIDANCE=['在平常使用的 Chrome 中加载本机扩展并配对，保持 Chrome 和扩展连接打开。','在同一个 Chrome 中完成 Catchtable 官网登录，再点击「核验扩展登录」。无需关闭浏览器。'];

function sessionFailureMessage(reason,fallback) {
  if(reason==='identity_mismatch')return '当前官网登录身份与此账号绑定不一致，已停止该账号的自动操作。请断开连接后核对所选 Chrome 资料和账号。';
  if(reason==='http_401')return '官方账号接口返回 401：当前会话未获授权，暂不能自动订座。';
  if(reason==='http_403')return '官方账号接口返回 403：当前请求被官网拒绝，尚不能确认登录状态。';
  if(reason==='guest_response')return '官方账号接口返回 200，但明确显示未登录（isLogin=false）。当前页面会话尚未通过核验。';
  return fallback;
}

export function classifySessionSnapshots(snapshots, { browserOpen = true, browserMode = 'controlled', checkedAt = new Date().toISOString() } = {}) {
  const result = (status, message, guidance = [], extra = {}) => ({ status, connected: status === 'authenticated', browserOpen, browserMode, checkedAt, message, guidance, ...extra });
  if (!browserOpen) return browserMode === 'extension'
    ? result('closed', 'Chrome 扩展页面尚未核验，请点击「核验扩展登录」。', ['保持当前 Chrome 打开，在扩展连接后核验登录。'])
    : result('closed', '专用浏览器尚未连接。', ['点击「打开普通登录窗口」，完成后关闭专用窗口，再点击「连接并核验登录」。']);
  if((snapshots || []).some(snapshot=>snapshot.serverAuthRequired===true && snapshot.serverAuth?.status==='identity_mismatch'))return result('identity_mismatch',sessionFailureMessage('identity_mismatch'),['核对账号绑定与扩展所在 Chrome 资料后，断开并重新连接。']);
  let official = false;
  let loginRequired = false;
  let account;
  let primaryOfficial=false;
  let primaryAccount;
  let primaryLogin=false;
  let bookingLogin=false;
  let bookingUnknown=false;
  let primaryLoginReason;
  let bookingLoginReason;
  for (const snapshot of snapshots || []) {
    let url;
    try { url = new URL(snapshot.url); } catch { continue; }
    if (url.hostname === 'accounts.google.com') {
      if (/\/signin\/rejected|\/signin\/denied/i.test(url.pathname) || /This browser or app may not be secure|此浏览器或应用可能不安全|浏览器或应用可能不安全|브라우저.*안전하지/i.test(snapshot.text || '')) {
        return result('oauth_blocked', 'Google 拒绝了当前受控浏览器的登录。请改用普通浏览器手动登录，或选择官方电子邮件登录。', MANUAL_GUIDANCE);
      }
      continue;
    }
    if (url.protocol !== 'https:' || !['catchtable.net', 'www.catchtable.net'].includes(url.hostname) || url.port || url.username || url.password) continue;
    official = true;
    if(snapshot.primary)primaryOfficial=true;
    if (snapshot.loading) continue;
    if(snapshot.serverAuthRequired===true) {
      const verified=snapshot.serverAuth;
      if(verified?.status==='unauthenticated') {loginRequired=true;if(snapshot.primary){primaryLogin=true;primaryLoginReason=verified.evidenceReason;}if(snapshot.booking){bookingLogin=true;bookingLoginReason=verified.evidenceReason;}continue;}
      if(verified?.status==='authenticated') {
        const proof=typeof verified.accountLabel==='string'?{accountLabel:verified.accountLabel}:{};
        account=proof;if(snapshot.primary)primaryAccount=proof;
        continue;
      }
      if(snapshot.booking)bookingUnknown=true;
      continue;
    }
    const evidence = snapshot.accountEvidence;
    if (evidence && ['logout', 'profile', 'account_menu'].includes(evidence.kind)) {
      const label = typeof evidence.label === 'string' ? evidence.label.trim().slice(0, 100) : undefined;
      const proof=label ? { accountLabel: label } : {};
      account=proof;
      if(snapshot.primary)primaryAccount=proof;
    }
    if (AUTH.test(snapshot.text || '') || /\/(?:login|sign-in|signin|sign-up|signup)(?:\/|$)/i.test(url.pathname)) {loginRequired=true;if(snapshot.primary)primaryLogin=true;if(snapshot.booking)bookingLogin=true;}
  }
  if(bookingLogin)return result(bookingLoginReason==='http_403'?'unknown':'unauthenticated',sessionFailureMessage(bookingLoginReason,'当前订座页面的官方会话核验显示未登录，已停止自动提交。'),['在所选专用浏览器完成登录后，再连接并核验。']);
  if(bookingUnknown)return result('unknown','订座页面尚未取得新的官方会话核验结果，暂不提交预约。',['等待页面加载或重新连接并核验登录。']);
  if(primaryOfficial) {
    if(primaryLogin)return result(primaryLoginReason==='http_403'?'unknown':'unauthenticated',sessionFailureMessage(primaryLoginReason,'最新官方账户页面显示登录尚未完成或已失效。'),['点击「打开普通登录窗口」重新登录后，再点击「连接并核验登录」。']);
    if(primaryAccount)return result('authenticated','已通过当前页面的官方账号会话核验。',[],primaryAccount);
    return result('unknown','最新官方账户页面尚未出现明确登录证据，暂不恢复自动任务。',['等待账户界面加载完成，再点击「连接并核验登录」。']);
  }
  if (loginRequired) return result('unauthenticated', '官方页面显示登录尚未完成或已失效。', ['在官方页面选择电子邮件登录；若使用 Google，建议先用普通浏览器手动登录。']);
  if (account) return result('authenticated', '已通过官方登录账户界面确认会话。', [], account);
  if (browserMode === 'manual') return result('manual_login', '普通专用浏览器正在等待手动登录。', MANUAL_GUIDANCE);
  return result('unknown', official ? '尚未看到明确的已登录账户证据，暂不恢复自动任务。' : '正在等待登录流程返回 Catchtable。', ['在官方 My Dining 或账户页面确认登录，然后再次检查。']);
}

function sessionSnapshotDom() {
  const visible = (element) => Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height && getComputedStyle(element).visibility !== 'hidden');
  const text = document.body?.innerText || '';
  const logout = [...document.querySelectorAll('button,a,[role="menuitem"]')].find((element) => visible(element) && /^(?:Log out|Logout|Sign out|退出登录|退出登陆|登出|로그아웃)$/i.test(element.innerText?.trim() || element.getAttribute('aria-label') || ''));
  const signedInAccount = [...document.querySelectorAll('[data-authenticated="true"], [data-user-authenticated="true"], [data-testid="logged-in-user"], [data-testid="account-email"]')].find(visible);
  const profileRoute=/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?my\/myMain(?:\/review)?\/?$/.test(location.pathname);
  const profileSections=profileRoute?[...document.querySelectorAll('main > section')].filter(visible):[];
  const profile=profileSections.find(section=>{
    const name=[...section.querySelectorAll('h4')].find(visible);
    const edit=[...section.querySelectorAll('button,a')].find(element=>visible(element) && /^(?:Edit Profile|编辑个人资料|编辑资料|编辑信息|修改个人资料|프로필 수정)$/i.test(element.innerText?.trim() || element.getAttribute('aria-label') || ''));
    return name?.innerText.trim() && edit;
  });
  const accountLabel = signedInAccount?.innerText?.trim() || profile?.querySelector('h4')?.innerText.trim();
  return { url: location.href, text: text.slice(0, 30000), loading: Boolean(document.querySelector('[aria-busy="true"], [role="progressbar"]')),
    accountEvidence: logout ? { kind: 'logout', ...(accountLabel ? { label: accountLabel } : {}) } : signedInAccount || profile ? { kind: 'profile', ...(accountLabel ? { label: accountLabel } : {}) } : null };
}

export function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  const match = text.match(/^(?:(上午|下午|오전|오후|am|pm)\s*)?(\d{1,2}):(\d{2})(?:\s*(上午|下午|오전|오후|am|pm))?$/i);
  if (!match || (match[1] && match[4])) return null;
  let hour = Number(match[2]); const minute = Number(match[3]);
  const meridiem = (match[1] || match[4] || '').toLowerCase();
  if (minute > 59 || hour > 23) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (/^(下午|오후|pm)$/.test(meridiem) ? 12 : 0);
  }
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

export function calendarLabelToDate(value) {
  if (typeof value !== 'string') return null;
  let year, month, day;
  let m = value.match(/(?:^|\D)(\d{4})[-/.年년]\s*(\d{1,2})[-/.月월]\s*(\d{1,2})(?:日|일)?(?:$|\D)/);
  if (m) [,year,month,day] = m.map(Number);
  else {
    m = value.match(/(?:^|\s)([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (m) { year = Number(m[3]); day = Number(m[2]); month = MONTHS.indexOf(m[1].toLowerCase()) + 1; }
    else {
      m = value.match(/(?:^|[ ,])([一二三四五六七八九十]+)月\s*(\d{1,2}),?\s*(\d{4})/);
      if (m) { year = Number(m[3]); day = Number(m[2]); month = CHINESE_MONTHS.indexOf(m[1]) + 1; }
    }
  }
  if (!year || year < 2000 || year > 2100 || !month || month > 12 || !day || day > 31) return null;
  const date = new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function shopId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['catchtable.net','www.catchtable.net'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?(?:explore\/)?shop\/([^/]+)\/?$/);
    return match && !/%2f|%5c/i.test(match[1]) ? match[1] : null;
  } catch { return null; }
}

export function parseAvailability(snapshot, task) {
  const unknown = (message) => ({status:'unknown',slots:[],message});
  if (AUTH.test(snapshot.text || '')) return {status:'auth_required',slots:[],message:'请在专用浏览器完成 Catchtable 登录。'};
  if (!shopId(snapshot.restaurantUrl) || shopId(snapshot.restaurantUrl) !== shopId(task.restaurantUrl)) return unknown('餐厅页面与任务不一致。');
  const date = calendarLabelToDate(snapshot.selectedDateLabel);
  if (!date || !task.dates.includes(date)) return unknown('无法核对已选日期。');
  if (snapshot.selectedPartySize !== task.partySize) return unknown('无法核对实际用餐人数。');
  if (snapshot.loading) return unknown('页面仍在加载，稍后重新检查。');
  const slots = [];
  for (const button of snapshot.buttons || []) {
    const time = normalizeTime(button.text);
    if (button.disabled || !time || time < task.timeStart || time > task.timeEnd) continue;
    if (!slots.some(s => s.time === time)) slots.push({date,time,partySize:task.partySize,label:button.text.trim()});
  }
  if (slots.length) return {status:'available',slots,message:`发现 ${slots.length} 个符合条件的时间。`};
  const hasAnyTime = (snapshot.buttons || []).some(b => normalizeTime(b.text));
  if (hasAnyTime || SOLD_OUT.test(snapshot.text || '')) return {status:'unavailable',slots:[],message:'当前没有符合条件的空位。'};
  return unknown('没有明确的空位或满位状态，保留上次有效观察。');
}

export function reservationMatches(evidence, task, slot) {
  if (!evidence || evidence.confirmed !== true || typeof evidence.reservationId !== 'string' || !evidence.reservationId.trim()) return false;
  const restaurantMatches = evidence.restaurantUrl ? shopId(evidence.restaurantUrl) && shopId(evidence.restaurantUrl) === shopId(task.restaurantUrl)
    : typeof evidence.restaurantName === 'string' && evidence.restaurantName.trim().toLowerCase() === task.restaurantName.trim().toLowerCase();
  return Boolean(restaurantMatches && calendarLabelToDate(evidence.date) === slot.date && normalizeTime(evidence.time) === slot.time && evidence.partySize === slot.partySize);
}

export function automaticSubmissionAllowed(task, evidence) {
  return task.mode === 'auto' && task.autoConsent === true && evidence.freeExplicitlyVerified === true && evidence.conditionsVerified === true
    && evidence.requiresPayment === false && evidence.requiresConsent === false && evidence.requiresCaptcha === false;
}

export function bookingConditionsFromText(text, task, slot) {
  const lines=String(text || '').split('\n').map(line=>line.trim()).filter(Boolean);
  const names=lines.map(line=>line.replace(/^(?:Restaurant|餐厅|매장)\s*[:：]\s*/i,''));
  const dateLabels=[...String(text || '').matchAll(/\d{4}[-/.年년]\s*\d{1,2}[-/.月월]\s*\d{1,2}(?:日|일)?/g)].map(match=>match[0]);
  const dates=[...new Set(dateLabels.map(calendarLabelToDate).filter(Boolean))];
  // Calendar/form/order summary only: clocks embedded in other descriptive
  // text (hours, cancellation policy, countdown) cannot identify a reservation.
  const times=[...new Set(lines.flatMap(line=> {
    const exact=normalizeTime(line);
    if(exact)return [exact];
    const labeled=line.match(/^(?:Time|Reservation time|用餐时间|预约时间|预订时间|예약 시간)\s*[:：]\s*(.+)$/i);
    if(labeled)return [normalizeTime(labeled[1])].filter(Boolean);
    if(!/\d{4}[-/.年년]/.test(line))return [];
    return [...line.matchAll(/(?:(?:上午|下午|오전|오후|am|pm)\s*)?\d{1,2}:\d{2}(?:\s*(?:上午|下午|오전|오후|am|pm))?/gi)].map(match=>normalizeTime(match[0])).filter(Boolean);
  }))];
  const people=[...new Set([...String(text || '').matchAll(/(?:Party size|Guests|用餐人数|人数|인원)\s*[:：]?\s*(\d+)\s*(?:people|persons|guests|人|명)?|(?:^|\s)(\d+)\s*(?:people|persons|guests|人|名|명)(?:\b|\s|$)/gim)].map(match=>Number(match[1] || match[2])))];
  return {restaurantName:names.some(name=>name.toLowerCase()===task.restaurantName.trim().toLowerCase())?task.restaurantName:'',
    date:dates.length===1?dates[0]:null,time:times.length===1?times[0]:null,partySize:people.length===1?people[0]:null};
}

export function parseOfficialBookingRecord(snapshot, task, slot) {
  const route=officialReservationRoute(snapshot?.url);
  if(route?.kind!=='detail' || snapshot.loading || snapshot.captcha)return null;
  const conditions=bookingConditionsFromText(snapshot.summary || snapshot.text,task,slot);
  const status=recordStatus(snapshot.statusLabels || String(snapshot.text || '').split('\n'));
  if(!status || !reservationMatches({...conditions,confirmed:true,reservationId:route.reservationId},task,slot))return null;
  if(slot.seatType && snapshot.seatType!==slot.seatType)return null;
  return {status,reservationId:route.reservationId,slot,submitted:true,
    phase:status==='pending_restaurant'?'awaiting_restaurant':status,
    message:status==='pending_restaurant'?'预约请求已发送，等待餐厅确认。系统会自动核验并同步预约记录。':status==='confirmed'?'已在官方预约记录核对预约编号、餐厅、日期、时间和人数，预约已确认。':'官方记录显示本次预约已拒绝或取消。'};
}

export function formConditionsVerified(snapshot, task, slot, calendarVerified=false) {
  if(officialReservationRoute(snapshot?.url)?.kind!=='form' || !snapshot.headings?.some(name=>name.trim().toLowerCase()===task.restaurantName.trim().toLowerCase()))return false;
  if(snapshot.summaries?.length!==1)return false;
  const parts=snapshot.summaries[0].split(' · ').map(part=>part.trim());
  const timeParts=parts.map(normalizeTime).filter(Boolean);
  const personParts=parts.filter(part=>/^(?:\d+\s*(?:人|名|명|people|persons|guests)|(?:People|Guests|人数)\s*[:：]?\s*\d+)$/i.test(part));
  if(timeParts.length!==1 || timeParts[0]!==slot.time || personParts.length!==1 || Number(personParts[0].match(/\d+/)?.[0])!==slot.partySize)return false;
  const fullDate=parts.map(calendarLabelToDate).filter(Boolean);
  if(fullDate.length)return fullDate.length===1 && fullDate[0]===slot.date;
  // Official localized form omits the year. Its shortened date can only be
  // checked alongside the verified calendar selection from this same flow.
  if(!calendarVerified)return false;
  const month=Number(slot.date.slice(5,7)),day=Number(slot.date.slice(8));
  const shortened=parts.filter(part=>/^\d{1,2}\.\d{1,2}\s*\([^)]*\)$/.test(part));
  const md=shortened[0]?.match(/^(\d{1,2})\.(\d{1,2})/);
  return shortened.length===1 && Number(md?.[1])===month && Number(md?.[2])===day && !slot.seatType;
}

function evidenceFromText(text, task, slot) {
  const id = text.match(/(?:Reservation\s*(?:number|no\.?|ID)|Booking\s*(?:number|no\.?|ID)|预订号|预约号|예약\s*번호)\s*[:：#]?\s*([A-Za-z0-9-]{4,})/i)?.[1];
  const dateForms = [slot.date,slot.date.replaceAll('-','.'),slot.date.replaceAll('-','/'),`${slot.date.slice(0,4)}年${Number(slot.date.slice(5,7))}月${Number(slot.date.slice(8))}日`,`${slot.date.slice(0,4)}년 ${Number(slot.date.slice(5,7))}월 ${Number(slot.date.slice(8))}일`];
  const date = dateForms.some(d => text.includes(d)) ? slot.date : null;
  const clocks = text.split(/\n/).flatMap(line => {
    const exact = normalizeTime(line.trim());
    if (exact) return [exact];
    const labeled = line.match(/^(?:Time|Reservation time|用餐时间|预约时间|预订时间|예약 시간)\s*[:：]\s*(.+)$/i);
    return labeled && normalizeTime(labeled[1]) ? [normalizeTime(labeled[1])] : [];
  });
  const partySize = text.match(/(?:Party size|Guests|用餐人数|人数|인원)\s*[:：]?\s*(\d+)\s*(?:people|persons|guests|人|명)?/i)?.[1]
    || text.match(/\b(\d+)\s*(?:people|persons|guests)\b/i)?.[1];
  const restaurantLine = text.split(/\n/).map(line=>line.trim().replace(/^(?:Restaurant|餐厅|매장)\s*[:：]\s*/i,''))
    .some(line=>line.toLowerCase()===task.restaurantName.trim().toLowerCase());
  const confirmed = /(?:Reservation confirmed|Booking confirmed|预订成功|预约成功|预订完成|预约完成|예약 완료)/i.test(text)
    && !/Payment required|Awaiting payment|Payment pending|待支付|待付款|支付待完成|결제 대기|예약 취소|Reservation cancelled|预约已取消|预订已取消/i.test(text);
  return {confirmed,reservationId:id || '',restaurantName:restaurantLine ? task.restaurantName : '',date,time:clocks.includes(slot.time) ? slot.time : null,partySize:partySize ? Number(partySize) : null};
}

export class CatchtableAdapter {
  #resumeChecks = new Map();
  constructor({dataDir,contextFactory,manualBrowserLauncher=launchManualBrowser,publicContextFactory,profileOccupancyProbe,browserChannel,extensionBridge,identityVerifier} = {}) {
    this.dataDir = dataDir || join(process.cwd(),'data'); this.contextFactory = contextFactory;
    this.manualBrowserLauncher = manualBrowserLauncher; this.publicContextFactory = publicContextFactory;
    this.profileOccupancyProbe = profileOccupancyProbe || (contextFactory ? async () => ({status:'free',ownerCount:0}) : probeProfileOccupancy);
    this.extensionBridge=extensionBridge;
    if(identityVerifier!==undefined && typeof identityVerifier!=='function')throw new TypeError('identityVerifier must be a function');
    this.identityVerifier=identityVerifier;this.identityRejected=false;
    this.defaultIntegration=extensionBridge?'extension':'dedicated';
    this.browserIntegration=this.defaultIntegration;
    this.browserMode = 'controlled'; this.browserChannel = browserChannel || process.env.CATCHABLE_BROWSER_CHANNEL || 'msedge';
    this.lastSession = classifySessionSnapshots([], {browserOpen:false,browserMode:this.browserMode});
    this.context = null; this.sessionPage = null; this.watchPages = new Map(); this.bookingPages = new Map(); this.bookingFlows = new Map();
    this.authStates=new WeakMap();
    this.inspections=new Map();
    this.newTabAuth=null;
  }
  get hasContext() { return Boolean(this.context); }
  get profileDir() { return this.browserChannel==='chrome'?join(this.dataDir,'browser-profiles','chrome'):join(this.dataDir,'browser-profile'); }
  browserInfo() {
    if(this.browserIntegration==='extension')return {browserIntegration:'extension',browserChannel:'chrome',browserName:'Google Chrome',profileLabel:'当前 Chrome 登录资料'};
    return {browserIntegration:'dedicated',browserChannel:this.browserChannel,browserName:this.browserChannel==='chrome'?'Google Chrome':'Microsoft Edge',profileLabel:this.browserChannel==='chrome'?'Chrome 专用会话':'Edge 专用会话'};
  }
  configureIntegration(mode) {
    if(!['extension','dedicated'].includes(mode))throw new HttpError(400,'浏览器执行方式须选择 extension 或 dedicated。');
    if(mode==='extension' && !this.extensionBridge)throw new HttpError(409,'当前服务未启用 Chrome 扩展连接。');
    if(this.context && mode!==this.browserIntegration)throw new HttpError(409,'请先断开已有会话，再更换执行方式。');
    this.browserIntegration=mode;
    if(mode==='extension')this.browserMode='extension';
    return this.#cacheSession({...this.lastSession});
  }
  async selectIntegration(mode) {
    if(!['extension','dedicated'].includes(mode))throw new HttpError(400,'浏览器执行方式须选择 extension 或 dedicated。');
    if(mode==='extension' && !this.extensionBridge)throw new HttpError(409,'当前服务未启用 Chrome 扩展连接。');
    if(mode===this.browserIntegration)return this.lastSession;
    if(this.context)await this.context.close();
    this.context=null;this.sessionPage=null;this.watchPages.clear();this.bookingPages.clear();this.bookingFlows.clear();this.newTabAuth=null;
    this.browserIntegration=mode;this.browserMode=mode==='extension'?'extension':'controlled';
    return this.#cacheSession({status:'closed',connected:false,browserOpen:false,browserMode:this.browserMode,checkedAt:new Date().toISOString(),
      message:mode==='extension'?'已切换为 Chrome 扩展。请在平常使用的 Chrome 中配对扩展后核验登录。':'已切换为专用浏览器，请在专用窗口登录并核验。',guidance:mode==='extension'?EXTENSION_GUIDANCE:MANUAL_GUIDANCE});
  }
  configureBrowser(channel) {
    if(!['chrome','msedge'].includes(channel))throw new HttpError(400,'专用浏览器须选择 chrome 或 msedge。');
    if(this.context && channel!==this.browserChannel)throw new HttpError(409,'请先断开旧专用浏览器连接，再更换浏览器。');
    this.browserChannel=channel;
    return this.#cacheSession({...this.lastSession,...this.browserInfo()});
  }
  async selectBrowser(channel) {
    if(!['chrome','msedge'].includes(channel))throw new HttpError(400,'专用浏览器须选择 chrome 或 msedge。');
    if(channel===this.browserChannel)return this.lastSession;
    if(this.context)await this.context.close();
    this.context=null;this.sessionPage=null;this.watchPages.clear();this.bookingPages.clear();this.bookingFlows.clear();
    this.browserChannel=channel;this.browserMode='controlled';this.newTabAuth=null;
    return this.#cacheSession({status:'closed',connected:false,browserOpen:false,browserMode:'controlled',checkedAt:new Date().toISOString(),
      message:'已更换专用浏览器。原浏览器的登录资料已保留，请在所选浏览器的专用窗口登录后连接。',guidance:MANUAL_GUIDANCE});
  }
  #cacheSession(value) {
    this.lastSession={...value,...this.browserInfo(),...(this.browserIntegration==='extension'?{browserMode:'extension',guidance:value.status==='authenticated'?[]:EXTENSION_GUIDANCE}:{})};
    return this.lastSession;
  }
  #trackPageAuth(page) {
    if(typeof page?.on!=='function' || typeof page.waitForResponse!=='function' || typeof page.mainFrame!=='function')return null;
    if(this.authStates.has(page))return this.authStates.get(page);
    const state={status:'unknown',request:null,pending:null,checkedAt:null};
    this.authStates.set(page,state);
    page.on('request',request=>{
      if(request.isNavigationRequest() && request.frame()===page.mainFrame())Object.assign(state,{status:'unknown',accountLabel:undefined,identityFingerprint:undefined,evidenceReason:undefined,request:null,checkedAt:null});
      if(request.method()==='GET' && isOfficialUserInfo(request.url()))Object.assign(state,{status:'unknown',accountLabel:undefined,identityFingerprint:undefined,evidenceReason:undefined,request,checkedAt:null});
    });
    page.on('response',response=>{
      if(!isOfficialUserInfo(response.url()) || response.request()!==state.request)return;
      const request=state.request;
      state.pending=(async()=>{
        let parsed;
        let evidenceReason;
        let fingerprint;
        try {
          const status=response.status();
          const body=status===200?await response.json():null;
          parsed=parseSessionEvidence(response.url(),status,body);
          fingerprint=sessionIdentityFingerprint(response.url(),status,body);
          if(parsed?.status==='authenticated' && this.identityVerifier && state.request===request)await this.identityVerifier(fingerprint);
          if(parsed?.status==='unauthenticated')evidenceReason=status===401?'http_401':status===403?'http_403':status===200?'guest_response':undefined;
        }
        catch(error) {
          fingerprint=undefined;
          parsed={status:error.code==='IDENTITY_MISMATCH'?'identity_mismatch':'unknown'};
          if(parsed.status==='identity_mismatch') {this.identityRejected=true;evidenceReason='identity_mismatch';this.newTabAuth=null;}
        }
        if(state.request===request)Object.assign(state,{accountLabel:undefined,identityFingerprint:undefined},parsed || {status:'unknown'},{identityFingerprint:parsed?.status==='authenticated'?fingerprint:undefined,evidenceReason,checkedAt:new Date().toISOString()});
      })();
    });
    page.on('requestfailed',request=>{
      if(request===state.request)Object.assign(state,{status:'unknown',accountLabel:undefined,identityFingerprint:undefined,evidenceReason:undefined,checkedAt:new Date().toISOString()});
    });
    return state;
  }
  async #pageIdentityReady(page) {
    if(!this.identityVerifier)return true;
    const state=this.#trackPageAuth(page);
    if(state?.pending)await state.pending;
    if(this.identityRejected || state?.status==='identity_mismatch') {
      this.#cacheSession({status:'identity_mismatch',connected:false,browserOpen:Boolean(this.context),browserMode:this.browserMode,checkedAt:new Date().toISOString(),message:sessionFailureMessage('identity_mismatch'),guidance:[]});
      return false;
    }
    return state?.status==='authenticated' && typeof state.identityFingerprint==='string';
  }
  #expectPageAuth(page) {
    const state=this.#trackPageAuth(page);
    if(!state)return Promise.resolve(null);
    return page.waitForResponse(response=>isOfficialUserInfo(response.url()) && response.request().method()==='GET',{timeout:15000})
      .catch(()=>null).then(async response=>{
        if(response)await response.finished().catch(()=>{});
        if(state.pending)await state.pending;
        return state;
      });
  }
  async #verifyNewTabSession() {
    if(!this.#trackPageAuth(this.sessionPage))return null;
    const page=await this.context.newPage();
    try {
      const ready=this.#expectPageAuth(page);
      await page.goto('https://www.catchtable.net/zh-CN/my/myMain',{waitUntil:'domcontentloaded',timeout:30000});
      const auth=await ready;
      this.newTabAuth={status:auth?.status || 'unknown',checkedAt:auth?.checkedAt || new Date().toISOString()};
      return this.newTabAuth;
    }catch {
      this.newTabAuth={status:'unknown',checkedAt:new Date().toISOString()};return this.newTabAuth;
    }finally {await page.close().catch(()=>{});}
  }
  isBookingAuthenticated(taskId) {
    const page=this.bookingPages.get(taskId);
    if(!page || page.isClosed())return false;
    const state=this.#trackPageAuth(page);
    if(this.identityRejected || state?.status==='identity_mismatch') {this.#cacheSession({status:'identity_mismatch',connected:false,browserOpen:true,browserMode:this.browserMode,checkedAt:new Date().toISOString(),message:sessionFailureMessage('identity_mismatch'),guidance:[]});return false;}
    if(state && state.status!=='authenticated')this.#cacheSession({status:state.status==='unauthenticated'?'unauthenticated':'unknown',connected:false,browserOpen:true,browserMode:'controlled',checkedAt:new Date().toISOString(),message:'当前订座页的官方会话核验未通过。',guidance:MANUAL_GUIDANCE});
    return state?state.status==='authenticated':!this.identityVerifier && this.lastSession.status==='authenticated';
  }
  #profileInUse() {
    this.browserMode='manual';
    return this.#cacheSession({status:'profile_in_use',connected:false,browserOpen:true,browserMode:'manual',checkedAt:new Date().toISOString(),
      message:new BrowserProfileInUseError().message,
      guidance:['请保存专用窗口中的操作，然后关闭这个窗口的所有标签和窗口；只关闭 Catchtable 标签不能释放资料。',
        '如果 Catchable 控制台也在同一专用窗口，请改从 Codex 内的本地控制台，或其他普通浏览器打开 http://127.0.0.1:4174/。',
        '关闭专用窗口不会退出账号，也不会删除已保存的登录会话。再点击「连接并核验登录」即可。']});
  }
  async #launch() {
    if (this.context) return this.context;
    this.identityRejected=false;
    if(this.browserIntegration==='extension') {
      if(!this.extensionBridge.state().connected)throw Object.assign(new Error('Chrome 扩展尚未连接。请先在平常使用的 Chrome 中加载扩展并完成本机配对。'),{code:'EXTENSION_DISCONNECTED'});
      this.context=this.contextFactory?await this.contextFactory({browserIntegration:'extension',bridge:this.extensionBridge}):await connectExtensionContext({bridge:this.extensionBridge});
      this.browserMode='extension';
    }else {
    const occupancy = await this.profileOccupancyProbe({profileDir:this.profileDir});
    if (occupancy.status==='in_use') throw new BrowserProfileInUseError();
    if (occupancy.status!=='free') throw Object.assign(new Error('无法确认专用浏览器资料是否被占用。尚未启动新的浏览器；请关闭整个专用窗口后重新连接。'),{code:'PROFILE_PROBE_UNKNOWN'});
    await mkdir(this.profileDir,{recursive:true});
    if (this.contextFactory) this.context = await this.contextFactory({channel:this.browserChannel,profileDir:this.profileDir});
    else {
      await initializeSessionRestorePreferences({profileDir:this.profileDir});
      const { chromium } = await import('playwright');
      try {
        this.context = await chromium.launchPersistentContext(this.profileDir,{
          channel:this.browserChannel,headless:false,
          args:['--restore-last-session'],
          viewport:{width:480,height:900},locale:'zh-CN',timezoneId:'Asia/Seoul',
        });
      } catch (error) { throw new Error(`专用浏览器无法连接。若普通专用窗口仍打开，请先关闭它的所有窗口再连接。${error.message.split('\n')[0]}`); }
    }
    }
    const context=this.context;
    for(const page of context.pages?.() || [])this.#trackPageAuth(page);
    context.on?.('page',page=>this.#trackPageAuth(page));
    context.setDefaultTimeout?.(10000);
    context.on?.('close',() => {
      if(this.context!==context)return;
      this.context=null;this.sessionPage=null;this.watchPages.clear();this.bookingPages.clear();this.bookingFlows.clear();
      this.inspections.clear();
      this.newTabAuth=null;
      this.#cacheSession(classifySessionSnapshots([],{browserOpen:false,browserMode:this.browserMode}));
    });
    return this.context;
  }
  async openSession({mode='manual'} = {}) {
    if(!['manual','controlled'].includes(mode)) throw new HttpError(400,'浏览器模式须为 manual 或 controlled。');
    if(this.browserIntegration==='extension') {
      try {
        const context=await this.#launch();await this.#navigateSession(context);await this.sessionPage.bringToFront();
        return this.observeSession();
      }catch(error){return this.#cacheSession({status:'unknown',connected:false,browserOpen:Boolean(this.context),browserMode:'extension',checkedAt:new Date().toISOString(),message:safeMessage(error),guidance:EXTENSION_GUIDANCE});}
    }
    if(mode==='manual') {
      if(this.context) await this.context.close();
      this.context=null;this.sessionPage=null;this.watchPages.clear();this.bookingPages.clear();this.bookingFlows.clear();
      this.newTabAuth=null;
      this.browserMode='manual';
      try {
        const launched=await this.manualBrowserLauncher({channel:this.browserChannel,profileDir:this.profileDir,url:'https://www.catchtable.net/zh-CN/my/myMain'});
        if(launched?.channel && launched.channel!==this.browserChannel)throw new Error('登录浏览器与所选浏览器不一致，尚未连接。');
        return this.#cacheSession({status:'manual_login',connected:false,browserOpen:true,browserMode:'manual',checkedAt:new Date().toISOString(),message:'普通专用浏览器已打开。请手动登录，完成后关闭该专用窗口，再点击「连接并核验登录」。',guidance:MANUAL_GUIDANCE});
      } catch(error) {
        const launchProblem=['MANUAL_WINDOW_NOT_VISIBLE','MANUAL_WINDOW_PROBE_FAILED','MANUAL_LAUNCH_FAILED'].includes(error.code);
        return this.#cacheSession({status:'closed',connected:false,browserOpen:false,browserMode:'manual',checkedAt:new Date().toISOString(),message:safeMessage(error),
          guidance:launchProblem?['本次没有确认到可见登录窗口，尚未核验登录。请再次点击「打开普通登录窗口」，不要先点击连接。',
            '如果已看到窗口但官网页面空白，请在该专用窗口重新打开 https://www.catchtable.net/zh-CN/my/myMain；页面完成登录后再关闭专用窗口并连接。']:
            ['检查所选浏览器是否已安装，或使用受控浏览器中的官方电子邮件登录。']});
      }
    }
    this.browserMode='controlled';
    let context;
    try {context = await this.#launch();} catch(error) {if(error instanceof BrowserProfileInUseError)return this.#profileInUse();throw error;}
    await this.#navigateSession(context);
    await this.sessionPage.bringToFront();
    return this.observeSession();
  }
  async #navigateSession(context) {
    if (!this.sessionPage || this.sessionPage.isClosed()) {
      const reserved = new Set([...this.watchPages.values(),...this.bookingPages.values()]);
      const available = (context.pages?.() || []).filter(page=>!page.isClosed?.() && !reserved.has(page));
      this.sessionPage = available.find(page=>/^https:\/\/(?:www\.)?catchtable\.net\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?my\/myMain\/?$/.test(page.url?.() || ''))
        || available.find(page=>['about:blank','about:newtab','chrome://newtab/','edge://newtab/'].includes(page.url?.())) || await context.newPage();
    }
    const page=this.sessionPage;
    const authReady=this.#expectPageAuth(page);
    const wasBlank=['about:blank','about:newtab','chrome://newtab/','edge://newtab/'].includes(page.url?.());
    try {
      await page.goto('https://www.catchtable.net/zh-CN/my/myMain',{waitUntil:'domcontentloaded',timeout:30000});
      await authReady;
      await this.#waitSessionReady(page);
    } catch(error) {
      if (wasBlank && !page.isClosed?.()) await page.close?.().catch(()=>{});
      if(this.sessionPage===page)this.sessionPage=null;
      throw error;
    }
  }
  async #waitSessionReady(page) {
    if(typeof page.waitForFunction!=='function')return;
    await page.waitForFunction(()=>{
      const visible=element=>Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height && getComputedStyle(element).visibility!=='hidden');
      const body=document.body?.innerText || '';
      const proof=[...document.querySelectorAll('button,a,[role="menuitem"]')].some(element=>visible(element) && /^(?:Log out|Logout|Sign out|退出登录|退出登陆|登出|로그아웃)$/i.test(element.innerText?.trim() || element.getAttribute('aria-label') || ''))
        || [...document.querySelectorAll('[data-authenticated="true"], [data-user-authenticated="true"], [data-testid="logged-in-user"], [data-testid="account-email"]')].some(visible)
        || (/\/my\/myMain\/?$/.test(location.pathname) && [...document.querySelectorAll('main > section h4')].some(element=>visible(element) && element.innerText.trim()));
      return proof || /登录或注册|使用谷歌账号登录|Sign in with Google|Continue with Apple|log in|로그인/i.test(body)
        || (!document.querySelector('[aria-busy="true"],[role="progressbar"]') && body.trim().length>120 && [...document.querySelectorAll('main,h1,h2,form')].some(visible));
    },null,{timeout:8000}).catch(()=>{});
  }
  async observeSession() {
    if(!this.context) {
      this.newTabAuth=null;
      return this.lastSession.browserMode==='manual' && this.lastSession.browserOpen ? this.lastSession : this.#cacheSession(classifySessionSnapshots([],{browserOpen:false,browserMode:this.browserMode}));
    }
    if(this.identityRejected)return this.#cacheSession({status:'identity_mismatch',connected:false,browserOpen:true,browserMode:this.browserMode,checkedAt:new Date().toISOString(),message:sessionFailureMessage('identity_mismatch'),guidance:[]});
    const snapshots=[];
    for(const page of this.context.pages?.() || []) {
      if(page.isClosed?.())continue;
      const auth=this.#trackPageAuth(page);
      if(auth?.pending)await auth.pending;
      const metadata={primary:page===this.sessionPage,booking:[...this.bookingPages.values()].includes(page),serverAuthRequired:Boolean(auth || this.identityVerifier),serverAuth:auth?{status:auth.status,evidenceReason:auth.evidenceReason,...(auth.accountLabel?{accountLabel:auth.accountLabel}:{})}:undefined};
      try {snapshots.push({...await page.evaluate(sessionSnapshotDom),...metadata});} catch {snapshots.push({url:page.url?.() || '',text:'',loading:true,...metadata});}
    }
    const observed=classifySessionSnapshots(snapshots,{browserOpen:true,browserMode:this.browserIntegration==='extension'?'extension':'controlled'});
    if(observed.status==='authenticated' && this.newTabAuth && this.newTabAuth.status!=='authenticated')return this.#cacheSession({...observed,status:this.newTabAuth.status,connected:false,
      message:'新页面未通过官方会话核验，暂不能自动订座。请在所选专用浏览器重新登录后核验。',guidance:MANUAL_GUIDANCE});
    if(observed.status==='authenticated' && this.newTabAuth?.status==='authenticated')return this.#cacheSession({...observed,newTabVerified:true,newTabCheckedAt:this.newTabAuth.checkedAt,
      message:'当前账号及新页面均已通过官方会话核验，可以自动订座。'});
    if(observed.status!=='authenticated')this.newTabAuth=null;
    return this.#cacheSession(observed);
  }
  async getSessionStatus() {
    if(!this.context) {
      const manual=this.browserMode==='manual';
      const manualOpen=manual && this.lastSession.browserOpen;
      this.#cacheSession({status:'connecting',connected:false,browserOpen:manualOpen,browserMode:this.browserMode,checkedAt:new Date().toISOString(),message:'正在连接专用浏览器并读取官方登录状态。',guidance:manual?MANUAL_GUIDANCE:[]});
      try {await this.#launch();} catch(error) {
        if(error instanceof BrowserProfileInUseError)return this.#profileInUse();
        if(error.code==='PROFILE_PROBE_UNKNOWN')return this.#cacheSession({status:'unknown',connected:false,browserOpen:manualOpen,browserMode:this.browserMode,checkedAt:new Date().toISOString(),message:error.message,guidance:['本次没有创建浏览器或空白标签，请关闭专用窗口后重试连接。']});
        return this.#cacheSession({status:manualOpen?'manual_login':'unknown',connected:false,browserOpen:manualOpen,browserMode:this.browserMode,checkedAt:new Date().toISOString(),message:manualOpen?'普通专用窗口可能仍占用登录资料。请关闭该专用浏览器的所有窗口后再连接。':safeMessage(error),guidance:manualOpen?MANUAL_GUIDANCE:['请关闭占用本系统专用资料的窗口，然后重新连接。']});
      }
      this.browserMode=this.browserIntegration==='extension'?'extension':'controlled';
    }
    const observed=await this.observeSession();
    if(observed.status==='oauth_blocked')return observed;
    const pages=this.context.pages?.() || [];
    const oauth=pages.some(page=>{try{return new URL(page.url()).hostname==='accounts.google.com';}catch{return false;}});
    const pendingBooking=[...this.bookingPages.values()].some(page=>!page.isClosed());
    if(oauth || (pendingBooking && !this.sessionPage))return observed;
    this.newTabAuth=null;
    await this.#navigateSession(this.context);
    const fresh=await this.observeSession();
    if(fresh.status!=='authenticated')return fresh;
    const newTab=await this.#verifyNewTabSession();
    if(newTab && newTab.status!=='authenticated')return this.#cacheSession({...fresh,status:newTab.status,connected:false,message:newTab.status==='identity_mismatch'?sessionFailureMessage('identity_mismatch'):'账号页与新页面的会话核验未全部通过，暂不能自动订座。请在所选专用浏览器登录后重新核验。',guidance:MANUAL_GUIDANCE});
    return this.#cacheSession({...fresh,...(newTab?{newTabVerified:true,newTabCheckedAt:newTab.checkedAt,message:'当前账号及新页面均已通过官方会话核验，可以自动订座。'}:{})});
  }
  async resolveRestaurant(value) {
    const url=restaurantUrl(value);
    let context,page;
    let ownsContext=false;
    try {
      // Use the chosen account's ordinary Chrome connection when available.
      // Its existing network/proxy settings can differ from a new headless
      // browser. Lookup owns only this new page, never the shared context.
      const connectedExtension=this.browserIntegration==='extension' && this.extensionBridge?.state().connected;
      if(connectedExtension)context=await this.#launch();
      else if(this.publicContextFactory){context=await this.publicContextFactory();ownsContext=true;}
      else {
        const {chromium}=await import('playwright');
        const browser=await chromium.launch({channel:this.browserChannel,headless:true});
        try {context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Seoul'});} catch(error){await browser.close();throw error;}
        const close=context.close.bind(context);
        context.close=async()=>{try {await close();}finally {await browser.close();}};
        ownsContext=true;
      }
      page=await context.newPage();
      // The extension already restricts page navigation to Catchtable and
      // intentionally does not grant Fetch interception. Routing is only
      // installed on the disposable anonymous context.
      if(ownsContext && context.route)await context.route('**/*',async route=>{
        const request=route.request();
        if(request.isNavigationRequest() && request.frame()===page.mainFrame()) {
          let allowed=false;
          try {const target=new URL(request.url());allowed=target.protocol==='https:' && ['catchtable.net','www.catchtable.net'].includes(target.hostname) && !target.port && !target.username && !target.password;}catch{}
          if(!allowed)return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
      const status=response?.status?.();
      if(status>=400)throw new HttpError(502,status===404?'官网没有找到这家餐厅，请检查链接。':`官网餐厅页面暂时无法读取（${status}），请稍后重试。`);
      await page.locator('h1,h2').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
      const snapshot=await readRestaurantSnapshot(page);
      const verified=parseRestaurantSnapshot(snapshot,url);
      if(snapshot.informationLink) {
        let allowedInfo=false;
        try {const info=new URL(snapshot.informationLink);const target=new URL(verified.restaurantUrl);allowedInfo=info.protocol==='https:' && ['catchtable.net','www.catchtable.net'].includes(info.hostname) && !info.port && !info.username && !info.password && info.pathname.replace(/\/$/,'')===`${target.pathname.replace(/\/$/,'')}/info`;}catch{}
        if(allowedInfo) {
          try {
            await page.goto(snapshot.informationLink,{waitUntil:'domcontentloaded',timeout:20000});
            await page.locator('h3').first().waitFor({state:'visible',timeout:10000});
            snapshot.information=await readRestaurantInformationSnapshot(page);
          }catch {verified.bookingNotes.push('部分公开详细信息暂未读取，可在官方餐厅页面继续查看。');return verified;}
        }
      }
      return parseRestaurantSnapshot(snapshot,url);
    } catch(error) {
      if(error instanceof HttpError)throw error;
      throw new HttpError(502,`未能核验官方餐厅页面：${safeMessage(error)}。可保留链接并手动填写名称。`);
    } finally {
      if(ownsContext && context)await context.close().catch(()=>{});
      else if(page)await page.close().catch(()=>{});
    }
  }
  async #page(task, booking=false) {
    if (!this.context) return null;
    const pages = booking ? this.bookingPages : this.watchPages;
    let page = pages.get(task.id);
    if (!page || page.isClosed()) { page = await this.context.newPage(); pages.set(task.id,page); }
    this.#trackPageAuth(page);
    return page;
  }
  async #dismiss(page) {
    for (const name of ['关闭','Close','今日隐藏']) {
      const button = page.getByRole('button',{name,exact:true});
      if (await button.count() === 1 && await button.isVisible().catch(()=>false)) await button.click();
    }
  }
  async #dismissAppPromo(page) {
    const heading=page.getByRole('heading',{name:/^(?:在App中体验更佳|Better in the app|Better on the app)$/i});
    if(await heading.count()!==1 || !await heading.isVisible().catch(()=>false))return false;
    const card=heading.locator('xpath=../..');
    const later=card.getByRole('button',{name:/^(?:稍后|Later)$/i});
    if(await later.count()===1 && await later.isVisible().catch(()=>false) && await later.isEnabled()) {
      await this.#settledAction(page,()=>later.click());
      return true;
    }
    return false;
  }
  async #settledAction(page, action) {
    // Wait for requests created by this interaction, rather than all background
    // connections on the site (which can stay open indefinitely).
    const pending = new Set(); let changedAt = Date.now(); let failed = false;
    const requested = request => {
      let official=false;
      try {official=['api.catchtable.net','www.catchtable.net','catchtable.net'].includes(new URL(request.url()).hostname);}catch{}
      if (official && ['fetch','xhr'].includes(request.resourceType())) { pending.add(request); changedAt=Date.now(); }
    };
    const finished = request => { if (pending.delete(request)) changedAt=Date.now(); };
    const rejected = request => {
      if (pending.has(request) && /catchtable\./i.test(new URL(request.url()).hostname)) failed=true;
      finished(request);
    };
    page.on('request',requested); page.on('requestfinished',finished); page.on('requestfailed',rejected);
    try {
      await action();
      const started=Date.now();
      while (Date.now()-started<10000) {
        if (!pending.size && Date.now()-changedAt>=700 && Date.now()-started>=700) {
          if (failed) throw new Error('当前筛选的数据请求失败。');
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('当前筛选仍在加载，稍后重新检查。');
    } finally { page.off('request',requested); page.off('requestfinished',finished); page.off('requestfailed',rejected); }
  }
  async #calendar(page, task) {
    const url = `https://www.catchtable.net/zh-CN/shop/${shopId(task.restaurantUrl)}`;
    await page.bringToFront();
    const authReady=this.#expectPageAuth(page);
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    const auth=await authReady;
    if(!await this.#pageIdentityReady(page))throw new Error('AUTH_REQUIRED');
    if(auth && auth.status!=='authenticated') {
      this.#cacheSession({status:auth.status==='unauthenticated'?'unauthenticated':'unknown',connected:false,browserOpen:true,browserMode:'controlled',checkedAt:new Date().toISOString(),
        message:auth.status==='unauthenticated'?'当前餐厅页面的官方会话核验显示未登录。':'当前餐厅页面没有取得新的官方会话核验结果。',guidance:MANUAL_GUIDANCE});
      throw new Error('AUTH_REQUIRED');
    }
    const opener = page.getByRole('button',{name:/^日期.*时间.*人$|^Date.*Time.*(?:People|Guests|Party)/i});
    const reserveEntry=page.getByRole('button',{name:/^(?:预订|Reserve|Book now|예약하기)$/i});
    const entries=opener.or(reserveEntry).filter({visible:true});
    try { await entries.first().waitFor({state:'visible',timeout:15000}); } catch {
      await this.#dismiss(page);
      if (AUTH.test(await page.locator('body').innerText())) throw new Error('AUTH_REQUIRED');
      await entries.first().waitFor({state:'visible',timeout:5000});
    }
    const inline=opener.filter({visible:true});
    const entry=await inline.count() ? inline : reserveEntry.filter({visible:true});
    if(shopId(page.url())!==shopId(task.restaurantUrl) || await entry.count()!==1)throw new Error('无法唯一确认当前餐厅的选座入口。');
    await this.#settledAction(page,()=>entry.click());
    const dialog = page.getByRole('dialog').last();
    await dialog.waitFor({state:'visible'});
    const partyButton = dialog.locator('button.rounded-full').filter({hasText:new RegExp(`^${task.partySize}$`)});
    if (await partyButton.count() !== 1) throw new Error('无法唯一定位用餐人数控件。');
    await this.#settledAction(page,()=>partyButton.click());
    return dialog;
  }
  async #readCalendarCells(dialog) {
    return dialog.locator('[role="button"][aria-label], [role="checkbox"][aria-label]').evaluateAll(elements=>{
        const visible=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.visibility!=='collapse' && !element.closest('[aria-hidden="true"]');};
        const root=elements[0]?.closest('[role="dialog"]');
        const loading=Boolean(root && [...root.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible));
        const selectedParties=root ? [...root.querySelectorAll('button.rounded-full')].filter(button=>{
          const css=getComputedStyle(button);
          return visible(button) && (button.getAttribute('aria-pressed')==='true' || (css.color==='rgb(255, 255, 255)' && css.backgroundColor!=='rgba(0, 0, 0, 0)' && css.backgroundColor!=='rgb(255, 255, 255)'));
        }) : [];
        const selectedPartySize=selectedParties.length===1 ? Number(selectedParties[0].textContent.trim()) : null;
        return {loading,selectedPartySize,cells:elements.map((element,index)=>{
          const rect=element.getBoundingClientRect(),shown=visible(element);
          const hit=shown?document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2):null;
          return {index,label:element.getAttribute('aria-label') || '',visible:shown,exposed:Boolean(hit && (hit===element || element.contains(hit))),
            disabled:Boolean(element.matches(':disabled') || element.disabled || element.closest('[aria-disabled="true"]'))};
        })};
    });
  }
  async #selectDate(page, dialog, date, initialCalendar=null, partySize=null) {
    for (let step=0;step<13;step++) {
      const cells = dialog.locator('[role="button"][aria-label], [role="checkbox"][aria-label]');
      const calendar=initialCalendar || await this.#readCalendarCells(dialog);
      initialCalendar=null;
      if(calendar.loading)throw new Error('日历筛选仍在加载，稍后重新检查。');
      if(partySize!==null && calendar.selectedPartySize!==partySize)throw new Error('当前用餐人数尚未核验，稍后重新检查。');
      // Mobiscroll also renders clipped adjacent slides. One batched DOM read
      // identifies the unique date actually exposed to pointer input.
      const matching=calendar.cells.filter(cell=>cell.visible && cell.exposed && calendarLabelToDate(cell.label)===date);
      if(matching.length>1)throw new Error('目标日期出现多个可点击日历控件，尚未继续选择。');
      if(matching.length===1) {
        if(matching[0].disabled)return false;
        await this.#settledAction(page,()=>cells.nth(matching[0].index).click());
        return true;
      }
      const header = await dialog.getByRole('button',{name:/^\d{4}年/}).innerText().catch(()=> '');
      const match = header.match(/(\d{4})年\s*([一二三四五六七八九十]+)月/);
      if (!match) throw new Error('无法读取当前日历月份。');
      const current = `${match[1]}-${String(CHINESE_MONTHS.indexOf(match[2])+1).padStart(2,'0')}`;
      if (current === date.slice(0,7)) throw new Error('目标日期没有可核验的日历控件，稍后重新读取。');
      const button = dialog.getByRole('button',{name:date.slice(0,7) < current ? 'Previous page' : 'Next page',exact:true});
      if (!await button.isEnabled()) return false;
      await this.#settledAction(page,()=>button.click());
    }
    throw new Error('目标日期超出可验证的日历范围。');
  }
  async #snapshot(page, dialog) {
    return dialog.evaluate((el,restaurantUrl) => {
      const selected = el.querySelector('[aria-pressed="true"][aria-label], [aria-checked="true"][aria-label]');
      const parties = [...el.querySelectorAll('button.rounded-full')];
      const selectedParty = parties.filter(b => {
        const css = getComputedStyle(b); return b.getAttribute('aria-pressed')==='true' || (css.color==='rgb(255, 255, 255)' && css.backgroundColor!=='rgba(0, 0, 0, 0)' && css.backgroundColor!=='rgb(255, 255, 255)');
      });
      return {restaurantUrl,selectedDateLabel:selected?.getAttribute('aria-label') || '',selectedPartySize:selectedParty.length === 1 ? Number(selectedParty[0].textContent.trim()) : null,
        text:el.innerText,loading:Boolean(el.querySelector('[aria-busy="true"], [role="progressbar"]')),
        buttons:[...el.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0).map(b=>({text:b.innerText.trim(),disabled:b.disabled || b.getAttribute('aria-disabled')==='true'}))};
    },page.url());
  }
  async inspect(task,{firstMatch=task.mode==='auto' && task.autoConsent===true}={}) {
    this.inspections.delete(task.id);
    if (!shopId(task.restaurantUrl)) return {status:'unknown',slots:[],message:'餐厅地址无效。'};
    const page = await this.#page(task);
    if (!page) return {status:'auth_required',slots:[],message:'请先连接专用浏览器。'};
    try {
      const dialog = await this.#calendar(page,task);
      let initialCalendar=await this.#readCalendarCells(dialog);
      if(initialCalendar.loading)throw new Error('日历筛选仍在加载，稍后重新检查。');
      if(initialCalendar.selectedPartySize!==task.partySize)throw new Error('当前用餐人数尚未核验，稍后重新检查。');
      const calendarDates=new Map();
      for(const cell of initialCalendar.cells) {
        if(!cell.visible || !cell.exposed)continue;
        const date=calendarLabelToDate(cell.label);
        if(date)calendarDates.set(date,[...(calendarDates.get(date) || []),cell]);
      }
      const disabledDates=new Set(task.dates.filter(date=>calendarDates.get(date)?.length===1 && calendarDates.get(date)[0].disabled));
      const slots = []; const observedDates=task.dates.filter(date=>disabledDates.has(date)); let unknownCount=0;
      for (const date of task.dates) {
        if(disabledDates.has(date))continue;
        const calendar=initialCalendar;initialCalendar=null;
        if (!await this.#selectDate(page,dialog,date,calendar,task.partySize)) { observedDates.push(date); continue; }
        const result = parseAvailability(await this.#snapshot(page,dialog),{...task,dates:[date]});
        if (result.status==='auth_required') return result;
        if (result.status==='unknown') unknownCount++; else observedDates.push(date);
        slots.push(...result.slots);
        if(firstMatch===true && result.status==='available' && result.slots.length) {
          const inspectionId=randomUUID();
          this.inspections.set(task.id,{inspectionId,page,dialog,checkedAt:Date.now(),conditions:this.#inspectionConditions(task)});
          return {status:'available',slots:result.slots,inspectionId,observedDates,complete:unknownCount===0 && observedDates.length===task.dates.length,
            message:`已发现 ${date} 的 ${result.slots.length} 个匹配时间，立即进入预约；其余日期留待后续检查。`};
        }
      }
      const restaurantName = await page.getByRole('heading',{level:2}).first().innerText().catch(()=>task.restaurantName);
      if (slots.length) return {status:'available',slots,observedDates,complete:unknownCount===0,restaurantName,message:`发现 ${slots.length} 个匹配时间。${unknownCount ? '部分日期暂未核验。' : ''}`};
      return {status:unknownCount ? 'unknown' : 'unavailable',slots:[],observedDates,complete:unknownCount===0,restaurantName,message:unknownCount?'部分日期无法判断，稍后检查。':'当前没有匹配空位。'};
    } catch(error) {
      const diagnostics=await page.evaluate(()=>{
        const visible=element=>{const rect=element.getBoundingClientRect();return rect.width>0 && rect.height>0 && getComputedStyle(element).visibility!=='hidden';};
        return {route:location.pathname.slice(0,200),title:document.title.slice(0,160),readyState:document.readyState,
          headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0,10).map(element=>element.innerText.trim().slice(0,160)),
          buttons:[...document.querySelectorAll('button,a,[role="button"]')].filter(visible).slice(0,40).map(element=>({label:(element.innerText || element.getAttribute('aria-label') || '').trim().slice(0,120),disabled:Boolean(element.matches(':disabled') || element.closest('[aria-disabled="true"]'))}))};
      }).catch(()=>null);
      if(diagnostics)diagnostics.blockedBy=String(error.message || '').split('\n').filter(line=>/not enabled|intercepts pointer events|not stable|not visible/.test(line)).map(line=>line.replace(/\u001b\[[0-9;]*m/g,'').trim()).slice(0,3);
      return {status:error.message==='AUTH_REQUIRED'?'auth_required':'unknown',slots:[],diagnostics,message:error.message==='AUTH_REQUIRED'?'登录已失效，请重新连接。':`检查未完成：${error.message.split('\n')[0]}`};
    }
  }
  #inspectionConditions(task) {
    return JSON.stringify([shopId(task.restaurantUrl),task.restaurantName,task.dates,task.partySize,task.timeStart,task.timeEnd]);
  }
  async #reuseInspection(task,slot,inspectionId) {
    const inspected=this.inspections.get(task.id);
    this.inspections.delete(task.id);
    if(!inspected || inspected.inspectionId!==inspectionId || Date.now()-inspected.checkedAt>5000 || inspected.conditions!==this.#inspectionConditions(task)
      || inspected.page.isClosed() || this.watchPages.get(task.id)!==inspected.page || !this.context?.pages?.().includes(inspected.page))return null;
    try {
      if(!await this.#pageIdentityReady(inspected.page))return null;
      const auth=this.#trackPageAuth(inspected.page);
      if(auth && auth.status!=='authenticated')return null;
      if(!await inspected.dialog.isVisible())return null;
      const availability=parseAvailability(await this.#snapshot(inspected.page,inspected.dialog),{...task,dates:[slot.date]});
      const current=availability.slots.find(value=>value.date===slot.date && value.time===slot.time && value.partySize===slot.partySize);
      if(!current)return null;
      this.watchPages.delete(task.id);
      this.bookingPages.set(task.id,inspected.page);
      return {page:inspected.page,dialog:inspected.dialog,current};
    }catch {return null;}
  }
  async #receipt(page, task, slot, snapshot) {
    if(!await this.#pageIdentityReady(page))return null;
    if(typeof page.evaluate==='function') {
      return parseOfficialBookingRecord(snapshot || await page.evaluate(readBookingFlowDom),task,slot);
    }
    const cards = await page.locator('article, section, [data-reservation-id], [data-testid*="reservation"]').all();
    for (const card of cards) {
      if (!await card.isVisible()) continue;
      const text = await card.innerText();
      // Do not merge several bookings into one purported receipt.
      if ((text.match(/Reservation\s*(?:number|no\.?|ID)|Booking\s*(?:number|no\.?|ID)|预订号|预约号|예약\s*번호/gi)||[]).length!==1) continue;
      const evidence = evidenceFromText(text,task,slot);
      if (reservationMatches(evidence,task,slot)) return {status:'confirmed',reservationId:evidence.reservationId,slot,message:'已核对预约号、餐厅、日期、时间和人数。'};
    }
    return null;
  }
  #observeOrders(page, task, slot, expectedId) {
    const captured={records:[],complete:false,detail:null,shops:[],pending:new Set(),responseStatus:null,responseKeys:[],networkError:null};
    const observed=response=>{
      let url;
      try {url=new URL(response.url());}catch{return;}
      if(url.protocol!=='https:' || url.hostname!=='api.catchtable.net' || url.port || !['/api/v6/my-dining/scheduled','/api/v5/reservation/detail','/api/v5/shop/detail'].includes(url.pathname))return;
      if(['/api/v6/my-dining/scheduled','/api/v5/reservation/detail'].includes(url.pathname))captured.responseStatus=response.status();
      if(response.status()!==200)return;
      const work=(async()=>{
        const json=await response.json();
        if(url.pathname==='/api/v6/my-dining/scheduled' && json && typeof json==='object')captured.responseKeys=Object.keys(json).slice(0,12);
        const shop=parseShopResponse(url.href,json);
        if(shop)captured.shops.push(shop);
        if(url.pathname==='/api/v5/reservation/detail')captured.detail={url:url.href,json};
        const scheduled=parseScheduledResponse(url.href,json,task,slot,expectedId);
        if(scheduled){captured.records.push(...scheduled.records);captured.complete=scheduled.complete;}
        const direct=parseReservationResponse(url.href,json,task,slot,expectedId);
        if(direct)captured.records.push(direct);
      })().catch(()=>{});
      captured.pending.add(work);void work.finally(()=>captured.pending.delete(work));
    };
    page.on('response',observed);
    const failed=request=>{
      try {const url=new URL(request.url());if(url.origin==='https://api.catchtable.net' && ['/api/v6/my-dining/scheduled','/api/v5/reservation/detail'].includes(url.pathname))captured.networkError=String(request.failure()?.errorText || '读取失败').slice(0,120);}catch{}
    };
    page.on('requestfailed',failed);
    return {read:async()=>{
      await Promise.allSettled([...captured.pending]);
      if(!await this.#pageIdentityReady(page))return {record:null,complete:false,responseStatus:captured.responseStatus,responseKeys:captured.responseKeys,networkError:'当前订单页尚未通过此账号的官方身份核验。'};
      if(captured.detail)for(const shopEvidence of captured.shops){
        const parsed=parseReservationResponse(captured.detail.url,captured.detail.json,task,slot,expectedId,shopEvidence);
        if(parsed)captured.records.push(parsed);
      }
      return {record:captured.records.filter(item=>!expectedId || item.reservationId===expectedId).at(-1),complete:captured.complete,responseStatus:captured.responseStatus,responseKeys:captured.responseKeys,networkError:captured.networkError};
    },close:()=>{page.off('response',observed);page.off('requestfailed',failed);}};
  }
  async #officialOrders(task,slot,expectedId) {
    const checkPage=await this.context.newPage();
    const observation=this.#observeOrders(checkPage,task,slot,expectedId);
    try {
      const identityReady=this.identityVerifier?this.#expectPageAuth(checkPage):Promise.resolve(null);
      const url=expectedId?`https://www.catchtable.net/zh-CN/customer/reservation/detail/${encodeURIComponent(expectedId)}`:'https://www.catchtable.net/zh-CN/my-dining/scheduled';
      const responseReady=checkPage.waitForResponse(response=>{
        try {const target=new URL(response.url());return target.origin==='https://api.catchtable.net' && target.pathname===(expectedId?'/api/v5/reservation/detail':'/api/v6/my-dining/scheduled');}catch{return false;}
      },{timeout:20000}).catch(()=>null);
      const shopReady=expectedId?checkPage.waitForResponse(response=>{
        try {const target=new URL(response.url());return target.origin==='https://api.catchtable.net' && target.pathname==='/api/v5/shop/detail' && response.status()===200;}catch{return false;}
      },{timeout:20000}).catch(()=>null):Promise.resolve(null);
      await checkPage.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
      await identityReady;
      if(!await this.#pageIdentityReady(checkPage))return {record:null,complete:false,networkError:'当前订单页尚未通过此账号的官方身份核验。'};
      const primaryResponse=await responseReady;
      if(primaryResponse && primaryResponse.status()!==200)return {record:null,complete:false,responseStatus:primaryResponse.status()};
      if(primaryResponse)await primaryResponse.finished().catch(()=>{});
      const initial=await observation.read();
      const receipt=initial.record || await this.#receipt(checkPage,task,slot);
      if(receipt && (!expectedId || receipt.reservationId===expectedId))return {...initial,record:receipt};
      if(!expectedId)return {...initial,record:null};
      const shopResponse=await shopReady;
      if(shopResponse)await shopResponse.finished().catch(()=>{});
      const captured=await observation.read();
      return {record:captured.record || await this.#receipt(checkPage,task,slot),complete:captured.complete,responseStatus:captured.responseStatus,responseKeys:captured.responseKeys,networkError:captured.networkError};
    } finally {observation.close();await checkPage.close();}
  }
  async #fillBookingContact(page,contact) {
    return fillReservationPhone(page,contact,{onStep:step=>{this.contactSelectionStep=step;}});
  }
  async #completeFreeFlow(page,task,slot,{onBeforeSubmit,calendarVerified=false,observation,bookingContact}={}) {
    let submitted=false;
    let shopSlotOpened=false;
    let diagnostics={};
    const blocked=(message,phase='before_submit')=>({status:'user_action_required',phase,submitted:false,message,diagnostics});
    try {
      for(let step=0;step<7;step++) {
        if(!await this.#pageIdentityReady(page))return blocked(this.identityRejected?sessionFailureMessage('identity_mismatch'):'当前订座页面尚未通过此账号的官方身份核验，未继续预约。','authentication');
        const captured=observation?await observation.read():{};
        if(captured.record)return captured.record;
        const snapshot=await page.evaluate(readBookingFlowDom);
        const existing=await this.#receipt(page,task,slot,snapshot);
        if(existing)return existing;
        if(await this.#dismissAppPromo(page))continue;
        diagnostics={route:new URL(snapshot.url).pathname,buttons:snapshot.buttons.map(button=>button.text).filter(Boolean).slice(-25),headings:snapshot.headings.slice(-10),dialogs:snapshot.dialogs.map(dialog=>dialog.text.slice(0,160)),summaries:snapshot.summaries,loading:snapshot.loading,calendarVerified};
        if(snapshot.captcha)return blocked('官方页面要求验证码验证。完成验证后，系统会继续核验原预约。','captcha');
        if(AUTH.test(snapshot.text))return blocked('预约页面要求重新登录，登录后可继续原任务。','authentication');
        if(calendarVerified && !shopSlotOpened && shopId(snapshot.url)===shopId(task.restaurantUrl) && !snapshot.dialogs.length) {
          const available=snapshot.buttons.filter(button=>!button.disabled && normalizeTime(button.text)===slot.time);
          if(available.length!==1)return blocked('餐厅页面上的匹配时间已变化，保留原尝试等待核验。');
          const label=available[0].text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
          const selected=page.locator('button:visible').filter({hasText:new RegExp(`^\\s*${label}\\s*$`)});
          if(await selected.count()!==1 || !await selected.isEnabled())return blocked('不能唯一核对餐厅页面上的预约时间，未继续提交。');
          await selected.evaluate(element=>element.scrollIntoView({block:'center',inline:'center',behavior:'instant'}));
          diagnostics.pointerTarget=await selected.evaluate(element=>{
            const rect=element.getBoundingClientRect(),top=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
            return top && !element.contains(top)?`${top.tagName} ${top.getAttribute('role') || ''} ${top.getAttribute('aria-label') || ''} ${(top.innerText || '').slice(0,160)}`:'matching_slot';
          });
          shopSlotOpened=true;
          try {await this.#settledAction(page,()=>selected.click());}
          catch(error) {
            // A delayed pre-option sheet can open while Playwright is still
            // waiting on the underlying slot. Use the visible next step once;
            // never retry the covered button or force through its backdrop.
            const advanced=await page.evaluate(readBookingFlowDom);
            if(knownSameDayNotice(advanced,task,slot,calendarVerified)
              || knownConfirmationNotice(advanced) || formConditionsVerified(advanced,task,slot,calendarVerified))continue;
            if(await this.#dismissAppPromo(page))continue;
            throw error;
          }
          continue;
        }
        if(knownSameDayNotice(snapshot,task,slot,calendarVerified)) {
          const next=page.getByRole('button',{name:/^(?:下一步|Next)$/i});
          if(await next.count()!==1 || !await next.isEnabled())return blocked('当天预约提醒的下一步按钮不能唯一核对，尚未提交。');
          await this.#settledAction(page,()=>next.click());
          continue;
        }
        if(knownConfirmationNotice(snapshot) && calendarVerified) {
          if(snapshot.uncheckedAgreements?.length)return blocked('预约提示出现需要接受的协议，需核对具体条款后确认。','agreement');
          if(snapshot.missingRequiredFields?.length)return blocked('预约提示缺少必填资料，请补齐后继续原预约。','required_fields');
          if(classifyCheckout(snapshot,{conditionsVerified:false}).blocker==='holding_expired')return blocked('官方预约保留时间已过期，先核验原预约结果。','holding_expired');
          const request=page.getByRole('button',{name:/^(请求|Request)$/i});
          if(await request.count()!==1)return blocked('预约提示中的请求按钮不唯一，保留原尝试等待核验。');
          await this.#settledAction(page,()=>request.click());
          continue;
        }
        const route=officialReservationRoute(snapshot.url);
        if(route?.kind!=='form')return blocked('当前官方步骤尚未识别。已保留原预约条件，后续只读核验，不会创建第二笔订单。');
        const matched=formConditionsVerified(snapshot,task,slot,calendarVerified);
        const requirements=classifyCheckout(snapshot,{conditionsVerified:matched});
        diagnostics.conditionsVerified=requirements.conditionsVerified;
        diagnostics.freeExplicitlyVerified=requirements.freeExplicitlyVerified;
        diagnostics.requiresPayment=requirements.requiresPayment;
        diagnostics.requiresConsent=requirements.requiresConsent;
        diagnostics.requiresCaptcha=requirements.requiresCaptcha;
        diagnostics.checkoutName=requirements.checkoutName;
        diagnostics.checkoutBlocker=requirements.blocker;
        diagnostics.missingRequiredFields=snapshot.missingRequiredFields;
        if(bookingContact?.fullName && task.mode==='auto' && task.autoConsent===true && matched && !snapshot.loading
          && !requirements.requiresPayment && !requirements.requiresConsent && !requirements.requiresCaptcha) {
          const name=await fillReservationName(page,snapshot,bookingContact.fullName);
          if(name==='blocked')return blocked('预约姓名字段不唯一、只读或不能准确填写；请在官网当前预约表单核对，系统不会修改个人资料。','required_fields');
          if(name==='filled')continue;
        }
        if(bookingContact && task.mode==='auto' && task.autoConsent===true
          && matched && !snapshot.loading && !requirements.requiresPayment && !requirements.requiresConsent && !requirements.requiresCaptcha
          && [null,'required_fields'].includes(requirements.blocker) && snapshot.missingRequiredFields.every(field=>field==='电话号码')
          && snapshot.buttons.filter(button=>CHECKOUT_NAME.test(button.text)).length===1) {
          const phone=await this.#fillBookingContact(page,bookingContact);
          if(phone==='blocked') {
            diagnostics.contactSelectionStep=this.contactSelectionStep;
            return blocked('预约电话字段不唯一、只读或不能准确填写；请在官网当前表单核对，号码尚未提交。','required_fields');
          }
          if(phone==='filled')continue;
        }
        if(!automaticSubmissionAllowed(task,requirements)) {
          const messages={payment:'此预约需要支付费用，当前任务仅授权免费预约。',agreement:'官方表单出现需要接受的协议，需核对具体条款后确认。',required_fields:'官方表单缺少必填资料，请补齐后继续原预约。',holding_expired:'官方预约保留时间已过期，请先核验预约结果。',captcha:'官方表单要求验证码验证。'};
          return blocked(messages[requirements.blocker] || '尚未完整核对餐厅、日期、时间、人数和免费结账按钮，保留原尝试等待核验。',requirements.blocker || 'before_submit');
        }
        const checkout=page.getByRole('button',{name:requirements.checkoutName,exact:true});
        if(await checkout.count()!==1 || !await checkout.isEnabled())return blocked('免费预约结账按钮尚未启用，官方表单仍有必填资料或保留时间已失效。');
        const auth=this.#trackPageAuth(page);
        if(!await this.#pageIdentityReady(page) || (auth && auth.status!=='authenticated')) {
          if(!this.identityRejected)this.#cacheSession({status:auth?.status==='unauthenticated'?'unauthenticated':'unknown',connected:false,browserOpen:true,browserMode:'controlled',checkedAt:new Date().toISOString(),message:'当前订座表单尚未通过新的官方会话核验。',guidance:MANUAL_GUIDANCE});
          return blocked('当前订座表单没有有效登录会话，未提交预约。','authentication');
        }
        if(typeof onBeforeSubmit!=='function')return blocked('提交前持久登记不可用，未提交预约。');
        // Persist the write boundary before clicking. Beyond this point a
        // timeout/crash only permits read-only verification of this attempt.
        await onBeforeSubmit();submitted=true;
        await this.#settledAction(page,()=>checkout.click());
        const after=observation?await observation.read():{};
        if(after.record)return after.record;
        const verified=await this.#officialOrders(task,slot);
        return verified.record || {status:'outcome_unknown',phase:'submitted',submitted:true,message:'免费预约已提交，正在自动核验官方记录；结果确认前不会重复提交。'};
      }
      return blocked('官方预约流程仍未完成，保留原尝试等待核验。');
    }catch(error){
      try {
        const current=await page.evaluate(readBookingFlowDom);
        diagnostics.route=new URL(current.url).pathname;
        diagnostics.headings=current.headings.slice(-10);
        diagnostics.dialogs=current.dialogs.map(dialog=>dialog.text.slice(0,300));
        diagnostics.buttons=current.buttons.map(button=>button.text).filter(Boolean).slice(-25);
        diagnostics.summaries=current.summaries;
      }catch{}
      diagnostics.error=safeMessage(error.message?.split('\n')[0] || error);
      diagnostics.blockedBy=String(error.message || '').split('\n').filter(line=>/intercepts pointer events|subtree intercepts|not stable|not enabled/.test(line)).map(line=>line.replace(/\u001b\[[0-9;]*m/g,'').trim()).slice(0,3);
      return {status:submitted?'outcome_unknown':'user_action_required',phase:submitted?'submitted':error.code==='AUTH_REQUIRED'?'authentication':'before_submit',submitted,diagnostics,
        message:submitted?'已执行提交，系统正在自动核验官方记录；结果明确前不会重复提交。':diagnostics.blockedBy.length?'官网浮层或控件状态阻碍了预约操作，尚未提交。':'官网未完成当前预约操作，尚未提交；已保留原条件继续核验。'};
    }
  }
  async prepare(task, slot, options={}) {
    if(this.identityRejected)return {status:'user_action_required',phase:'authentication',submitted:false,message:sessionFailureMessage('identity_mismatch')};
    const inspected=typeof options.inspectionId==='string'?await this.#reuseInspection(task,slot,options.inspectionId):null;
    const page = inspected?.page || await this.#page(task,true);
    if (!page) return {status:'user_action_required',phase:'authentication',submitted:false,message:'请先在专用浏览器登录。'};
    const observation=this.#observeOrders(page,task,slot);
    try {
      const dialog = inspected?.dialog || await this.#calendar(page,task);
      if (!inspected && !await this.#selectDate(page,dialog,slot.date,null,task.partySize)) return {status:'rejected',message:'日期已不可预约。'};
      const availability = inspected?{status:'available',slots:[inspected.current]}:parseAvailability(await this.#snapshot(page,dialog),task);
      const current = inspected?.current || availability.slots.find(s=>s.date===slot.date && s.time===slot.time && s.partySize===slot.partySize);
      if (!current) return {status:availability.status==='unknown'?'user_action_required':'rejected',phase:'before_submit',submitted:false,message:'重新核验时空位已变化，请检查。'};
      this.bookingFlows.set(task.id,{page,slot:{...slot},calendarVerified:true});
      await this.#settledAction(page,()=>dialog.getByRole('button',{name:current.label,exact:true}).click());
      const later = page.getByRole('button',{name:/^(稍后|Later|Not now)$/i});
      if (await later.isVisible().catch(()=>false)) await later.click();
      await page.bringToFront();
      return await this.#completeFreeFlow(page,task,slot,{...options,calendarVerified:true,observation});
    } catch(error) { return {status:'user_action_required',phase:error.message==='AUTH_REQUIRED'?'authentication':'before_submit',submitted:false,
      message:error.message==='AUTH_REQUIRED'?this.lastSession.message:`原预约尚未提交：${safeMessage(error)}`}; }
    finally {observation.close();}
  }
  async continueAttempt(attempt,options={}) {
    const task=attempt.task || attempt.taskSnapshot || attempt;
    if(!this.context || !attempt.slot)return {status:'user_action_required',phase:attempt.phase,submitted:attempt.submitted===true,message:'请连接已登录的专用浏览器，系统会继续处理原预约。'};
    const legacy=attempt.legacyBeforeSubmit===true || (attempt.status==='user_action_required' && !attempt.phase && attempt.message==='已打开匹配时间。请在浏览器核对套餐、条款及支付要求后完成预订。');
    if(attempt.submitted===true || attempt.reservationId || (attempt.status==='outcome_unknown' && !legacy) || (!legacy && !['before_submit','required_fields','authentication'].includes(attempt.phase)))return this.reconcile(attempt);
    const proof=this.#resumeChecks.get(task.id);
    this.#resumeChecks.delete(task.id);
    const proofAge=proof?Date.now()-proof.checkedAt:Infinity;
    const sameCheck=proof && !this.identityRejected && proof.context===this.context && proof.attemptId===attempt.id
      && proofAge>=0 && proofAge<=5000 && proof.conditions===this.#inspectionConditions(task)
      && proof.slot===JSON.stringify([attempt.slot.date,attempt.slot.time,attempt.slot.partySize,attempt.slot.seatType || '']);
    const verified=sameCheck?{complete:true}:await this.#officialOrders(task,attempt.slot);
    if(verified.record)return verified.record;
    if(!verified.complete)return {status:'outcome_unknown',phase:attempt.phase,submitted:false,diagnostics:{orderResponseStatus:verified.responseStatus,responseKeys:verified.responseKeys,networkError:verified.networkError},message:verified.responseStatus===401?'官方预约记录要求重新登录，原预约尚未提交。':verified.responseStatus===429?'官网暂时限制访问频率，系统会退避后自动核验原预约。':'官方预约记录尚未完整读取，暂不能排除已提交订单；正在自动只读核验。'};
    const flow=this.bookingFlows.get(task.id);
    if(flow?.calendarVerified===true && !flow.page.isClosed() && flow.page===this.bookingPages.get(task.id)
      && flow.slot.date===attempt.slot.date && flow.slot.time===attempt.slot.time && flow.slot.partySize===attempt.slot.partySize) {
      const snapshot=await flow.page.evaluate(readBookingFlowDom);
      if(formConditionsVerified(snapshot,task,attempt.slot,true)) {
        const observation=this.#observeOrders(flow.page,task,attempt.slot);
        try {return await this.#completeFreeFlow(flow.page,task,attempt.slot,{...options,calendarVerified:true,observation});}
        finally {observation.close();}
      }
    }
    return this.prepare(task,attempt.slot,options);
  }
  async reconcile(attempt) {
    const task = attempt.task || attempt.taskSnapshot || attempt;
    const slot = attempt.slot;
    this.#resumeChecks.delete(task.id);
    if (!this.context || !slot) return {status:'outcome_unknown',message:'请打开专用浏览器并提供原预订条件后核验。'};
    try {
      const page = this.bookingPages.get(task.id);
      if (!attempt.reservationId && page && !page.isClosed()) { const receipt = await this.#receipt(page,task,slot); if (receipt?.status==='confirmed') return receipt; }
      if(typeof this.context.on!=='function' && !page?.evaluate) {
        const checkPage=await this.context.newPage();
        try {await checkPage.goto('https://www.catchtable.net/zh-CN/my-dining/scheduled',{waitUntil:'domcontentloaded',timeout:30000});const receipt=await this.#receipt(checkPage,task,slot);if(receipt)return receipt;}
        finally{await checkPage.close();}
      }else {
        const verified=await this.#officialOrders(task,slot,attempt.reservationId || undefined);
        if(verified.record)return verified.record;
        const knownBefore=['before_submit','required_fields','agreement','captcha','holding_expired','authentication'].includes(attempt.phase)
          && attempt.submitted===false && !attempt.reservationId && ['user_action_required','outcome_unknown'].includes(attempt.status);
        if(verified.complete && (knownBefore || (attempt.status==='user_action_required' && !attempt.phase && attempt.submitted!==true))) {
          if(typeof attempt.id==='string' && knownBefore && ['before_submit','authentication'].includes(attempt.phase) && !this.identityRejected) {
            this.#resumeChecks.set(task.id,{attemptId:attempt.id,context:this.context,checkedAt:Date.now(),conditions:this.#inspectionConditions(task),
              slot:JSON.stringify([slot.date,slot.time,slot.partySize,slot.seatType || ''])});
          }
          return {
          status:'user_action_required',phase:attempt.phase,submitted:false,
          message:attempt.status==='outcome_unknown'?'官方已完整核对没有同条件订单，原预约明确尚未提交，可继续处理原表单。':attempt.message,
          resumeAllowed:['before_submit','authentication'].includes(attempt.phase) && attempt.submitted===false && !attempt.reservationId};
        }
        return {status:'outcome_unknown',phase:attempt.phase,submitted:attempt.submitted===true,diagnostics:{orderResponseStatus:verified.responseStatus,responseKeys:verified.responseKeys,networkError:verified.networkError},
          message:verified.responseStatus===401?'官方预约记录要求重新登录，系统正在等待账号恢复。':verified.responseStatus===429?'官网暂时限制访问频率，系统会退避后自动核验。':'官方预约记录尚未完整读取，系统会继续只读核验原尝试。'};
      }
      return {status:'outcome_unknown',message:'尚未核验到完整匹配的预约记录。请在 My Dining 查看；系统不会自动再次提交。'};
    } catch(error) { return {status:'outcome_unknown',message:`结果仍待核验：${error.message.split('\n')[0]}`}; }
  }
  async releaseTask(taskId) {
    const pages=new Set([this.watchPages.get(taskId),this.bookingPages.get(taskId),this.bookingFlows.get(taskId)?.page]);
    this.watchPages.delete(taskId);this.bookingPages.delete(taskId);this.bookingFlows.delete(taskId);this.inspections.delete(taskId);
    this.#resumeChecks.delete(taskId);
    await Promise.allSettled([...pages].filter(page=>page && page!==this.sessionPage && !page.isClosed?.()).map(page=>page.close()));
  }
  async close() { this.#resumeChecks.clear(); if (this.context) await this.context.close(); }
}
