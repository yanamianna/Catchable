import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AppState, BrowserChannel, BrowserIntegration } from '../types';
import { formatTime } from '../api';
import { Icon } from './Icon';
import { IntervalInput, intervalValidation } from './IntervalInput';
import { SessionPanel } from './SessionPanel';
import type { SessionAction } from './SessionPanel';

type Permission = NotificationPermission | 'unsupported';
function browserPermission(): Permission { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }

export function Settings({ state, pending, onSave, onSession, onEngine, onClear }: { state: AppState | null; pending: ReadonlySet<string>; onSave: (settings: { pollIntervalMs: number; webhookUrl: string; applyToExistingTasks: boolean; bookingPhoneCountryCode: string; bookingPhoneNumber: string; bookingPhoneAutoFill: boolean; browserChannel: BrowserChannel; browserIntegration: BrowserIntegration }) => Promise<void>; onSession: SessionAction; onEngine: () => void; onClear?: () => void }) {
  const [poll, setPoll] = useState(() => String(state?.settings.pollIntervalMs ?? 1000));
  const [webhook, setWebhook] = useState(state?.settings.webhookUrl ?? '');
  const [phoneCountryCode, setPhoneCountryCode] = useState(state?.settings.bookingPhoneCountryCode ?? '');
  const [phoneNumber, setPhoneNumber] = useState(state?.settings.bookingPhoneNumber ?? '');
  const [phoneAutoFill, setPhoneAutoFill] = useState(state?.settings.bookingPhoneAutoFill ?? false);
  const [browserChannel, setBrowserChannel] = useState<BrowserChannel>(state?.settings.browserChannel ?? 'msedge');
  const [browserIntegration, setBrowserIntegration] = useState<BrowserIntegration>(state?.settings.browserIntegration ?? 'extension');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [permission, setPermission] = useState<Permission>(browserPermission);
  const [applyToExisting, setApplyToExisting] = useState(true);
  useEffect(() => {
    if (!dirty && state) {
      setPoll(String(state.settings.pollIntervalMs ?? 1000));
      setWebhook(state.settings.webhookUrl ?? '');
      setPhoneCountryCode(state.settings.bookingPhoneCountryCode ?? '');
      setPhoneNumber(state.settings.bookingPhoneNumber ?? '');
      setPhoneAutoFill(state.settings.bookingPhoneAutoFill ?? false);
      setBrowserChannel(state.settings.browserChannel ?? 'msedge');
      setBrowserIntegration(state.settings.browserIntegration ?? 'extension');
    }
  }, [state?.settings.pollIntervalMs, state?.settings.webhookUrl, state?.settings.bookingPhoneCountryCode, state?.settings.bookingPhoneNumber, state?.settings.bookingPhoneAutoFill, state?.settings.browserChannel, state?.settings.browserIntegration, dirty]);
  function updateIntegration(value: string) {
    if (value !== 'extension' && value !== 'dedicated') return;
    setBrowserIntegration(value); setDirty(true);
  }
  function updateBrowser(value: string) {
    if (value !== 'chrome' && value !== 'msedge') return;
    setBrowserChannel(value); setDirty(true);
  }
  const hasPhone = Boolean(phoneCountryCode.trim() && phoneNumber);
  function updateCountryCode(value: string) {
    setPhoneCountryCode(value); setDirty(true);
    if (!value.trim()) setPhoneAutoFill(false);
  }
  function updatePhoneNumber(value: string) {
    const digits = value.replace(/[^0-9]/g, '');
    setPhoneNumber(digits); setDirty(true);
    if (!digits) setPhoneAutoFill(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const pollError = intervalValidation(poll);
      if (pollError) throw new Error(pollError);
      await onSave({ pollIntervalMs: Number(poll), webhookUrl: webhook.trim(), applyToExistingTasks: applyToExisting, bookingPhoneCountryCode: phoneCountryCode.trim(), bookingPhoneNumber: phoneNumber, bookingPhoneAutoFill: hasPhone && phoneAutoFill, browserChannel: browserIntegration === 'extension' ? 'chrome' : browserChannel, browserIntegration }); setDirty(false);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  async function enableNotification() {
    if (typeof Notification === 'undefined') return;
    try { setPermission(await Notification.requestPermission()); }
    catch { setError('浏览器未能开启通知，请检查浏览器的站点权限。'); }
  }
  const hasMessages = !!state && (state.events.length > 0 || state.notifications.length > 0 || state.bookings.some(booking => ['confirmed', 'rejected'].includes(booking.status)));
  return <section className="settings-section"><div className="section-intro"><span className="eyebrow">YOUR CONTROL ROOM</span><h2>运行设置</h2></div>
    <SessionPanel state={state} busy={pending.has('session')} onSession={onSession} />
    <form className="settings-card" onSubmit={save}><div className="settings-heading"><Icon name="settings" size={22} /><div><h3>任务设置</h3></div></div>
      <div className="form-grid settings-form">
        <label className="field full" htmlFor="settings-browser-integration">浏览器连接方式<select id="settings-browser-integration" value={browserIntegration} onInput={event => updateIntegration(event.currentTarget.value)} onChange={event => updateIntegration(event.target.value)}><option value="extension">Chrome 扩展（推荐）</option><option value="dedicated">专用浏览器窗口</option></select><span className="field-help">切换会断开旧连接，保留登录资料。</span></label>
        {browserIntegration === 'dedicated' ? <label className="field full" htmlFor="settings-browser-channel">登录与订座浏览器<select id="settings-browser-channel" value={browserChannel} onInput={event => updateBrowser(event.currentTarget.value)} onChange={event => updateBrowser(event.target.value)}><option value="msedge">Microsoft Edge</option><option value="chrome">Google Chrome</option></select><span className="field-help">使用独立登录资料，首次需登录。</span></label> : null}
        <IntervalInput id="settings-check-interval" className="full" value={poll} onChange={value => { setPoll(value); setDirty(true); }} />
        <label className="field full">Webhook 地址 <span className="optional">选填</span><input type="url" value={webhook} onInput={event => { setWebhook(event.currentTarget.value); setDirty(true); }} onChange={event => { setWebhook(event.target.value); setDirty(true); }} placeholder="https://your-webhook.example/..." autoComplete="off" /><span className="field-help">留空仅站内通知。</span></label>
        <div className="field full">预约预填电话 <span className="optional">选填</span><span className="field-help">仅本机保存，不从账号推断。</span></div>
        <label className="field" htmlFor="booking-phone-country-code">国家区号<input id="booking-phone-country-code" type="tel" value={phoneCountryCode} onInput={event => updateCountryCode(event.currentTarget.value)} onChange={event => updateCountryCode(event.target.value)} placeholder="+86" autoComplete="off" /></label>
        <label className="field" htmlFor="booking-phone-number">电话号码（不含国家区号）<input id="booking-phone-number" type="tel" inputMode="numeric" value={phoneNumber} onInput={event => updatePhoneNumber(event.currentTarget.value)} onChange={event => updatePhoneNumber(event.target.value)} placeholder="请输入号码" autoComplete="off" title="仅保留 0–9 数字" /></label>
        <div className="full"><label className="settings-apply"><input type="checkbox" checked={hasPhone && phoneAutoFill} disabled={!hasPhone} onChange={event => { setPhoneAutoFill(event.target.checked); setDirty(true); }} /><span>允许在已授权的 Catchtable 免费自动预约中填写此号码</span></label><span className="field-help">支付、验证码或新条款需你处理。</span></div>
      </div>
      <label className="settings-apply"><input type="checkbox" checked={applyToExisting} onChange={event => { setApplyToExisting(event.target.checked); setDirty(true); }} /><span>应用到已有真实任务</span></label>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="settings-actions"><button className="button primary" type="submit" disabled={pending.has('settings') || !dirty}>{pending.has('settings') ? '正在保存…' : '保存设置'}</button></div></form>
    <div className="settings-card"><div className="settings-heading"><Icon name="bell" size={22} /><div><h3>浏览器通知</h3><p>{permission === 'granted' ? '已开启。' : permission === 'denied' ? '权限被拒绝，可在浏览器设置开启。' : permission === 'unsupported' ? '不支持桌面通知，仍有站内通知。' : '点击开启后向浏览器授权。'}</p></div></div><div className="settings-actions"><button type="button" className="button" disabled={permission !== 'default'} onClick={() => void enableNotification()}>{permission === 'granted' ? '已允许通知' : permission === 'denied' ? '浏览器权限已关闭' : permission === 'unsupported' ? '暂不支持' : '开启浏览器通知'}</button></div></div>
    <div className="settings-card"><div className="settings-heading"><Icon name="monitor" size={22} /><div><h3>本地运行</h3><p>关闭后台或电脑休眠会停止运行。</p></div><span className={`status ${state?.engine.paused ? 'status-paused' : 'status-confirmed'}`}><span />{state?.engine.paused ? '全部暂停' : '服务可用'}</span></div><div className="settings-actions"><button type="button" className="button" disabled={pending.has('engine') || !state} onClick={onEngine}><Icon name={state?.engine.paused ? 'play' : 'pause'} size={16} />{state?.engine.paused ? '恢复全部监控' : '暂停全部监控'}</button><span className="settings-tick">最近运行：{formatTime(state?.engine.lastTickAt)}</span></div></div>
    {onClear ? <div className="settings-card"><div className="settings-heading"><Icon name="trash" size={22} /><div><h3>消息记录</h3><p>待核验预约保留，不取消官方订单。</p></div></div><div className="settings-actions"><button type="button" className="button clear-records" disabled={pending.has('clear-records') || !hasMessages} onClick={onClear}>{pending.has('clear-records') ? '清除中…' : '清除全部消息'}</button></div></div> : null}
  </section>;
}
