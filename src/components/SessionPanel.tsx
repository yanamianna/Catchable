import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../types';
import { api, formatTime } from '../api';
import { ExtensionConnectionError, extensionRequest } from '../extension-connection';
import { Icon } from './Icon';

export type LoginMode = 'manual' | 'controlled';
export type SessionAction = (action: 'open' | 'check', mode?: LoginMode) => Promise<void> | void;
const labels: Record<string, string> = { closed: '浏览器未连接', manual_login: '等待手动登录', profile_in_use: '请先关闭专用窗口', connecting: '正在连接', authenticated: '已核验登录', unauthenticated: '未登录', oauth_blocked: 'Google 登录受阻', identity_mismatch: '登录身份已改变', unknown: '登录状态待核验' };

export function SessionPanel({ state, accountId, bindingLabel, busy, onSession, compact = false, embedded = false, onManage }: { state: Pick<AppState, 'settings' | 'session' | 'extension'> | null; accountId?: string; bindingLabel?: string; busy: boolean; onSession: SessionAction; compact?: boolean; embedded?: boolean; onManage?: () => void }) {
  const session = state?.session;
  const integration = state?.settings.browserIntegration ?? session?.browserIntegration ?? 'extension';
  const isExtension = integration === 'extension';
  const extensionConnected = state?.extension?.connected === true;
  const status = isExtension && !extensionConnected ? 'closed' : session?.status ?? (session?.authenticated === true ? 'authenticated' : session?.connected ? 'unknown' : 'closed');
  const checkedAt = typeof session?.checkedAt === 'string' ? session.checkedAt : session?.lastCheckedAt;
  const accountLabel = typeof session?.accountLabel === 'string' ? session.accountLabel : '';
  const channel = isExtension ? 'chrome' : session?.browserChannel ?? state?.settings.browserChannel ?? 'msedge';
  const browserName = isExtension ? 'Google Chrome' : session?.browserName || (channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge');
  const [pairingCode, setPairingCode] = useState('');
  const [extensionPath, setExtensionPath] = useState('<项目目录>\\extension');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionPhase, setConnectionPhase] = useState('');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [pairingMessage, setPairingMessage] = useState('');
  const [missingExtension, setMissingExtension] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const actionLock = useRef(false);
  const manualAttempt = useRef(false);
  useEffect(() => {
    generation.current++; operation.current?.abort(); operation.current = null; actionLock.current = false;
    manualAttempt.current = false;
    setPairingCode(''); setPairingMessage(''); setPairingBusy(false); setConnectionBusy(false); setConnectionPhase(''); setConnectionMessage(''); setMissingExtension(false); setManualOpen(false);
    return () => { generation.current++; operation.current?.abort(); };
  }, [integration, accountId]);
  async function readPairing(signal?: AbortSignal) {
    if (!accountId || accountId === 'all') throw new Error('请先选择一个账号。');
    const result = await api<{ pairingCode: string; extensionPath: string }>(`/api/accounts/${encodeURIComponent(accountId)}/pairing`, undefined, undefined, signal);
    if (typeof result.pairingCode !== 'string' || !result.pairingCode) throw new Error('未获取到连接码，请重试。');
    return result;
  }
  async function showPairingCode() {
    if (actionLock.current) return;
    actionLock.current = true;
    manualAttempt.current = true;
    const request = generation.current;
    const controller = new AbortController(); operation.current = controller;
    setPairingBusy(true); setPairingMessage('');
    try {
      const result = await readPairing(controller.signal);
      if (request !== generation.current) return;
      setPairingCode(result.pairingCode);
      if (result.extensionPath) setExtensionPath(result.extensionPath);
    } catch (cause) { if (request === generation.current) setPairingMessage(cause instanceof Error ? cause.message : '读取连接码失败。'); }
    finally { if (request === generation.current) { setPairingBusy(false); actionLock.current = false; operation.current = null; } }
  }
  async function copyPairingCode() {
    const request = generation.current;
    try { await navigator.clipboard.writeText(pairingCode); if (request === generation.current) setPairingMessage('已复制。粘贴到对应 Chrome 的扩展中即可。'); }
    catch { if (request === generation.current) setPairingMessage('请直接选中并复制上方连接码。'); }
  }
  async function connectAndCheck() {
    if (actionLock.current || busy || !state || !accountId || accountId === 'all') return;
    actionLock.current = true;
    const request = generation.current;
    const controller = new AbortController(); operation.current = controller;
    const current = () => request === generation.current && !controller.signal.aborted;
    setConnectionBusy(true); setConnectionMessage(''); setPairingMessage(''); setMissingExtension(false);
    try {
      if (isExtension && !extensionConnected) {
        setConnectionPhase('正在连接…');
        const detected = await extensionRequest('status', {}, controller.signal);
        if (!current()) return;
        if (!detected.ok) throw new Error(detected.message || '扩展暂不可用，请重试。');
        const pairing = await readPairing(controller.signal);
        if (!current()) return;
        if (pairing.extensionPath) setExtensionPath(pairing.extensionPath);
        const connect = (force = false) => extensionRequest('connect', { pairingCode: pairing.pairingCode, accountId, accountLabel: bindingLabel || accountId, force }, controller.signal);
        let connected = await connect();
        if (!current()) return;
        if (!connected.ok && connected.code === 'ACCOUNT_CONFLICT') {
          const previous = connected.accountLabel || '其他账号';
          if (!window.confirm(`此 Chrome 已连接「${previous}」。确定改为连接「${bindingLabel || accountId}」？\n原账号会断开；同时运行请使用另一个 Chrome 用户资料。`)) { setConnectionMessage('已保留原账号连接。'); return; }
          connected = await connect(true);
          if (!current()) return;
        }
        if (!connected.ok || connected.status !== 'connected') throw new Error(connected.message || '连接失败，请重试。');
        if (connected.accountId !== accountId) throw new Error('扩展连接的账号不同，请重新连接。');
      }
      if (!current()) return;
      setConnectionPhase('正在核验…');
      await onSession('check');
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ExtensionConnectionError && cause.code === 'EXTENSION_UNAVAILABLE') {
        setMissingExtension(true); setManualOpen(true);
        setConnectionMessage('请在已安装扩展、已登录 Catchtable 的 Chrome 中打开此控制台，再点击连接。');
      } else setConnectionMessage(cause instanceof Error ? cause.message : '连接失败，请重试。');
    } finally { if (current()) { setConnectionBusy(false); setConnectionPhase(''); actionLock.current = false; operation.current = null; } }
  }
  useEffect(() => {
    if (manualOpen && !connectionBusy && !busy && !manualAttempt.current) void showPairingCode();
  }, [manualOpen, connectionBusy, busy]);
  const working = busy || connectionBusy;
  const sessionDisabled = working || pairingBusy || !state || !accountId || accountId === 'all';
  const openDisabled = sessionDisabled || (isExtension && !extensionConnected);
  const message = isExtension && !extensionConnected ? '' : session?.message;
  return <section className={`session-panel ${embedded ? 'embedded' : compact ? 'compact' : 'settings-card'}`} aria-label="Catchtable 登录状态" aria-busy={working}>
    {!embedded ? <div className="session-heading"><span className="account-icon"><Icon name={status === 'authenticated' ? 'check' : 'link'} size={24} /></span><div className="session-heading-copy"><h2>Catchtable 登录</h2>{status === 'authenticated' && accountLabel ? <p>{accountLabel}</p> : null}</div><span className={`status status-${status === 'authenticated' ? 'confirmed' : ['oauth_blocked', 'profile_in_use', 'identity_mismatch'].includes(status) ? 'auth_required' : 'paused'}`}><span />{working ? '正在处理…' : isExtension && !extensionConnected ? '扩展未连接' : labels[status] ?? '状态待核验'}</span></div> : null}
    {status !== 'authenticated' && message ? <p className="session-message" role="status">{message}</p> : null}
    <div className="session-meta">{embedded && accountLabel && extensionConnected ? <span>{accountLabel}</span> : null}<span>{isExtension ? extensionConnected ? 'Chrome 已连接' : 'Chrome 未连接' : `${browserName}${session?.connected ? '已连接' : '未连接'}`}</span><span>最近核验：{formatTime(checkedAt)}</span></div>
    <div className="session-buttons"><button type="button" className={`button ${isExtension && !extensionConnected ? 'primary' : ''}`} disabled={sessionDisabled} onClick={() => void connectAndCheck()}><Icon name={isExtension && !extensionConnected ? 'link' : 'refresh'} size={16} />{working ? connectionPhase || '正在核验…' : isExtension && !extensionConnected ? '连接此浏览器并核验' : '重新核验登录'}</button>{extensionConnected && status !== 'authenticated' ? <button type="button" className="button" disabled={openDisabled} onClick={() => void Promise.resolve(onSession('open')).catch(() => {})}><Icon name="external" size={15} />去 Catchtable 登录</button> : null}</div>
    {connectionMessage ? <p className="session-message" role="status">{connectionMessage}</p> : null}
    {pairingMessage ? <p className="session-message" role="status">{pairingMessage}</p> : null}
    {isExtension ? <details className="login-help" open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}><summary>手动连接</summary><p>在另一个 Chrome 用户资料连接时，输入此账号的连接码。只需连接一次。</p><div className="settings-actions">{pairingBusy ? <span>正在读取连接码…</span> : !pairingCode ? <button type="button" className="button small" disabled={working} onClick={() => void showPairingCode()}>重试读取连接码</button> : null}</div>{pairingCode ? <div className="pairing-code-row"><label className="field">连接码<input type="text" inputMode="numeric" readOnly value={pairingCode} autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /></label><button type="button" className="button small" onClick={() => void copyPairingCode()}>复制</button></div> : null}<details className="extension-install"><summary>首次安装扩展</summary><p>Chrome 打开 <code>chrome://extensions</code>，开启开发者模式，加载此目录：</p><label className="field">扩展目录<input type="text" readOnly value={extensionPath} autoComplete="off" onFocus={event => event.target.select()} /></label><p>安装后刷新本页，点击「连接此浏览器并核验」。</p></details>{missingExtension ? <p className="field-help">每个账号使用独立的 Chrome 用户资料，Chrome 保持打开。</p> : null}</details> : <details className="login-help"><summary>登录设置</summary><p>在专用窗口登录，关闭专用窗口后回到这里核验。</p><div className="session-buttons"><button type="button" className="button small" disabled={sessionDisabled} onClick={() => void Promise.resolve(onSession('open', 'manual')).catch(() => {})}>打开登录窗口</button><button type="button" className="button small" disabled={sessionDisabled} onClick={() => void Promise.resolve(onSession('open', 'controlled')).catch(() => {})}>其他登录方式</button></div></details>}
    {onManage ? <button type="button" className="text-button session-manage" onClick={onManage}>管理账号</button> : null}
  </section>;
}
