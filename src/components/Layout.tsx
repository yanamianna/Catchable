import { formatTime } from '../api';
import type { AppState, Page } from '../types';
import { Icon } from './Icon';

const pages: { id: Page; label: string; icon: string }[] = [
  { id: 'tasks', label: '订座任务', icon: 'calendar' },
  { id: 'bookings', label: '预约记录', icon: 'record' },
  { id: 'notifications', label: '通知中心', icon: 'bell' },
  { id: 'settings', label: '运行设置', icon: 'settings' },
];

export function Sidebar({ page, onNavigate }: { page: Page; onNavigate: (page: Page) => void }) {
  return <aside className="sidebar">
    <a className="brand" href="#tasks" onClick={event => { event.preventDefault(); onNavigate('tasks'); }} aria-label="Catchable 订座任务"><span className="brand-symbol"><Icon name="fork" size={21} /></span><span>catchable</span></a>
    <nav className="main-nav" aria-label="主导航">{pages.map(item => <button type="button" key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}><Icon name={item.icon} size={21} /><span>{item.label}</span></button>)}</nav>
    <div className="sidebar-bottom"><a className="nav-item" href="https://www.catchtable.net/" target="_blank" rel="noreferrer"><Icon name="external" size={20} /><span>Catchtable 国际站</span></a><span className="local-label"><Icon name="monitor" size={20} />本地运行</span></div>
  </aside>;
}

export function Activity({ state }: { state: AppState | null }) {
  const events = state?.events.slice(0, 5) ?? [];
  return <aside className="activity" aria-label="运行动态">
    <h2>运行动态</h2>
    {events.length ? <div className="activity-events">{events.map(event => <div className="activity-event" key={event.id}><span className={`activity-dot ${event.level === 'error' ? 'danger' : ['warn', 'warning'].includes(event.level) ? 'warning' : 'green'}`} /><div><p>{event.source === 'demo' ? <span className="badge demo">演练</span> : null}{event.message}</p><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></div></div>)}</div> : <div className="ready-event"><span className="activity-dot green" /><div><strong>{state ? '系统已就绪' : '连接本地服务中'}</strong><p>{state?.session.connected ? '添加任务，开始期待下一顿' : '连接账号后即可开始'}</p></div><span className="time-now">现在</span></div>}
    <div className="workflow"><h3>订座流程</h3><div className="workflow-step current"><span className="step-dot" /><div><strong>发现空位</strong><p>持续监控餐厅，发现符合条件的空位</p></div><Icon name="arrow" size={17} className="flow-arrow" /></div><div className="workflow-step"><span className="step-dot" /><div><strong>核对条件</strong><p>自动核对日期、时间、人数等条件</p></div><Icon name="arrow" size={17} className="flow-arrow" /></div><div className="workflow-step"><span className="step-dot" /><div><strong>预订并确认</strong><p>按任务方式处理并核验预订结果</p></div></div></div>
    <div className="activity-help"><Icon name="info" size={20} /><p>需要支付或人工确认时，会在这里提醒你。</p></div>
    {state?.engine.accountWriteBlocked ? <div className="lock-notice">有一笔预订结果待核验。账号的自动预订已暂停，请在任务中核验结果。</div> : null}
  </aside>;
}
