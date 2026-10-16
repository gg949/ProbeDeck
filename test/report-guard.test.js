// 回归用例：上报通道服务端防护（v2.13.2-beta1 安全加固）
//   1) HTTP /update 落库频率闸：同一服务器两次历史落库的最小间隔，超频上报丢弃历史写入
//      （仍返回 2xx、仍刷新内存最新状态），正常探针（最密 1s）不受影响；
//   2) /update 未认证连接寿命：匿名连接超过 N 秒仍未完成首次有效鉴权即主动关闭。
// 两项都不改探针协议：探针握手无凭证，鉴权仍在首条上报帧里用 API_SECRET 校验。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createD1Database } from '../server/d1.js';
import { installRuntimeShims } from '../server/runtime.js';
import { initDatabase } from '../src/database/schema.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { handleUpdate } from '../src/handlers/update.js';
import { getWorkerLatestReportUpdates } from '../src/utils/latestReportCache.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';
import {
  AGENT_WS_AUTH_TIMEOUT_MS_DEFAULT,
  REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT
} from '../src/utils/config.js';
import {
  AGENT_WS_AUTH_TIMEOUT_MS_MAX,
  REPORT_MIN_WRITE_INTERVAL_MS_MAX,
  clearReportHistoryWriteGuard,
  releaseReportHistoryWrite,
  resolveAgentWsAuthTimeoutMs,
  resolveReportMinWriteIntervalMs,
  tryReserveReportHistoryWrite
} from '../src/utils/reportGuard.js';

// 与 server/index.js 启动时一致：补 Workers 运行时差异（Response 允许 status 101 等）
installRuntimeShims();

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

// 记录 DO 侧创建的 agent socket（send/close），供未认证连接超时用例断言
const fakeAgentSockets = [];
globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const record = { sent: [], closed: [], listeners: {} };
    const server = {
      accept() {},
      send(message) {
        record.sent.push(message);
      },
      close(code, reason) {
        record.closed.push({ code, reason });
        // 真实 WebSocketPair 的 server 关闭后会派发 close 事件（驱动 DO 侧连接清理）
        record.listeners.close?.();
      },
      addEventListener(type, handler) {
        record.listeners[type] = handler;
      }
    };
    const client = { __fakeClient: true };
    fakeAgentSockets.push(record);
    this['0'] = client;
    this['1'] = server;
  }
};

const API_SECRET = 'report-guard-test-secret';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeBroadcaster(webSockets = [], env = { DB: {} }) {
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() {
      return webSockets;
    },
    storage: {
      async get() {
        return null;
      },
      async put() {}
    }
  }, env);
}

function makeFakeAgentServer() {
  const record = { sent: [], closed: [], listeners: {} };
  return {
    record,
    server: {
      accept() {},
      send(message) {
        record.sent.push(message);
      },
      close(code, reason) {
        record.closed.push({ code, reason });
        // 真实 server socket 关闭后会派发 close 事件（驱动连接清理）
        record.listeners.close?.();
      },
      addEventListener(type, handler) {
        record.listeners[type] = handler;
      }
    }
  };
}

function makeSettingsDb(settingsSource) {
  const readSettings = typeof settingsSource === 'function' ? settingsSource : () => settingsSource;
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return {
            value: JSON.stringify({
              jwt_secret: 'x'.repeat(32),
              ...(readSettings() || {})
            })
          };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        }
      };
    }
  };
}

function makeUpgradeRequest(url) {
  return new Request(url, {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
    }
  });
}

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-report-guard-'));
  return { db: createD1Database(path.join(dir, 'monitor.db')), dir };
}

async function insertServer(db, serverId, historyPartitionId = 1) {
  await db.prepare(
    `INSERT OR REPLACE INTO servers
     (id, name, server_group, history_partition_id, timestamp, report_interval, is_hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(serverId, '频率闸测试机', 'Default', historyPartitionId, Date.now(), 1, '0').run();
}

async function countHistoryRows(db, serverId) {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM metrics_history WHERE server_id = ?').bind(serverId).first();
  return Number(row?.c) || 0;
}

function makeReportRequest(serverId, metrics) {
  return new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: serverId, secret: API_SECRET, metrics })
  });
}

test('落库频率闸：默认值与环境变量解析（0 = 关闭、非法回退、上限收敛）', () => {
  assert.equal(REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT, 500);
  assert.equal(AGENT_WS_AUTH_TIMEOUT_MS_DEFAULT, 60 * 1000);

  assert.equal(resolveReportMinWriteIntervalMs({}), REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT);
  assert.equal(resolveReportMinWriteIntervalMs({ REPORT_MIN_WRITE_INTERVAL_MS: '' }), REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT);
  assert.equal(resolveReportMinWriteIntervalMs({ REPORT_MIN_WRITE_INTERVAL_MS: '2000' }), 2000);
  assert.equal(resolveReportMinWriteIntervalMs({ REPORT_MIN_WRITE_INTERVAL_MS: '0' }), 0);
  assert.equal(resolveReportMinWriteIntervalMs({ REPORT_MIN_WRITE_INTERVAL_MS: '-5' }), 0);
  assert.equal(resolveReportMinWriteIntervalMs({ REPORT_MIN_WRITE_INTERVAL_MS: 'abc' }), REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT);
  assert.equal(
    resolveReportMinWriteIntervalMs({ REPORT_MIN_WRITE_INTERVAL_MS: String(REPORT_MIN_WRITE_INTERVAL_MS_MAX * 10) }),
    REPORT_MIN_WRITE_INTERVAL_MS_MAX
  );

  assert.equal(resolveAgentWsAuthTimeoutMs({}), AGENT_WS_AUTH_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveAgentWsAuthTimeoutMs({ AGENT_WS_AUTH_TIMEOUT_MS: '120000' }), 120000);
  assert.equal(resolveAgentWsAuthTimeoutMs({ AGENT_WS_AUTH_TIMEOUT_MS: '0' }), 0);
  assert.equal(resolveAgentWsAuthTimeoutMs({ AGENT_WS_AUTH_TIMEOUT_MS: 'n/a' }), AGENT_WS_AUTH_TIMEOUT_MS_DEFAULT);
  assert.equal(
    resolveAgentWsAuthTimeoutMs({ AGENT_WS_AUTH_TIMEOUT_MS: String(AGENT_WS_AUTH_TIMEOUT_MS_MAX * 10) }),
    AGENT_WS_AUTH_TIMEOUT_MS_MAX
  );
});

test('落库占位：间隔内拒绝、到期放行、按服务器隔离、失败可归还', () => {
  clearReportHistoryWriteGuard();

  assert.equal(tryReserveReportHistoryWrite('guard-a', 1_000_000, 500), true);
  assert.equal(tryReserveReportHistoryWrite('guard-a', 1_000_100, 500), false);
  assert.equal(tryReserveReportHistoryWrite('guard-a', 1_000_499, 500), false);
  assert.equal(tryReserveReportHistoryWrite('guard-a', 1_000_500, 500), true);
  assert.equal(tryReserveReportHistoryWrite('guard-b', 1_000_500, 500), true);

  // 闸门关闭（0）时永不拦截
  assert.equal(tryReserveReportHistoryWrite('guard-c', 1_000_000, 0), true);
  assert.equal(tryReserveReportHistoryWrite('guard-c', 1_000_001, 0), true);

  // 落库失败归还占位后可以立刻重试
  assert.equal(tryReserveReportHistoryWrite('guard-d', 1_000_000, 500), true);
  releaseReportHistoryWrite('guard-d', 1_000_000);
  assert.equal(tryReserveReportHistoryWrite('guard-d', 1_000_001, 500), true);

  // 归还时时间戳不匹配（已有更新的占位）则不动
  releaseReportHistoryWrite('guard-d', 1_000_000);
  assert.equal(tryReserveReportHistoryWrite('guard-d', 1_000_002, 500), false);

  clearReportHistoryWriteGuard();
});

test('HTTP 上报频率闸：超频上报不落库，但仍返回 200 且刷新实时状态', async () => {
  const { db, dir } = makeTempDb();
  try {
    await initDatabase(db);
    const serverId = 'guard-http-1';
    await insertServer(db, serverId);

    // 统计 metrics_history 插入尝试次数：能区分「被闸门拦掉」与「DB 侧主键去重」
    const insertAttempts = { count: 0 };
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/INSERT INTO metrics_history/i.test(sql)) insertAttempts.count += 1;
      return originalPrepare(sql);
    };

    const env = { DB: db, API_SECRET };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    clearReportHistoryWriteGuard();

    const first = await handleUpdate(makeReportRequest(serverId, { cpu: 10.5, ram_total: 4096, ram_used: 2048 }), env, ctx);
    assert.equal(first.status, 200);
    assert.equal(insertAttempts.count, 1);
    assert.equal(await countHistoryRows(db, serverId), 1);

    // 立刻再来一条（远小于 500ms 闸门）→ 落库被闸门丢弃（连 INSERT 都不会发生）
    const second = await handleUpdate(makeReportRequest(serverId, { cpu: 11.5, ram_total: 4096, ram_used: 2048 }), env, ctx);
    assert.equal(second.status, 200);
    assert.equal(insertAttempts.count, 1);
    assert.equal(await countHistoryRows(db, serverId), 1);

    // 但内存里的最新状态照旧刷新（前端实时推送/回放缓存）
    const cached = getWorkerLatestReportUpdates([serverId])[0];
    assert.ok(cached, '最新上报缓存应存在');
    assert.equal(cached.samples.length, 1);
    assert.equal(Number(cached.samples[0].payload.cpu), 11.5);

    // 间隔到期后正常落库（正常探针最密 1s 一报，不受影响）
    await sleep(1100);
    const third = await handleUpdate(makeReportRequest(serverId, { cpu: 12.5, ram_total: 4096, ram_used: 2048 }), env, ctx);
    assert.equal(third.status, 200);
    assert.equal(insertAttempts.count, 2);
    assert.equal(await countHistoryRows(db, serverId), 2);

    // env 显式 0 = 关闭闸门 → 立刻再来一条会走到 INSERT（同一秒内同服务器历史 id 相同，
    // 由 metrics_history 主键去重，因此行数不变；这里断言的是「闸门确实放行了」）
    const disabledEnv = { ...env, REPORT_MIN_WRITE_INTERVAL_MS: '0' };
    const fourth = await handleUpdate(makeReportRequest(serverId, { cpu: 13.5, ram_total: 4096, ram_used: 2048 }), disabledEnv, ctx);
    assert.equal(fourth.status, 200);
    assert.equal(insertAttempts.count, 3);
  } finally {
    clearReportHistoryWriteGuard();
    try {
      db.close?.();
    } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未认证的 /update 连接超过寿命后主动关闭（错误帧 + 1008）', async () => {
  const broadcaster = makeBroadcaster();
  const { server, record } = makeFakeAgentServer();

  const ws = broadcaster._acceptStandardAgentWebSocket(
    server,
    { kind: 'agent-report', authenticated: false, serverId: '' },
    { authTimeoutMs: 20 }
  );
  assert.equal(broadcaster.standardAgentWebSocketCount, 1);
  assert.equal(record.closed.length, 0);

  await sleep(80);

  assert.equal(record.closed.length, 1);
  assert.equal(record.closed[0].code, 1008);
  const frames = record.sent.map(message => JSON.parse(message));
  const error = frames.find(frame => frame.type === 'error');
  assert.ok(error, '应下发 error 帧');
  assert.equal(error.error, 'Authentication timeout');
  assert.equal(error.code, 408);
  assert.equal(ws.deserializeAttachment().authenticated, false);
});

test('完成首次有效鉴权后不再被超时关闭（正常探针路径）', async () => {
  const broadcaster = makeBroadcaster();
  const { server, record } = makeFakeAgentServer();

  const ws = broadcaster._acceptStandardAgentWebSocket(
    server,
    { kind: 'agent-report', authenticated: false, serverId: '' },
    { authTimeoutMs: 20 }
  );
  // 模拟首条上报通过 API_SECRET 校验后的状态（_resolveAgentContext 会这样写 attachment）
  ws.serializeAttachment({ ...ws.deserializeAttachment(), authenticated: true, serverId: 'guard-ws-1' });

  await sleep(80);

  assert.equal(record.closed.length, 0);
  assert.equal(broadcaster.standardAgentWebSocketCount, 1);
});

test('寿命设为 0（关闭）时不主动关闭未认证连接', async () => {
  const broadcaster = makeBroadcaster();
  const { server, record } = makeFakeAgentServer();

  broadcaster._acceptStandardAgentWebSocket(
    server,
    { kind: 'agent-report', authenticated: false, serverId: '' },
    { authTimeoutMs: 0 }
  );

  await sleep(60);
  assert.equal(record.closed.length, 0);
});

test('DO 按环境变量关闭匿名 /update 连接（真实升级路径）', async () => {
  clearSiteSettingsCache();
  fakeAgentSockets.length = 0;
  const currentHour = new Date().getUTCHours();
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb({ wss_report_enabled: 'true', wss_report_hours: [currentHour] }),
    AGENT_WS_AUTH_TIMEOUT_MS: '20'
  });

  const response = await broadcaster._handleAgentReportWebSocket(
    makeUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );

  assert.equal(response.status, 101);
  assert.equal(fakeAgentSockets.length, 1);
  const record = fakeAgentSockets[0];
  // 握手后立刻收到 hello，但没有任何有效鉴权
  assert.ok(record.sent.some(message => JSON.parse(message).type === 'hello'));

  await sleep(80);

  assert.equal(record.closed.length, 1);
  assert.equal(record.closed[0].code, 1008);

  // 未认证连接已被清理，不再占用连接额度
  assert.equal(broadcaster.standardAgentWebSocketCount, 0);
});
