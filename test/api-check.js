#!/usr/bin/env node
// node --check test/api-check.js
// node test/api-check.js --help

const DEFAULT_BASE_URL = 'http://localhost:8787';
const MOCK_PUBLIC_SERVER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOCK_HIDDEN_SERVER_ID = '550e8400-e29b-41d4-a716-446655440002';
const AGENT_VERSION = '1.3.0';

const args = new Set(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(getArgValue('--base-url') || process.env.BASE_URL || DEFAULT_BASE_URL);
const apiSecret = getArgValue('--api-secret') || process.env.API_SECRET || '123456';
const adminUsername = getArgValue('--admin-user') || process.env.ADMIN_USER || process.env.API_USER_NAME || 'admin';
const adminPassword = getArgValue('--admin-password') || process.env.ADMIN_PASSWORD || apiSecret || '123456';
const includeWrite = !args.has('--skip-write') && process.env.INCLUDE_WRITE !== 'false';
const timeoutMs = Number(getArgValue('--timeout') || process.env.TIMEOUT_MS || 10000);

const state = {
  token: '',
  cookieAuth: false,
  createdServerId: '',
  results: []
};

function getArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function normalizeBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function jsonBody(body) {
  return JSON.stringify(body ?? {});
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function isExpectedStatus(status, expected) {
  if (Array.isArray(expected)) return expected.includes(status);
  return status === expected;
}

function expectedText(expected) {
  return Array.isArray(expected) ? expected.join('/') : String(expected);
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      redirect: 'manual',
      ...options,
      headers: {
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      data,
      text
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.name === 'AbortError' ? `请求超时：${timeoutMs}ms` : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCase(testCase) {
  if (typeof testCase.skip === 'function') {
    const reason = testCase.skip();
    if (reason) {
      record('skip', testCase.name, '-', reason);
      return;
    }
  }

  const result = await testCase.run();
  const expected = testCase.expectedStatus;
  const pass = result.ok && isExpectedStatus(result.status, expected);

  if (pass) {
    record('pass', testCase.name, result.status, testCase.note || '');
  } else {
    const detail = result.ok
      ? `期望 ${expectedText(expected)}，实际 ${result.status}${result.text ? `，响应：${truncate(result.text)}` : ''}`
      : result.error;
    record('fail', testCase.name, result.status || '-', detail);
  }

  if (typeof testCase.after === 'function') {
    await testCase.after(result);
  }
}

function record(status, name, code, detail) {
  state.results.push({ status, name, code, detail });
  const label = status.toUpperCase().padEnd(4);
  const codeText = String(code).padEnd(3);
  console.log(`[${label}] ${codeText} ${name}${detail ? ` - ${detail}` : ''}`);
}

function truncate(text, max = 180) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function printUsage() {
  console.log(`本地接口测试工具\n\n用法：\n  node test/api-check.js [选项]\n\n选项：\n  --base-url=http://localhost:8787       本地服务地址，默认 ${DEFAULT_BASE_URL}\n  --api-secret=xxx                       API_SECRET，用于登录和可选写入测试\n  --admin-user=admin                     管理员用户名，默认 admin\n  --admin-password=xxx                   管理员密码，默认使用 API_SECRET\n  --server-id=uuid                       指定服务器 ID\n  --timeout=10000                        单个请求超时时间\n\n环境变量同名可用：BASE_URL、API_SECRET、ADMIN_USER、ADMIN_PASSWORD、SERVER_ID、INCLUDE_WRITE、TIMEOUT_MS\n\n说明：\n  默认只执行安全或只读检查；重建数据库、清理历史、删除服务器等破坏性接口不会执行。\n  Cloudflare Turnstile 开启时，只验证未携带 token 会失败，不尝试绕过人机验证。`);
}

async function bootstrap() {
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    process.exit(0);
  }

  console.log(`接口测试目标：${baseUrl}`);
  console.log(`写入测试：${includeWrite ? '开启' : '关闭'}`);
  console.log('');

  // ============================================================
  // 定义测试用例
  // ============================================================

  // 未登录测试用例
  const unauthenticatedCases = [
    { name: 'GET /api/config', method: 'GET', path: '/api/config', expectedStatus: 200 },
    { name: 'GET /api/servers', method: 'GET', path: '/api/servers', expectedStatus: 200 },
    { name: 'GET /api/server 缺少 ID', method: 'GET', path: '/api/server', expectedStatus: 400 },
    { name: 'GET /api/history/all 缺少 ID', method: 'GET', path: '/api/history/all', expectedStatus: 400 },
    { name: 'GET /api/ws', method: 'GET', path: '/api/ws', expectedStatus: 426, note: 'WebSocket 仅做 HTTP 探测' },
    { name: 'POST /updateDatabase', method: 'POST', path: '/updateDatabase', expectedStatus: 401 },
    { name: 'POST /clearHistory', method: 'POST', path: '/clearHistory', expectedStatus: 401 },
    { name: 'GET /__do/health', method: 'GET', path: '/__do/health', expectedStatus: 200 },
    { name: 'POST /update 无效 secret', method: 'POST', path: '/update', expectedStatus: 401, body: { id: MOCK_PUBLIC_SERVER_ID, secret: '__invalid__', metrics: {} } },
    { name: 'POST /update 公开服务器上报成功', method: 'POST', path: '/update', expectedStatus: 200, body: { id: MOCK_PUBLIC_SERVER_ID, secret: apiSecret, metrics: buildMockMetrics() }, headers: { 'X-Agent-Version': AGENT_VERSION } },
    { name: 'POST /update 隐藏服务器上报成功', method: 'POST', path: '/update', expectedStatus: 200, body: { id: MOCK_HIDDEN_SERVER_ID, secret: apiSecret, metrics: buildMockMetrics() }, headers: { 'X-Agent-Version': AGENT_VERSION } },
    { name: 'GET /api/server 公开服务器（未登录）', method: 'GET', path: `/api/server?id=${encodeURIComponent(MOCK_PUBLIC_SERVER_ID)}`, expectedStatus: 200 },
    { name: 'GET /api/server 隐藏服务器（未登录）', method: 'GET', path: `/api/server?id=${encodeURIComponent(MOCK_HIDDEN_SERVER_ID)}`, expectedStatus: 404 },
    { name: 'GET 不存在路径', method: 'GET', path: '/__api_check_not_found__', expectedStatus: 200, note: 'Worker 未命中 API 路由时会回退前端' }
  ];

  // 登录测试用例
  const loginCases = [
    { name: 'POST /admin/api login 缺少密码', method: 'POST', path: '/admin/api', expectedStatus: 400, body: { action: 'login', username: adminUsername } },
    { name: 'POST /admin/api login 无效密码', method: 'POST', path: '/admin/api', expectedStatus: 401, body: { action: 'login', username: adminUsername, password: '__invalid__' } },
    { name: 'POST /admin/api login 成功', method: 'POST', path: '/admin/api', expectedStatus: 200, body: { action: 'login', username: adminUsername, password: adminPassword } }
  ];

  // 已登录测试用例
  const authenticatedCases = [
    { name: 'GET /api/server 公开服务器（已登录）', method: 'GET', path: `/api/server?id=${encodeURIComponent(MOCK_PUBLIC_SERVER_ID)}`, expectedStatus: 200 },
    { name: 'GET /api/server 隐藏服务器（已登录）', method: 'GET', path: `/api/server?id=${encodeURIComponent(MOCK_HIDDEN_SERVER_ID)}`, expectedStatus: 200 },
    { name: 'GET /api/history/all 公开服务器（已登录）', method: 'GET', path: `/api/history/all?id=${encodeURIComponent(MOCK_PUBLIC_SERVER_ID)}&hours=1`, expectedStatus: 200 },
    { name: 'GET /api/history/all 隐藏服务器（已登录）', method: 'GET', path: `/api/history/all?id=${encodeURIComponent(MOCK_HIDDEN_SERVER_ID)}&hours=1`, expectedStatus: 200 }
  ];

  // 后台管理测试用例
  const adminCases = [
    { name: 'POST /admin/api get_settings', method: 'POST', path: '/admin/api', expectedStatus: 200, body: { action: 'get_settings' } },
    { name: 'POST /admin/api list', method: 'POST', path: '/admin/api', expectedStatus: 200, body: { action: 'list' } },
    { name: 'POST /admin/api 未知 action', method: 'POST', path: '/admin/api', expectedStatus: 400, body: { action: '__unknown__' } },
    { name: 'POST /admin/api edit 参数校验', method: 'POST', path: '/admin/api', expectedStatus: 400, body: { action: 'edit', id: 'invalid-id' } },
    { name: 'POST /admin/api delete 参数校验', method: 'POST', path: '/admin/api', expectedStatus: 400, body: { action: 'delete', id: 'invalid-id' } },
    { name: 'POST /admin/api batch_delete 参数校验', method: 'POST', path: '/admin/api', expectedStatus: 400, body: { action: 'batch_delete', ids: [] } },
    { name: 'POST /admin/api save_order 参数校验', method: 'POST', path: '/admin/api', expectedStatus: 400, body: { action: 'save_order', orders: [] } },
    { name: 'POST /admin/api add 成功', method: 'POST', path: '/admin/api', expectedStatus: 200, body: { action: 'add', name: 'test-server-' + Date.now(), secret: 'test-secret-' + Date.now(), group_id: 0, location: 'Test Location', ip: '127.0.0.1', ssh_port: 22, ssh_user: 'root', ssh_password: '', note: 'API test server' }, write: true },
    { name: 'POST /admin/api delete 成功', method: 'POST', path: '/admin/api', expectedStatus: 200, body: () => ({ action: 'delete', id: state.createdServerId }), write: true, dependsOn: 'POST /admin/api add 成功' }
  ];

  // ============================================================
  // 执行测试
  // ============================================================

  console.log('\n━━━ [未登录] 测试 ━━━\n');

  for (const c of unauthenticatedCases) {
    await runCase({
      name: c.name,
      expectedStatus: c.expectedStatus,
      note: c.note,
      run: () => request(c.path, {
        method: c.method,
        headers: { 'Content-Type': 'application/json', ...(c.headers || {}) },
        body: c.body ? jsonBody(c.body) : undefined
      }),
      after: c.name === 'GET /api/config' ? async result => {
        const data = result.data && result.data.data ? result.data.data : result.data;
        state.cookieAuth = data && data.verified === true;
      } : undefined
    });
  }

  console.log('\n━━━ [登录流程] ━━━\n');

  for (const c of loginCases) {
    await runCase({
      name: c.name,
      expectedStatus: c.expectedStatus,
      run: () => request(c.path, {
        method: c.method,
        headers: { 'Content-Type': 'application/json' },
        body: c.body ? jsonBody(c.body) : undefined
      }),
      after: c.name === 'POST /admin/api login 成功' ? async result => {
        if (result.status === 200 && result.data && result.data.token) {
          state.token = result.data.token;
        }
      } : undefined
    });
  }

  if (!state.token) {
    record('skip', '已登录接口测试', '-', '未登录成功，跳过需要 Bearer Token 的接口');
  } else {
    console.log('\n━━━ [已登录] 测试 ━━━\n');

    const headers = { 'Content-Type': 'application/json', ...authHeaders() };

    for (const c of authenticatedCases) {
      await runCase({
        name: c.name,
        expectedStatus: c.expectedStatus,
        run: () => request(c.path, { method: c.method, headers })
      });
    }

    console.log('\n━━━ [后台管理] 测试 ━━━\n');

    for (const c of adminCases) {
      if (c.write && !includeWrite) {
        record('skip', c.name, '-', '写入测试已关闭');
        continue;
      }
      if (c.dependsOn && !state.createdServerId) {
        record('skip', c.name, '-', '依赖于 ' + c.dependsOn + '，但该测试未成功');
        continue;
      }
      const body = typeof c.body === 'function' ? c.body() : c.body;
      await runCase({
        name: c.name,
        expectedStatus: c.expectedStatus,
        run: () => request(c.path, {
          method: c.method,
          headers: { ...headers, ...(c.headers || {}) },
          body: body ? jsonBody(body) : undefined
        }),
        after: async result => {
          if (c.name === 'POST /admin/api list' && result.ok && result.status === 200) {
            const payload = result.data && result.data.data ? result.data.data : result.data;
            const servers = Array.isArray(payload?.servers) ? payload.servers : [];
            const hasVersion = servers.some(server => server && server.agent_version === AGENT_VERSION);
            if (hasVersion) {
              record('pass', 'POST /admin/api list agent_version 校验', '-', AGENT_VERSION);
            } else {
              record('fail', 'POST /admin/api list agent_version 校验', '-', '未找到预期版本号');
            }
          }

          if (c.name === 'POST /admin/api add 成功' && result.status === 200 && result.data && result.data.id) {
            state.createdServerId = result.data.id;
            console.log('add 成功，服务器 ID:', state.createdServerId);
          }
        }
      });
    }
  }

  printSummary();
}

function buildMockMetrics() {
  return {
    cpu: 12.3,
    ram: 45.6,
    disk: {
      read_bps: 4096,
      write_bps: 2048,
      read_iops: 12,
      write_iops: 8,
      await_ms: 1.5,
      util: 3.2
    },
    load_avg: '0.12 0.20 0.18',
    net_in_speed: 1024,
    net_out_speed: 2048,
    net_rx: 123456789,
    net_tx: 987654321,
    processes: 128,
    tcp_conn: 32,
    udp_conn: 8,
    ping_ct: 30,
    ping_cu: 40,
    ping_cm: 50,
    ping_bd: 60,
    ram_total: 8192,
    ram_used: 3735,
    swap_total: 1024,
    swap_used: 64,
    disk_total: 102400,
    disk_used: 38707,
    cpu_cores: 2,
    cpu_info: 'Local API Check CPU',
    arch: process.arch,
    os: process.platform,
    ip_v4: '127.0.0.1',
    ip_v6: '::1',
    boot_time: new Date(Date.now() - 3600000).toISOString()
  };
}

function printSummary() {
  const counts = state.results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log(`汇总：通过 ${counts.pass || 0}，失败 ${counts.fail || 0}，跳过 ${counts.skip || 0}`);

  if (counts.fail > 0) {
    process.exitCode = 1;
  }
}

bootstrap().catch(error => {
  console.error(error);
  process.exit(1);
});
