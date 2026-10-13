import { access, mkdir, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const profileProbeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $targetProfile = [IO.Path]::GetFullPath($env:CATCHABLE_PROFILE_PROBE_TARGET).TrimEnd([char[]]'\/')
  $owners = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=') {
      $argument = [regex]::Match($_.CommandLine, '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))')
      if ($argument.Success) {
        $profileValue = @($argument.Groups[1].Value, $argument.Groups[2].Value, $argument.Groups[3].Value) | Where-Object { $_ } | Select-Object -First 1
        try { $candidateProfile = [IO.Path]::GetFullPath($profileValue).TrimEnd([char[]]'\/') } catch { $candidateProfile = '' }
        if ($candidateProfile -eq $targetProfile) {
          [pscustomobject]@{browserName = if ($_.Name -eq 'msedge.exe') { 'Microsoft Edge' } else { 'Google Chrome' }}
        }
      }
    }
  })
  [pscustomobject]@{status = if ($owners.Count) { 'in_use' } else { 'free' }; ownerCount = $owners.Count; browserName = if ($owners.Count) { $owners[0].browserName } else { $null }} | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{status = 'unknown'; ownerCount = 0} | ConvertTo-Json -Compress
}
`;

// Inspect only the exact application profile before Chromium can forward startup
// URLs (including its default about:blank) to an already-running browser.
export async function probeProfileOccupancy({ profileDir, platform = process.platform, runCommand = runFile, env = process.env } = {}) {
  if (!profileDir || platform !== 'win32') return { status: 'unknown', ownerCount: 0 };
  try {
    const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', profileProbeScript], {
      windowsHide: true, shell: false, timeout: 5000, maxBuffer: 16384, encoding: 'utf8',
      env: { ...env, CATCHABLE_PROFILE_PROBE_TARGET: resolve(profileDir) },
    });
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (!['free', 'in_use', 'unknown'].includes(value.status) || !Number.isInteger(value.ownerCount) || value.ownerCount < 0) return { status: 'unknown', ownerCount: 0 };
    if ((value.status === 'free' && value.ownerCount !== 0) || (value.status === 'in_use' && value.ownerCount === 0)) return { status: 'unknown', ownerCount: 0 };
    return { status: value.status, ownerCount: value.ownerCount, ...(['Microsoft Edge', 'Google Chrome'].includes(value.browserName) ? { browserName: value.browserName } : {}) };
  } catch { return { status: 'unknown', ownerCount: 0 }; }
}

const profileWindowProbeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $targetProfile = [IO.Path]::GetFullPath($env:CATCHABLE_WINDOW_PROBE_TARGET).TrimEnd([char[]]'\/')
  $targetName = $env:CATCHABLE_WINDOW_PROBE_BROWSER
  if ($targetName -notin @('chrome.exe', 'msedge.exe')) { throw 'Invalid browser' }
  $owners = @(Get-CimInstance Win32_Process -Filter "Name='$targetName'" | Where-Object {
    if ($_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=') {
      $argument = [regex]::Match($_.CommandLine, '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))')
      if ($argument.Success) {
        $profileValue = @($argument.Groups[1].Value, $argument.Groups[2].Value, $argument.Groups[3].Value) | Where-Object { $_ } | Select-Object -First 1
        try { $candidateProfile = [IO.Path]::GetFullPath($profileValue).TrimEnd([char[]]'\/') } catch { $candidateProfile = '' }
        $candidateProfile -eq $targetProfile
      }
    }
  })
  $visibleWindowCount = 0
  foreach ($owner in $owners) {
    try {
      $browserProcess = Get-Process -Id $owner.ProcessId -ErrorAction Stop
      $browserProcess.Refresh()
      if ($browserProcess.MainWindowHandle -ne [IntPtr]::Zero) { $visibleWindowCount++ }
    } catch {
      if (Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue) { throw }
    }
  }
  [pscustomobject]@{status = if ($visibleWindowCount) { 'visible' } else { 'not_visible' }; ownerCount = $owners.Count; visibleWindowCount = $visibleWindowCount} | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{status = 'unknown'; ownerCount = 0; visibleWindowCount = 0} | ConvertTo-Json -Compress
}
`;

// MainWindowHandle is zero for processes without a visible main window. Inspect
// only the chosen browser and exact application profile, never window titles.
export async function probeProfileWindow({ profileDir, channel, platform = process.platform, runCommand = runFile, env = process.env, timeoutMs = 2500 } = {}) {
  const unknown = { status: 'unknown', ownerCount: 0, visibleWindowCount: 0 };
  if (!profileDir || platform !== 'win32' || !['chrome', 'msedge'].includes(channel)) return unknown;
  try {
    const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', profileWindowProbeScript], {
      windowsHide: true, shell: false, timeout: Math.max(1, Math.min(2500, timeoutMs)), maxBuffer: 16384, encoding: 'utf8',
      env: { ...env, CATCHABLE_WINDOW_PROBE_TARGET: resolve(profileDir), CATCHABLE_WINDOW_PROBE_BROWSER: channel === 'chrome' ? 'chrome.exe' : 'msedge.exe' },
    });
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (!['visible', 'not_visible', 'unknown'].includes(value.status) || !Number.isInteger(value.ownerCount) || value.ownerCount < 0 ||
      !Number.isInteger(value.visibleWindowCount) || value.visibleWindowCount < 0 || value.visibleWindowCount > value.ownerCount) return unknown;
    if ((value.status === 'visible' && value.visibleWindowCount === 0) || (value.status !== 'visible' && value.visibleWindowCount !== 0)) return unknown;
    return { status: value.status, ownerCount: value.ownerCount, visibleWindowCount: value.visibleWindowCount };
  } catch { return unknown; }
}

function manualLaunchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class BrowserProfileInUseError extends Error {
  constructor() {
    super('专用浏览器仍在使用登录资料。请关闭整个专用 Edge/Chrome 窗口，包括其中的 Catchable 控制台和 about:blank 标签，再从 Codex 本地控制台连接。无需退出 Catchtable 账号。');
    this.name = 'BrowserProfileInUseError';
  }
}

export async function initializeSessionRestorePreferences({ profileDir } = {}) {
  if (typeof profileDir !== 'string' || !profileDir.trim()) throw new Error('缺少本系统的专用浏览器目录。');
  const defaultDir = join(resolve(profileDir), 'Default');
  await mkdir(defaultDir, { recursive: true });
  try {
    // Chromium's persisted PrefValueLast is 1, distinct from its LAST enum (2):
    // https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/prefs/session_startup_pref.h
    // New profiles ignore the restore-last-session command-line override.
    await writeFile(join(defaultDir, 'Preferences'), `${JSON.stringify({ session: { restore_on_startup: 1 } })}\n`, { encoding: 'utf8', flag: 'wx' });
    return { initialized: true };
  } catch (error) {
    if (error.code === 'EEXIST') return { initialized: false };
    throw error;
  }
}

export function ordinaryBrowserArguments(profileDir, url = 'https://www.catchtable.net/zh-CN/my/myMain') {
  return [`--user-data-dir=${resolve(profileDir)}`, '--restore-last-session', '--new-window', url];
}

export function officialBrowserCandidates(env = process.env, channel) {
  const roots = [...new Set([env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean))];
  const candidates=[
    ...roots.map((root) => ({ name: 'Microsoft Edge', channel:'msedge', path: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })),
    ...roots.map((root) => ({ name: 'Google Chrome', channel:'chrome', path: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })),
  ];
  return channel===undefined?candidates:candidates.filter(browser=>browser.channel===channel);
}

export async function launchManualBrowser({ profileDir, url = 'https://www.catchtable.net/zh-CN/my/myMain',
  channel, env = process.env, platform = process.platform, accessFile = access, spawnBrowser = spawn,
  windowProbe = probeProfileWindow, now = Date.now, wait = (ms) => new Promise((done) => setTimeout(done, ms)), windowTimeoutMs = 4500 } = {}) {
  if (platform !== 'win32') throw new Error('普通浏览器手动登录目前支持 Windows，请选择受控浏览器和官方电子邮件登录。');
  if (!profileDir) throw new Error('缺少本系统的专用浏览器目录。');
  if(channel!==undefined && !['chrome','msedge'].includes(channel))throw new Error('浏览器选择须为 chrome 或 msedge。');
  const candidates = officialBrowserCandidates(env,channel);
  let browser;
  for (const candidate of candidates) {
    try { await accessFile(candidate.path); browser = candidate; break; } catch { /* Try the next official installation. */ }
  }
  if (!browser) {
    if(channel!==undefined)throw new Error(`未在官方安装目录找到已选择的 ${channel==='chrome'?'Google Chrome':'Microsoft Edge'}。请先安装该浏览器，或在设置中明确选择其他浏览器。`);
    throw new Error('未找到官方安装目录中的 Microsoft Edge 或 Google Chrome，请先安装浏览器。');
  }
  await initializeSessionRestorePreferences({ profileDir });
  const child = spawnBrowser(browser.path, ordinaryBrowserArguments(profileDir, url), {
    detached: true, stdio: 'ignore', windowsHide: false, shell: false,
  });
  let exited;
  let processError;
  const onExit = (code, signal) => { exited = { code, signal }; };
  const onError = (error) => { processError = error; };
  child.once('exit', onExit);
  child.once('error', onError);
  try {
    await new Promise((done, failed) => { child.once('spawn', done); child.once('error', failed); });
    const deadline = now() + Math.max(1, Math.min(4500, windowTimeoutMs));
    while (now() < deadline) {
      let observed;
      try { observed = await windowProbe({ profileDir: resolve(profileDir), channel: browser.channel, env, platform, timeoutMs: Math.min(2500, deadline - now()) }); }
      catch { throw manualLaunchError('MANUAL_WINDOW_PROBE_FAILED', '浏览器进程已创建，但无法核验专用登录窗口是否可见。请检查任务栏后重试。'); }
      if (observed?.status === 'visible' && observed.visibleWindowCount > 0) {
        return { browserName: browser.name, channel: browser.channel, processId: child.pid };
      }
      if (!observed || !['not_visible', 'visible'].includes(observed.status)) {
        throw manualLaunchError('MANUAL_WINDOW_PROBE_FAILED', '浏览器进程已创建，但无法核验专用登录窗口是否可见。请检查任务栏后重试。');
      }
      if (processError || (exited && (exited.code !== 0 || exited.signal))) {
        throw manualLaunchError('MANUAL_LAUNCH_FAILED', `${browser.name} 启动后提前退出，且未发现专用登录窗口。请检查浏览器启动提示后重试。`);
      }
      const remaining = deadline - now();
      if (remaining > 0) await wait(Math.min(150, remaining));
    }
    throw manualLaunchError('MANUAL_WINDOW_NOT_VISIBLE', `已创建 ${browser.name} 进程，但未显示专用登录窗口。请检查任务栏和浏览器首次启动提示后重试。`);
  } finally {
    child.removeListener('exit', onExit);
    child.removeListener('error', onError);
    child.unref();
  }
}
