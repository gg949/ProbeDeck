// ─────────────────────────────────────────────────────────────────────────────
// durable.js — Durable Objects (MetricsBroadcaster) 的本地实现
//
// 原版使用名为 METRICS_BROADCASTER 的 Durable Object（单实例，name='global'）
// 作为实时指标广播中心。这里在同一进程内创建该实例，并把 Worker 侧的
// env.METRICS_BROADCASTER 命名空间接口 (idFromName/get/fetch) 完整模拟：
//
//   const id = env.METRICS_BROADCASTER.idFromName('global');
//   const stub = env.METRICS_BROADCASTER.get(id);
//   await stub.fetch('http://internal/health', ...)
//
// stub.fetch 直接调用 DO 实例的 fetch，等价于原版跨隔离环境的 RPC。
// ─────────────────────────────────────────────────────────────────────────────
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { DurableObjectStateShim } from './ws-bridge.js';

export function createBroadcasterNamespace(env, options = {}) {
  let instance = null;
  const doRef = { instance: null };

  function ensureInstance() {
    if (!instance) {
      const state = new DurableObjectStateShim(doRef, options);
      instance = new MetricsBroadcaster(state, env);
      doRef.instance = instance;
    }
    return instance;
  }

  return {
    // Cloudflare 的 DurableObjectNamespace API 子集
    idFromName(name) {
      return { name: String(name) };
    },
    idFromString(id) {
      return { name: String(id) };
    },
    newUniqueId() {
      return { name: `do-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    },
    get(id) {
      return {
        fetch: async (input, init) => {
          const doInstance = ensureInstance();
          let request;
          if (typeof input === 'string' || input instanceof URL) {
            request = new Request(String(input), init);
          } else if (input instanceof Request) {
            request = init ? new Request(input, init) : input;
          } else {
            request = new Request(String(input), init);
          }
          return doInstance.fetch(request);
        },
      };
    },
  };
}
