import { getLatestMetricsForAllServers } from '../database/schema.js';
import { updateDatabase } from '../database/updateDatabase.js';
import { clearServersListCache, getAllServers } from '../utils/cache.js';
import {
  DEFAULT_NOTIFICATION_TEMPLATE,
  getExpireReminderDays,
  getResourceAlertConfig,
  getResourceAlertRuleThresholds,
  getTgNotifyMinutes,
  loadSiteSettings,
  normalizeExpireNotificationTime,
  normalizeBooleanSetting,
  normalizeNotificationTemplate,
  normalizeNotificationTimezone,
  normalizeNotificationWebhookBody,
  normalizeNotificationWebhookFormat,
  normalizeNotificationWebhookHeaders,
  normalizeNotificationWebhookMethod,
  debug
} from '../utils/settings.js';
import { detectBillingCycle, normalizeBillingCycle, renewExpireDateIfNeeded } from '../utils/serverBilling.js';
import {
  NOTIFICATION_MAX_RETRIES,
  NOTIFICATION_RETRY_DELAY_MS,
  RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE,
  RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE,
  RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT
} from '../utils/config.js';

const RESOURCE_ALERT_STATE_ACTIVE = 'active';
const RESOURCE_ALERT_STATE_RECOVERED = 'recovered';
const RESOURCE_ALERT_STATE_KEY = 'resource_alert_state';
const DAY_MS = 24 * 60 * 60 * 1000;
const TRAFFIC_REPORT_SERVER_BATCH_SIZE = 50;
const TRAFFIC_REPORT_NOTIFICATION_SOFT_LIMIT = 3000;

function isMissingColumnError(error) {
  const message = error?.message || String(error);
  return /no such column|has no column/i.test(message);
}

async function saveTrafficSnapshots(db, snapshots, serverId) {
  const write = () => db.prepare('UPDATE servers SET traffic_snapshots = ? WHERE id = ?')
    .bind(JSON.stringify(snapshots), serverId).run();

  try {
    await write();
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;

    console.warn('[TrafficReport] 检测到数据库字段缺失，尝试升级数据库后重试...');
    const upgrade = await updateDatabase(db);
    if (!upgrade?.success) throw error;
    await write();
  }
}

function getZonedDateParts(timestamp = Date.now(), timezone = 'UTC') {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = normalizeNotificationTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(part => [part.type, part.value])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function formatNotificationTime(timestamp = Date.now(), settings = {}) {
  const parts = getZonedDateParts(timestamp, settings?.notification_timezone);
  if (!parts) return '无效时间';
  const pad = value => String(value).padStart(2, '0');
  return `${Number(parts.year)}/${Number(parts.month)}/${Number(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatLastReportTime(timestamp, settings = {}) {
  if (!timestamp) return '无上报记录';

  return formatNotificationTime(timestamp, settings);
}

function isExpireNotificationTimeDue(settings = {}, timestamp = Date.now()) {
  const parts = getZonedDateParts(timestamp, settings.notification_timezone);
  if (!parts) return false;
  return Number(parts.hour) === Number(normalizeExpireNotificationTime(settings.expire_notification_time));
}

function getZonedDateSerial(timestamp, timezone) {
  const parts = getZonedDateParts(timestamp, timezone);
  if (!parts) return NaN;
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS);
}

function parseDateSerial(dateString) {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return NaN;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function formatDateSerial(serial) {
  const date = new Date(serial * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatTrafficBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function isTrafficReportEnabled(settings, field) {
  return normalizeBooleanSetting(settings?.[field]) === 'true';
}

function formatMegabitsPerSecond(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 Mbps';
  const mbps = number * 8 / 1000 / 1000;
  return `${mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

function formatResourceMetric(metric) {
  const metricLabels = {
    cpu: 'CPU',
    ram: 'RAM',
    disk: 'DISK',
    netIn: '下行网速',
    netOut: '上行网速',
    netTotal: '总网速'
  };
  const label = metricLabels[metric.metric] || metric.metric;
  const valueLabel = metric.mode === 'average' ? '平均' : '当前';
  const value = metric.triggerValue ?? metric.current;
  if (metric.metric === 'cpu' || metric.metric === 'ram' || metric.metric === 'disk') {
    return `${label} ${valueLabel} ${formatPercent(value)} > ${formatPercent(metric.threshold)}`;
  }
  return `${label} ${valueLabel} ${formatMegabitsPerSecond(value)} > ${formatMegabitsPerSecond(metric.threshold)}`;
}

function getResourceMetricLabel(metric) {
  const metricLabels = {
    cpu: 'CPU',
    ram: 'RAM',
    disk: 'DISK',
    netIn: '下行网速',
    netOut: '上行网速',
    netTotal: '总网速'
  };
  return metricLabels[metric?.metric] || metric?.metric || '';
}

function formatResourceMetricValue(metric, value) {
  if (metric?.metric === 'cpu' || metric?.metric === 'ram' || metric?.metric === 'disk') {
    return formatPercent(value);
  }
  return formatMegabitsPerSecond(value);
}

function formatRecoveredResourceMetric(metric) {
  if (!metric || typeof metric !== 'object') return '';
  const label = getResourceMetricLabel(metric);
  const value = metric.current;
  const valueText = formatResourceMetricValue(metric, value);
  const thresholdText = formatResourceMetricValue(metric, metric.threshold);

  return `${label} 当前 ${valueText} < ${thresholdText}`;
}

function parseResourceAlertState(row) {
  if (!row || !row.value) return { signature: '', servers: {} };
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
      return {
        signature: String(parsed.signature || ''),
        servers: parsed.servers
      };
    }
  } catch (_) {}
  return { signature: '', servers: {} };
}

function hasResourceAlertStateEntries(alertState) {
  return alertState && typeof alertState === 'object' && Object.keys(alertState).length > 0;
}

function getD1Changes(result) {
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  return Number.isFinite(changes) && changes > 0 ? changes : 0;
}

export async function clearResourceAlertState(db) {
  if (!db) return false;
  const result = await db.prepare(
    `DELETE FROM settings WHERE key = ?`
  ).bind(RESOURCE_ALERT_STATE_KEY).run();
  return getD1Changes(result) > 0;
}

async function saveResourceAlertState(db, configSignature, alertState, hadStoredState) {
  if (hasResourceAlertStateEntries(alertState)) {
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(RESOURCE_ALERT_STATE_KEY, JSON.stringify({ signature: configSignature, servers: alertState })).run();
    return;
  }

  if (hadStoredState) {
    await clearResourceAlertState(db);
  }
}

function getResourceAlertStateStatus(state) {
  if (!state || typeof state !== 'object') return RESOURCE_ALERT_STATE_ACTIVE;
  return state.status === RESOURCE_ALERT_STATE_RECOVERED
    ? RESOURCE_ALERT_STATE_RECOVERED
    : RESOURCE_ALERT_STATE_ACTIVE;
}

function getResourceAlertStateTimestamp(state, key) {
  if (!state || typeof state !== 'object') return 0;
  const timestamp = Number(state[key] || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function getStoredResourceAlertMetrics(alert) {
  return (alert?.metrics || []).map(m => ({
    metric: m.metric,
    mode: m.mode,
    threshold: m.threshold,
    triggerValue: m.triggerValue ?? m.current
  }));
}

function canRecoverResourceAlert(evaluation) {
  const metrics = Array.isArray(evaluation?.metrics) ? evaluation.metrics : [];
  return metrics.length > 0 && metrics.every(metric => {
    const current = Number(metric?.current);
    const threshold = Number(metric?.threshold);
    return Number.isFinite(current) && Number.isFinite(threshold) && current < threshold;
  });
}

function getResourceAlertRuleIntervalMs(rule) {
  const minutes = Number(rule?.intervalMinutes);
  const normalizedMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  return Math.max(5, normalizedMinutes) * 60 * 1000;
}

function formatCurrentTime(settings = {}) {
  return formatNotificationTime(Date.now(), settings);
}

function getResourceAlertRuleStateKey(rule, serverId) {
  return `${rule.id}:${serverId}`;
}

function getResourceAlertRuleName(rule) {
  return String(rule?.name || '资源负载告警').trim() || '资源负载告警';
}

function getResourceAlertRuleServerIds(rule, servers) {
  const allServerIds = servers.map(server => String(server.id)).filter(Boolean);
  if (!Array.isArray(rule.servers) || rule.servers.length === 0) {
    return allServerIds;
  }

  const allowed = new Set(allServerIds);
  const seen = new Set();
  const ids = [];
  for (const serverId of rule.servers) {
    const id = String(serverId || '').trim();
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function formatConciseResourceMetric(metric, valueKey = 'triggerValue') {
  const label = getResourceMetricLabel(metric);
  const value = metric?.[valueKey] ?? metric?.current;
  return `${label} ${formatResourceMetricValue(metric, value)}`;
}

function buildGroupedResourceAlertEntries(nodes, valueKey = 'triggerValue') {
  const groups = new Map();

  for (const item of Array.isArray(nodes) ? nodes : []) {
    const serverName = String(item?.server?.name || '').trim();
    if (!serverName) continue;

    const sourceMetrics = item.alert?.metrics || item.metrics || [];
    if (!Array.isArray(sourceMetrics) || sourceMetrics.length === 0) continue;

    let group = groups.get(serverName);
    if (!group) {
      group = { serverName, metrics: [], seen: new Set() };
      groups.set(serverName, group);
    }

    for (const metric of sourceMetrics) {
      const text = formatConciseResourceMetric(metric, valueKey);
      if (!text || group.seen.has(text)) continue;
      group.seen.add(text);
      group.metrics.push(text);
    }
  }

  return Array.from(groups.values())
    .filter(group => group.metrics.length > 0)
    .map(group => ({
      serverName: group.serverName,
      text: `${group.serverName}  ${group.metrics.join('  ')}`
    }));
}

function appendResourceAlertNotificationChunks(payloads, entries, options) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  let chunkEntries = [];
  let chunkClients = [];
  const flush = () => {
    if (chunkEntries.length === 0) return;

    const nodeList = chunkEntries.map(entry => entry.text).join('\n');
    payloads.push({
      msg: nodeList,
      context: {
        event: options.event,
        emoji: options.emoji,
        clients: chunkClients,
        count: new Set(chunkClients).size || chunkEntries.length,
        message: nodeList
      }
    });
    chunkEntries = [];
    chunkClients = [];
  };

  for (const entry of entries) {
    const candidateEntries = [...chunkEntries, entry];
    const candidateNodeList = candidateEntries.map(item => item.text).join('\n');
    const candidate = candidateNodeList;
    if (chunkEntries.length > 0 && candidate.length > RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT) {
      flush();
    }
    chunkEntries.push(entry);
    if (entry.serverName) chunkClients.push(entry.serverName);
  }

  flush();
}

export function buildResourceAlertNotificationPayloads(alertNodes, recoveredNodes) {
  const payloads = [];
  appendResourceAlertNotificationChunks(
    payloads,
    buildGroupedResourceAlertEntries(alertNodes, 'triggerValue'),
    {
      event: '资源负载告警',
      emoji: '❌'
    }
  );
  appendResourceAlertNotificationChunks(
    payloads,
    buildGroupedResourceAlertEntries(recoveredNodes, 'current'),
    {
      event: '资源负载恢复',
      emoji: '✅'
    }
  );
  return payloads;
}

async function evaluateResourceAlertRules(stub, ruleRequests) {
  const resultMap = new Map();
  const requests = [];

  for (const item of Array.isArray(ruleRequests) ? ruleRequests : []) {
    const serverIds = Array.isArray(item?.serverIds) ? item.serverIds : [];
    for (let offset = 0; offset < serverIds.length; offset += RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE) {
      requests.push({
        rule: item.rule,
        serverIds: serverIds.slice(offset, offset + RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE)
      });
    }
  }

  for (let offset = 0; offset < requests.length; offset += RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE) {
    const batch = requests.slice(offset, offset + RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE);
    if (batch.length === 0) continue;

    try {
      const response = await stub.fetch('http://internal/evaluate-resource-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rules: batch.map(({ rule, serverIds }) => ({
            ruleId: rule.id,
            serverIds,
            mode: rule.mode,
            windowMinutes: Number(rule.intervalMinutes),
            thresholds: getResourceAlertRuleThresholds(rule)
          }))
        })
      });

      if (!response.ok) {
        console.warn('[ResourceAlert] DO evaluate failed:', response.status);
        continue;
      }

      const result = await response.json();
      for (const item of Array.isArray(result?.results) ? result.results : []) {
        const ruleId = String(item?.ruleId || '').trim();
        if (!ruleId) continue;
        const existing = resultMap.get(ruleId) || {
          alerts: [],
          evaluatedServerIds: [],
          evaluations: []
        };
        existing.alerts.push(...(Array.isArray(item.alerts) ? item.alerts : []));
        existing.evaluatedServerIds.push(...(
          Array.isArray(item.evaluatedServerIds)
            ? item.evaluatedServerIds.map(id => String(id)).filter(Boolean)
            : []
        ));
        existing.evaluations.push(...(
          Array.isArray(item.evaluations)
            ? item.evaluations.filter(evaluation => evaluation && evaluation.serverId)
            : []
        ));
        resultMap.set(ruleId, existing);
      }
    } catch (e) {
      console.warn('[ResourceAlert] DO evaluate failed:', e?.message || e);
    }
  }

  return resultMap;
}

async function fetchWithRetry(url, options, retries = NOTIFICATION_MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, NOTIFICATION_RETRY_DELAY_MS));
      }
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, NOTIFICATION_RETRY_DELAY_MS));
      } else {
        throw e;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/^[\s✅⚠️⏰💌•-]+/u, '')
    .trim();
}

function inferNotificationEvent(msg) {
  const firstLine = String(msg || '').split('\n').find(line => line.trim());
  return stripMarkdown(firstLine || '通知') || '通知';
}

function escapeJsonStringFragment(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

function renderTemplate(template, data, options = {}) {
  const source = String(template || '');
  return source.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = data[key] ?? '';
    return options.jsonString ? escapeJsonStringFragment(value) : String(value);
  });
}

function normalizeNotificationClients(context = {}) {
  const source = Array.isArray(context.clients)
    ? context.clients
    : (context.client ? String(context.client).split(',') : []);
  const clients = source
    .map(client => String(client || '').trim())
    .filter(Boolean);
  if (clients.length > 0) return Array.from(new Set(clients));
  return ['CF Server Monitor'];
}

function inferNotificationEmoji(event) {
  const normalizedEvent = String(event || '');
  if (/恢复|测试|成功/.test(normalizedEvent)) return '✅';
  if (/到期|提醒/.test(normalizedEvent)) return '⚠️';
  if (/离线|告警|失败|异常/.test(normalizedEvent)) return '❌';
  return 'ℹ️';
}

function buildNotificationContext(settings, msg, context = {}) {
  const now = formatCurrentTime(settings);
  const clients = normalizeNotificationClients(context);
  const count = Number.isFinite(Number(context.count)) && Number(context.count) > 0
    ? Number(context.count)
    : clients.length;
  const event = context.event || inferNotificationEvent(msg);
  return {
    title: '💌 Cloudflare Server Monitor',
    event,
    emoji: context.emoji || inferNotificationEmoji(event),
    client: context.client || clients.join(', '),
    clients: clients.join(', '),
    count: String(count),
    message: context.message || String(msg || ''),
    time: context.time || now
  };
}

function formatNotificationMessage(settings, msg, context) {
  const template = normalizeNotificationTemplate(settings?.notification_template || DEFAULT_NOTIFICATION_TEMPLATE);
  return renderTemplate(template, context) || String(msg || '');
}

function parseWebhookHeaders(rawHeaders, context) {
  const raw = renderTemplate(normalizeNotificationWebhookHeaders(rawHeaders), context).trim();
  const headers = {};
  if (!raw) return headers;

  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers must be an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey || /^(host|content-length)$/i.test(normalizedKey)) continue;
      headers[normalizedKey] = String(value ?? '');
    }
    return headers;
  }

  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key || /^(host|content-length)$/i.test(key)) continue;
    headers[key] = line.slice(index + 1).trim();
  }
  return headers;
}

function buildWebhookQueryParams(settings, context) {
  const rawBody = normalizeNotificationWebhookBody(settings.notification_webhook_body);
  try {
    const body = renderTemplate(rawBody, context, { jsonString: true });
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]);
    }
  } catch (_) {}

  const params = new URLSearchParams(renderTemplate(rawBody, context));
  return Array.from(params.entries());
}

function buildWebhookUrl(settings, context, method) {
  const rawUrl = settings.notification_webhook_url;
  const renderedUrl = renderTemplate(String(rawUrl || '').trim(), context);
  if (!renderedUrl) throw new Error('missing webhook url');

  const url = new URL(renderedUrl);
  if (method === 'GET') {
    for (const [key, value] of buildWebhookQueryParams(settings, context)) {
      if (!key) continue;
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildWebhookBody(settings, context, format) {
  const rawBody = normalizeNotificationWebhookBody(settings.notification_webhook_body);
  if (format === 'json') {
    const body = renderTemplate(rawBody, context, { jsonString: true });
    return JSON.stringify(JSON.parse(body));
  }
  if (format === 'form') {
    try {
      const body = renderTemplate(rawBody, context, { jsonString: true });
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed)) {
          params.set(key, String(value ?? ''));
        }
        return params.toString();
      }
    } catch (_) {}
  }
  return renderTemplate(rawBody, context);
}

async function sendCustomWebhookNotification(settings, context) {
  const method = normalizeNotificationWebhookMethod(settings.notification_webhook_method);
  const format = normalizeNotificationWebhookFormat(settings.notification_webhook_format);
  const endpoint = buildWebhookUrl(settings, context, method);
  const headers = parseWebhookHeaders(settings.notification_webhook_headers, context);
  const options = { method, headers };

  if (method !== 'GET') {
    const contentTypeHeader = Object.keys(headers).find(key => key.toLowerCase() === 'content-type');
    if (!contentTypeHeader) {
      headers['Content-Type'] = format === 'json'
        ? 'application/json'
        : (format === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain; charset=utf-8');
    }
    options.body = buildWebhookBody(settings, context, format);
  }

  await fetchWithRetry(endpoint, options);
}

function hasNotificationTarget(settings) {
  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    return String(settings?.notification_webhook_url || '').trim().length > 0;
  }
  return String(settings?.tg_bot_token || '').trim().length > 0;
}

export async function sendNotification(settings, msg, notificationContext = {}) {
  const context = buildNotificationContext(settings || {}, msg, notificationContext);
  const formattedMsg = formatNotificationMessage(settings || {}, msg, context);
  context.notification = formattedMsg;
  const title = context.title;

  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    if (!String(settings?.notification_webhook_url || '').trim()) return "自定义 Webhook 通知失败: 缺少 URL";
    try {
      await sendCustomWebhookNotification(settings, context);
      return;
    } catch (e) {
      return "自定义 Webhook 通知发送失败: " + e.message;
    }
  }

  if(!settings.tg_bot_token) return;
  if(settings.tg_bot_token.indexOf("onebot:") == 0) {
    // OneBot 协议 (QQ 等)，私聊格式: onebot:http://127.0.0.1:3000/send_private_msg?access_token=xxx
    // 群聊格式: onebot:http://127.0.0.1:3000/send_group_msg?access_token=xxx
    let onebotUrl = settings.tg_bot_token.replace("onebot:", "");
    const targetId = settings.tg_chat_id || '';
    const isGroup = onebotUrl.indexOf("send_group_msg") != -1;
    if (!targetId) {
      return "OneBot 通知失败: 缺少 tg_chat_id（私人: QQ号，群: group:群号）";
    }
    try {
      const endpoint = onebotUrl.trim();
      const body = {
        [isGroup ? 'group_id' : 'user_id']: targetId,
        message: [
          {
            type: 'text',
            data: {
              text: `${title}\n${String(formattedMsg || '').replace(/\*/g, '')}\n`
            }
          }
        ]
      };
      await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return "OneBot 通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("open.feishu.cn")) {
    // 飞书机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          msg_type: "interactive",
          card: {
            schema: "2.0",
            header: { template: "blue", title: { content: title, tag: "plain_text" } },
            body: { elements: [{ tag: "markdown", content: formattedMsg }] }
          }
        })
      });
    } catch (e) {
      return "飞书通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("oapi.dingtalk.com") || settings.tg_bot_token.includes("api.dingtalk.com")) {
    // 钉钉机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { title: title, text: formattedMsg }
        })
      });
    } catch (e) {
      return "钉钉通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://api.day.app/") || settings.tg_bot_token.indexOf("bark:") == 0) {
    let barkUrl = settings.tg_bot_token;
    if(barkUrl.indexOf("bark:") == 0) {
      barkUrl = barkUrl.replace("bark:", "");
    }
    try {
      await fetchWithRetry(barkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          markdown: formattedMsg,
          group: "Cloudflare Server Monitor"
        })
      });
    } catch (e) {
      return "Bark通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://qyapi.weixin.qq.com")){
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "text",
          text: {
            content: formattedMsg.replace(/\*/g, '')
          }
        })
      });
    } catch (e) {
      return "企业微信通知发送失败: " + e.message;
    }
  // Server 酱（使用 sendkey）
  }else if(settings.tg_bot_token.includes("https://sctapi.ftqq.com/") || settings.tg_bot_token.indexOf("server:") == 0) {
    let serverUrl = settings.tg_bot_token;
    if(serverUrl.indexOf("server:") == 0) {
      serverUrl = serverUrl.replace("server:", "");
    }
    try {
      await fetchWithRetry(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          desp: formattedMsg
        })
      });
    } catch (e) {
      return "Server酱通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://wxpusher.zjiecode.com/api/send/message/SPT_")) {
    const match = settings.tg_bot_token.match(/\/message\/([^/]+)/);
    const spt = match ? match[1] : null;
    if (!spt) return "WxPusher 通知失败: 无法提取 SPT";
    try {
      await fetchWithRetry("https://wxpusher.zjiecode.com/api/send/message/simple-push", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "content": formattedMsg,
          "summary": title,
          "contentType":3,
          "spt": spt,
        })
      });
    } catch (e) {
      return "WxPusher通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("/message?token=")) {
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          message: formattedMsg,
          priority: 5,
          extras: {
            "client::display": { "contentType": "text/markdown" }
          }
        })
      });
    } catch (e) {
      return "Gotify通知发送失败: " + e.message;
    }
  }else if(settings.tg_chat_id) {
    // Telegram Bot (最后 fallback，通过 chat_id 判断)
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${settings.tg_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.tg_chat_id,
          text: formattedMsg
        })
      });
    } catch (e) {
      return "Telegram 通知发送失败: " + e.message;
    }
  }else {
    return "未知的通知方式";
  }
}

export async function checkOfflineNodes(db) {
  const siteSettings = await loadSiteSettings(db);
  const tgNotifyMinutes = getTgNotifyMinutes(siteSettings.tg_notify);

  if (tgNotifyMinutes === 0 || !hasNotificationTarget(siteSettings)) return;

  try {
    const allServers = await getAllServers(db);
    
    const latestMetricsMap = await getLatestMetricsForAllServers(db);
    
    let alertState = {};
    const stateRes = await db.prepare(
      "SELECT value FROM settings WHERE key = 'alert_state'"
    ).first();
    
    if (stateRes) {
      try {
        alertState = JSON.parse(stateRes.value);
      } catch (e) {
        alertState = {};
      }
    }

    const now = Date.now();
    const offlineThreshold = tgNotifyMinutes * 60 * 1000;
    const offlineNodes = [];
    const recoveredNodes = [];

    for (const s of allServers) {
      if (s.offline_notify_disabled === '1') continue;

      const latestMetrics = latestMetricsMap.get(s.id);
      
      let isOffline = true;
      if (latestMetrics) {
        const diff = now - latestMetrics.timestamp;
        isOffline = diff > offlineThreshold;
      }

      if (isOffline && !alertState[s.id]) {
        offlineNodes.push({
          name: s.name,
          lastReportTime: latestMetrics?.timestamp
        });
        alertState[s.id] = true;
      } else if (!isOffline && alertState[s.id]) {
        recoveredNodes.push(s);
        delete alertState[s.id];
      }
    }

    if (offlineNodes.length > 0 || recoveredNodes.length > 0) {
      await db.prepare(
        'INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(JSON.stringify(alertState)).run();
    }

    if (offlineNodes.length > 0) {
      const nodeList = offlineNodes
        .map(n => `${n.name}  最后上报: ${formatLastReportTime(n.lastReportTime, siteSettings)}`)
        .join('\n');
      const msg = nodeList;
      await sendNotification(siteSettings, msg, {
        event: '节点离线告警',
        emoji: '❌',
        clients: offlineNodes.map(n => n.name),
        count: offlineNodes.length,
        message: nodeList
      });
    }

    if (recoveredNodes.length > 0) {
      const nodeList = recoveredNodes.map(n => n.name).join('\n');
      const msg = nodeList;
      await sendNotification(siteSettings, msg, {
        event: '节点恢复通知',
        emoji: '✅',
        clients: recoveredNodes.map(n => n.name),
        count: recoveredNodes.length,
        message: nodeList
      });
    }
  } catch (e) {
    console.error('离线检测失败:', e);
  }
}

export async function checkResourceAlerts(env) {
  if (!env?.DB || !env?.METRICS_BROADCASTER) return;

  const db = env.DB;
  const siteSettings = await loadSiteSettings(db, { forceRefresh: true });
  if (!hasNotificationTarget(siteSettings)) return;

  const resourceConfig = getResourceAlertConfig(siteSettings);

  if (!resourceConfig.enabled || !resourceConfig.hasRules) {
    await clearResourceAlertState(db);
    return;
  }

  try {
    const allServers = await getAllServers(db);
    if (allServers.length === 0) {
      await clearResourceAlertState(db);
      return;
    }

    const serverMap = new Map(allServers.map(server => [String(server.id), server]));
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const activeMap = new Map();
    const evaluationMap = new Map();
    const configuredRules = [];
    const configuredRuleServers = [];
    const evaluatedRuleServers = [];

    const configSignature = JSON.stringify({
      rules: resourceConfig.rules.map(rule => ({
        id: rule.id,
        name: rule.name,
        metric: rule.metric,
        threshold: rule.threshold,
        servers: rule.servers,
        intervalMinutes: rule.intervalMinutes,
        mode: rule.mode
      }))
    });

    for (const rule of resourceConfig.rules) {
      const serverIds = getResourceAlertRuleServerIds(rule, allServers);
      if (serverIds.length === 0) continue;

      const ruleServers = [];
      for (const serverId of serverIds) {
        const server = serverMap.get(String(serverId));
        if (!server) continue;
        ruleServers.push({
          key: getResourceAlertRuleStateKey(rule, serverId),
          rule,
          server,
          serverId: String(serverId)
        });
      }
      if (ruleServers.length === 0) continue;
      configuredRuleServers.push(...ruleServers);
      configuredRules.push({ rule, serverIds, ruleServers });
    }

    if (configuredRuleServers.length === 0) {
      await clearResourceAlertState(db);
      return;
    }

    const evaluationResults = await evaluateResourceAlertRules(stub, configuredRules);
    for (const { rule, ruleServers } of configuredRules) {
      const result = evaluationResults.get(String(rule.id));
      if (!result) continue;
      const evaluatedServerIdSet = new Set(result.evaluatedServerIds);
      evaluatedRuleServers.push(...ruleServers.filter(item => evaluatedServerIdSet.has(item.serverId)));
      for (const alert of result.alerts) {
        activeMap.set(getResourceAlertRuleStateKey(rule, alert.serverId), { rule, alert });
      }
      for (const evaluation of result.evaluations || []) {
        evaluationMap.set(getResourceAlertRuleStateKey(rule, evaluation.serverId), evaluation);
      }
    }

    const stateRow = await db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    ).bind(RESOURCE_ALERT_STATE_KEY).first();
    const hadStoredState = !!stateRow;
    const parsedState = parseResourceAlertState(stateRow);
    let alertState = parsedState.servers || {};

    const now = Date.now();
    const alertNodes = [];
    const recoveredNodes = [];
    const validStateKeys = new Set(configuredRuleServers.map(item => item.key));
    let stateChanged = hadStoredState && parsedState.signature !== configSignature;

    for (const key of Object.keys(alertState)) {
      if (!validStateKeys.has(key)) {
        delete alertState[key];
        stateChanged = true;
      }
    }

    for (const { key, rule, server } of evaluatedRuleServers) {
      const active = activeMap.get(key);
      const alert = active?.alert;
      const evaluation = evaluationMap.get(key);
      const currentState = alertState[key];
      const currentStatus = currentState
        ? getResourceAlertStateStatus(currentState)
        : '';
      const ruleIntervalMs = getResourceAlertRuleIntervalMs(rule);

      if (alert) {
        const isActiveAlert = currentStatus === RESOURCE_ALERT_STATE_ACTIVE;
        const recoveredAt = currentStatus === RESOURCE_ALERT_STATE_RECOVERED
          ? getResourceAlertStateTimestamp(currentState, 'recoveredAt')
          : 0;
        if (recoveredAt > 0 && now - recoveredAt < ruleIntervalMs) {
          continue;
        }

        if (!isActiveAlert) {
          alertNodes.push({ rule, server, alert });
          alertState[key] = {
            status: RESOURCE_ALERT_STATE_ACTIVE,
            alertAt: now,
            lastTriggeredAt: now,
            metrics: getStoredResourceAlertMetrics(alert)
          };
          stateChanged = true;
        } else {
          const lastTriggeredAt = getResourceAlertStateTimestamp(currentState, 'lastTriggeredAt');
          if (lastTriggeredAt === 0 || now - lastTriggeredAt >= ruleIntervalMs) {
            alertState[key] = {
              ...currentState,
              status: RESOURCE_ALERT_STATE_ACTIVE,
              alertAt: getResourceAlertStateTimestamp(currentState, 'alertAt') || now,
              lastTriggeredAt: now,
              metrics: getStoredResourceAlertMetrics(alert)
            };
            stateChanged = true;
          }
        }
      } else if (currentState) {
        if (currentStatus === RESOURCE_ALERT_STATE_ACTIVE) {
          if (!canRecoverResourceAlert(evaluation)) {
            continue;
          }

          recoveredNodes.push({ rule, server, metrics: evaluation?.metrics || [] });
          alertState[key] = {
            ...currentState,
            status: RESOURCE_ALERT_STATE_RECOVERED,
            recoveredAt: now,
            metrics: evaluation?.metrics || currentState.metrics
          };
          stateChanged = true;
        } else {
          const recoveredAt = getResourceAlertStateTimestamp(currentState, 'recoveredAt');
          if (recoveredAt === 0 || now - recoveredAt >= ruleIntervalMs) {
            delete alertState[key];
            stateChanged = true;
          }
        }
      }
    }

    if (stateChanged) {
      await saveResourceAlertState(db, configSignature, alertState, hadStoredState);
    }

    const notificationPayloads = buildResourceAlertNotificationPayloads(alertNodes, recoveredNodes);
    for (const payload of notificationPayloads) {
      const notificationError = await sendNotification(siteSettings, payload.msg, payload.context);
      if (notificationError) {
        console.warn('[ResourceAlert] notification failed:', notificationError);
      }
    }
  } catch (e) {
    console.error('资源负载告警检测失败:', e);
  }
}

export function calculateTrafficDelta(current, previous) {
  const currentValue = Math.max(0, Number(current) || 0);
  if (previous === null || previous === undefined) return 0;
  const previousValue = Math.max(0, Number(previous) || 0);
  return currentValue >= previousValue ? currentValue - previousValue : currentValue;
}

export function normalizeTrafficSnapshots(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const type of ['daily', 'weekly', 'monthly']) {
      const snapshot = parsed[type];
      if (!snapshot || typeof snapshot !== 'object') continue;
      const time = Number(snapshot.time);
      if (!Number.isFinite(time) || time <= 0) continue;
      result[type] = {
        time,
        rx_bytes: Math.max(0, Number(snapshot.rx_bytes) || 0),
        tx_bytes: Math.max(0, Number(snapshot.tx_bytes) || 0)
      };
    }
    return result;
  } catch (_) {
    return {};
  }
}

export function getTrafficPeriodKeys(timestamp, timezone) {
  const serial = getZonedDateSerial(timestamp, timezone);
  const parts = getZonedDateParts(timestamp, timezone);
  if (!Number.isFinite(serial) || !parts) return null;
  const weekday = ((serial + 4) % 7 + 7) % 7;
  const mondayOffset = (weekday + 6) % 7;
  return {
    daily: formatDateSerial(serial),
    weekly: formatDateSerial(serial - mondayOffset),
    monthly: `${parts.year}-${parts.month}`
  };
}

export function getDueTrafficReportTypes(timestamp, timezone) {
  const keys = getTrafficPeriodKeys(timestamp, timezone);
  if (!keys) return [];
  const parts = getZonedDateParts(timestamp, timezone);
  const serial = getZonedDateSerial(timestamp, timezone);
  const weekday = ((serial + 4) % 7 + 7) % 7;
  const types = [];
  types.push('daily');
  if (weekday === 1) types.push('weekly');
  if (Number(parts.day) === 1) types.push('monthly');
  return types;
}

function isPreviousTrafficPeriod(snapshot, timestamp, type, timezone) {
  const previousTimestamp = Number(snapshot?.time) * 1000;
  if (!Number.isFinite(previousTimestamp) || previousTimestamp >= timestamp) return false;

  const currentKeys = getTrafficPeriodKeys(timestamp, timezone);
  const previousKeys = getTrafficPeriodKeys(previousTimestamp, timezone);
  if (!currentKeys || !previousKeys) return false;

  if (type === 'daily') {
    return parseDateSerial(currentKeys.daily) - parseDateSerial(previousKeys.daily) === 1;
  }
  if (type === 'weekly') {
    return parseDateSerial(currentKeys.weekly) - parseDateSerial(previousKeys.weekly) === 7;
  }
  if (type === 'monthly') {
    const currentParts = getZonedDateParts(timestamp, timezone);
    const previousParts = getZonedDateParts(previousTimestamp, timezone);
    return currentParts && previousParts &&
      (Number(currentParts.year) * 12 + Number(currentParts.month)) -
      (Number(previousParts.year) * 12 + Number(previousParts.month)) === 1;
  }
  return false;
}

async function claimTrafficReportTypes(db, reportTypes, periodKeys) {
  const claimedTypes = [];
  for (const type of reportTypes) {
    const result = await db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE value <> excluded.value
    `).bind(`traffic_report_last_${type}`, periodKeys[type]).run();
    if (result.meta?.changes > 0) claimedTypes.push(type);
  }
  return claimedTypes;
}

async function releaseTrafficReportTypes(db, reportTypes, periodKeys) {
  await Promise.all(reportTypes.map(type => db.prepare(
    'DELETE FROM settings WHERE key = ? AND value = ?'
  ).bind(`traffic_report_last_${type}`, periodKeys[type]).run()));
}

export function updateTrafficSnapshots(value, currentRx, currentTx, timestamp, types, timezone = 'UTC') {
  const snapshots = normalizeTrafficSnapshots(value);
  const nowSeconds = Math.floor(timestamp / 1000);
  const rx = Math.max(0, Number(currentRx) || 0);
  const tx = Math.max(0, Number(currentTx) || 0);
  const usage = {};
  let changed = false;

  for (const type of types) {
    const previous = snapshots[type];
    if (previous && isPreviousTrafficPeriod(previous, timestamp, type, timezone)) {
      usage[type] = {
        rx_bytes: calculateTrafficDelta(rx, previous.rx_bytes),
        tx_bytes: calculateTrafficDelta(tx, previous.tx_bytes)
      };
    }
    snapshots[type] = { time: nowSeconds, rx_bytes: rx, tx_bytes: tx };
    changed = true;
  }
  return { snapshots, usage, changed };
}

export function buildTrafficReportContent(servers, rows, label) {
  const usageByServer = new Map((rows || []).map(row => [row.server_id, row]));
  const lines = [];
  const clients = [];
  let totalRx = 0;
  let totalTx = 0;
  let measuredCount = 0;
  const missingLabels = {
    '每日': '暂无昨日数据',
    '每周': '暂无上周数据',
    '每月': '暂无上月数据'
  };

  for (const server of servers) {
    const usage = usageByServer.get(server.id);
    if (!usage) continue;
    clients.push(server.name);
    if (usage.missing) {
      lines.push(`${server.name}  ${missingLabels[label] || '暂无上一周期数据'}`);
      continue;
    }
    const rx = Math.max(0, Number(usage.rx_bytes) || 0);
    const tx = Math.max(0, Number(usage.tx_bytes) || 0);
    totalRx += rx;
    totalTx += tx;
    measuredCount += 1;
    lines.push(`${server.name}  ↓ ${formatTrafficBytes(rx)} + ↑ ${formatTrafficBytes(tx)}  = ${formatTrafficBytes(rx + tx)}`);
  }

  if (lines.length === 0) return null;
  if (measuredCount > 0) {
    lines.push(`总计  ↓ ${formatTrafficBytes(totalRx)} + ↑ ${formatTrafficBytes(totalTx)}  = ${formatTrafficBytes(totalRx + totalTx)}`);
  }
  return {
    msg: lines.join('\n'),
    context: {
      event: `${label}流量报告`,
      emoji: '📊',
      clients,
      count: clients.length,
      message: lines.join('\n')
    }
  };
}

export function buildTrafficReportPayloads(servers, rows, label, batchSize = TRAFFIC_REPORT_SERVER_BATCH_SIZE) {
  const rowServerIds = new Set((Array.isArray(rows) ? rows : []).map(row => row.server_id));
  const normalizedServers = (Array.isArray(servers) ? servers : [])
    .filter(server => rowServerIds.has(server.id));
  const normalizedBatchSize = Math.max(1, Math.floor(Number(batchSize) || TRAFFIC_REPORT_SERVER_BATCH_SIZE));
  const batches = [];
  let currentBatch = [];

  for (const server of normalizedServers) {
    const candidate = [...currentBatch, server];
    const candidateReport = buildTrafficReportContent(candidate, rows, label);
    const exceedsCount = candidate.length > normalizedBatchSize;
    const exceedsLength = currentBatch.length > 0 &&
      candidateReport?.msg.length > TRAFFIC_REPORT_NOTIFICATION_SOFT_LIMIT;
    if (exceedsCount || exceedsLength) {
      batches.push(currentBatch);
      currentBatch = [server];
    } else {
      currentBatch = candidate;
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const totalBatches = batches.length;
  const payloads = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batchServers = batches[index];
    const report = buildTrafficReportContent(batchServers, rows, label);
    if (!report) continue;
    if (totalBatches > 1) {
      report.context.event = `${label}流量报告（${index + 1}/${totalBatches}）`;
    }
    payloads.push(report);
  }

  return payloads;
}

export async function checkTrafficReports(db, options = {}) {
  const settings = await loadSiteSettings(db);
  const now = Number(options.now || Date.now());
  if (!isTrafficReportEnabled(settings, 'traffic_report_enabled')) return false;
  if (options.scheduled && !isExpireNotificationTimeDue(settings, now)) return false;
  const zonedParts = getZonedDateParts(now, settings.notification_timezone);
  if (options.scheduledMinute !== undefined && Number(zonedParts?.minute) !== Number(options.scheduledMinute)) return false;
  const dueTypes = getDueTrafficReportTypes(now, settings.notification_timezone);
  const requestedTypes = Array.isArray(options.reportTypes) && options.reportTypes.length > 0
    ? new Set(options.reportTypes)
    : null;
  let reportTypes = requestedTypes
    ? dueTypes.filter(type => requestedTypes.has(type))
    : dueTypes;
  if (options.staggered && zonedParts) {
    const baseMinute = 0;
    const slot = Number(zonedParts.minute) - baseMinute;
    const slotType = slot === 0 ? 'daily' : slot === 1 ? 'weekly' : slot === 2 ? 'monthly' : null;
    reportTypes = slotType && dueTypes.includes(slotType) ? [slotType] : [];
  }
  if (reportTypes.length === 0) return false;
  const servers = await getAllServers(db);
  const latestMetrics = await getLatestMetricsForAllServers(db);
  const periodKeys = getTrafficPeriodKeys(now, settings.notification_timezone);
  const claimedReportTypes = await claimTrafficReportTypes(
    db,
    reportTypes,
    periodKeys
  );
  if (claimedReportTypes.length === 0) return false;

  try {
    const usageRows = { daily: [], weekly: [], monthly: [] };

    for (const server of servers) {
      const metrics = latestMetrics.get(server.id);
      if (!metrics) continue;
      const result = updateTrafficSnapshots(
        server.traffic_snapshots,
        metrics.net_rx,
        metrics.net_tx,
        now,
        claimedReportTypes,
        settings.notification_timezone
      );
      for (const type of claimedReportTypes) {
        usageRows[type].push(result.usage[type]
          ? { server_id: server.id, ...result.usage[type] }
          : { server_id: server.id, missing: true });
      }
      if (result.changed) {
        await saveTrafficSnapshots(db, result.snapshots, server.id);
        server.traffic_snapshots = JSON.stringify(result.snapshots);
      }
    }

    if (!hasNotificationTarget(settings)) return true;
    const reports = [
      ...(claimedReportTypes.includes('daily') ? buildTrafficReportPayloads(servers, usageRows.daily, '每日') : []),
      ...(claimedReportTypes.includes('weekly') ? buildTrafficReportPayloads(servers, usageRows.weekly, '每周') : []),
      ...(claimedReportTypes.includes('monthly') ? buildTrafficReportPayloads(servers, usageRows.monthly, '每月') : [])
    ];

    for (const report of reports) {
      const error = await sendNotification(settings, report.msg, report.context);
      if (error) console.warn('[TrafficReport] notification failed:', error);
    }

    return true;
  } catch (error) {
    try {
      await releaseTrafficReportTypes(db, claimedReportTypes, periodKeys);
    } catch (releaseError) {
      console.warn('[TrafficReport] failed to release report claim:', releaseError);
    }
    throw error;
  }
}

export async function checkExpiringServers(db, options = {}) {
  const siteSettings = await loadSiteSettings(db);
  const now = Number(options?.now || Date.now());

  if (options?.scheduled && !isExpireNotificationTimeDue(siteSettings, now)) {
    return false;
  }

  try {
    const allServers = await getAllServers(db);
    const expiringServers = [];
    const reminderDays = getExpireReminderDays(siteSettings.expire_reminder);
    const shouldNotify = reminderDays > 0 && hasNotificationTarget(siteSettings);
    let hasRenewedServers = false;
    const currentDateSerial = getZonedDateSerial(now, siteSettings.notification_timezone);

    for (const s of allServers) {
      if (!s.expire_date) continue;

      const billingCycle = normalizeBillingCycle(detectBillingCycle(s.price) || s.billing_cycle);
      const renewal = renewExpireDateIfNeeded(s.expire_date, billingCycle, s.auto_renewal, now, 1);
      if (renewal.renewed) {
        await db.prepare(
          'UPDATE servers SET expire_date = ?, billing_cycle = ? WHERE id = ?'
        ).bind(renewal.expire_date, billingCycle, s.id).run();
        s.expire_date = renewal.expire_date;
        s.billing_cycle = billingCycle;
        hasRenewedServers = true;
        debug(`[Cron] 服务器 ${s.name} 已自动续费，到期日期更新为 ${s.expire_date}`);
      }

      if (!shouldNotify) continue;

      const expireDateSerial = parseDateSerial(s.expire_date);
      if (!Number.isFinite(expireDateSerial) || !Number.isFinite(currentDateSerial)) continue;

      const days = expireDateSerial - currentDateSerial;

      debug(`[Cron] 检测到服务器 ${s.name} 到期日期 ${s.expire_date}，剩余天数 ${days} 天`);

      if (days > 0 && days <= reminderDays) {
        expiringServers.push({ name: s.name, expire_date: s.expire_date, days });
      }
    }

    if (hasRenewedServers) {
      clearServersListCache();
    }

    if (expiringServers.length > 0) {
      const serverList = expiringServers.map(s => `${s.name}  剩余${s.days}天  ${s.expire_date}`).join('\n');
      const msg = serverList;
      debug(`[Cron] 发送到期提醒通知: ${msg}`);
      await sendNotification(siteSettings, msg, {
        event: '服务器到期提醒',
        emoji: '⚠️',
        clients: expiringServers.map(s => s.name),
        count: expiringServers.length,
        message: serverList
      });
    }
    return true;
  } catch (e) {
    console.error('到期检测失败:', e);
    return false;
  }
}
