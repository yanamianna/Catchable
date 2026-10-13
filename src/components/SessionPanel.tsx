import { useEffect, useState } from 'react';
import type { AppState } from '../types';
import { api, formatTime } from '../api';
import { Icon } from './Icon';

export type LoginMode = 'manual' | 'controlled';
export type SessionAction = (action: 'open' | 'check', mode?: LoginMode) => void;
const labels: Record<string, string> = { closed: '浏览器未连接', manual_login: '等待手动登录', profile_in_use: '请先关闭专用窗口', connecting: '正在连接', authenticated: '已核验登录', unauthenticated: '未登录', oauth_blocked: 'Google 登录受阻', unknown: '登录状态待核验' };

export function SessionPanel({ state, busy, onSession, compact = false, onManage }: { state: AppState | null; busy: boolean; onSession: SessionAction; compact?: boolean; onManage?: () => void }) {
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
  const guidance = Array.isArray(session?.guidance) ? session.guidance.filter((item): item is string => typeof item === 'string') : [];
  const extraGuidance = status === 'manual_login' ? guidance.filter(item => !item.includes('打开普通登录窗口') && !item.includes('登录完成后')) : guidance;
  const manual = session?.browserMode === 'manual' || status === 'manual_login';
  const [pairingCode, setPairingCode] = useState('');
  const [extensionPath, setExtensionPath] = useState('<项目目录>\\extension');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingMessage, setPairingMessage] = useState('');
  useEffect(() => { setPairingCode(''); setPairingMessage(''); }, [integration]);
  async function showPairingCode() {
    setPairingBusy(true); setPairingMessage('');
    try {
      const result = await api<{ pairingCode: string; extensionPath: string }>('/api/extension/pairing');
      if (typeof result.pairingCode !== 'string' || !result.pairingCode) throw new Error('本地服务未返回配对码，请重试。');
      setPairingCode(result.pairingCode);
      if (typeof result.extensionPath === 'string' && result.extensionPath) setExtensionPath(result.extensionPath);
    } catch (cause) { setPairingMessage(cause instanceof Error ? cause.message : '读取配对码失败，请检查本地服务后重试。'); }
    finally { setPairingBusy(false); }
  }
  async function copyPairingCode() {
    try { await navigator.clipboard.writeText(pairingCode); setPairingMessage('配对码已复制，请粘贴到 Chrome 扩展弹窗。'); }
    catch { setPairingMessage('浏览器未能复制配对码，请允许剪贴板权限后重试。'); }
  }
  const sessionDisabled = busy || !state || (isExtension && !extensionConnected);
  return <section className={`session-panel ${compact ? 'compact' : 'settings-card'}`} aria-label="Catchtable 登录状态" aria-busy={busy}>
    <div className="session-heading"><span className="account-icon"><Icon name={status === 'authenticated' ? 'check' : 'link'} size={24} /></span><div className="session-heading-copy"><h2>Catchtable 登录状态</h2><p>{status === 'authenticated' ? `当前会话已通过登录核验${accountLabel ? `（${accountLabel}）` : ''}。` : isExtension ? extensionConnected ? '扩展已连接，请在当前 Chrome 页面登录后核验账号。' : '先在 Chrome 安装并配对扩展，再核验当前页面的登录。' : status === 'profile_in_use' ? '网站登录与系统连接分开核验；当前专用窗口仍占用资料。' : '在专用窗口完成登录，再连接账号进行核验。'}</p></div><span className={`status status-${status === 'authenticated' ? 'confirmed' : status === 'oauth_blocked' || status === 'profile_in_use' ? 'auth_required' : 'paused'}`}><span />{busy ? '正在处理…' : isExtension && !extensionConnected ? '扩展未连接' : labels[status] ?? '状态待核验'}</span></div>
    <p className="session-message" role="status">{isExtension && !extensionConnected ? state?.extension?.message || '完成下方扩展安装与配对后，才能打开 Catchtable 和核验扩展登录。' : session?.message ?? '尚未连接登录浏览器。'}</p>
    <div className="session-meta"><span>预约浏览器：{browserName}（{channel}）</span><span>{isExtension ? '登录资料' : '专用资料'}：{profileLabel}</span><span>{isExtension ? extensionConnected ? `Chrome 扩展已连接${state?.extension?.clientName ? ` · ${state.extension.clientName}` : ''}` : 'Chrome 扩展未连接' : manual ? '普通手动登录窗口' : session?.browserOpen ? '监控窗口已连接' : '监控窗口未连接'}</span><span>最近核验：{formatTime(checkedAt)}</span></div>
    <div className="session-buttons"><button type="button" className="button primary-outline" disabled={sessionDisabled} onClick={() => isExtension ? onSession('open') : onSession('open', 'manual')}><Icon name="external" size={16} />{isExtension ? '打开 Chrome 中的 Catchtable' : '打开普通登录窗口'}</button><button type="button" className="button" disabled={sessionDisabled} onClick={() => onSession('check')}><Icon name="refresh" size={16} />{busy ? '正在核验…' : isExtension ? '核验扩展登录' : '连接并核验登录'}</button>{onManage ? <button type="button" className="text-button" onClick={onManage}>登录帮助<Icon name="arrow" size={14} /></button> : null}</div>
    {isExtension ? <details className="login-help" open={!extensionConnected || !compact}><summary>Chrome 扩展安装与配对</summary><ol><li>在 Chrome 打开 <code>chrome://extensions</code>，开启「开发者模式」，点击「加载已解压的扩展程序」，选择下方目录。</li><li>点击「显示配对码」并复制。在 Chrome 工具栏打开本扩展，把本机配对码粘贴到弹窗并连接。</li><li>连接后点击「打开 Chrome 中的 Catchtable」，在同一窗口完成登录，再点击「核验扩展登录」。</li></ol><label className="field">本地扩展安装目录<input type="text" readOnly value={extensionPath} autoComplete="off" /></label><div className="settings-actions"><button type="button" className="button small" disabled={pairingBusy} onClick={() => void showPairingCode()}>{pairingBusy ? '正在读取…' : '显示配对码'}</button>{pairingCode ? <button type="button" className="button small" onClick={() => void copyPairingCode()}>复制配对码</button> : null}</div>{pairingCode ? <label className="field">本机配对码<input type="password" readOnly value={pairingCode} autoComplete="off" spellCheck={false} /><span className="field-help">配对码只用于连接此本机服务，请勿公开或放入截图。</span></label> : null}{pairingMessage ? <p role="status">{pairingMessage}</p> : null}<p>安装时需要你在 Chrome 中授权 debugger、tabs 和 storage 权限，用于操作 Catchtable 页面及保存配对设置。标准 Chrome 调试横幅是预期提示；无需复制登录 cookie 或个人浏览器资料。</p><p>Chrome 保持打开即可，无需关闭浏览器或另开专用小窗口。账号过期时在当前 Catchtable 窗口手动登录，再回到系统核验。</p></details> : <details className="login-help" open={status === 'oauth_blocked' || status === 'profile_in_use' || !compact}>
      <summary>登录步骤与其他登录方式</summary><ol><li>打开普通登录窗口，在 Catchtable 自行完成 Google 或网站提供的其他登录。</li><li>登录完成后关闭整个专用 Edge/Chrome 窗口，包括其中的控制台及空白标签。无需退出账号。</li><li>从 Codex 内的本地控制台，或其他普通浏览器打开本系统，再点击「连接并核验登录」。</li></ol>
      {extraGuidance.length ? <ul>{extraGuidance.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
      <p>Google 可能拒绝受控浏览器。普通手动登录使用独立的本地会话；也可以在下方窗口选择 Catchtable 提供的电子邮件登录。</p>
      <button type="button" className="button small" disabled={busy || !state} onClick={() => onSession('open', 'controlled')}>打开其他登录方式窗口</button>
    </details>}
  </section>;
}
