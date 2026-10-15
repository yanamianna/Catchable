import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Account, AccountFormValues } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { SessionPanel } from './SessionPanel';
import type { LoginMode } from './SessionPanel';
import './accounts.css';

export function accountAuthenticated(account: Account) {
  return (account.settings.browserIntegration !== 'extension' || account.extension?.connected === true)
    && (account.session.status === 'authenticated' || account.session.authenticated === true);
}
function maskedPhone(account: Account) {
  const phone = account.settings.bookingPhoneNumber;
  return phone ? `尾号 ${phone.slice(-4)}` : '未设置电话';
}
function AccountEditor({ account, busy, onClose, onSave }: { account: Account | null; busy: boolean; onClose: () => void; onSave: (values: AccountFormValues, accountId?: string) => Promise<void> }) {
  const [label, setLabel] = useState(account?.label ?? '');
  const [name, setName] = useState(account?.settings.bookingName ?? '');
  const [country, setCountry] = useState(account?.settings.bookingPhoneCountryCode ?? '');
  const [phone, setPhone] = useState(account?.settings.bookingPhoneNumber ?? '');
  const [autoFill, setAutoFill] = useState(account?.settings.bookingPhoneAutoFill ?? false);
  const [error, setError] = useState('');
  const hasPhone = !!country.trim() && !!phone;
  function updatePhone(value: string) { const digits = value.replace(/[^0-9]/g, ''); setPhone(digits); if (!digits) setAutoFill(false); }
  function updateCountry(value: string) { setCountry(value); if (!value.trim()) setAutoFill(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!label.trim()) { setError('请填写账号名称。'); return; }
    try { await onSave({ label: label.trim(), bookingName: name.trim(), bookingPhoneCountryCode: country.trim(), bookingPhoneNumber: phone, bookingPhoneAutoFill: hasPhone && autoFill }, account?.id); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal title={account ? '编辑账号' : '添加账号'} onClose={onClose} busy={busy}><form onSubmit={save}><div className="form-grid">
    <label className="field full">账号名称 <span className="required">*</span><input data-autofocus required maxLength={80} value={label} onInput={event => setLabel(event.currentTarget.value)} onChange={event => setLabel(event.target.value)} autoComplete="off" placeholder="例如：个人账号" /></label>
    <label className="field full">预订姓名<input maxLength={100} value={name} onInput={event => setName(event.currentTarget.value)} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
    <label className="field">国家区号<input type="tel" value={country} onInput={event => updateCountry(event.currentTarget.value)} onChange={event => updateCountry(event.target.value)} placeholder="+86" autoComplete="off" /></label>
    <label className="field">电话号码<input type="tel" inputMode="numeric" value={phone} onInput={event => updatePhone(event.currentTarget.value)} onChange={event => updatePhone(event.target.value)} autoComplete="off" /></label>
    <label className="consent full"><input type="checkbox" checked={hasPhone && autoFill} disabled={!hasPhone} onChange={event => setAutoFill(event.target.checked)} /><span>允许在此账号已授权的免费预约中填写姓名和电话</span></label>
    <p className="field-help full">资料仅用于此账号。支付、验证码或新条款需你处理。</p>
  </div>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存账号'}</button></div></form></Modal>;
}

type AccountFilter = 'all' | 'ready' | 'login' | 'disconnected' | 'paused' | 'disabled';
const filters: Array<{ id: AccountFilter; label: string }> = [{ id: 'all', label: '全部状态' }, { id: 'ready', label: '可调度' }, { id: 'login', label: '待核验登录' }, { id: 'disconnected', label: '未连接' }, { id: 'paused', label: '已暂停' }, { id: 'disabled', label: '已停用' }];

export function Accounts({ accounts, pending, globalPaused, selectedAccountId, onSave, onToggle, onEngine, onSession }: { accounts: Account[]; pending: ReadonlySet<string>; globalPaused: boolean; selectedAccountId: string; onSave: (values: AccountFormValues, accountId?: string) => Promise<void>; onToggle: (account: Account) => void; onEngine: (accountId: string) => void; onSession: (accountId: string, action: 'open' | 'check', mode?: LoginMode) => Promise<void> | void }) {
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState<AccountFilter>('all'); const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Account | 'new' | null>(null);
  useEffect(() => { if (selectedAccountId !== 'all') { setSearch(''); setFilter('all'); const index = accounts.findIndex(account => account.id === selectedAccountId); if (index >= 0) setPage(Math.floor(index / 20) + 1); } }, [selectedAccountId]);
  const visible = accounts.filter(account => {
    if (!`${account.label} ${account.id}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
    const connected = account.settings.browserIntegration !== 'extension' ? account.session.connected === true : account.extension?.connected === true;
    return filter === 'all' || (filter === 'disabled' ? !account.enabled : filter === 'disconnected' ? !connected : filter === 'login' ? connected && !accountAuthenticated(account) : filter === 'paused' ? !!account.engine.paused : account.enabled && !account.engine.paused && accountAuthenticated(account));
  });
  const pages = Math.max(1, Math.ceil(visible.length / 20)); const currentPage = Math.min(page, pages); const rows = visible.slice((currentPage - 1) * 20, currentPage * 20);
  function updateSearch(value: string) { setSearch(value); setPage(1); }
  return <section className="accounts-section"><div className="records-heading"><div className="section-intro"><span className="eyebrow">ACCOUNTS</span><h2>账号管理</h2><p>{accounts.length} 个账号 · 每个账号最多 5 个任务</p></div><button type="button" className="button primary" onClick={() => setEditor('new')} disabled={pending.has('account:new')}><Icon name="plus" size={17} />添加账号</button></div>
    <div className="accounts-toolbar"><label className="search-field"><Icon name="search" size={17} /><input aria-label="搜索账号" value={search} onInput={event => updateSearch(event.currentTarget.value)} onChange={event => updateSearch(event.target.value)} placeholder="搜索账号名称或 ID" /></label><label className="account-filter">状态<select aria-label="账号状态筛选" value={filter} onChange={event => { setFilter(event.target.value as AccountFilter); setPage(1); }}>{filters.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
    {globalPaused ? <p className="accounts-global-note">全局调度已暂停。单个账号恢复不会解除全局暂停。</p> : null}
    {rows.length ? <div className="accounts-list">{rows.map(account => {
      const authenticated = accountAuthenticated(account); const connected = account.settings.browserIntegration === 'extension' ? !!account.extension?.connected : !!account.session.connected;
      const sessionBusy = pending.has(`session:${account.id}`); const engineBusy = pending.has(`engine:${account.id}`); const accountBusy = pending.has(`account:${account.id}`);
      return <article className="account-card" key={account.id}><div className="account-card-top"><div className="account-card-title"><h3>{account.label}</h3><p>{maskedPhone(account)} · {account.taskCount ?? '—'}/5 任务</p></div><div className="account-statuses"><span className={`status ${!account.enabled || account.engine.paused ? 'status-paused' : 'status-confirmed'}`}><span />{!account.enabled ? '已停用' : globalPaused ? '全局暂停' : account.settings.enginePaused ? '账号暂停' : '已启用'}</span><span className={`status ${authenticated ? 'status-confirmed' : 'status-auth_required'}`}><span />{authenticated ? '登录已核验' : connected ? '待核验登录' : '未连接'}</span></div></div>
        <SessionPanel accountId={account.id} bindingLabel={account.label} state={{ settings: account.settings, session: account.session, extension: account.extension }} embedded busy={sessionBusy} onSession={(action, mode) => onSession(account.id, action, mode)} />
        <div className="account-card-actions"><button type="button" className="button small" disabled={engineBusy || !account.enabled} onClick={() => onEngine(account.id)}>{engineBusy ? '处理中…' : account.settings.enginePaused ? '恢复账号' : '暂停账号'}</button><button type="button" className="button small" disabled={accountBusy} onClick={() => setEditor(account)}>编辑</button><button type="button" className="text-button" disabled={accountBusy} onClick={() => onToggle(account)}>{accountBusy ? '处理中…' : account.enabled ? '停用' : '启用'}</button></div>
      </article>;
    })}</div> : <div className="empty-state compact"><Icon name="link" size={30} /><h3>{accounts.length ? '没有符合条件的账号' : '先添加一个账号'}</h3>{accounts.length ? <button type="button" className="button" onClick={() => { setSearch(''); setFilter('all'); setPage(1); }}>查看全部账号</button> : null}</div>}
    <div className="account-pagination"><span aria-live="polite">{visible.length} 个匹配 · 第 {currentPage}/{pages} 页 · 20/页</span><div><button type="button" className="button small" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className="button small" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div>
    {editor ? <AccountEditor key={editor === 'new' ? 'new' : editor.id} account={editor === 'new' ? null : editor} busy={pending.has(editor === 'new' ? 'account:new' : `account:${editor.id}`)} onClose={() => setEditor(null)} onSave={onSave} /> : null}
  </section>;
}
