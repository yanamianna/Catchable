import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AppState } from '../types';
import { formatTime } from '../api';
import { Icon } from './Icon';
import { IntervalInput, intervalValidation } from './IntervalInput';

type Permission = NotificationPermission | 'unsupported';
function browserPermission(): Permission { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
export interface GlobalSettingsValues { pollIntervalMs: number; webhookUrl: string; applyToExistingTasks: boolean }

export function Settings({ state, pending, onSave, onEngine, onClear }: { state: AppState | null; pending: ReadonlySet<string>; onSave: (settings: GlobalSettingsValues) => Promise<void>; onEngine: () => void; onClear: () => void }) {
  const [poll, setPoll] = useState(() => String(state?.settings.pollIntervalMs ?? 1000));
  const [webhook, setWebhook] = useState(state?.settings.webhookUrl ?? '');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [permission, setPermission] = useState<Permission>(browserPermission);
  const [applyToExisting, setApplyToExisting] = useState(true);
  useEffect(() => { if (!dirty && state) { setPoll(String(state.settings.pollIntervalMs ?? 1000)); setWebhook(state.settings.webhookUrl ?? ''); } }, [state?.settings.pollIntervalMs, state?.settings.webhookUrl, dirty]);
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const validation = intervalValidation(poll); if (validation) throw new Error(validation);
      await onSave({ pollIntervalMs: Number(poll), webhookUrl: webhook.trim(), applyToExistingTasks: applyToExisting }); setDirty(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  async function enableNotification() {
    if (typeof Notification === 'undefined') return;
    try { setPermission(await Notification.requestPermission()); } catch { setError('浏览器未能开启通知，请检查站点权限。'); }
  }
  const globalPaused = state?.engine.globalPaused ?? state?.engine.paused ?? true;
  const hasMessages = !!state && (state.events.length > 0 || state.notifications.length > 0 || state.bookings.some(booking => ['confirmed', 'rejected'].includes(booking.status)));
  const clearBusy = [...pending].some(key => key.startsWith('clear-records:'));
  return <section className="settings-section"><div className="section-intro"><span className="eyebrow">YOUR CONTROL ROOM</span><h2>全局运行设置</h2></div>
    <form className="settings-card" onSubmit={save}><div className="settings-heading"><Icon name="settings" size={22} /><div><h3>监控与通知</h3></div></div><div className="form-grid settings-form">
      <IntervalInput id="settings-check-interval" className="full" value={poll} onChange={value => { setPoll(value); setDirty(true); }} />
      <label className="field full">Webhook 地址 <span className="optional">选填</span><input type="url" value={webhook} onInput={event => { setWebhook(event.currentTarget.value); setDirty(true); }} onChange={event => { setWebhook(event.target.value); setDirty(true); }} placeholder="https://your-webhook.example/..." autoComplete="off" /><span className="field-help">留空仅站内通知。</span></label>
    </div><label className="settings-apply"><input type="checkbox" checked={applyToExisting} onChange={event => { setApplyToExisting(event.target.checked); setDirty(true); }} /><span>应用到已有真实任务</span></label>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="settings-actions"><button className="button primary" type="submit" disabled={pending.has('settings') || !dirty || !state}>{pending.has('settings') ? '正在保存…' : '保存设置'}</button></div></form>
    <div className="settings-card"><div className="settings-heading"><Icon name="bell" size={22} /><div><h3>浏览器通知</h3><p>{permission === 'granted' ? '已开启。' : permission === 'denied' ? '权限被拒绝，可在浏览器设置开启。' : permission === 'unsupported' ? '不支持桌面通知，仍有站内通知。' : '点击开启后向浏览器授权。'}</p></div></div><div className="settings-actions"><button type="button" className="button" disabled={permission !== 'default'} onClick={() => void enableNotification()}>{permission === 'granted' ? '已允许通知' : permission === 'denied' ? '浏览器权限已关闭' : permission === 'unsupported' ? '暂不支持' : '开启浏览器通知'}</button></div></div>
    <div className="settings-card"><div className="settings-heading"><Icon name="monitor" size={22} /><div><h3>全部账号调度</h3><p>关闭后台或电脑休眠会停止运行。</p></div><span className={`status ${globalPaused ? 'status-paused' : 'status-confirmed'}`}><span />{globalPaused ? '全局暂停' : '全局可用'}</span></div><div className="settings-actions"><button type="button" className="button" disabled={pending.has('engine:all') || !state} onClick={onEngine}><Icon name={globalPaused ? 'play' : 'pause'} size={16} />{globalPaused ? '恢复全部账号调度' : '暂停全部账号调度'}</button><span className="settings-tick">最近运行：{formatTime(state?.engine.lastTickAt)}</span></div></div>
    <div className="settings-card"><div className="settings-heading"><Icon name="trash" size={22} /><div><h3>消息记录</h3><p>清除当前账号范围。待核验预约保留，不取消官方订单。</p></div></div><div className="settings-actions"><button type="button" className="button clear-records" disabled={clearBusy || !hasMessages} onClick={onClear}>{clearBusy ? '清除中…' : '清除当前范围消息'}</button></div></div>
  </section>;
}
