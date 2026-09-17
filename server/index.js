// ─────────────────────────────────────────────────────────────────────────────
// ProbeDeck · CF-Server-Monitor 的 Docker/VPS 版服务器入口
//
// 把原版 Cloudflare Workers + D1 + Durable Objects 的运行环境在 Node.js
// 单进程内完整模拟，src/ 内的业务代码保持原样：
//
//   Workers fetch/scheduled  → 本文件的 HTTP 服务器与定时器
//   D1 (env.DB)              → better-sqlite3（server/d1.js）
//   Durable Objects          → 单进程实例（server/durable.js + ws-bridge.js）
//   Workers Assets           → dist/ 目录静态文件（server/assets.js）
//   Cron Triggers            → 按 UTC 对齐的 setInterval
//
// 启动：API_SECRET=xxx node server/index.js
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';

import { installRuntimeShims } from './runtime.js';
import { upgradeContext, WebSocketPairShim, WebSocketRequestResponsePairShim } from './ws-bridge.js';
import { createD1Database } from './d1.js';
import { createAssetsService } from './assets.js';
import { createBroadcasterNamespace } from './durable.js';
import { createGeoIpService, extractClientIp } from './geoip.js';

// ── 1) 安装运行时兼容层（必须在业务代码创建 Response/WebSocket 之前）──────
installRuntimeShims();
globalThis.WebSocketPair = WebSocketPairShim;
globalThis.WebSocketRequestResponsePair = WebSocketRequestResponsePairShim;

// ── 2) 路径与配置 ──────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 17986);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
const DIST_DIR = path.resolve(process.env.DIST_DIR || path.join(rootDir, 'dist'));

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── API_SECRET：未设置时自动生成并持久化 ───────────────────────────────────
// 优先使用环境变量；否则读取数据目录中已保存的密钥；再否则随机生成一份并写入
// data/api_secret.txt（重启后保持不变，探针不会失联），同时打印在启动日志里。
function resolveApiSecret() {
  const fromEnv = String(process.env.API_SECRET || '').trim();
  if (fromEnv) return { secret: fromEnv, generated: false };

  const secretFile = path.join(DATA_DIR, 'api_secret.txt');
  try {
    if (fs.existsSync(secretFile)) {
      const saved = fs.readFileSync(secretFile, 'utf8').trim();
      if (saved) return { secret: saved, generated: false };
    }
  } catch (_) {}

  const generated = randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(secretFile, generated + '\n', { mode: 0o600 });
  } catch (_) {}
  return { secret: generated, generated: true };
}

const apiSecretInfo = resolveApiSecret();

// ── 3) 构造 env（对应 wrangler.toml 的绑定与环境变量）──────────────────────
const env = {
  // 环境变量（与原版 Worker 的 vars / secrets 对齐）
  API_SECRET: apiSecretInfo.secret,
  API_USER_NAME: process.env.API_USER_NAME || '',
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || '',
  API_BASE: process.env.API_BASE || '',
  DEBUG: process.env.DEBUG || '',
  HISTORY_RETENTION_DAYS: process.env.HISTORY_RETENTION_DAYS || '',
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || '',
  // 绑定
  DB: createD1Database(path.join(DATA_DIR, 'monitor.db')),
  ASSETS: createAssetsService(DIST_DIR),
};
env.METRICS_BROADCASTER = createBroadcasterNamespace(env, {
  storageFile: path.join(DATA_DIR, 'do-storage.json'),
});

// ── 探针地区识别（MaxMind GeoLite2 / ipinfo.io，复刻 CF 的 cf-ipcountry）──
const geoip = await createGeoIpService({
  provider: process.env.GEOIP_PROVIDER || 'maxmind',
  mmdbPath: process.env.GEOIP_MMDB_PATH || '',
  dataDir: DATA_DIR,
  ipinfoToken: process.env.IPINFO_TOKEN || '',
  builtinDir: path.join(rootDir, 'geoip'),
});

// ── 4) 加载 Worker 业务代码（src/ 保持原样）────────────────────────────────
const worker = (await import('../src/index.js')).default;
const { initDatabase } = await import('../src/database/schema.js');
const { loadSettings } = await import('../src/utils/settings.js');
const { tryHandleCfMigrate } = await import('./cf-migrate.js');

if (typeof worker?.fetch !== 'function') {
  console.error('❌ src/index.js 未导出 fetch 处理函数，请检查代码完整性。');
  process.exit(1);
}

await initDatabase(env.DB);
console.log('✅ 数据库已就绪:', path.join(DATA_DIR, 'monitor.db'));

// ── 5) ctx（waitUntil / passThroughOnException）────────────────────────────
function createCtx() {
  return {
    waitUntil(promise) {
      if (promise && typeof promise.then === 'function') {
        Promise.resolve(promise).catch((e) =>
          console.error('[ctx.waitUntil]', e?.message || e)
        );
      }
    },
    passThroughOnException() {},
  };
}

// ── 6) Node 请求 → Workers Request ─────────────────────────────────────────
async function toFetchRequest(req, { withBody = true } = {}) {
  const proto =
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host =
    String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`)
      .split(',')[0]
      .trim();
  const url = new URL(req.url || '/', `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection' || lower === 'host') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  // GeoIP：复刻 Cloudflare 的 cf-ipcountry 请求头（探针地区自动识别）。
  // src/ 内的更新与心跳逻辑只读取该头，因此在这里注入即可，业务代码零改动。
  if (geoip.enabled && !headers.has('cf-ipcountry')) {
    try {
      const country = await geoip.lookup(extractClientIp(req));
      if (country) headers.set('cf-ipcountry', country);
    } catch (_) {}
  }

  let body;
  if (withBody && req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length > 0) body = Buffer.concat(chunks);
  }

  return new Request(url.toString(), { method: req.method, headers, body });
}

// ── 7) Workers Response → Node 响应 ────────────────────────────────────────
async function writeFetchResponse(res, req, response) {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    try {
      res.setHeader(key, value);
    } catch (_) {}
  });
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  if (setCookies.length > 0) res.setHeader('set-cookie', setCookies);

  if (
    req.method === 'HEAD' ||
    response.status === 204 ||
    response.status === 304 ||
    !response.body
  ) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(response.body);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (_) {}
  });
  stream.pipe(res);
}

// ── 7.5) CORS：对应原版 Workers 的 CORS_ALLOWED_ORIGINS 环境变量 ───────────
function resolveCorsOrigin(req, env) {
  const origin = req.headers.origin || '';
  if (!origin) return '';
  const allowed = String(env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : '';
}

function buildCorsHeaders(origin, req) {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ||
      'Content-Type, Authorization, X-Turnstile-Token, X-Turnstile-Verified'
  );
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

function withCorsHeaders(response, req, env) {
  const origin = resolveCorsOrigin(req, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  buildCorsHeaders(origin, req).forEach((value, key) => headers.set(key, value));
  const vary = headers.get('Vary');
  headers.set('Vary', vary && !/origin/i.test(vary) ? `${vary}, Origin` : 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// ── 8) 拒绝 WebSocket 升级时，直接以裸 socket 写回 HTTP 响应 ───────────────
async function writeRawHttpResponse(socket, response) {
  if (socket.destroyed) return;
  let body = null;
  if (response.body) {
    const chunks = [];
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    if (chunks.length > 0) body = Buffer.concat(chunks);
  }

  const lines = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    lines.push(`${key}: ${value}`);
  });
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  for (const cookie of setCookies) lines.push(`set-cookie: ${cookie}`);
  if (body) lines.push(`content-length: ${body.length}`);
  if (!response.headers.has('date')) {
    lines.push(`date: ${new Date().toUTCString()}`);
  }
  lines.push('connection: close');

  // 升级被拒等响应可能不带 statusText（如 409），按标准状态码补齐原因短语，
  // 保证裸 socket 写回的响应行是「HTTP/1.1 409 Conflict」这样的完整形式
  const statusText = response.statusText || http.STATUS_CODES[response.status] || 'Unknown';

  socket.write(
    `HTTP/1.1 ${response.status} ${statusText}\r\n${lines.join('\r\n')}\r\n\r\n`
  );
  if (body) socket.write(body);
  socket.end();
}

// ── 9) /favicon.ico：优先返回面板中自定义的网站图标（VPS 版增强）───────────
// 背景：主题页面的站点 Logo 与浏览器标签图标都会请求 /favicon.ico，原版由
// 静态文件兜底，导致在后台更换图标后页面 Logo 不更新。这里在静态文件之前
// 拦截：设置了自定义图标（data URI / http 链接）就直接返回它，否则回退默认。
function parseFaviconDataUri(value) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(value);
  if (!m) return null;
  try {
    const mime = m[1] || 'image/x-icon';
    const buf = m[2]
      ? Buffer.from(m[3] || '', 'base64')
      : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8');
    return buf.length ? { mime, buf } : null;
  } catch {
    return null;
  }
}

async function tryServeCustomFavicon(request, env) {
  try {
    const url = new URL(request.url);
    const isPlainFavicon = url.pathname === '/favicon.ico';
    const hashedMatch = /^\/favicon-([a-f0-9]{12})\.ico$/.exec(url.pathname);
    if (!isPlainFavicon && !hashedMatch) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;

    const settings = await loadSettings(env.DB);
    const favicon = String(settings?.favicon || '').trim();
    if (!favicon) return null;

    if (/^https?:\/\//i.test(favicon)) {
      return new Response(null, { status: 302, headers: { Location: favicon, 'Cache-Control': 'no-store' } });
    }
    const parsed = parseFaviconDataUri(favicon);
    if (!parsed) return null;

    // 缓存策略：真正的资源地址 = 图标内容哈希路径 /favicon-<hash>.ico（可放心长缓存，
    // 图标一改地址就变）；/favicon.ico 与过期哈希一律 302 到当前哈希地址且不缓存。
    // 解决：Emerald 等主题的 Logo 直接请求 /favicon.ico，换图标后浏览器 / CDN 会拿
    // 旧缓存长期显示旧图（Cloudflare 还会把 .ico 按默认策略缓存 4 小时）。
    const hash = createHash('sha1').update(favicon).digest('hex').slice(0, 12);
    if (!hashedMatch || hashedMatch[1] !== hash) {
      return new Response(null, {
        status: 302,
        headers: { Location: `/favicon-${hash}.ico`, 'Cache-Control': 'no-store' }
      });
    }

    return new Response(request.method === 'HEAD' ? null : parsed.buf, {
      status: 200,
      headers: {
        'Content-Type': parsed.mime,
        'Content-Length': String(parsed.buf.length),
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  } catch (e) {
    console.error('[server] 自定义图标处理失败，回退静态文件:', e?.message || e);
    return null;
  }
}

// ── 10) HTTP 服务器 ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const request = await toFetchRequest(req);

    // /favicon.ico 优先返回面板中的自定义图标（VPS 版增强）
    const faviconResponse = await tryServeCustomFavicon(request, env);

    // /_pd/cf-migrate：从 Cloudflare 一键迁移（VPS 版专属功能）
    const cfMigrateResponse = faviconResponse ? null : await tryHandleCfMigrate(request, env, DATA_DIR);

    // 静态资产优先（模拟 Cloudflare Workers Assets 的默认行为：
    // 命中 dist/ 中的文件直接返回，未命中才进入 Worker 逻辑）
    const staticResponse = faviconResponse || cfMigrateResponse || (await env.ASSETS.tryServeStatic(request));
    const response = staticResponse || (await worker.fetch(request, env, createCtx()));

    // CORS：主题跨域部署时放行白名单来源（OPTIONS 预检直接响应）
    if (req.method === 'OPTIONS' && resolveCorsOrigin(req, env)) {
      await writeFetchResponse(res, req, withCorsHeaders(new Response(null, { status: 204 }), req, env));
      return;
    }

    await writeFetchResponse(res, req, withCorsHeaders(response, req, env));
  } catch (e) {
    console.error('[server] 请求处理失败:', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('Internal Server Error');
  }
});

// ── 10) WebSocket 升级处理 ─────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// 迁移到自托管 Node 后需自行补齐的原平台兜底能力：
// 1) 主动心跳：空闲连接（探针上报间隔 60-180s、无前端订阅时无数据流）会被
//    nginx/Caddy 等反向代理的默认 60s 空闲超时掐断；协议层 ping 可保活。
// 2) 死连接清理：静默断网（无 FIN/RST）时 close 事件永不触发；用 isAlive +
//    pong 检测死亡连接并 terminate（terminate 触发 close → 既有清理逻辑生效）。
// 3) 101 握手响应补标准 Date 头：WSS 模式下探针的时间校准样本只来自握手响应
//    的 Date 头（Node/ws 库不会自动补；Cloudflare 原版由平台边缘补）。
const WS_HEARTBEAT_INTERVAL_MS = 25000;

wss.on('headers', (headers) => {
  headers.push(`Date: ${new Date().toUTCString()}`);
});

const wsHeartbeatTimer = setInterval(() => {
  for (const rawSocket of wss.clients) {
    if (rawSocket.isAlive === false) {
      rawSocket.terminate();
      continue;
    }
    rawSocket.isAlive = false;
    try {
      rawSocket.ping();
    } catch (_) {}
  }
}, WS_HEARTBEAT_INTERVAL_MS);
wsHeartbeatTimer.unref?.();

server.on('upgrade', async (req, socket, head) => {
  try {
    const request = await toFetchRequest(req, { withBody: false });
    const store = { pairs: [] };

    // 在原版的升级调用链（worker → DO）中执行，收集 DO 创建的 WebSocketPair
    const response = await upgradeContext.run(store, () =>
      worker.fetch(request, env, createCtx())
    );

    if (response.status === 101 && store.pairs.length > 0) {
      const serverSocket = store.pairs[0];
      wss.handleUpgrade(req, socket, head, (rawWs) => {
        rawWs.isAlive = true;
        rawWs.on('pong', () => {
          rawWs.isAlive = true;
        });
        serverSocket.bindReal(rawWs);
      });
      // 兜底：握手未完成时 socket 被 ws 库直接销毁（升级回调不会触发），此时
      // shim 未绑定任何 raw 连接、永远不会收到 close 事件——延迟检查并清理，
      // 避免其永久残留于连接池（及其待发送队列）。
      socket.once('close', () => {
        setTimeout(() => {
          try {
            if (!serverSocket._raw) {
              serverSocket._state?._sockets?.delete(serverSocket);
              serverSocket._doInstance?.webSocketClose?.(serverSocket, 1006, 'upgrade aborted');
            }
          } catch (_) {}
        }, 1000);
      });
      return;
    }

    // 升级被拒绝（如 403/426），按普通 HTTP 响应写回
    await writeRawHttpResponse(socket, response);
  } catch (e) {
    console.error('[server] WebSocket 升级失败:', e);
    try {
      socket.destroy();
    } catch (_) {}
  }
});

// ── 11) Cron（对应 wrangler.toml 的 triggers.crons，按 UTC）────────────────
let lastCronMinuteKey = null;
function utcMinuteKey(date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}-${date.getUTCMinutes()}`;
}

async function runScheduled(cron) {
  try {
    await worker.scheduled({ cron, scheduledTime: Date.now() }, env, createCtx());
  } catch (e) {
    console.error(`[cron] ${cron} 执行失败:`, e);
  }
}

lastCronMinuteKey = utcMinuteKey(new Date()); // 启动瞬间不补跑，下一分钟开始
setInterval(() => {
  const now = new Date();
  const key = utcMinuteKey(now);
  if (key === lastCronMinuteKey) return;
  lastCronMinuteKey = key;

  runScheduled('*/1 * * * *');
  if (now.getUTCMinutes() === 0) {
    runScheduled('0 * * * *');
  }
}, 20 * 1000);

// ── 12) 启动 ───────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  ProbeDeck · 探针台（CF-Server-Monitor Docker/VPS 版）');
  console.log('──────────────────────────────────────────────');
  console.log(`  监听地址 : http://${HOST}:${PORT}`);
  console.log(`  数据目录 : ${DATA_DIR}`);
  console.log(`  静态目录 : ${DIST_DIR}`);
  console.log(`  地区识别 : ${geoip.describe()}`);
  console.log(`  管理面板 : http://<你的域名>/#/admin （用户名 admin）`);
  if (apiSecretInfo.generated) {
    console.log('  ┌────────────────────────────────────────────');
    console.log(`  │ API_SECRET 已自动生成: ${apiSecretInfo.secret}`);
    console.log('  │ （同时是管理面板初始密码）');
    console.log('  │ 已保存到 data/api_secret.txt，重启不会变化');
    console.log('  └────────────────────────────────────────────');
  } else if (!process.env.API_SECRET) {
    console.log('  提示     : API_SECRET 来自数据目录中的 api_secret.txt（可用环境变量覆盖）');
  }
  if (!fs.existsSync(path.join(DIST_DIR, 'dashboard.html'))) {
    console.warn('  ⚠️  未找到 dist/dashboard.html：前端未构建。请运行 npm run build:frontend');
  }
  console.log('──────────────────────────────────────────────');
});

// ── 13) 优雅退出 ───────────────────────────────────────────────────────────
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] 收到 ${signal}，正在退出…`);
    try {
      server.close();
    } catch (_) {}
    try {
      if (typeof env.DB.close === 'function') env.DB.close();
    } catch (_) {}
    setTimeout(() => process.exit(0), 500).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
