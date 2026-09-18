// ─────────────────────────────────────────────────────────────────────────────
// cf-migrate.js — 从 Cloudflare 一键迁移数据（Docker/VPS 版专属）
//
// 用户在管理面板填入 CF 账号 ID、D1 数据库 ID、API Token，服务端调用
// Cloudflare 官方 D1 export API 拉取 SQL 全量导出，导入本地 SQLite。
// Cloudflare Workers 版没有此端点（前端探测不到就隐藏入口）。
//
// 流程：① 发起导出并轮询直到完成 → ② 下载 SQL → ③ 备份现有库、清表导入 →
//       ④ 断开连接、重启进程（Docker restart 策略自动拉起，缓存归零）。
// 任何一步失败都会自动还原备份，保证数据不丢。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const { checkAuth } = await import('../src/middleware/auth.js');
const { loadSettings } = await import('../src/utils/settings.js');

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const CF_MIGRATE_POLL_INTERVAL_MS = 2500;
const CF_MIGRATE_MAX_POLLS = 72; // 最长约 3 分钟

let cfMigrateRunning = false;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

// 备份现有库 → 清空业务表 → 执行 CF 导出的 SQL → 校验落盘。
// restart=false 仅供测试使用（不触发进程重启）。
export async function performCfImport(dataDir, env, sqlText, restart = true) {
  const dbPath = path.join(dataDir, 'monitor.db');
  const backupPath = path.join(dataDir, `monitor.db.pre-migrate-${Date.now()}`);
  let importError = null;
  let tableCount = 0;

  const raw = new Database(dbPath);
  try {
    raw.pragma('busy_timeout = 10000');
    raw.pragma('wal_checkpoint(TRUNCATE)'); // 合并 WAL，确保备份文件完整
    fs.copyFileSync(dbPath, backupPath);

    raw.pragma('foreign_keys = OFF');
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    tableCount = tables.length;
    for (const t of tables) {
      const name = String(t.name).replace(/"/g, '""');
      raw.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    raw.exec(sqlText);
    raw.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    importError = e?.message || String(e);
  } finally {
    try { raw.close(); } catch (_) {}
  }

  // 断开主连接（后续对数据库文件做独占操作）
  try { env?.DB?.close?.(); } catch (_) {}

  if (importError) {
    console.error('[cf-migrate] 导入失败，正在还原备份:', importError);
    let restored = false;
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, dbPath);
        for (const suffix of ['-wal', '-shm']) {
          try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
        }
        restored = true;
      }
    } catch (e) {
      console.error('[cf-migrate] 还原备份失败:', e?.message || e);
    }
    if (restart) setTimeout(() => process.exit(0), 1500).unref();
    return { ok: false, error: importError, restored };
  }

  console.log(`[cf-migrate] 导入完成：${tableCount} 张表已替换，备份文件：${backupPath}`);
  if (restart) setTimeout(() => process.exit(0), 1500).unref();
  return { ok: true, tables: tableCount, backup: path.basename(backupPath) };
}

// 路由入口：命中 /_pd/cf-migrate 时返回 Response，否则返回 null（交给后续处理）。
export async function tryHandleCfMigrate(request, env, dataDir) {
  const url = new URL(request.url);
  if (url.pathname !== '/_pd/cf-migrate') return null;

  // 能力探测：前端据此决定是否显示该功能（Cloudflare Workers 版没有此端点）
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse({ error: 'methodNotAllowed' }, 405);
  }

  // 认证：复用面板登录态（Authorization: Bearer <jwt>）
  let authorized = false;
  try {
    const sys = await loadSettings(env.DB);
    authorized = await checkAuth(request, env, sys);
  } catch (e) {
    console.error('[cf-migrate] 认证检查失败:', e?.message || e);
  }
  if (!authorized) return jsonResponse({ error: 'unauthorized' }, 401);

  // 能力探测同样需要管理员登录态（避免未登录即可指纹识别 /_pd/ 扩展端点）
  if (request.method === 'GET') {
    return jsonResponse({ available: true });
  }

  if (cfMigrateRunning) {
    return jsonResponse({ error: 'migrateAlreadyRunning' }, 409);
  }

  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'invalidBody' }, 400);
  }
  const accountId = String(body?.accountId || '').trim();
  const databaseId = String(body?.databaseId || '').trim();
  const apiToken = String(body?.apiToken || '').trim();
  if (!accountId || !databaseId || !apiToken) {
    return jsonResponse({ error: 'missingFields' }, 400);
  }

  cfMigrateRunning = true;
  try {
    // ① 调用 Cloudflare API 导出 D1（POST 发起 + 轮询直到完成）
    const exportUrl = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/export`;
    let bookmark = null;
    let signedUrl = null;

    for (let i = 0; i < CF_MIGRATE_MAX_POLLS; i++) {
      const cfRes = await fetch(exportUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bookmark
          ? { output_format: 'polling', current_bookmark: bookmark }
          : { output_format: 'polling' })
      });

      let cfData = null;
      try {
        cfData = await cfRes.json();
      } catch (_) {}

      if (!cfRes.ok || !cfData || cfData.success === false) {
        const msg = (cfData && cfData.errors && cfData.errors[0] && cfData.errors[0].message)
          || `Cloudflare API HTTP ${cfRes.status}`;
        console.error('[cf-migrate] 导出请求失败:', msg);
        return jsonResponse({ error: 'cfApiError', message: msg }, 400);
      }

      const r = cfData.result || {};
      if (r.at_bookmark) bookmark = r.at_bookmark;
      if (r.status === 'error') {
        const msg = typeof r.error === 'string' ? r.error : 'Cloudflare export failed';
        return jsonResponse({ error: 'cfExportError', message: msg }, 400);
      }
      if (r.status === 'complete') {
        signedUrl = (r.result && r.result.signed_url) || null;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, CF_MIGRATE_POLL_INTERVAL_MS));
    }

    if (!signedUrl) {
      return jsonResponse({ error: 'cfExportTimeout' }, 504);
    }

    // ② 下载导出的 SQL
    const dlRes = await fetch(signedUrl);
    if (!dlRes.ok) {
      return jsonResponse({ error: 'downloadFailed', message: `HTTP ${dlRes.status}` }, 502);
    }
    const sqlText = await dlRes.text();
    if (!sqlText || !sqlText.trim()) {
      return jsonResponse({ error: 'emptyExport' }, 400);
    }

    // ③ 备份并导入（better-sqlite3 是同步 API，执行期间事件循环阻塞，
    //    天然不会与其他请求产生并发写入）
    const result = await performCfImport(dataDir, env, sqlText, true);
    if (!result.ok) {
      return jsonResponse({ error: 'importFailed', message: result.error, restored: result.restored }, 500);
    }
    return jsonResponse({ success: true, tables: result.tables, backup: result.backup });
  } catch (e) {
    console.error('[cf-migrate] 迁移失败:', e);
    return jsonResponse({ error: 'migrateFailed', message: e?.message || String(e) }, 500);
  } finally {
    cfMigrateRunning = false;
  }
}
