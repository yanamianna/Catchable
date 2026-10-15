import test from 'node:test';
import assert from 'node:assert/strict';
import { safeMessage } from '../server/domain.mjs';

test('navigation failures become actionable messages without browser logs or terminal escapes', () => {
  const message = safeMessage(new Error('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://www.catchtable.net/shop/fixture\nCall log:\n\x1b[2m - navigating to https://www.catchtable.net/shop/fixture\x1b[22m'));
  assert.equal(message, '浏览器阻止了网络访问，请确认当前 Chrome 可以打开官网后重试。');
  assert.doesNotMatch(message, /page\.goto|Call log|\x1b|https?:/);
  assert.match(safeMessage(new Error('page.goto: net::ERR_CONNECTION_RESET at https://example.invalid/')), /连接中断/);
  assert.match(safeMessage(new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED')), /代理连接失败/);
});

test('timeout and closed-page errors keep recovery guidance while unknown errors stay concise and redacted', () => {
  assert.match(safeMessage(Object.assign(new Error('locator.waitFor: Timeout 15000ms exceeded.\nCall log:\nprivate debug data'), { name: 'TimeoutError' })), /超时/);
  assert.match(safeMessage(new Error('page.goto: Target page, context or browser has been closed')), /重新连接/);
  assert.equal(safeMessage('page.goto: Unknown failure at https://example.invalid/private\nCall log: secret'), 'Unknown failure at [网址]');
  assert.equal(safeMessage('Transport failed ws://127.0.0.1:4174/cdp/private-token\nDetails'), 'Transport failed [网址]');
});

test('application validation and caller fallback messages remain useful', () => {
  assert.equal(safeMessage(new Error('任务不属于指定账号，请刷新后重试。')), '任务不属于指定账号，请刷新后重试。');
  assert.equal(safeMessage(null, '请稍后重试'), '请稍后重试');
  assert.equal(safeMessage('\x1b[2m\x1b[22m', '请稍后重试'), '请稍后重试');
  assert.equal(safeMessage('字'.repeat(800)).length, 500);
});
