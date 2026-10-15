import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../types';
import { api, formatTime } from '../api';
import { Icon } from './Icon';

export type LoginMode = 'manual' | 'controlled';
export type SessionAction = (action: 'open' | 'check', mode?: LoginMode) => void;
const labels: Record<string, string> = { closed: '浏览器未连接', manual_login: '等待手动登录', profile_in_use: '请先关闭专用窗口', connecting: '正在连接', authenticated: '已核验登录', unauthenticated: '未登录', oauth_blocked: 'Google 登录受阻', unknown: '登录状态待核验' };

export function SessionPanel({ state, accountId, busy, onSession, compact = false, onManage }: { state: Pick<AppState, 'settings' | 'session' | 'extension'> | null; accountId?: string; busy: boolean; onSession: SessionAction; compact?: boolean; onManage?: () => void }) {
  const session = state?.session;
  const integration = state?.settings.browserIntegration ?? session?.browserIntegration ?? 'extension';
  const isExtension = integration === 'extension';
  const extensionConnected = state?.extension?.connected === true;
  const status = isExtension && !extensionConnected ? 'closed' : session?.status ?? (session?.authenticated === true ? 'authenticated' : session?.connected ? 'unknown' : 'closed');
  const checkedAt = typeof session?.checkedAt === 'string' ? session.checkedAt : session?.lastCheckedAt;
  const accountLabel = typeof session?.accountLabel === 'string' ? session.accountLabel : '';
  const channel = isExtension ? 'chrome' : session?.browserChannel ?? state?.settings.browserChannel ?? 'msedge';
  const browserName = isExtension ? 'Google Chrome' : session?.browserName || (channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge');
  const profileLabel = isExtension ? session?.profileLabel || '当前 Chrome 登录资料' : session?.profileLabel || '连接后显示';
  const [pairingCode, setPairingCode] = useState('');
  const [extensionPath, setExtensionPath] = useState('<项目目录>\\extension');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingMessage, setPairingMessage] = useState('');
  const pairingRequest = useRef(0);
  useEffect(() => { pairingRequest.current++; setPairingCode(''); setPairingMessage(''); setPairingBusy(false); return () => { pairingRequest.current++; }; }, [integration, accountId]);
  async function showPairingCode() {
    const request = ++pairingRequest.current;
    setPairingBusy(true); setPairingMessage('');
    try {
      if (!accountId || accountId === 'all') throw new Error('请先选择一个账号。');
      const result = await api<{ pairingCode: string; extensionPath: string }>(`/api/accounts/${encodeURIComponent(accountId)}/pairing`);
      if (request !== pairingRequest.current) return;
      if (typeof result.pairingCode !== 'string' || !result.pairingCode) throw new Error('本地服务未返回配对码，请重试。');
      setPairingCode(result.pairingCode);
      if (typeof result.extensionPath === 'string' && result.extensionPath) setExtensionPath(result.extensionPath);
    } catch (cause) { if (request === pairingRequest.current) setPairingMessage(cause instanceof Error ? cause.message : '读取配对码失败，请重试。'); }
    finally { if (request === pairingRequest.current) setPairingBusy(false); }
  }
  async function copyPairingCode() {
    try { await navigator.clipboard.writeText(pairingCode); setPairingMessage('配对码已复制，请粘贴到 Chrome 扩展弹窗。'); }
    catch { setPairingMessage('浏览器未能复制配对码，请允许剪贴板权限后重试。'); }
  }
  const sessionDisabled = busy || !state || !accountId || (isExtension && !extensionConnected);
  const message = isExtension && !extensionConnected ? state?.extension?.message || '在登录设置中安装并配对扩展。' : session?.message;
  const needsSetup = isExtension ? !extensionConnected : ['closed', 'manual_login', 'profile_in_use', 'oauth_blocked'].includes(status);
  return <section className={`session-panel ${compact ? 'compact' : 'settings-card'}`} aria-label="Catchtable 登录状态" aria-busy={busy}>
    <div className="session-heading"><span className="account-icon"><Icon name={status === 'authenticated' ? 'check' : 'link'} size={24} /></span><div className="session-heading-copy"><h2>Catchtable 登录</h2>{status === 'authenticated' && accountLabel ? <p>{accountLabel}</p> : null}</div><span className={`status status-${status === 'authenticated' ? 'confirmed' : status === 'oauth_blocked' || status === 'profile_in_use' ? 'auth_required' : 'paused'}`}><span />{busy ? '正在处理…' : isExtension && !extensionConnected ? '扩展未连接' : labels[status] ?? '状态待核验'}</span></div>
    {status !== 'authenticated' && message ? <p className="session-message" role="status">{message}</p> : null}
    <div className="session-meta"><span>{isExtension ? extensionConnected ? 'Chrome 扩展已连接' : 'Chrome 扩展未连接' : `${browserName}${session?.connected ? '已连接' : '未连接'}`}</span><span>最近核验：{formatTime(checkedAt)}</span></div>
    <div className="session-buttons"><button type="button" className="button" disabled={sessionDisabled} onClick={() => onSession('check')}><Icon name="refresh" size={16} />{busy ? '正在核验…' : isExtension ? '核验扩展登录' : '核验登录'}</button></div>
    <details className="login-help" open={needsSetup}><summary>登录设置</summary>
      {isExtension ? <><ol><li>Chrome 打开 <code>chrome://extensions</code>，开启开发者模式，加载下方目录。</li><li>复制本机配对码到扩展弹窗，点击连接。</li><li>在 Chrome 登录 Catchtable，然后核验登录。</li></ol><label className="field">扩展目录<input type="text" readOnly value={extensionPath} autoComplete="off" /></label><div className="settings-actions"><button type="button" className="button small" disabled={pairingBusy} onClick={() => void showPairingCode()}>{pairingBusy ? '正在读取…' : '显示配对码'}</button>{pairingCode ? <button type="button" className="button small" onClick={() => void copyPairingCode()}>复制配对码</button> : null}</div>{pairingCode ? <label className="field">本机配对码<input type="password" readOnly value={pairingCode} autoComplete="off" spellCheck={false} /></label> : null}{pairingMessage ? <p role="status">{pairingMessage}</p> : null}<p className="field-help">Chrome 保持打开；登录过期时在原窗口重新登录。</p></> : <p>在专用窗口登录，关闭专用窗口后回到这里核验。</p>}
      <div className="session-buttons"><button type="button" className="button small" disabled={sessionDisabled} onClick={() => isExtension ? onSession('open') : onSession('open', 'manual')}><Icon name="external" size={15} />{isExtension ? '打开 Chrome 中的 Catchtable' : '打开普通登录窗口'}</button>{!isExtension ? <button type="button" className="button small" disabled={busy || !state} onClick={() => onSession('open', 'controlled')}>其他登录方式</button> : null}{onManage ? <button type="button" className="text-button" onClick={onManage}>连接方式设置</button> : null}</div>
      <p className="field-help">{browserName} · {profileLabel}</p>
    </details>
  </section>;
}
