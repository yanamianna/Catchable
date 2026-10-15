'use strict';
const form = document.querySelector('#connect-form');
const input = document.querySelector('#pairing-code');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
const error = document.querySelector('#error');
let busy = false;
let replacement = null;
const labels = { disconnected: '尚未连接', connecting: '连接中', connected: '已连接本机', error: '需要处理' };
function render(state) {
  const account = document.querySelector('#account-label');
  account.hidden = state.status !== 'connected' || !state.accountLabel;
  account.textContent = account.hidden ? '' : `当前账号：${state.accountLabel}`;
  document.querySelector('#status-label').textContent = labels[state.status] || '尚未连接';
  document.querySelector('#status-message').textContent = state.message || '';
  document.querySelector('#status-dot').dataset.status = state.status;
  connect.disabled = busy || state.status === 'connecting';
  disconnect.disabled = busy || !state.enabled;
}
async function operation(message) {
  error.hidden = true; busy = true; connect.disabled = true; disconnect.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.code === 'ACCOUNT_CONFLICT') {
      replacement = message;
      document.querySelector('#replace-message').textContent = response.message;
      document.querySelector('#replace-binding').hidden = false;
      return;
    }
    if (!response?.ok) throw new Error(response?.message || '扩展暂时不可用。');
    if (message.type === 'connect') { input.value = ''; replacement = null; document.querySelector('#replace-binding').hidden = true; document.querySelector('#manual-pairing').open = false; }
    render(response);
  } catch (caught) { error.textContent = caught.message; error.hidden = false; }
  finally { busy = false; await refresh(); }
}
async function refresh() {
  if (busy) return;
  try { const state = await chrome.runtime.sendMessage({ type: 'status' }); if (state?.ok) render(state); }
  catch { document.querySelector('#status-message').textContent = '暂时无法读取扩展状态，请重新打开扩展。'; }
}
form.addEventListener('submit', (event) => { event.preventDefault(); void operation({ type: 'connect', pairingCode: input.value.trim(), awaitAcknowledgement: true }); });
document.querySelector('#confirm-replace').addEventListener('click', () => { if (replacement && !busy) void operation({ ...replacement, force: true }); });
document.querySelector('#cancel-replace').addEventListener('click', () => { replacement = null; document.querySelector('#replace-binding').hidden = true; });
disconnect.addEventListener('click', () => void operation({ type: 'disconnect' }));
document.querySelector('#open-console').addEventListener('click', () => void operation({ type: 'open_console' }));
void refresh();
setInterval(refresh, 1000);
