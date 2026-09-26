import assert from 'node:assert/strict';
import test from 'node:test';

import { hasResourceAlertNotificationTarget } from '../src/handlers/update.js';

// v2.13.1 回归：只填自定义脚本（无 TG Token / Webhook）也必须视为有效通知目标。
// 此前该判断只认 Webhook/TG Token（与 notification.js 的「脚本优先」不一致），
// 导致「只配脚本 + 无人看面板」时 HTTP 上报走 latestReportOnly 分支、
// 跳过资源告警样本缓存，资源负载告警永不触发。

test('只配自定义脚本即可作为资源告警通知目标（回归）', () => {
  assert.equal(hasResourceAlertNotificationTarget({
    notification_custom_script: 'async function sendMessage(message, title) { return true; }'
  }), true);
});

test('空白自定义脚本不算有效目标', () => {
  assert.equal(hasResourceAlertNotificationTarget({ notification_custom_script: '   ' }), false);
});

test('Webhook 需开启且填了 URL 才算有效目标', () => {
  assert.equal(hasResourceAlertNotificationTarget({
    notification_webhook_enabled: 'true',
    notification_webhook_url: 'https://example.com/hook'
  }), true);
  assert.equal(hasResourceAlertNotificationTarget({
    notification_webhook_enabled: 'true',
    notification_webhook_url: ''
  }), false);
  assert.equal(hasResourceAlertNotificationTarget({
    notification_webhook_enabled: 'false',
    notification_webhook_url: 'https://example.com/hook'
  }), false);
});

test('TG Token 兜底；全空不算有效目标', () => {
  assert.equal(hasResourceAlertNotificationTarget({ tg_bot_token: '123456:abc' }), true);
  assert.equal(hasResourceAlertNotificationTarget({}), false);
});
