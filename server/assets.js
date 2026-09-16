// ─────────────────────────────────────────────────────────────────────────────
// assets.js — Workers Assets (env.ASSETS) 的本地文件系统实现
//
// 原版通过 Cloudflare Workers Assets 服务 dist/ 目录中的静态文件：
//   • 请求命中磁盘上的文件时由 Assets 直接返回（不进入 Worker 逻辑）；
//   • dashboard.html / style.css 等也可由 Worker 内部通过 env.ASSETS.fetch()
//     主动读取。
// 这里用 Node 文件系统实现同样的两种用法，并做路径穿越防护。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

const IMMUTABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf',
]);

// 解析请求路径到 dist 内的安全文件路径；越界或非法路径返回 null
export function resolveSafePath(rootDir, urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname || '/');
  } catch (_) {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const normalized = path.posix.normalize(decoded);
  if (normalized.includes('..')) return null;

  const filePath = path.join(rootDir, normalized);
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(rootDir);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return resolved;
}

function buildFileResponse(filePath, stat, readBody) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'Cache-Control': IMMUTABLE_EXTENSIONS.has(ext)
      ? 'public, max-age=3600'
      : 'public, max-age=0, must-revalidate',
    'Last-Modified': stat.mtime.toUTCString(),
    'ETag': `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
  };

  if (!readBody) {
    return new Response(null, { status: 200, headers });
  }
  const data = fs.readFileSync(filePath);
  return new Response(data, { status: 200, headers });
}

export function createAssetsService(distDir) {
  const rootDir = path.resolve(distDir);

  // 请求入口的“静态资产优先”模拟：命中文件返回 Response，未命中返回 null（穿透到 Worker）
  async function tryServeStatic(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;

    let pathname;
    try {
      pathname = new URL(request.url).pathname;
    } catch (_) {
      return null;
    }
    if (pathname.endsWith('/')) return null; // 目录请求交给 Worker（原版 assets 未启用 index 处理）

    const filePath = resolveSafePath(rootDir, pathname);
    if (!filePath) return null;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      return null;
    }
    if (!stat.isFile()) return null;

    return buildFileResponse(filePath, stat, request.method === 'GET');
  }

  // env.ASSETS.fetch(new Request('http://static/<filename>')) 的内部读取
  async function fetch(request) {
    let pathname;
    try {
      pathname = new URL(request.url).pathname;
    } catch (_) {
      return new Response('Not Found', { status: 404 });
    }

    const filePath = resolveSafePath(rootDir, pathname);
    if (!filePath) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }
    if (!stat.isFile()) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }

    return buildFileResponse(filePath, stat, true);
  }

  return { fetch, tryServeStatic };
}
