// 上报通道服务端防护（安全加固；不改探针协议、不影响正常探针）
//
// 1) 落库频率闸：/update 的 HTTP 上报只校验 API_SECRET 与 ±60s 时间戳窗口，持有密钥
//    的异常探针可以无上限地高频上报，把 SQLite 写放大（每条上报 = 一次 metrics_history
//    插入）。这里给「同一台服务器两次历史落库」设一个最小间隔：间隔内的上报照常返回
//    2xx（不触发探针侧重试放大）、照常刷新内存里的最新状态与前端实时推送，只是不再写
//    历史行。正常探针最密 1 秒一报，默认间隔 500ms（2 倍余量）→ 行为不变。
// 2) 未认证 WSS 连接寿命：/update 的 WebSocket 握手天然无凭证（密钥在首条上报帧里才
//    校验），匿名连接可以一直占着连接额度与内存。这里给一个兜底寿命：超时仍没有完成
//    过任何一次有效鉴权就主动关闭。探针 WSS 上报节奏为 1–5 秒（types.go 的
//    min/maxWSSReportIntervalSec），连上后数秒内必上报，默认 60 秒余量充足。
//
// 两项都可用环境变量覆盖，0 = 关闭：REPORT_MIN_WRITE_INTERVAL_MS / AGENT_WS_AUTH_TIMEOUT_MS。

import {
  AGENT_WS_AUTH_TIMEOUT_MS_DEFAULT,
  REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT
} from './config.js';

// 上限：避免把闸门设得过大（等于让历史长期不落库）。
export const REPORT_MIN_WRITE_INTERVAL_MS_MAX = 10 * 60 * 1000;
export const AGENT_WS_AUTH_TIMEOUT_MS_MAX = 30 * 60 * 1000;

// 跟踪表上限：键一定是真实存在的 serverId（不存在的 id 在落库前就被 404 拦掉），
// 这里只是极端情况下的兜底——超出后整表重置重新计数（仅短暂放宽闸门，不影响正确性）。
export const MAX_TRACKED_REPORT_SERVERS = 4096;
const lastHistoryWriteByServer = new Map();

function resolveEnvMilliseconds(raw, { fallback, max }) {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.min(Math.floor(value), max);
}

// 同一服务器两次历史落库的最小间隔（毫秒）。默认 500；显式 0 = 关闭闸门。
export function resolveReportMinWriteIntervalMs(env = {}) {
  return resolveEnvMilliseconds(env?.REPORT_MIN_WRITE_INTERVAL_MS, {
    fallback: REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT,
    max: REPORT_MIN_WRITE_INTERVAL_MS_MAX
  });
}

// /update 未认证连接的寿命（毫秒）。默认 60000；显式 0 = 关闭超时。
export function resolveAgentWsAuthTimeoutMs(env = {}) {
  return resolveEnvMilliseconds(env?.AGENT_WS_AUTH_TIMEOUT_MS, {
    fallback: AGENT_WS_AUTH_TIMEOUT_MS_DEFAULT,
    max: AGENT_WS_AUTH_TIMEOUT_MS_MAX
  });
}

// 返回 true 表示「这次上报可以落库」，并记下时间戳；返回 false 表示距上次落库不足
// 最小间隔，调用方应丢弃这次历史写入（内存最新状态不受影响）。
export function tryReserveReportHistoryWrite(
  serverId,
  now = Date.now(),
  minIntervalMs = REPORT_MIN_WRITE_INTERVAL_MS_DEFAULT
) {
  const key = String(serverId ?? '').trim();
  if (!key) return true;

  const interval = Number(minIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return true;

  const stamp = Number(now);
  const timestamp = Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now();

  const last = Number(lastHistoryWriteByServer.get(key)) || 0;
  if (last > 0 && timestamp - last < interval) return false;

  if (lastHistoryWriteByServer.size >= MAX_TRACKED_REPORT_SERVERS && !lastHistoryWriteByServer.has(key)) {
    lastHistoryWriteByServer.clear();
  }
  lastHistoryWriteByServer.set(key, timestamp);
  return true;
}

// 落库失败时归还占位（避免一次失败把该服务器接下来的上报全部闸掉）。
export function releaseReportHistoryWrite(serverId, reservedAt = null) {
  const key = String(serverId ?? '').trim();
  if (!key) return;
  const current = lastHistoryWriteByServer.get(key);
  if (current === undefined) return;
  if (reservedAt !== null && Number(current) !== Number(reservedAt)) return;
  lastHistoryWriteByServer.delete(key);
}

// 测试/维护用：清空跟踪表（例如手动需要立刻落库）。
export function clearReportHistoryWriteGuard() {
  lastHistoryWriteByServer.clear();
}
