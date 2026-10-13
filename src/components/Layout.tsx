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

export function Activity({ state, clearing = false, onClear }: { state: AppState | null; clearing?: boolean; onClear?: () => void }) {
  const events = state?.events.slice(0, 5) ?? [];
  return <aside className="activity" aria-label="运行动态">
    <div className="activity-heading"><h2>运行动态</h2>{onClear ? <button type="button" className="text-button clear-records" disabled={clearing || !events.length} onClick={onClear}>{clearing ? '清除中…' : '清除动态'}</button> : null}</div>
    {events.length ? <div className="activity-events">{events.map(event => <div className="activity-event" key={event.id}><span className={`activity-dot ${event.level === 'error' ? 'danger' : ['warn', 'warning'].includes(event.level) ? 'warning' : 'green'}`} /><div><p>{event.source === 'demo' ? <span className="badge demo">演练</span> : null}{event.message}</p><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></div></div>)}</div> : <p className="activity-empty">{state ? '暂无运行动态' : '连接本地服务中…'}</p>}
    <div className="activity-help"><Icon name="info" size={20} /><p>支付或验证码需要你处理。</p></div>
    {state?.engine.accountWriteBlocked ? <div className="lock-notice">预订结果待核验，自动提交已暂停。</div> : null}
  </aside>;
}
