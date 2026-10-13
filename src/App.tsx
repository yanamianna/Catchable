import { useEffect, useRef, useState } from 'react';
import { api, useAppState } from './api';
import type { NewTask, Page, RecordKind, Task } from './types';
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

export default function App() {
  const { state, error, loading, refresh } = useAppState();
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
  useEffect(() => {
    if (!state) return;
    if (notificationIds.current === null) { notificationIds.current = new Set(state.notifications.map(item => item.id)); return; }
    for (const item of state.notifications) {
      if (notificationIds.current.has(item.id)) continue;
      notificationIds.current.add(item.id);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && item.channel === 'in_app') {
        try { new Notification(item.source === 'demo' ? 'Catchable · 演练通知' : 'Catchable · 订座动态', { body: item.message, tag: item.id }); } catch { /* 站内通知保留为可靠的显示方式。 */ }
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
    if (action === 'abandon') { setNoReservation(false); setAbandonTask(task); return; }
    void perform(action === 'pause' ? `${task.id}:pause` : task.id, async () => {
      if (action === 'delete') return api(`/api/tasks/${encodeURIComponent(task.id)}`, undefined, 'DELETE');
      const result = await api<{ url?: string }>(`/api/tasks/${encodeURIComponent(task.id)}/action`, { action });
      if (action === 'handoff') {
        // 后台在专用浏览器中准备预订；普通新标签只作为官方入口。
        if (result.url && task.source !== 'demo') setNotice({ message: '已准备预订，请在 Catchtable 页面完成确认。' });
      }
      return result;
    }, action === 'delete' ? '任务已删除。' : action === 'start' ? state?.engine.paused ? '任务已启用，但全部监控仍暂停。点击「恢复监控」后开始自动检查。' : '任务已启动，运行结果会显示在动态中。' : action === 'pause' ? '任务已暂停。' : action === 'check' ? '已完成本次检查，请查看任务状态。' : action === 'reconcile' ? '核验已完成，请查看预约记录。' : action === 'continue_auto' ? '已继续处理原预约，后续结果会自动同步到预约记录。' : undefined).catch(() => {});
  }
  async function sessionAction(action: 'open' | 'check', mode: LoginMode = 'manual') {
    const result = await perform('session', () => api<{ session: { message?: string } }>(`/api/session/${action}`, action === 'open' ? { mode } : {}));
    setNotice({ message: result.session.message ?? '登录状态已更新，请查看账号面板。' });
  }
  function engineAction() { void perform('engine', () => api('/api/engine/action', { action: state?.engine.paused ? 'resume_all' : 'pause_all' }), state?.engine.paused ? '已恢复监控。' : '已暂停全部监控。').catch(() => {}); }
  function clearRecords(kind: RecordKind) {
    const labels = { events: '运行动态', notifications: '全部通知', bookings: '已结束预约记录', all: '历史消息记录' };
    void perform('clear-records', () => api('/api/records/clear', { kind }), `${labels[kind]}已清除。`).catch(() => {});
  }
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
    <header className="page-header"><div><h1>{page === 'tasks' ? '把好位置，留给下一顿。' : page === 'bookings' ? '每一次期待，都有记录。' : page === 'notifications' ? '好消息，及时到达。' : '订座这件事，由你掌控。'}</h1><p>{page === 'tasks' ? '粘贴餐厅链接，核验信息，安排下一顿。' : page === 'bookings' ? '查看预订结果，安心安排你的用餐计划。' : page === 'notifications' ? '不错过空位，也看得见每一次提醒。' : '连接账号，设置节奏，随时开始或暂停。'}</p></div><button className="button primary new-task-button" type="button" disabled={pending.has('new-task') || !state} onClick={() => setModal(true)}><Icon name="plus" size={20} />新建订座任务</button></header>
    {error ? <div className="connection-error" role="alert"><Icon name="info" size={20} /><div><strong>本地服务连接失败</strong><span>{error}。{state ? '当前显示上一次读取的状态。' : '请确认后台服务正在运行。'}</span></div><button type="button" className="button small" onClick={() => void refresh()}>重试</button></div> : null}
    {page === 'tasks' ? <>
      <SessionPanel state={state} busy={pending.has('session')} compact onSession={(action, mode) => void sessionAction(action, mode).catch(() => {})} onManage={() => navigate('settings')} />
      <div className="metrics" aria-label="订座统计">{metrics.map(metric => <button type="button" className="metric" key={metric.label} aria-label={`${metric.label} ${state ? metric.value : '—'}，${metric.detail}`} title={metric.detail} disabled={!state} onClick={metric.action}><span className={`metric-dot ${metric.color}`} /><div><span className="metric-label">{metric.label}</span><strong>{state ? metric.value : '—'}</strong><span className="metric-action">{metric.actionLabel}<Icon name="arrow" size={12} /></span></div></button>)}</div>
      <Tasks state={state} loading={loading} pending={pending} filter={taskFilter} onFilter={setTaskFilter} onNew={() => setModal(true)} onDemo={() => void perform('demo', () => api('/api/demo/run', {}), '演练已运行，所有模拟数据已标记。未查询或预订真实餐厅。').catch(() => {})} onEngine={engineAction} onAction={onTaskAction} onDetails={task => setDetailTaskId(task.id)} onLogin={() => navigate('settings')} />
      {state?.tasks.some(task => task.source === 'demo') ? <p className="demo-footnote"><span className="badge demo">演练</span>模拟结果单独标记，不计入真实预约成功。可删除演练任务，历史模拟记录仍会保留。</p> : null}
    </> : page === 'bookings' ? <Bookings state={state} filter={bookingFilter} onFilter={setBookingFilter} onTask={showTask} clearing={pending.has('clear-records')} onClear={() => clearRecords('bookings')} /> : page === 'notifications' ? <Notifications state={state} filter={notificationFilter} onFilter={setNotificationFilter} onTask={showTask} clearing={pending.has('clear-records')} onClear={() => clearRecords('notifications')} /> : <Settings state={state} pending={pending} onSave={settings => perform('settings', () => api('/api/settings', settings), '运行设置已保存。').then(() => {})} onSession={(action, mode) => void sessionAction(action, mode).catch(() => {})} onEngine={engineAction} onClear={() => clearRecords('all')} />}
    <footer className="page-footer">餐厅时间以韩国时间为准 · Asia/Seoul <span>比北京时间快 1 小时</span></footer>
  </main><Activity state={state} clearing={pending.has('clear-records')} onClear={() => clearRecords('events')} />
    {modal ? <NewTaskModal interval={state?.settings.pollIntervalMs ?? 1000} currentDate={state?.engine.currentDate ?? '2026-10-12'} onClose={() => setModal(false)} onCreate={(task: NewTask) => perform('new-task', () => api('/api/tasks', task), '任务已创建，启动后开始检查。').then(() => {})} /> : null}
    {detailTask && state ? <TaskDetails key={detailTask.id} task={detailTask} state={state} onClose={() => setDetailTaskId(null)} onLogin={() => { setDetailTaskId(null); navigate('settings'); }} onRecords={() => { setDetailTaskId(null); navigate('bookings'); }} /> : null}
    {abandonTask ? <Modal title="确认没有完成预约" onClose={() => setAbandonTask(null)} busy={pending.has(abandonTask.id)}><p className="modal-subtitle">请先在 Catchtable 官方 My Dining 核对「{abandonTask.restaurantName}」确实没有预约。确认后，任务回到暂停状态；你可以再点击启动。</p><label className="consent"><input data-autofocus type="checkbox" checked={noReservation} onChange={event => setNoReservation(event.target.checked)} /><span>我已核对官方预约记录，确认没有这笔订单。</span></label><div className="modal-footer"><button type="button" className="button" disabled={pending.has(abandonTask.id)} onClick={() => setAbandonTask(null)}>取消</button><button type="button" className="button primary" disabled={!noReservation || pending.has(abandonTask.id)} onClick={() => { void perform(abandonTask.id, () => api(`/api/tasks/${encodeURIComponent(abandonTask.id)}/action`, { action: 'abandon', noReservationConfirmed: true }), '已记录为未预约，任务回到暂停状态。').then(() => setAbandonTask(null)).catch(() => {}); }}>{pending.has(abandonTask.id) ? '处理中…' : '确认未预约，任务回到暂停'}</button></div></Modal> : null}
    {notice ? <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'info' : 'check'} size={19} /><span>{notice.message}</span><button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示"><Icon name="close" size={16} /></button></div> : null}
  </div>;
}
