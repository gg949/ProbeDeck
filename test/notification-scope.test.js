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

// v2.12.0：通知服务器范围——范围外的服务器不进入告警状态（离线告警 / 到期提醒 / 流量报告共用范围字段格式）
// 注：initDatabase 带模块级初始化标志，同一进程只能初始化一个库；
//    因此本用例单独占一个测试文件，避免与 offline-notify.test.js 共用进程时拿不到建表。

const SCOPE_ID = 'scope-a';
const OUT_ID = 'scope-b';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-scope-test-'));
  return { db: createD1Database(path.join(dir, 'monitor.db')), dir };
}

async function readAlertState(db) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind('alert_state').first();
  return row ? JSON.parse(row.value) : null;
}

test('offline alert scope only covers selected servers', async () => {
  const { db, dir } = makeTempDb();
  try {
    await initDatabase(db);

    await db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind('site_options', JSON.stringify({
      username: 'admin',
      tg_notify: '3',
      notification_timezone: 'Asia/Shanghai',
      offline_notify_scope: SCOPE_ID,
      notification_custom_script: 'async function sendMessage(message, title) { return true; }'
    })).run();

    const offlineSince = Date.now() - 10 * 60 * 1000;
    const servers = [
      { id: SCOPE_ID, name: '范围内机器', ts: offlineSince },
      { id: OUT_ID, name: '范围外机器', ts: offlineSince + 30000 }
    ];
    for (const item of servers) {
      await db.prepare(
        `INSERT OR REPLACE INTO servers
         (id, name, server_group, history_partition_id, timestamp, report_interval, offline_notify_disabled, is_hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(item.id, item.name, 'Default', 1, item.ts - 3600000, 3, '0', '0').run();
      await db.prepare(
        `INSERT INTO metrics_history
         (id, server_id, timestamp, agent_version, cpu, load_avg, net_in_speed, net_out_speed, net_rx, net_tx, ram_total, ram_used, disk_total, disk_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        buildHistoryId(1, item.ts), item.id, item.ts, 'v1.0.17',
        10.5, '0.1 0.2 0.3', 1000, 2000, 1000000, 2000000, 4096, 2048, 100000, 50000
      ).run();
    }
    clearAllCaches();

    await checkOfflineNodes(db);
    assert.deepEqual(
      await readAlertState(db),
      { [SCOPE_ID]: true },
      '只有范围内的服务器应进入离线告警状态'
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
