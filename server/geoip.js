// ─────────────────────────────────────────────────────────────────────────────
// geoip.js — 探针地区自动识别（MaxMind GeoLite2 / ipinfo.io）
//
// 原版在 Cloudflare 上通过请求上下文（request.cf.country / cf-ipcountry 头）
// 自动识别探针位置。VPS 版本用本模块复刻该能力：
//   • maxmind（默认）：本地 GeoLite2-Country.mmdb 数据库，离线查询
//   • ipinfo ：ipinfo.io 在线查询（可配 token）
//   • off    ：关闭（地区留空，需在管理面板手动设置）
//
// 实现方式对 src/ 零改动：服务器层把识别结果写入请求的 `cf-ipcountry`
// 头，业务代码读取该头的原有逻辑直接生效。
//
// 数据库文件查找顺序（maxmind 模式）：
//   1. GEOIP_MMDB_PATH 环境变量（自定义数据库）
//   2. DATA_DIR/geoip/GeoLite2-Country.mmdb（可自行放置，也会自动下载到此）
//   3. <项目>/geoip/GeoLite2-Country.mmdb（Docker 镜像内置）
//   4. 以上都没有时自动下载（多个公共源，失败则功能降级并告警）
//
// 数据来源：GeoLite2 数据由 MaxMind 提供（https://www.maxmind.com），
// 公共镜像源见下方 DOWNLOAD_URLS。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { Reader } from 'mmdb-lib';

const MMDB_FILENAME = 'GeoLite2-Country.mmdb';

// 公共 GeoLite2 镜像源（依次尝试）
const DOWNLOAD_URLS = [
  `https://cdn.jsdelivr.net/gh/P3TERX/GeoLite.mmdb@download/${MMDB_FILENAME}`,
  `https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/${MMDB_FILENAME}`,
  `https://github.com/P3TERX/GeoLite.mmdb/raw/download/${MMDB_FILENAME}`,
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 同一 IP 24 小时内只查一次
const CACHE_MAX_ENTRIES = 10000;

// ── 地址判断 ────────────────────────────────────────────────────────────────
export function isPrivateIp(ip) {
  if (!ip) return true;
  const value = String(ip).trim().toLowerCase();
  if (!value) return true;

  // IPv6
  if (value.includes(':')) {
    const normalized = value.replace(/^::ffff:/, '');
    if (normalized.includes('.')) return isPrivateIp(normalized); // v4-mapped
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    return false;
  }

  // IPv4
  const parts = value.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // 非法地址按私有处理，直接跳过查询
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// 从请求中提取客户端真实 IP（兼容各类反向代理 / Cloudflare 隧道）
export function extractClientIp(req) {
  const headers = req.headers || {};
  const first = (value) => String(value || '').split(',')[0].trim() || '';

  const candidate =
    first(headers['cf-connecting-ip']) || // Cloudflare / cloudflared 隧道
    first(headers['x-real-ip']) || // nginx 默认
    first(headers['x-forwarded-for']) || // 通用反代
    (req.socket && req.socket.remoteAddress) ||
    '';

  // 去掉 IPv4-mapped 前缀（::ffff:1.2.3.4）
  return candidate.replace(/^::ffff:/i, '');
}

// ── 主服务 ──────────────────────────────────────────────────────────────────
export async function createGeoIpService(options = {}) {
  const {
    provider: rawProvider = 'maxmind',
    mmdbPath: envMmdbPath = '',
    dataDir = '',
    ipinfoToken = '',
    builtinDir = '',
    logger = console,
  } = options;

  const provider = ['maxmind', 'ipinfo', 'off'].includes(String(rawProvider).trim().toLowerCase())
    ? String(rawProvider).trim().toLowerCase()
    : 'maxmind';

  const cache = new Map();

  function cacheGet(ip) {
    const entry = cache.get(ip);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(ip);
      return undefined;
    }
    return entry.country;
  }

  function cacheSet(ip, country) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(ip, { country, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  // ── MaxMind 本地数据库 ────────────────────────────────────────────────────
  let reader = null;
  let mmdbSource = '';

  function candidateMmdbPaths() {
    const list = [];
    if (envMmdbPath) list.push({ path: path.resolve(envMmdbPath), label: '自定义(GEOIP_MMDB_PATH)' });
    if (dataDir) list.push({ path: path.join(dataDir, 'geoip', MMDB_FILENAME), label: '数据目录' });
    if (builtinDir) list.push({ path: path.join(builtinDir, MMDB_FILENAME), label: '镜像内置' });
    return list;
  }

  function tryLoadMmdb(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 1024) return false;
      const buf = fs.readFileSync(filePath);
      const nextReader = new Reader(buf);
      // 抽样验证可解析
      nextReader.get('8.8.8.8');
      reader = nextReader;
      return true;
    } catch (e) {
      logger.warn(`[geoip] mmdb 加载失败 (${filePath}):`, e?.message || e);
      return false;
    }
  }

  async function ensureMaxmind() {
    // 1) 依次尝试已存在的候选路径
    for (const candidate of candidateMmdbPaths()) {
      if (tryLoadMmdb(candidate.path)) {
        mmdbSource = `${candidate.label}: ${candidate.path}`;
        return true;
      }
    }

    // 2) 都不存在且允许自动下载时，下载到数据目录
    if (!dataDir) return false;
    const target = path.join(dataDir, 'geoip', MMDB_FILENAME);
    for (const url of DOWNLOAD_URLS) {
      try {
        logger.log(`[geoip] 正在下载 GeoLite2 数据库: ${url}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500 * 1024) throw new Error(`文件过小 (${buf.length}B)`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        if (tryLoadMmdb(target)) {
          mmdbSource = `自动下载: ${target}`;
          logger.log(`[geoip] GeoLite2 数据库已就绪 (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
          return true;
        }
      } catch (e) {
        logger.warn(`[geoip] 下载失败 (${url}): ${e?.message || e}`);
      }
    }
    return false;
  }

  function maxmindLookup(ip) {
    try {
      const record = reader.get(ip);
      if (!record) return null;
      const code = record?.country?.iso_code || record?.registered_country?.iso_code || null;
      return code ? String(code).toUpperCase() : null;
    } catch (_) {
      return null;
    }
  }

  // ── ipinfo.io 在线查询 ────────────────────────────────────────────────────
  async function ipinfoLookup(ip) {
    try {
      const url = `https://ipinfo.io/${encodeURIComponent(ip)}/country${ipinfoToken ? `?token=${encodeURIComponent(ipinfoToken)}` : ''}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const text = (await res.text()).trim().toUpperCase();
      return /^[A-Z]{2}$/.test(text) ? text : null;
    } catch (_) {
      return null;
    }
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  let enabled = false;
  let degradedReason = '';

  if (provider === 'off') {
    degradedReason = '已关闭 (GEOIP_PROVIDER=off)';
  } else if (provider === 'maxmind') {
    enabled = await ensureMaxmind();
    if (!enabled) {
      degradedReason = '不可用：未找到数据库且下载失败（地区将留空，可放置自定义 mmdb 或改用 GEOIP_PROVIDER=ipinfo）';
    }
  } else if (provider === 'ipinfo') {
    enabled = true; // 在线查询，无需初始化
  }

  async function lookup(rawIp) {
    if (!enabled) return null;
    const ip = String(rawIp || '').trim();
    if (!ip || isPrivateIp(ip)) return null;

    const cached = cacheGet(ip);
    if (cached !== undefined) return cached;

    const country = provider === 'maxmind' ? maxmindLookup(ip) : await ipinfoLookup(ip);
    cacheSet(ip, country);
    return country;
  }

  function describe() {
    if (provider === 'off') return `已禁用 (${degradedReason})`;
    if (!enabled) return `已降级 (${degradedReason})`;
    if (provider === 'maxmind') return `MaxMind GeoLite2 · ${mmdbSource}`;
    return 'ipinfo.io 在线查询' + (ipinfoToken ? ' (带 token)' : ' (匿名)');
  }

  return {
    get enabled() {
      return enabled;
    },
    provider,
    lookup,
    describe,
  };
}
