// ─────────────────────────────────────────────────────────────────────────────
// customScript.js — 自定义 JS 通知脚本执行器（ProbeDeck 自托管增强，对齐 Komari 玩法）
//
// 约定：面板「设置 → 通知」中可填写一段 JS 代码，实现：
//   sendMessage(message, title)   必须；可返回 Promise / boolean（返回 false 视为失败）
//   sendEvent(event)              可选；event = { event, clients, time, message, emoji }
// 可用宿主 API：fetch（自带 10 秒超时兜底）/ xhr（简化封装）/ console（转发服务端日志）/
//   setTimeout / clearTimeout；其余为 ECMAScript 内建对象。
//
// 安全定位：node:vm 沙箱只能防手滑、不防蓄意（与 Komari 的 Go 嵌入式引擎同级思路）——
// 脚本在服务端进程内执行，仅应粘贴可信代码。
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_SYNC_TIMEOUT_MS = 5000;   // vm 单次同步执行（含死循环）上限
const SCRIPT_TOTAL_TIMEOUT_MS = 5000;  // 整体（含异步等待）上限
const SCRIPT_FETCH_TIMEOUT_MS = 10000; // 脚本内 fetch 的默认超时
const LOG_PREFIX = '[custom-js]';

let cachedSource = null;
let cachedScript = null;
let vmModule = null;

async function loadVmModule() {
  if (!vmModule) {
    vmModule = await import('node:vm');
  }
  return vmModule;
}

function buildSandboxConsole() {
  const forward = (level) => (...args) => {
    const logger = typeof console[level] === 'function' ? console[level] : console.log;
    logger.call(console, LOG_PREFIX, ...args);
  };
  return {
    log: forward('log'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    debug: forward('debug')
  };
}

function buildSandboxFetch() {
  const requestFetch = (input, init = {}) => {
    const options = { ...(init || {}) };
    if (!options.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS);
    }
    return fetch(input, options);
  };
  const xhr = {
    request: (method, url, body, headers) => requestFetch(url, { method, body, headers }),
    get: (url, headers) => requestFetch(url, { method: 'GET', headers }),
    post: (url, body, headers) => requestFetch(url, { method: 'POST', body, headers })
  };
  return { requestFetch, xhr };
}

function formatScriptError(e) {
  const message = e?.message || String(e);
  if (/Script execution timed out/i.test(message)) {
    return `脚本执行超时（${SCRIPT_SYNC_TIMEOUT_MS / 1000} 秒）`;
  }
  return `脚本执行出错: ${message}`;
}

function runWithTimeout(task, timeoutMs) {
  let timer = null;
  const timeoutMarker = Symbol('custom-script-timeout');
  return Promise.race([
    Promise.resolve(task).then(
      (value) => ({ value }),
      (error) => ({ error })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
    })
  ]).then((outcome) => {
    if (timer) clearTimeout(timer);
    return outcome === timeoutMarker ? { timedOut: true } : outcome;
  });
}

/**
 * 执行用户自定义通知脚本。
 *
 * @param {string} source  用户脚本源码
 * @param {{ message: string, title: string, event: object }} payload
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runCustomNotificationScript(source, payload = {}) {
  const code = String(source || '');
  if (!code.trim()) {
    return { ok: false, error: '脚本为空' };
  }

  let vm;
  try {
    vm = await loadVmModule();
  } catch (_) {
    return { ok: false, error: '当前运行环境不支持自定义 JS 通知（仅自托管 Node 版可用）' };
  }

  let compiled;
  if (cachedSource === code && cachedScript) {
    compiled = cachedScript;
  } else {
    try {
      compiled = new vm.Script(code, { filename: 'notification-custom-script.js' });
    } catch (e) {
      return { ok: false, error: `脚本语法错误: ${e?.message || e}` };
    }
    cachedSource = code;
    cachedScript = compiled;
  }

  const { requestFetch, xhr } = buildSandboxFetch();
  // 每次发送使用全新 context（互不串状态）；函数声明 / const / globalThis 赋值均能取到
  const context = vm.createContext({
    fetch: requestFetch,
    xhr,
    console: buildSandboxConsole(),
    setTimeout,
    clearTimeout
  });

  const invoke = (name, args) => {
    context.__probeDeckInvoke = { args };
    try {
      // 在 context 内按名字调用，同步部分纳入 vm 超时（脚本内同步死循环也能被打断）
      return vm.runInContext(
        `(function() {
           var call = __probeDeckInvoke;
           var fn = (typeof ${name} === 'function') ? ${name} : null;
           if (typeof fn !== 'function') return { missing: true };
           return { value: fn.apply(undefined, call.args) };
         })()`,
        context,
        { timeout: SCRIPT_SYNC_TIMEOUT_MS }
      );
    } finally {
      try { delete context.__probeDeckInvoke; } catch (_) {}
    }
  };

  try {
    // 1) 执行顶层代码（定义 sendMessage / sendEvent）
    compiled.runInContext(context, { timeout: SCRIPT_SYNC_TIMEOUT_MS });

    // 2) 调用 sendMessage（必须实现）
    let first;
    try {
      first = invoke('sendMessage', [payload.message, payload.title]);
    } catch (e) {
      return { ok: false, error: formatScriptError(e) };
    }
    if (first.missing) {
      return { ok: false, error: '脚本未实现 sendMessage(message, title) 函数' };
    }

    const outcome = await runWithTimeout(first.value, SCRIPT_TOTAL_TIMEOUT_MS);
    if (outcome.timedOut) {
      return { ok: false, error: `脚本执行超时（${SCRIPT_TOTAL_TIMEOUT_MS / 1000} 秒）` };
    }
    if (outcome.error) {
      return { ok: false, error: `sendMessage 执行出错: ${outcome.error?.message || outcome.error}` };
    }
    if (outcome.value === false) {
      return { ok: false, error: 'sendMessage 返回失败（false）' };
    }

    // 3) 可选 sendEvent（出错只记日志，不影响主通知结果）
    try {
      const eventCall = invoke('sendEvent', [payload.event]);
      if (!eventCall.missing) {
        const eventOutcome = await runWithTimeout(eventCall.value, SCRIPT_TOTAL_TIMEOUT_MS);
        if (eventOutcome.timedOut) {
          console.warn(`${LOG_PREFIX} sendEvent 执行超时`);
        } else if (eventOutcome.error) {
          console.warn(`${LOG_PREFIX} sendEvent 执行出错:`, eventOutcome.error?.message || eventOutcome.error);
        }
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} sendEvent 执行出错:`, e?.message || e);
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: formatScriptError(e) };
  }
}
