import assert from 'node:assert/strict';
import test from 'node:test';

import { timingSafeEqualString } from '../src/utils/common.js';
import {
  isReportTimestampWithinWindow,
  REPORT_TIMESTAMP_PAST_WINDOW_MS,
  REPORT_TIMESTAMP_FUTURE_WINDOW_MS
} from '../src/handlers/update.js';
import { stripVisitorRestrictedFields } from '../src/handlers/dashboard.js';
import { isLoginRateLimited, registerLoginFailure, clearLoginFailures } from '../src/handlers/admin.js';

// 回归用例：v2.11.3 安全加固（封板前安全复核修复）
//  ① 恒时字符串比较（API_SECRET 等敏感值比对，替代 === / !==）
//  ② 上报时间戳 ±60s 漂移窗口（拒绝历史抓包重放 / 时钟异常数据）
//  ③ 访客字段服务端剥离（show_* 关闭时不再随原始接口泄露）
//  ④ 登录失败节流（防在线暴力破解与 PBKDF2 CPU 打满）

test('timingSafeEqualString：恒时比较行为与边界', async () => {
  assert.equal(await timingSafeEqualString('abc123', 'abc123'), true);
  assert.equal(await timingSafeEqualString('abc123', 'abc124'), false);
  assert.equal(await timingSafeEqualString('abc', 'abcd'), false);
  assert.equal(await timingSafeEqualString('', ''), true);
  assert.equal(await timingSafeEqualString('', 'x'), false);
  assert.equal(await timingSafeEqualString(undefined, undefined), false);
  assert.equal(await timingSafeEqualString(null, 'abc'), false);
  assert.equal(await timingSafeEqualString({}, 'abc'), false);
  assert.equal(await timingSafeEqualString(123, '123'), false);
});

test('上报时间戳窗口：边界判定与历史包拒绝', () => {
  const now = 1758163200000; // 固定基准
  assert.equal(isReportTimestampWithinWindow(now, now), true);
  assert.equal(isReportTimestampWithinWindow(now - REPORT_TIMESTAMP_PAST_WINDOW_MS + 1000, now), true);
  assert.equal(isReportTimestampWithinWindow(now - REPORT_TIMESTAMP_PAST_WINDOW_MS - 1000, now), false);
  assert.equal(isReportTimestampWithinWindow(now + REPORT_TIMESTAMP_FUTURE_WINDOW_MS - 1000, now), true);
  assert.equal(isReportTimestampWithinWindow(now + REPORT_TIMESTAMP_FUTURE_WINDOW_MS + 1000, now), false);
  assert.equal(isReportTimestampWithinWindow(now - 3600000, now), false); // 一小时前的历史抓包
  assert.equal(isReportTimestampWithinWindow(now + 86400000, now), false); // 时钟超前一天
  assert.equal(isReportTimestampWithinWindow(0, now), false);
  assert.equal(isReportTimestampWithinWindow('', now), false);
  assert.equal(isReportTimestampWithinWindow('not-a-number', now), false);
});

test('访客字段剥离：show_* 关闭时隐藏价格/到期/流量，开启时保留', () => {
  const restricted = stripVisitorRestrictedFields({
    id: 'a', name: '节点A', tags: '["x"]',
    price: '99.00', currency: '¥', billing_cycle: 'month', auto_renewal: '1',
    expire_date: '2027-01-01 00:00:00', traffic_limit: '1000 GB'
  }, { show_price: 'false', show_expire: 'false', show_tf: 'false' });
  assert.equal('price' in restricted, false);
  assert.equal('currency' in restricted, false);
  assert.equal('billing_cycle' in restricted, false);
  assert.equal('auto_renewal' in restricted, false);
  assert.equal('expire_date' in restricted, false);
  assert.equal('traffic_limit' in restricted, false);
  assert.equal(restricted.name, '节点A');
  assert.equal(restricted.tags, '["x"]'); // tags 属公开展示项，保留

  const enabled = stripVisitorRestrictedFields({
    price: '9.9', expire_date: '2027-01-01', traffic_limit: '100 GB'
  }, { show_price: 'true', show_expire: 'true', show_tf: 'true' });
  assert.equal(enabled.price, '9.9');
  assert.equal(enabled.expire_date, '2027-01-01');
  assert.equal(enabled.traffic_limit, '100 GB');

  assert.equal(stripVisitorRestrictedFields(null, { show_price: 'false' }), null);
});

test('登录失败节流：阈值触发、成功清零与窗口过期', () => {
  const ip = '203.0.113.7';
  clearLoginFailures(ip);
  assert.equal(isLoginRateLimited(ip), false);

  for (let i = 0; i < 10; i++) registerLoginFailure(ip);
  assert.equal(isLoginRateLimited(ip), true);

  clearLoginFailures(ip);
  assert.equal(isLoginRateLimited(ip), false);

  // 窗口过期自动放行
  const t0 = 1700000000000;
  const ip2 = '203.0.113.8';
  clearLoginFailures(ip2);
  for (let i = 0; i < 10; i++) registerLoginFailure(ip2, t0);
  assert.equal(isLoginRateLimited(ip2, t0 + 60 * 1000), true);
  assert.equal(isLoginRateLimited(ip2, t0 + 11 * 60 * 1000), false);

  // 不同 IP 互不影响
  assert.equal(isLoginRateLimited('203.0.113.9', t0 + 60 * 1000), false);
});
