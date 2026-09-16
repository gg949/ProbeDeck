// ─────────────────────────────────────────────────────────────────────────────
// runtime.js — Cloudflare Workers 运行时全局对象的 Node.js 兼容层
//
// 本项目原始代码 (src/) 是按 Cloudflare Workers 运行时编写的，依赖若干
// Workers 独有的全局对象。本文件在进程启动时对 Node.js 全局环境进行少量
// 补充，使原始代码可以“原样”运行，无需修改 src/ 内的任何业务代码。
//
// 需要模拟的 Workers 差异：
//   1. Response 构造函数：Workers 允许 status 101（WebSocket 升级响应），
//      而 Node 的 undici 强制限制在 200-599，因此这里做一层包装。
//   2. crypto.subtle.timingSafeEqual：Workers 扩展 API，Node 没有。
//   3. caches.default：Workers Cache API，这里用带 TTL 的内存缓存实现。
//
// 注意：WebSocketPair 相关对象在 ws-bridge.js 中定义（需要与升级流程联动）。
// ─────────────────────────────────────────────────────────────────────────────
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

let installed = false;

export function installRuntimeShims() {
  if (installed) return;
  installed = true;

  // ── 1) Response：支持 status 101（WebSocket 升级）────────────────────────
  const NativeResponse = globalThis.Response;

  class UpgradeResponse101 {
    constructor(init = {}) {
      this.status = 101;
      this.statusText = 'Switching Protocols';
      this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
      this.body = null;
      this.bodyUsed = false;
      this.ok = false;
      this.redirected = false;
      this.type = 'default';
      this.url = '';
      this.webSocket = init.webSocket || null;
    }
    clone() {
      return this;
    }
  }

  function ResponseShim(body, init) {
    if (init && Number(init.status) === 101) {
      return new UpgradeResponse101(init);
    }
    return new NativeResponse(body, init);
  }
  ResponseShim.prototype = NativeResponse.prototype;
  try {
    Object.defineProperty(ResponseShim, 'name', { value: 'Response' });
  } catch (_) {}
  ResponseShim.redirect = NativeResponse.redirect.bind(NativeResponse);
  ResponseShim.json = NativeResponse.json.bind(NativeResponse);
  ResponseShim.error = NativeResponse.error.bind(NativeResponse);
  globalThis.Response = ResponseShim;

  // ── 2) crypto.subtle.timingSafeEqual（Workers 扩展）──────────────────────
  try {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle && typeof subtle.timingSafeEqual !== 'function') {
      Object.defineProperty(subtle, 'timingSafeEqual', {
        value: (a, b) => {
          if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
          if (a.length !== b.length) return false;
          try {
            return nodeTimingSafeEqual(Buffer.from(a), Buffer.from(b));
          } catch (_) {
            return false;
          }
        },
        writable: true,
        configurable: true,
      });
    }
  } catch (_) {}

  // ── 3) caches.default（内存实现，含 TTL + 容量上限）──────────────────────
  if (typeof globalThis.caches === 'undefined') {
    class MemoryCache {
      constructor(maxEntries = 500) {
        this.map = new Map();
        this.maxEntries = maxEntries;
      }
      _key(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input);
      }
      async match(input) {
        const key = this._key(input);
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
          this.map.delete(key);
          return undefined;
        }
        // LRU：触碰后移到队尾
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.response.clone();
      }
      async put(input, response) {
        const key = this._key(input);
        let ttl = 3600 * 1000;
        try {
          const cc = response.headers.get('Cache-Control') || '';
          const m = /max-age\s*=\s*(\d+)/i.exec(cc);
          if (m) ttl = Number(m[1]) * 1000;
        } catch (_) {}
        const entry = {
          response: response.clone(),
          expiresAt: ttl > 0 ? Date.now() + ttl : 0,
        };
        this.map.delete(key);
        this.map.set(key, entry);
        while (this.map.size > this.maxEntries) {
          const oldest = this.map.keys().next().value;
          this.map.delete(oldest);
        }
      }
      async delete(input) {
        return this.map.delete(this._key(input));
      }
    }

    globalThis.caches = {
      default: new MemoryCache(),
      // 其余命名缓存暂不使用；如未来需要可按名创建
      open: async (name) => new MemoryCache(),
    };
  }
}
