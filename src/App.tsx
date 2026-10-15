import { useEffect, useRef, useState } from 'react';
import { api, useAppState } from './api';
import type { Account, AccountFormValues, NewTask, Page, RecordKind, Task } from './types';
import { Activity, Sidebar } from './components/Layout';
import { Icon } from './components/Icon';
import { NewTaskModal } from './components/NewTaskModal';
import { isPending, Tasks } from './components/Tasks';
import type { TaskAction } from './components/Tasks';
import { Bookings, Notifications } from './components/Records';
import { Settings } from './components/Settings';
import { Modal } from './components/Modal';
import { SessionPanel } from './components/SessionPanel';
import type { LoginMode } from './components/SessionPanel';
import type { TaskFilter } from './components/Tasks';
import type { BookingFilter, NotificationFilter } from './components/Records';
import { TaskDetails } from './components/TaskDetails';
import { Accounts } from './components/Accounts';

export default function App() {
  const [accountScope, setAccountScope] = useState('all');
  const { state, accounts, error, loading, refresh } = useAppState(accountScope);
  const [page, setPage] = useState<Page>('tasks');
  const [modal, setModal] = useState(false);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [bookingFilter, setBookingFilter] = useState<BookingFilter>('all');
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>('all');
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [abandonTask, setAbandonTask] = useState<Task | null>(null);
  const [noReservation, setNoReservation] = useState(false);
  const notificationIds = useRef<Set<string> | null>(null);
  const actionLocks = useRef(new Set<string>());
  useEffect(() => { notificationIds.current = null; }, [accountScope]);
  useEffect(() => {
    if (!state) return;
    if (notificationIds.current === null) { notificationIds.current = new Set(state.notifications.map(item => item.id)); return; }
    for (const item of state.notifications) {
      if (notificationIds.current.has(item.id)) continue;
      notificationIds.current.add(item.id);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && item.channel === 'in_app') {
        try { new Notification(`${item.accountLabel ?? 'Catchable'} · ${item.source === 'demo' ? '演练通知' : '订座动态'}`, { body: item.message, tag: item.id }); } catch { /* 站内通知保留为可靠的显示方式。 */ }
      }
    }
  }, [state]);
  useEffect(() => { if (!notice) return; const timeout = window.setTimeout(() => setNotice(null), notice.error ? 10000 : 5500); return () => window.clearTimeout(timeout); }, [notice]);

  async function perform<T>(key: string, operation: () => Promise<T>, message?: string) {
    if (actionLocks.current.has(key)) throw new Error('这项操作仍在处理中，请稍后再试。');
    actionLocks.current.add(key); setPending(previous => new Set(previous).add(key));
    try { const result = await operation(); await refresh(); if (message) setNotice({ message }); return result; }
    catch (cause) { setNotice({ message: cause instanceof Error ? cause.message : '操作失败，请重试。', error: true }); throw cause; }
    finally { actionLocks.current.delete(key); setPending(previous => { const next = new Set(previous); next.delete(key); return next; }); }
  }
  function onTaskAction(task: Task, action: TaskAction) {
    const owner = accounts.find(account => account.id === task.accountId);
    const ownerPaused = !!state?.engine.paused || !!owner?.settings.enginePaused || owner?.enabled === false;
    if (action === 'abandon') { setNoReservation(false); setAbandonTask(task); return; }
    void perform(action === 'pause' ? `${task.id}:pause` : task.id, async () => {
      if (action === 'delete') return api(`/api/tasks/${encodeURIComponent(task.id)}`, { accountId: task.accountId }, 'DELETE');
      const result = await api<{ url?: string }>(`/api/tasks/${encodeURIComponent(task.id)}/action`, { action, accountId: task.accountId });
      if (action === 'handoff') {
        // 后台在专用浏览器中准备预订；普通新标签只作为官方入口。
        if (result.url && task.source !== 'demo') setNotice({ message: '已准备预订，请在 Catchtable 页面完成确认。' });
      }
      return result;
    }, action === 'delete' ? '任务已删除。' : action === 'start' ? ownerPaused ? '任务已启用，账号或全局调度仍暂停。' : '任务已启动，运行结果会显示在动态中。' : action === 'pause' ? '任务已暂停。' : action === 'check' ? '已完成本次检查，请查看任务状态。' : action === 'reconcile' ? '核验已完成，请查看预约记录。' : action === 'continue_auto' ? '已继续处理原预约，后续结果会自动同步到预约记录。' : undefined).catch(() => {});
  }
  async function sessionAction(accountId: string, action: 'open' | 'check', mode?: LoginMode) {
    const result = await perform(`session:${accountId}`, () => api<{ session?: { message?: string } }>(`/api/accounts/${encodeURIComponent(accountId)}/session/${action}`, action === 'open' && mode ? { mode } : {}));
    setNotice({ message: result.session?.message ?? '此账号登录状态已更新。' });
  }
  const selectedAccount = accounts.find(account => account.id === accountScope);
  const globalPaused = state?.engine.globalPaused ?? state?.engine.paused ?? true;
  const resources = [{ label: '进程内存', value: state?.engine.processMemoryMB, unit: ' MB' }, { label: '系统可用', value: state?.engine.systemFreeMemoryMB, unit: ' MB' }, { label: '已连接', value: state?.engine.connectedAccounts, unit: ' 个账号' }, { label: '登录已核验', value: state?.engine.authenticatedAccounts, unit: ' 个账号' }].filter(item => typeof item.value === 'number' && Number.isFinite(item.value));
  function engineAction(accountId = accountScope) {
    const paused = accountId === 'all' ? globalPaused : accounts.find(account => account.id === accountId)?.settings.enginePaused ?? false;
    void perform(`engine:${accountId}`, () => api('/api/engine/action', { action: paused ? 'resume' : 'pause', accountId }), paused ? '调度已恢复；已暂停任务仍需单独启动。' : '调度已暂停。').catch(() => {});
  }
  async function saveAccount(values: AccountFormValues, accountId?: string) {
    const result = await perform(accountId ? `account:${accountId}` : 'account:new', () => api<{ account: Account }>(accountId ? `/api/accounts/${encodeURIComponent(accountId)}` : '/api/accounts', values), accountId ? '账号资料已保存。' : '账号已添加，点击连接浏览器即可。');
    if (!accountId && result.account?.id) selectAccount(result.account.id);
  }
  function toggleAccount(account: Account) { void perform(`account:${account.id}`, () => api(`/api/accounts/${encodeURIComponent(account.id)}/action`, { action: account.enabled ? 'disable' : 'enable' }), account.enabled ? '账号已停用。' : '账号已启用，暂停任务不会自动启动。').catch(() => {}); }
  function clearRecords(kind: RecordKind) {
    const labels = { events: '运行动态', notifications: '全部通知', bookings: '已结束预约记录', all: '历史消息记录' };
    void perform(`clear-records:${accountScope}`, () => api('/api/records/clear', { kind, accountId: accountScope }), `${labels[kind]}已清除。`).catch(() => {});
  }
  const clearBusy = accountScope === 'all' ? [...pending].some(key => key.startsWith('clear-records:')) : pending.has('clear-records:all') || pending.has(`clear-records:${accountScope}`);
  function selectAccount(value: string) { setAccountScope(value); setDetailTaskId(null); setAbandonTask(null); }
  function manageAccount(accountId: string) { selectAccount(accountId); setPage('accounts'); }
  const availableEvents = state?.stats.availableEvents ?? 0;
  const pendingTasks = new Set(state?.tasks.filter(isPending).map(task => task.id) ?? []);
  state?.bookings.filter(booking => booking.source === 'live' && ['outcome_unknown','user_action_required','pending_restaurant','submitting'].includes(booking.status)).forEach(booking => pendingTasks.add(booking.taskId));
  const metrics = [
    { label: '监控中', value: state?.stats.activeTasks ?? 0, color: 'orange', detail: '查看监控任务', actionLabel: '查看任务', action: () => setTaskFilter('active') },
    { label: '发现空位', value: availableEvents, color: 'blue', detail: '查看历史空位提醒', actionLabel: '历史提醒', action: () => { setNotificationFilter('available'); setPage('notifications'); } },
    { label: '预约成功', value: state?.stats.confirmedBookings ?? 0, color: 'green', detail: '查看已确认预约', actionLabel: '查看记录', action: () => { setBookingFilter('confirmed'); setPage('bookings'); } },
    { label: '待处理', value: pendingTasks.size, color: 'gray', detail: '查看需要处理的任务', actionLabel: '查看任务', action: () => setTaskFilter('pending') },
  ];
  function navigate(next: Page) { setPage(next); if (next === 'tasks') setTaskFilter('all'); if (next === 'bookings') setBookingFilter('all'); if (next === 'notifications') setNotificationFilter('all'); }
  function showTask(id: string) { const task = state?.tasks.find(item => item.id === id); if (task) setDetailTaskId(id); else setNotice({ message: '原任务已删除，历史记录仍然保留。' }); }
  const detailTask = state?.tasks.find(task => task.id === detailTaskId);
  return <div className="app-shell"><Sidebar page={page} onNavigate={navigate} /><main className="main-content" id="main-content">
    <header className="page-header"><div><h1>{page === 'tasks' ? '把好位置，留给下一顿。' : page === 'bookings' ? '每一次期待，都有记录。' : page === 'notifications' ? '好消息，及时到达。' : page === 'accounts' ? '每个账号，各自有序。' : '订座这件事，由你掌控。'}</h1><p>{page === 'tasks' ? '粘贴餐厅链接，核验信息，安排下一顿。' : page === 'bookings' ? '查看预订结果，安心安排你的用餐计划。' : page === 'notifications' ? '不错过空位，也看得见每一次提醒。' : page === 'accounts' ? '独立管理登录、预订资料与调度。' : '设置全局节奏与通知方式。'}</p></div><button className="button primary new-task-button" type="button" disabled={[...pending].some(key => key.startsWith('new-task:')) || !state || !accounts.length} onClick={() => setModal(true)}><Icon name="plus" size={20} />新建订座任务</button></header>
    <div className="global-account-control"><label htmlFor="global-account-scope">账号范围<select id="global-account-scope" value={accountScope} onInput={event => selectAccount(event.currentTarget.value)} onChange={event => selectAccount(event.target.value)}><option value="all">全部账号</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.enabled ? '' : ' · 已停用'}</option>)}</select></label><button type="button" className="text-button" onClick={() => navigate('accounts')}>管理账号</button></div>
    {resources.length ? <div className="resource-summary" aria-label="全局资源"><span>全局资源</span>{resources.map(item => <span key={item.label}>{item.label} {item.value?.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}{item.unit}</span>)}</div> : null}
    {error ? <div className="connection-error" role="alert"><Icon name="info" size={20} /><div><strong>本地服务连接失败</strong><span>{error}。{state ? '当前显示上一次读取的状态。' : '请确认后台服务正在运行。'}</span></div><button type="button" className="button small" onClick={() => void refresh()}>重试</button></div> : null}
    {page === 'tasks' ? <>
      {selectedAccount ? <SessionPanel key={selectedAccount.id} accountId={selectedAccount.id} bindingLabel={selectedAccount.label} state={{ settings: selectedAccount.settings, session: selectedAccount.session, extension: selectedAccount.extension }} busy={pending.has(`session:${selectedAccount.id}`)} compact onSession={(action, mode) => sessionAction(selectedAccount.id, action, mode)} onManage={() => navigate('accounts')} /> : <div className="account-overview"><span>{accounts.length} 个账号 · {accounts.filter(account => account.enabled).length} 个已启用{globalPaused ? ' · 全局暂停' : ''}</span><button type="button" className="button small" onClick={() => navigate('accounts')}>管理账号</button></div>}
      <div className="metrics" aria-label="订座统计">{metrics.map(metric => <button type="button" className="metric" key={metric.label} aria-label={`${metric.label} ${state ? metric.value : '—'}，${metric.detail}`} title={metric.detail} disabled={!state} onClick={metric.action}><span className={`metric-dot ${metric.color}`} /><div><span className="metric-label">{metric.label}</span><strong>{state ? metric.value : '—'}</strong><span className="metric-action">{metric.actionLabel}<Icon name="arrow" size={12} /></span></div></button>)}</div>
      <Tasks state={state} loading={loading} pending={pending} filter={taskFilter} onFilter={setTaskFilter} onNew={() => setModal(true)} onDemo={() => { if (accountScope === 'all') { setNotice({ message: '请先选择一个账号运行演练。' }); return; } void perform('demo', () => api('/api/demo/run', { accountId: accountScope }), '演练已运行，所有模拟数据已标记。未查询或预订真实餐厅。').catch(() => {}); }} onEngine={() => engineAction()} enginePaused={accountScope === 'all' ? globalPaused : selectedAccount?.settings.enginePaused ?? false} engineBusy={pending.has(`engine:${accountScope}`)} engineLabel={selectedAccount?.label ?? '全部账号'} globalPaused={globalPaused} onGlobalSettings={() => navigate('settings')} accountDisabled={!!selectedAccount && !selectedAccount.enabled} onAccountManage={() => navigate('accounts')} onAction={onTaskAction} onDetails={task => setDetailTaskId(task.id)} onLogin={manageAccount} />
      {state?.tasks.some(task => task.source === 'demo') ? <p className="demo-footnote"><span className="badge demo">演练</span>模拟结果单独标记，不计入真实预约成功。可删除演练任务，历史模拟记录仍会保留。</p> : null}
    </> : page === 'bookings' ? <Bookings state={state} filter={bookingFilter} onFilter={setBookingFilter} onTask={showTask} clearing={clearBusy} onClear={() => clearRecords('bookings')} /> : page === 'notifications' ? <Notifications state={state} filter={notificationFilter} onFilter={setNotificationFilter} onTask={showTask} clearing={clearBusy} onClear={() => clearRecords('notifications')} /> : page === 'accounts' ? <Accounts accounts={accounts} pending={pending} globalPaused={globalPaused} selectedAccountId={accountScope} onSave={saveAccount} onToggle={toggleAccount} onEngine={engineAction} onSession={(accountId, action, mode) => sessionAction(accountId, action, mode)} /> : <Settings state={state} pending={pending} onSave={settings => perform('settings', () => api('/api/settings', settings), '运行设置已保存。').then(() => {})} onEngine={() => engineAction('all')} onClear={() => clearRecords('all')} />}
    <footer className="page-footer">餐厅时间以韩国时间为准 · Asia/Seoul <span>比北京时间快 1 小时</span></footer>
  </main><Activity state={state} clearing={clearBusy} onClear={() => clearRecords('events')} />
    {modal ? <NewTaskModal accounts={accounts} accountId={accountScope} interval={state?.settings.pollIntervalMs ?? 1000} currentDate={state?.engine.currentDate ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())} onClose={() => setModal(false)} onCreate={(task: NewTask) => perform(`new-task:${task.accountId}`, () => api('/api/tasks', task), '任务已创建，启动后开始检查。').then(() => {})} /> : null}
    {detailTask && state ? <TaskDetails key={detailTask.id} task={detailTask} state={state} onClose={() => setDetailTaskId(null)} onLogin={() => { setDetailTaskId(null); manageAccount(detailTask.accountId); }} onRecords={() => { setDetailTaskId(null); navigate('bookings'); }} /> : null}
    {abandonTask ? <Modal title="确认没有完成预约" onClose={() => setAbandonTask(null)} busy={pending.has(abandonTask.id)}><p className="modal-subtitle">使用「{abandonTask.accountLabel ?? abandonTask.accountId}」在官方 My Dining 核对「{abandonTask.restaurantName}」确实没有预约。</p><label className="consent"><input data-autofocus type="checkbox" checked={noReservation} onChange={event => setNoReservation(event.target.checked)} /><span>我已核对官方预约记录，确认没有这笔订单。</span></label><div className="modal-footer"><button type="button" className="button" disabled={pending.has(abandonTask.id)} onClick={() => setAbandonTask(null)}>取消</button><button type="button" className="button primary" disabled={!noReservation || pending.has(abandonTask.id)} onClick={() => { void perform(abandonTask.id, () => api(`/api/tasks/${encodeURIComponent(abandonTask.id)}/action`, { accountId: abandonTask.accountId, action: 'abandon', noReservationConfirmed: true }), '已记录为未预约，任务回到暂停状态。').then(() => setAbandonTask(null)).catch(() => {}); }}>{pending.has(abandonTask.id) ? '处理中…' : '确认未预约，任务回到暂停'}</button></div></Modal> : null}
    {notice ? <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'info' : 'check'} size={19} /><span>{notice.message}</span><button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示"><Icon name="close" size={16} /></button></div> : null}
  </div>;
}
