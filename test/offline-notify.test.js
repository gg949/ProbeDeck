import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createD1Database } from '../server/d1.js';
import { initDatabase } from '../src/database/schema.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { checkOfflineNodes } from '../src/services/notification.js';
import { clearAllCaches } from '../src/utils/cache.js';

// 回归用例：离线告警/恢复通知的状态存取（v2.11.2 修复的 better-sqlite3 兼容问题）
// 背景：上游把状态写入写成 VALUES ("alert_state", ?)（双引号字符串）——
//   在 CF D1 上会被当作字符串字面量容忍，但在 better-sqlite3（SQLITE_DQS 关闭）上
//   直接抛 `no such column: "alert_state"`，导致离线检测每轮在写状态时中断、告警永远发不出。
// 本用例断言 alert_state 能正常写入/清除；修复前第二个断言会因异常路径而缺失状态。

const SERVER_ID = 'test-offline-1';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-offline-test-'));
  return { db: createD1Database(path.join(dir, 'monitor.db')), dir };
}

async function insertMetrics(db, timestamp) {
  await db.prepare(
    `INSERT INTO metrics_history
     (id, server_id, timestamp, agent_version, cpu, load_avg, net_in_speed, net_out_speed, net_rx, net_tx, ram_total, ram_used, disk_total, disk_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    buildHistoryId(1, timestamp), SERVER_ID, timestamp, 'v1.0.17',
    10.5, '0.1 0.2 0.3', 1000, 2000, 1000000, 2000000, 4096, 2048, 100000, 50000
  ).run();
}

async function readAlertState(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind('alert_state').first();
  return row ? JSON.parse(row.value) : null;
}

test('offline alert state persists on better-sqlite3 and clears after recovery', async () => {
  const { db, dir } = makeTempDb();
  try {
    await initDatabase(db);

    // 站点设置：通知渠道 = 自定义 JS 脚本（非空即视为有目标），离线 3 分钟后告警
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind('site_options', JSON.stringify({
      username: 'admin',
      tg_notify: '3',
      notification_timezone: 'Asia/Shanghai',
      notification_custom_script: 'async function sendMessage(message, title) { return true; }'
    })).run();

    // 服务器：最后上报 = 10 分钟前（超过 3 分钟阈值）
    const offlineSince = Date.now() - 10 * 60 * 1000;
    await db.prepare(
      `INSERT OR REPLACE INTO servers
       (id, name, server_group, history_partition_id, timestamp, report_interval, offline_notify_disabled, is_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(SERVER_ID, '离线测试机', 'Default', 1, offlineSince - 3600000, 3, '0', '0').run();
    await insertMetrics(db, offlineSince);
    clearAllCaches();

    // 第一轮：应标记离线告警状态并（通过脚本渠道）发送
    await checkOfflineNodes(db);
    assert.deepEqual(
      await readAlertState(db),
      { [SERVER_ID]: true },
      '离线告警触发后 alert_state 应持久化为 {serverId:true}'
    );

    // 第二轮：同一离线事件不重复标记
    await checkOfflineNodes(db);
    assert.deepEqual(
      await readAlertState(db),
      { [SERVER_ID]: true },
      '同一离线事件不应重复变更状态'
    );

    // 模拟恢复上报：状态应清除
    clearAllCaches();
    await insertMetrics(db, Date.now());
    clearAllCaches();

    await checkOfflineNodes(db);
    assert.deepEqual(await readAlertState(db), {}, '恢复后 alert_state 应清空');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
