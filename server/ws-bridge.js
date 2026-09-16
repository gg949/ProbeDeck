// ─────────────────────────────────────────────────────────────────────────────
// ws-bridge.js — WebSocket / Durable Object 兼容层
//
// 在原版中：
//   • WebSocketPair 由 Workers 运行时提供，一端返回给浏览器、一端交给
//     Durable Object；
//   • DO 通过 state.acceptWebSocket()（前端实时订阅）或标准
//     addEventListener（探针 WSS 上报）接管连接；
//   • DO 还使用 state.storage.get/put/setAlarm 做持久化与定时唤醒。
//
// 在 Node.js 单进程中，这里用 ws 库 + 内存对象完整模拟上述行为：
//   • HTTP 升级成功时，把真实 ws 连接绑定到 DO 里创建的 server 端对象；
//   • 消息、关闭、错误事件按原有回调路径分发；
//   • storage/alarm 用一个可持久化到 JSON 文件的轻量存储实现。
// ─────────────────────────────────────────────────────────────────────────────
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

// ── 升级上下文：每次 HTTP WebSocket 升级请求一个独立 store ──────────────────
// DO 代码内部执行 `new WebSocketPair()` 时，会把 server 端注册到当前 store，
// HTTP 层处理 101 响应时从 store 取回并完成真实 socket 的绑定。
export const upgradeContext = new AsyncLocalStorage();

// ── WebSocketRequestResponsePair（Workers 扩展：自动 ping/pong 应答）────────
export class WebSocketRequestResponsePairShim {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
}

// ── WebSocketPair（模拟）────────────────────────────────────────────────────
// 返回 { 0: client, 1: server }，与原版 `Object.values(pair)` 的取用顺序一致。
// 注意：client 端仅为占位（真实连接由 HTTP 层完成升级后与 server 端绑定）。
export class WebSocketPairShim {
  constructor() {
    const store = upgradeContext.getStore();
    const client = new ServerSocketShim();
    const server = new ServerSocketShim();
    if (store && Array.isArray(store.pairs)) {
      store.pairs.push(server);
    }
    return { 0: client, 1: server };
  }
}

// ── 服务端 WebSocket 对象（模拟 Workers 的 server 端 API 子集）──────────────
export class ServerSocketShim {
  constructor() {
    this._raw = null; // 绑定的真实 ws（ws 库）对象
    this._queue = []; // 绑定前缓存的消息（例如 hello 帧）
    this._listeners = new Map(); // addEventListener 注册（探针标准 WS 模式）
    this._attachment = undefined; // serializeAttachment 数据
    this._state = null; // DurableObjectStateShim（前端订阅模式）
    this._doInstance = null;
    this._closedBeforeBind = false;
    this.readyState = 0;
  }

  // ── 标准 WebSocket API（探针 WSS 上报路径使用）───────────────────────────
  accept() {
    this.readyState = 1;
  }

  send(data) {
    if (this._raw) {
      if (this._raw.readyState === 1) {
        try {
          this._raw.send(data);
        } catch (e) {
          console.warn('[ws] send failed:', e?.message || e);
        }
      }
    } else {
      this._queue.push(data);
    }
  }

  close(code, reason) {
    if (this._raw) {
      try {
        this._raw.close(code, reason);
      } catch (_) {}
      return;
    }
    this._closedBeforeBind = true;
  }

  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type, event) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch (e) {
        console.error(`[ws] '${type}' listener failed:`, e);
      }
    }
  }

  // ── Workers Durable Object WebSocket API ─────────────────────────────────
  serializeAttachment(value) {
    this._attachment = value ?? {};
  }

  deserializeAttachment() {
    return this._attachment;
  }

  // ── 内部：由 DurableObjectStateShim.acceptWebSocket 调用 ─────────────────
  _attachStateCallbacks(stateShim, doInstance) {
    this._state = stateShim;
    this._doInstance = doInstance;
    if (this._raw) this._wireRaw();
  }

  // ── 内部：HTTP 升级成功后由服务器层调用，绑定真实 socket ─────────────────
  bindReal(rawWs) {
    this._raw = rawWs;
    this.readyState = 1;
    this._wireRaw();
    // 发送绑定前缓存的消息（例如 hello）
    for (const item of this._queue) {
      try {
        if (rawWs.readyState === 1) rawWs.send(item);
      } catch (_) {}
    }
    this._queue = [];
    if (this._closedBeforeBind) {
      try {
        rawWs.close(1000, '');
      } catch (_) {}
    }
  }

  _wireRaw() {
    const raw = this._raw;
    if (!raw || raw.__cfmWired) return;
    raw.__cfmWired = true;

    raw.on('message', (data, isBinary) => {
      const payload = isBinary
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data.toString('utf8');

      if (this._state) {
        // 前端订阅模式：ping 自动应答（不进入 DO），其余交给 webSocketMessage
        const auto = this._state._autoResponse;
        if (auto && typeof payload === 'string' && payload === auto.request) {
          try {
            if (raw.readyState === 1) raw.send(auto.response);
          } catch (_) {}
          return;
        }
        const doInstance = this._doInstance || this._state._doRef.instance;
        Promise.resolve()
          .then(() => doInstance.webSocketMessage(this, payload))
          .catch((e) => console.error('[do] webSocketMessage failed:', e?.message || e));
        return;
      }

      // 探针标准 WS 模式：交给 addEventListener('message')
      this._emit('message', { data: payload });
    });

    raw.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString('utf8') : '';
      this.readyState = 3;
      if (this._state) {
        this._state._sockets.delete(this);
        const doInstance = this._doInstance || this._state._doRef.instance;
        try {
          doInstance?.webSocketClose?.(this, code, reason);
        } catch (e) {
          console.error('[do] webSocketClose failed:', e?.message || e);
        }
        return;
      }
      this._emit('close', { code, reason, wasClean: code === 1000 });
    });

    raw.on('error', (err) => {
      if (this._state) {
        const doInstance = this._doInstance || this._state._doRef.instance;
        try {
          doInstance?.webSocketError?.(this, err);
        } catch (_) {}
        return;
      }
      this._emit('error', err);
    });
  }
}

// ── Durable Object Storage（内存 + JSON 文件持久化 + alarm）─────────────────
class StorageShim {
  constructor(doRef, options = {}) {
    this._doRef = doRef;
    this._file = options.storageFile || null;
    this._map = new Map();
    this._alarmTimer = null;
    this._saveTimer = null;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    if (!this._file) return;
    try {
      if (fs.existsSync(this._file)) {
        const data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        for (const [key, value] of Object.entries(data || {})) {
          this._map.set(key, value);
        }
      }
    } catch (e) {
      console.warn('[do-storage] load failed:', e?.message || e);
    }
  }

  _scheduleSave() {
    if (!this._file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const obj = Object.fromEntries(this._map);
        fs.mkdirSync(path.dirname(this._file), { recursive: true });
        fs.writeFileSync(this._file, JSON.stringify(obj));
      } catch (e) {
        console.warn('[do-storage] save failed:', e?.message || e);
      }
    }, 500);
  }

  async get(key) {
    return this._map.get(key);
  }

  async put(key, value) {
    this._map.set(key, value);
    this._scheduleSave();
  }

  async delete(key) {
    this._map.delete(key);
    this._scheduleSave();
  }

  async setAlarm(timestamp) {
    if (this._alarmTimer) {
      clearTimeout(this._alarmTimer);
      this._alarmTimer = null;
    }
    const delay = Math.max(0, Number(timestamp) - Date.now());
    const capped = Math.min(delay, 2147483647);
    this._alarmTimer = setTimeout(() => {
      this._alarmTimer = null;
      const doInstance = this._doRef.instance;
      if (doInstance && typeof doInstance.alarm === 'function') {
        Promise.resolve(doInstance.alarm()).catch((e) =>
          console.error('[do] alarm failed:', e?.message || e)
        );
      }
    }, capped);
  }

  async deleteAlarm() {
    if (this._alarmTimer) {
      clearTimeout(this._alarmTimer);
      this._alarmTimer = null;
    }
  }

  async getAlarm() {
    return null; // 本移植版不需要查询 alarm 时间
  }
}

// ── Durable Object State（模拟）─────────────────────────────────────────────
export class DurableObjectStateShim {
  constructor(doRef, options = {}) {
    this._doRef = doRef;
    this._sockets = new Set();
    this._autoResponse = null;
    this._storage = new StorageShim(doRef, options);
  }

  acceptWebSocket(ws) {
    this._sockets.add(ws);
    ws._attachStateCallbacks(this, this._doRef.instance);
    return ws;
  }

  getWebSockets(tag) {
    return Array.from(this._sockets);
  }

  setWebSocketAutoResponse(pair) {
    this._autoResponse = pair || null;
  }

  getWebSocketAutoResponse() {
    return this._autoResponse;
  }

  get storage() {
    return this._storage;
  }

  waitUntil(promise) {
    if (promise && typeof promise.then === 'function') {
      Promise.resolve(promise).catch((e) => console.error('[do waitUntil]', e?.message || e));
    }
  }
}
