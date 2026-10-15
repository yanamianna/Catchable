import { useEffect, useRef, useState } from 'react';
import type { AppState, RestaurantInfo, Task } from '../types';
import { api, formatTime } from '../api';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { RestaurantPreview } from './RestaurantPreview';
import { accountAuthenticated } from './Accounts';

export function TaskDetails({ task, state, onClose, onLogin, onRecords }: { task: Task; state: AppState; onClose: () => void; onLogin: () => void; onRecords: () => void }) {
  const [restaurant, setRestaurant] = useState<RestaurantInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const events = state.events.filter(event => event.taskId === task.id).slice(0, 8);
  const account = state.accounts.find(item => item.id === task.accountId);
  const authenticated = !!account && accountAuthenticated(account);
  async function resolve() {
    if (loading) return;
    setLoading(true); setError('');
    try { const result = await api<{ restaurant: RestaurantInfo }>('/api/restaurants/resolve', { restaurantUrl: task.restaurantUrl, accountId: task.accountId }); if (alive.current) setRestaurant(result.restaurant); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '读取餐厅资料失败，请重试。'); }
    finally { if (alive.current) setLoading(false); }
  }
  return <Modal title={`${task.restaurantName} · 任务详情`} onClose={onClose}>
    <p className="modal-subtitle">{task.lastMessage || '查看用餐条件、检查结果和运行记录。'}</p>
    <dl className="task-detail-grid"><div><dt>预约账号</dt><dd>{task.accountLabel ?? account?.label ?? task.accountId}</dd></div><div><dt>用餐日期 · 韩国时间</dt><dd>{task.dates.join('、')}</dd></div><div><dt>时间与人数</dt><dd>{task.timeStart}–{task.timeEnd} · {task.partySize} 人</dd></div><div><dt>检查间隔</dt><dd>{task.pollIntervalMs}ms{task.lastCheckDurationMs != null ? ` · 最近耗时 ${task.lastCheckDurationMs}ms` : ''}</dd></div><div><dt>最近检查</dt><dd>{formatTime(task.lastCheckedAt, true)} · 累计 {task.checkCount} 次</dd></div><div><dt>登录状态</dt><dd>{authenticated ? '已核验登录' : '尚未核验登录'}{!authenticated ? <button type="button" className="text-button" onClick={onLogin}>连接账号</button> : null}</dd></div><div><dt>监控运行</dt><dd>{account?.engine.paused ? '此账号调度暂停' : task.status === 'active' || task.status === 'backoff' ? '监控已启用' : '当前未自动检查'}</dd></div></dl>
    {task.slots?.length ? <div className="task-detail-section"><h3>最近读取到的空位</h3><p>以最近检查时的页面为准，继续预订时会再次核对。</p><div className="slot-list">{task.slots.map((slot, index) => <span className="slot-chip" key={`${slot.date}-${slot.time}-${index}`}>{slot.date} {slot.time} · {slot.partySize} 人{slot.seatType ? ` · ${slot.seatType}` : ''}</span>)}</div></div> : null}
    <div className="task-detail-section"><div className="task-detail-section-heading"><h3>餐厅资料</h3>{task.source === 'live' ? <button type="button" className="button small" disabled={loading} onClick={() => void resolve()}><Icon name={loading ? 'refresh' : 'search'} size={14} className={loading ? 'spin' : ''} />{loading ? '正在读取…' : restaurant ? '刷新资料' : '核验并查看资料'}</button> : null}</div>{restaurant ? <RestaurantPreview restaurant={restaurant} /> : <p>{task.source === 'demo' ? '本地演练使用固定模拟数据。' : '点击核验，从官方页面读取餐厅信息。'}</p>}{error ? <p className="form-error" role="alert">{error}</p> : null}</div>
    <div className="task-detail-section"><h3>最近运行记录</h3>{events.length ? <ul className="task-event-list">{events.map(event => <li key={event.id}><time>{formatTime(event.createdAt)}</time><span>{event.message}</span></li>)}</ul> : <p>暂无运行记录。</p>}</div>
    <div className="modal-footer"><button type="button" className="button" onClick={onRecords}>查看预约记录</button>{task.source === 'live' ? <a className="button" href={task.restaurantUrl} target="_blank" rel="noreferrer">官方餐厅页<Icon name="external" size={14} /></a> : null}<button type="button" className="button primary" onClick={onClose}>完成</button></div>
  </Modal>;
}
