import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { createD1Database } from '../server/d1.js';
import { createDbMaintenance, DB_BACKUP_KEEP, DB_BACKUP_PREFIX, DB_MAINTENANCE_BUSY } from '../server/db-maintenance.js';
import { initDatabase } from '../src/database/schema.js';
import { loadSiteSettings } from '../src/utils/settings.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';

// 回归用例：数据库运维接口（v2.13.2-beta1 第 3 项）
//   db_stats            → 数据库体积（主库 + WAL + 页数 / 空闲页 + 备份列表）
//   db_vacuum           → 先 wal_checkpoint(TRUNCATE) 再 VACUUM，返回释放量
//   db_backup           → wal_checkpoint(TRUNCATE) 后复制主库到 data/backups/，只保留最近 N 份
//   db_integrity_check  → PRAGMA integrity_check
// 全部动作走既有 admin checkAuth 闸门；CF 版（无 env.dbMaintenance）返回 501。

const API_SECRET = 'test-secret-0123456789abcdef';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-db-maintenance-'));
}

async function adminPost(env, sys, payload, authorized = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (authorized) {
    headers.Authorization = `Bearer ${await generateToken(env, sys)}`;
  }
  const request = new Request('http://localhost/admin/api', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  return await handleAdminAPI(request, env, sys, async () => loadSiteSettings(env.DB), null);
}

const dataDir = makeTempDir();
const dbPath = path.join(dataDir, 'monitor.db');
const backupDir = path.join(dataDir, 'backups');
const db = createD1Database(dbPath);
await initDatabase(db);
const maintenance = createDbMaintenance({ dataDir, db });
const sys = await loadSiteSettings(db);
const env = { DB: db, API_SECRET, dataDir, dbMaintenance: maintenance };

test('数据库运维接口在既有 checkAuth 闸门之后：未登录一律 401', async () => {
  const res = await adminPost(env, sys, { action: 'db_stats' }, false);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 401);
});

test('非 VPS 环境（无 env.dbMaintenance）四个动作都返回 501 dbMaintenanceUnsupported', async () => {
  const cfEnv = { DB: db, API_SECRET };
  for (const action of ['db_stats', 'db_vacuum', 'db_backup', 'db_integrity_check']) {
    const res = await adminPost(cfEnv, sys, { action });
    assert.equal(res.status, 501, `${action} 应返回 501`);
    const body = await res.json();
    assert.equal(body.error, 'dbMaintenanceUnsupported');
    assert.equal(body.code, 501);
  }
});

test('db_stats 返回主库 / WAL 体积与页信息', async () => {
  const res = await adminPost(env, sys, { action: 'db_stats' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  const stats = body.stats;
  assert.equal(stats.db_bytes, fs.statSync(dbPath).size, '主库体积应与磁盘文件一致');
  assert.ok(stats.db_bytes > 0);
  assert.ok(stats.wal_bytes >= 0);
  assert.equal(stats.total_bytes, stats.db_bytes + stats.wal_bytes);
  assert.ok(stats.page_size > 0);
  assert.ok(stats.page_count > 0);
  assert.equal(stats.freelist_bytes, stats.page_size * stats.freelist_count);
  assert.equal(stats.journal_mode, 'wal');
  assert.equal(stats.keep_backups, DB_BACKUP_KEEP);
  assert.ok(Number.isFinite(stats.checked_at));
  assert.ok(Array.isArray(stats.backups));
});

test('db_vacuum 回收空闲页（先 checkpoint 再 VACUUM），返回释放量', async () => {
  // 造碎片：插入一张临时表再删除，文件里留下空闲页
  await db.exec('CREATE TABLE pd_junk (id INTEGER PRIMARY KEY, payload TEXT)');
  for (let i = 0; i < 800; i += 1) {
    await db.prepare('INSERT INTO pd_junk (payload) VALUES (?)').bind('x'.repeat(200)).run();
  }
  await db.exec('DROP TABLE pd_junk');
  const before = await db.prepare('PRAGMA freelist_count').first();
  assert.ok(Number(before.freelist_count) > 0, '删除大表后应产生空闲页');

  const res = await adminPost(env, sys, { action: 'db_vacuum' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.stats.freelist_count, 0, 'VACUUM 后空闲页应清零');
  assert.ok(body.freed_bytes > 0, '应返回释放的磁盘空间');
  assert.ok(Number.isFinite(body.duration_ms));

  // VACUUM 之后同一条连接（含语句缓存）仍可正常读写
  const row = await db.prepare('SELECT COUNT(*) AS count FROM servers').first();
  assert.ok(Number(row.count) >= 0);
});

test('db_backup 生成可独立打开的备份，并自动清理最旧（保留 N 份）', async () => {
  const created = [];
  for (let i = 0; i < DB_BACKUP_KEEP + 1; i += 1) {
    const res = await adminPost(env, sys, { action: 'db_backup' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.backup.name.startsWith(DB_BACKUP_PREFIX), '备份命名应带统一前缀');
    assert.ok(body.backup.bytes > 0);
    assert.ok(Number.isFinite(body.backup.created_at));
    assert.ok(Array.isArray(body.removed));
    if (i === DB_BACKUP_KEEP) {
      assert.equal(body.removed.length, 1, '超出保留份数时应清理 1 个最旧备份');
    }
    created.push(body.backup.name);
  }

  const files = fs.readdirSync(backupDir).filter((name) => name.startsWith(DB_BACKUP_PREFIX));
  assert.equal(files.length, DB_BACKUP_KEEP, `备份应只保留 ${DB_BACKUP_KEEP} 份`);
  assert.ok(!files.includes(created[0]), '最旧的一份应被清理');
  assert.ok(files.includes(created[created.length - 1]), '最新的一份应保留');
  // 备份目录不影响 cf-migrate 的 pre-migrate 备份（不同目录 / 前缀）
  assert.ok(!created[0].startsWith('monitor.db.pre-migrate-'));

  // 备份文件是完整可独立打开的库（WAL 已合并）：完整性 ok + 业务表在
  const latest = path.join(backupDir, created[created.length - 1]);
  const copy = new Database(latest, { readonly: true });
  assert.deepEqual(copy.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  const tableRow = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'servers'").get();
  assert.ok(tableRow, '备份应包含业务表');
  copy.close();

  // stats 里能看到当前备份列表
  const statsRes = await adminPost(env, sys, { action: 'db_stats' });
  const stats = (await statsRes.json()).stats;
  assert.equal(stats.backups.length, DB_BACKUP_KEEP);
  assert.ok(stats.backups_bytes > 0);
});

test('db_integrity_check 返回 ok', async () => {
  const res = await adminPost(env, sys, { action: 'db_integrity_check' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.ok, true);
  assert.deepEqual(body.problems, []);
  assert.equal(body.problems_total, 0);
  assert.ok(Number.isFinite(body.duration_ms));
});

test('维护中再次触发返回 409，执行失败返回 500 且带原始报错', async () => {
  const stubEnv = {
    DB: db,
    API_SECRET,
    dbMaintenance: {
      stats: async () => ({}),
      vacuum: async () => {
        const error = new Error(DB_MAINTENANCE_BUSY);
        error.code = DB_MAINTENANCE_BUSY;
        throw error;
      },
      backup: async () => { throw new Error('disk full'); },
      integrityCheck: async () => ({ ok: true })
    }
  };

  let res = await adminPost(stubEnv, sys, { action: 'db_vacuum' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'dbMaintenanceBusy');

  res = await adminPost(stubEnv, sys, { action: 'db_backup' });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'dbBackupFailed');
  assert.equal(body.message, 'disk full');
});

test('同一实例的 VACUUM / 备份互斥（模块内部 busy 守卫）', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowDb = {
    prepare: () => ({ first: () => gate.then(() => ({ page_size: 4096 })), all: async () => ({ results: [] }) }),
    exec: () => {}
  };
  const isolated = createDbMaintenance({ dataDir, db: slowDb });
  const pending = isolated.vacuum();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => isolated.backup(),
    (error) => error && error.code === DB_MAINTENANCE_BUSY
  );
  release();
  await pending;
  assert.equal(isolated.isRunning(), false);
});

test('底层 SQL 失败时维护操作必须抛出可捕获的错误（不吞错、不产生未处理的 Promise 拒绝）', async () => {
  // d1 适配层的 exec 是 async：若调用处漏 await，SQLite 抛错会变成未处理的 Promise 拒绝
  //（Node 默认模式下会终止进程），且 vacuum() 会错误地报成功。
  const failingDb = {
    prepare: () => ({ first: async () => ({ page_size: 4096 }), all: async () => ({ results: [] }) }),
    exec: async () => { throw new Error('database or disk is full'); }
  };
  const isolated = createDbMaintenance({ dataDir, db: failingDb });
  await assert.rejects(() => isolated.vacuum(), /disk is full/);
  assert.equal(isolated.isRunning(), false);
});
