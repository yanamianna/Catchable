import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { Account, Mode, NewTask, RestaurantInfo } from '../types';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { IntervalInput, intervalValidation } from './IntervalInput';
import { RestaurantPreview } from './RestaurantPreview';
import { accountAuthenticated } from './Accounts';
import { HALF_HOUR_TIMES, halfHourRange } from '../time-slots';

const modeOptions = [
  { value: 'notify', label: '空位提醒', detail: '发现空位后通知你' },
  { value: 'assist', label: '辅助预订', detail: '核对条件后交给你确认' },
  { value: 'auto', label: '免费自动预订', detail: '在授权条件内尝试预订' },
] as const;
const modeDescriptions: Record<Mode, string> = {
  notify: '只监控符合条件的空位并提醒你；你从官方入口自行预订。',
  assist: '发现空位后核对用餐条件，准备官方预订流程，由你继续确认。',
  auto: '在授权条件内自动核对并完成已识别的免费确认步骤，再核验官方订单。支付、验证码、新绑定条款或未知表单仍由你处理。',
};
function buildDates(start: string, end: string) {
  const first = new Date(`${start}T00:00:00Z`).getTime();
  const last = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) throw new Error('结束日期不能早于开始日期。');
  const days = Math.round((last - first) / 86400000) + 1;
  if (days > 14) throw new Error('一次最多监控 14 个用餐日期，请缩小日期范围。');
  return Array.from({ length: days }, (_, index) => new Date(first + index * 86400000).toISOString().slice(0, 10));
}
function nextWeek(date: string) { return new Date(new Date(`${date}T00:00:00Z`).getTime() + 7 * 86400000).toISOString().slice(0, 10); }
function validateRestaurantUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error('请粘贴 Catchtable 国际站的具体餐厅链接。'); }
  const shopPath = parsed.pathname.match(/^(\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?)(?:explore\/)?shop\/([A-Za-z0-9_-]+)\/?$/);
  if (parsed.protocol !== 'https:' || !['www.catchtable.net', 'catchtable.net'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !shopPath) throw new Error('请使用 Catchtable 官方餐厅链接，可带语言路径，不带查询参数。');
  parsed.pathname = `${shopPath[1]}shop/${shopPath[2]}`;
  return parsed.href.replace(/\/$/, '');
}

export function NewTaskModal({ onClose, onCreate, interval, currentDate, accounts, accountId = 'all' }: { onClose: () => void; onCreate: (task: NewTask) => Promise<void>; interval: number; currentDate: string; accounts: Account[]; accountId?: string }) {
  const [selectedAccountId, setSelectedAccountId] = useState(accountId === 'all' ? '' : accountId);
  const selectedAccount = accounts.find(account => account.id === selectedAccountId);
  const [mode, setMode] = useState<Mode>('notify');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [restaurant, setRestaurant] = useState<RestaurantInfo | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [manualName, setManualName] = useState(false);
  const [start, setStart] = useState(() => nextWeek(currentDate));
  const [end, setEnd] = useState(() => nextWeek(currentDate));
  const [party, setParty] = useState(2);
  const [from, setFrom] = useState('18:00');
  const [to, setTo] = useState('20:00');
  const [timeSlots, setTimeSlots] = useState(() => halfHourRange('18:00', '20:00'));
  const [group, setGroup] = useState('');
  const [poll, setPoll] = useState(() => String(accounts.find(account => account.id === accountId)?.settings.pollIntervalMs ?? interval));
  const [consent, setConsent] = useState(false);
  const sequence = useRef(0);
  const currentUrl = useRef('');
  const mounted = useRef(true);
  const lookup = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const preferenceTouched = useRef({ party: false, times: false });
  const intervalTouched = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1; lookup.current?.abort(); }; }, []);

  function changeUrl(value: string) {
    if (value === currentUrl.current) return;
    currentUrl.current = value; sequence.current += 1; lookup.current?.abort(); lookup.current = null;
    setUrl(value); setRestaurant(null); setName(''); setManualName(false); setResolving(false); setResolveError(''); setError('');
  }
  function changeAccount(value: string) {
    if (value === selectedAccountId) return;
    setSelectedAccountId(value); sequence.current += 1; lookup.current?.abort(); lookup.current = null;
    setRestaurant(null); setName(''); setManualName(false); setResolving(false); setResolveError(''); setError('');
    if (!intervalTouched.current) setPoll(String(accounts.find(account => account.id === value)?.settings.pollIntervalMs ?? interval));
  }
  function cancelResolve() {
    sequence.current += 1; lookup.current?.abort(); lookup.current = null;
    setResolving(false); setResolveError('已停止等待，可重试或手动填写餐厅名。');
    if (!restaurant) setManualName(true);
  }
  function changeRange(edge: 'from' | 'to', value: string) {
    preferenceTouched.current.times = true;
    const startTime = edge === 'from' ? value : value < from ? value : from;
    const endTime = edge === 'to' ? value : value > to ? value : to;
    setFrom(startTime); setTo(endTime); setTimeSlots(halfHourRange(startTime, endTime));
    setError('');
  }
  function toggleTime(time: string) {
    preferenceTouched.current.times = true;
    setTimeSlots(previous => previous.includes(time) ? previous.filter(value => value !== time) : [...previous, time].sort());
    setError('');
  }
  async function resolveRestaurant() {
    setResolveError(''); setError('');
    let requestedUrl: string;
    try { if (!selectedAccount?.enabled) throw new Error('请先选择一个已启用账号。'); if (selectedAccount.taskCount >= 5) throw new Error('此账号已达 5 个任务上限。'); requestedUrl = validateRestaurantUrl(url); }
    catch (cause) { setResolveError(cause instanceof Error ? cause.message : '链接格式不正确。'); return; }
    const requestId = ++sequence.current;
    const inputAtStart = currentUrl.current;
    lookup.current?.abort();
    const controller = new AbortController(); lookup.current = controller;
    setResolving(true);
    try {
      const result = await api<{ restaurant: RestaurantInfo }>('/api/restaurants/resolve', { restaurantUrl: requestedUrl, accountId: selectedAccountId }, undefined, controller.signal);
      if (!mounted.current || requestId !== sequence.current || currentUrl.current !== inputAtStart) return;
      if (!result.restaurant?.restaurantName?.trim() || result.restaurant.source !== 'catchtable_public') throw new Error('未能确认官方餐厅名称，请重试或手动填写。');
      const info = result.restaurant;
      validateRestaurantUrl(info.restaurantUrl);
      setRestaurant(info); setName(info.restaurantName); setManualName(false);
      const defaults = info.defaults;
      if (!preferenceTouched.current.party && defaults && Number.isInteger(defaults.partySize) && defaults.partySize >= 1 && defaults.partySize <= 12) setParty(defaults.partySize);
      if (!preferenceTouched.current.times && defaults && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(defaults.timeStart) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(defaults.timeEnd)) {
        const suggested = halfHourRange(defaults.timeStart, defaults.timeEnd);
        if (suggested.length) { setFrom(suggested[0]); setTo(suggested[suggested.length - 1]); setTimeSlots(suggested); }
      }
    } catch (cause) {
      if (mounted.current && requestId === sequence.current && !controller.signal.aborted) {
        setResolveError(cause instanceof Error ? cause.message : '餐厅详情暂时无法读取，请重试。');
        if (!restaurant) setManualName(true);
      }
    } finally { if (mounted.current && requestId === sequence.current) { setResolving(false); lookup.current = null; } }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    try {
      const parsedUrl = validateRestaurantUrl(url);
      if (!selectedAccount?.enabled) throw new Error('请选择一个已启用账号。');
      if (selectedAccount.taskCount >= 5) throw new Error('此账号已达 5 个任务上限。');
      if (resolving) throw new Error('餐厅正在核验，请稍候。');
      if (!restaurant && !manualName) throw new Error('请先核验餐厅，或选择手动填写餐厅名。');
      if (!name.trim()) throw new Error('请填写与官方页面一致的餐厅名称。');
      if (!timeSlots.length) throw new Error('请至少勾选一个预约时段。');
      const pollError = intervalValidation(poll);
      if (pollError) throw new Error(pollError);
      if (mode === 'auto' && !consent) throw new Error('请先确认免费预订授权条件。');
      const dates = buildDates(start, end);
      submitting.current = true; setBusy(true);
      await onCreate({ accountId: selectedAccountId, restaurantName: name.trim(), restaurantUrl: restaurant?.restaurantUrl ?? parsedUrl, dates, partySize: party, timeStart: timeSlots[0], timeEnd: timeSlots[timeSlots.length - 1], timeSlots, mode, groupId: group.trim() || undefined, pollIntervalMs: Number(poll), ...(mode === 'auto' ? { autoConsent: true } : {}) });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败，请重试。'); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  const canCreate = !!selectedAccount?.enabled && selectedAccount.taskCount < 5 && !!name.trim() && (!!restaurant || manualName);
  const accountHint = selectedAccount ? !selectedAccount.enabled ? '此账号已停用，请先启用或选择其他账号。' : selectedAccount.taskCount >= 5 ? '此账号已有 5 个任务，请删除不需要的任务。' : !accountAuthenticated(selectedAccount) ? `${selectedAccount.taskCount}/5 个任务。可先创建，启动前请连接 Chrome 并核验登录。` : `${selectedAccount.taskCount}/5 个任务。创建后账号不可更改。` : '每个账号最多 5 个任务。';
  return <Modal title="新建订座任务" onClose={onClose} busy={busy}>
    <p className="modal-subtitle">粘贴餐厅链接，核验详情后即可按预填条件创建任务。</p>
    <form onSubmit={submit}>
      <fieldset className="task-form-fields" disabled={busy}>
      <div className="form-grid">
        <label className="field full">预约账号 <span className="required">*</span><select required aria-label="预约账号" value={selectedAccountId} onInput={event => changeAccount(event.currentTarget.value)} onChange={event => changeAccount(event.target.value)} disabled={busy}><option value="">请选择账号</option>{accounts.map(account => <option key={account.id} value={account.id} disabled={!account.enabled || account.taskCount >= 5}>{account.label} · {account.taskCount}/5 任务{!account.enabled ? ' · 已停用' : ''}</option>)}</select><span className="field-help">{accountHint}</span></label>
        <label className="field full">餐厅链接 <span className="required">*</span><div className="restaurant-link-entry"><input data-autofocus type="url" required value={url} onInput={event => changeUrl(event.currentTarget.value)} onChange={event => changeUrl(event.target.value)} placeholder="https://www.catchtable.net/shop/..." autoComplete="off" disabled={busy} /><button type="button" className="button primary-outline" disabled={busy || !url.trim()} onClick={() => resolving ? cancelResolve() : void resolveRestaurant()}>{resolving ? <><Icon name="refresh" className="spin" size={14} />取消等待</> : restaurant ? '重新核验' : resolveError ? '重试核验' : '核验餐厅'}</button></div><span className="field-help" role="status">{resolving ? '正在读取官方餐厅页，可停止等待并手动填写。' : '读取公开详情并填写餐厅名，不会提交预约。'}</span>{resolveError ? <span className="restaurant-resolve-error" role="alert">{resolveError}</span> : null}{!restaurant ? <div className="restaurant-resolve-actions"><button type="button" className="text-button" disabled={busy || resolving} onClick={() => setManualName(value => !value)}>{manualName ? '返回链接核验' : '手动填写餐厅名'}</button>{manualName ? <span className="restaurant-manual-note">请填写官网显示的餐厅名。</span> : null}{resolveError && /^https:\/\/(?:www\.)?catchtable\.net\//.test(url) ? <a className="text-button" href={url} target="_blank" rel="noreferrer">打开官方餐厅页<Icon name="external" size={12} /></a> : null}</div> : null}</label>
        {restaurant ? <div className="full"><RestaurantPreview key={restaurant.restaurantUrl} restaurant={restaurant} /></div> : null}
        {restaurant || manualName ? <label className="field full">餐厅名称 <span className="required">*</span><input required maxLength={100} value={name} onInput={event => setName(event.currentTarget.value)} onChange={event => setName(event.target.value)} placeholder="与 Catchtable 页面一致的官方餐厅名称" /><span className="field-help">{restaurant && name.trim() === restaurant.restaurantName ? '已从官方餐厅页自动填写。' : restaurant ? '名称已修改，请保持与官方页面一致，以便核验预订凭证。' : '手动名称尚未核验，请保持与官方页面一致。'}</span></label> : null}
      </div>
      <div className="task-prefill-summary" style={{ marginTop: 20 }}><strong>{restaurant ? '已预填，可修改' : '用餐条件已预填，可修改'}</strong><p>{start === end ? start || '请选择日期' : `${start || '开始日期'} 至 ${end || '结束日期'}`} · {party} 人 · {timeSlots.length ? `${timeSlots.length} 个时段：${timeSlots.join('、')}` : '尚未勾选时段'} · 韩国时间 · 检查间隔 {poll || '待填写'}ms · 创建后暂停</p></div>
      <div className="form-grid">
        <label className="field">开始日期<input required type="date" min={currentDate} value={start} onInput={event => setStart(event.currentTarget.value)} onChange={event => setStart(event.target.value)} /></label>
        <label className="field">结束日期<input required type="date" min={start} value={end} onInput={event => setEnd(event.currentTarget.value)} onChange={event => setEnd(event.target.value)} /></label>
        <label className="field full">用餐人数<select value={party} onChange={event => { preferenceTouched.current.party = true; setParty(Number(event.target.value)); }}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 人</option>)}</select></label>
        <label className="field">开始时间<select aria-label="开始时间" value={from} onChange={event => changeRange('from', event.target.value)}>{HALF_HOUR_TIMES.map(time => <option key={time} value={time}>{time}</option>)}</select></label>
        <label className="field">结束时间<select aria-label="结束时间" value={to} onChange={event => changeRange('to', event.target.value)}>{HALF_HOUR_TIMES.map(time => <option key={time} value={time}>{time}</option>)}</select></label>
        <fieldset className="time-slots-field full"><legend>预约时段 · 韩国时间 <span className="optional">已选 {timeSlots.length} 个</span></legend><div className="time-slot-actions"><span>仅检查勾选的时间，每半小时一档。</span><button type="button" className="text-button" onClick={() => { preferenceTouched.current.times = true; setTimeSlots(halfHourRange(from, to)); setError(''); }}>全选</button><button type="button" className="text-button" onClick={() => { preferenceTouched.current.times = true; setTimeSlots([]); }}>清空</button></div><div className="time-slot-grid">{halfHourRange(from, to).map(time => <label key={time} className={`time-slot-option ${timeSlots.includes(time) ? 'selected' : ''}`}><input type="checkbox" aria-label={`预约时段 ${time}`} checked={timeSlots.includes(time)} onChange={() => toggleTime(time)} /><span>{time}</span></label>)}</div></fieldset>
        <div className="field full"><span>订座方式</span><div className="mode-options">{modeOptions.map(option => <label className={`mode-option ${mode === option.value ? 'selected' : ''}`} key={option.value}><input type="radio" name="mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} /><strong>{option.label}</strong><span>{option.detail}</span></label>)}</div><p className="task-mode-help">{modeDescriptions[mode]}</p></div>
        {mode === 'auto' ? <label className="consent full"><input type="checkbox" required checked={consent} onChange={event => setConsent(event.target.checked)} /><span>我授权仅为此餐厅、所选日期／时间／人数，在页面明确免费且无需新绑定条款确认时自动核对并完成已识别的确认步骤。涉及押金、支付、验证码或未知表单时交由我处理；结果不明时先核验，避免重复提交。</span></label> : null}
      </div>
      <details className="task-advanced"><summary>高级参数 <span>检查间隔与互斥组</span></summary><div className="form-grid"><IntervalInput id="task-check-interval" className="full" value={poll} onChange={value => { intervalTouched.current = true; setPoll(value); }} /><label className="field full">互斥组 <span className="optional">选填</span><input maxLength={60} value={group} onInput={event => setGroup(event.currentTarget.value)} onChange={event => setGroup(event.target.value)} placeholder="例如：首尔周六晚餐" /><span className="field-help">同组任务只保留一笔已确认预订，适合同时关注备选餐厅。</span></label></div></details>
      <div className="soft-notice"><Icon name="info" size={17} /><span>创建后处于暂停状态，由你启动。餐厅时间以韩国时间（Asia/Seoul）为准，比北京时间快 1 小时。</span></div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      </fieldset>
      <div className="modal-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy || resolving || !canCreate}>{busy ? '正在创建…' : '创建暂停任务'}</button></div>
    </form>
  </Modal>;
}
