// ─────────────────────────────────────────────────────────────────────────────
// db-maintenance.js — 数据库运维（数据库体积 / VACUUM / 常规备份 / 完整性检查）
//
// Docker/VPS 版专属：Cloudflare Workers 版没有本地数据库文件，也不支持
// VACUUM / PRAGMA 这类操作。server/index.js 在构造 env 时注入
// env.dbMaintenance；src/handlers/admin.js 的管理员动作（db_stats /
// db_vacuum / db_backup / db_integrity_check）通过它执行。CF 环境
// env.dbMaintenance 为空 → 接口返回 501 dbMaintenanceUnsupported，
// 前端据此隐藏「数据库维护」入口。
//
// 备份：<dataDir>/backups/monitor-backup-YYYYMMDD-HHMMssSSS.db，只保留最新
// keepBackups 份（自动清理最旧）。备份前先 wal_checkpoint(TRUNCATE) 把 WAL
// 合并进主库（与 cf-migrate 的既有做法一致），因此单个 .db 文件即是完整备份。
// 与 cf-migrate 的 monitor.db.pre-migrate-* 备份互不干扰（不同目录 / 前缀）。
//
// 说明：better-sqlite3 是同步 API，VACUUM / 完整性检查执行期间会短暂占用
// 事件循环（面板接口排队等待），单事务失败即时抛错、不会卡死进程。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

export const DB_MAINTENANCE_BUSY = 'dbMaintenanceBusy';
export const DB_BACKUP_KEEP = 3;
export const DB_BACKUP_DIR_NAME = 'backups';
export const DB_BACKUP_PREFIX = 'monitor-backup-';
export const DB_BACKUP_SUFFIX = '.db';

// 完整性检查异常行的返回上限（正常库只返回一行 ok；异常行可能很多）
const INTEGRITY_REPORT_MAX = 50;

function createBusyError() {
  const error = new Error(DB_MAINTENANCE_BUSY);
  error.code = DB_MAINTENANCE_BUSY;
  return error;
}

function fileBytes(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch (_) {
    return 0;
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

// 备份文件名时间戳（本地时区，名称按字典序即时间序）
export function formatBackupStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
}

export function parseBackupStamp(name) {
  const match = /^monitor-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})\.db$/.exec(String(name || ''));
  if (!match) return null;
  const [, year, month, day, hour, minute, second, milli] = match;
  const timestamp = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second), Number(milli)
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function createDbMaintenance({ dataDir, db, keepBackups = DB_BACKUP_KEEP } = {}) {
  const baseDir = String(dataDir || '');
  const dbPath = path.join(baseDir, 'monitor.db');
  const backupDir = path.join(baseDir, DB_BACKUP_DIR_NAME);
  const keep = Math.max(1, Math.floor(Number(keepBackups)) || DB_BACKUP_KEEP);
  let running = false;

  async function pragmaValue(name) {
    const row = await db.prepare(`PRAGMA ${name}`).first();
    if (!row) return null;
    const value = Object.values(row)[0];
    return value === undefined ? null : value;
  }

  // 备份文件列表（按名称倒序 = 新 → 旧）
  function listBackups() {
    let names = [];
    try {
      names = fs.readdirSync(backupDir)
        .filter((name) => name.startsWith(DB_BACKUP_PREFIX) && name.endsWith(DB_BACKUP_SUFFIX));
    } catch (_) {
      return [];
    }
    return names.sort().reverse().map((name) => {
      const filePath = path.join(backupDir, name);
      let mtime = 0;
      try { mtime = fs.statSync(filePath).mtimeMs; } catch (_) {}
      const created = parseBackupStamp(name);
      return { name, bytes: fileBytes(filePath), created_at: created ?? mtime };
    });
  }

  function pruneBackups() {
    const stale = listBackups().slice(keep);
    const removed = [];
    for (const entry of stale) {
      try {
        fs.unlinkSync(path.join(backupDir, entry.name));
        removed.push(entry.name);
      } catch (_) {}
    }
    return removed;
  }

  function nextBackupName() {
    let stamp = Date.now();
    for (let attempt = 0; attempt < 5000; attempt += 1) {
      const name = `${DB_BACKUP_PREFIX}${formatBackupStamp(new Date(stamp))}${DB_BACKUP_SUFFIX}`;
      if (!fs.existsSync(path.join(backupDir, name))) return name;
      stamp += 1; // 同一毫秒内连打备份时顺延，保证名称唯一且仍有时间序
    }
    throw new Error('Unable to allocate backup file name');
  }

  async function snapshot() {
    const pageSize = Number(await pragmaValue('page_size')) || 0;
    const pageCount = Number(await pragmaValue('page_count')) || 0;
    const freelistCount = Number(await pragmaValue('freelist_count')) || 0;
    const journalMode = String((await pragmaValue('journal_mode')) || '');
    const autoVacuum = Number(await pragmaValue('auto_vacuum')) || 0;
    const dbBytes = fileBytes(dbPath);
    const walBytes = fileBytes(`${dbPath}-wal`);
    const backups = listBackups();

    return {
      db_bytes: dbBytes,
      wal_bytes: walBytes,
      total_bytes: dbBytes + walBytes,
      page_size: pageSize,
      page_count: pageCount,
      freelist_count: freelistCount,
      freelist_bytes: pageSize * freelistCount,
      journal_mode: journalMode,
      auto_vacuum: autoVacuum,
      keep_backups: keep,
      backups: backups.map((entry) => ({ name: entry.name, bytes: entry.bytes, created_at: entry.created_at })),
      backups_bytes: backups.reduce((sum, entry) => sum + entry.bytes, 0),
      checked_at: Date.now()
    };
  }

  // VACUUM / 备份互斥：同一时间只允许一个（避免并发复制到半个库 / 重复压缩）
  async function runExclusive(task) {
    if (running) throw createBusyError();
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  }

  async function stats() {
    return await snapshot();
  }

  async function vacuum() {
    return await runExclusive(async () => {
      const startedAt = Date.now();
      const before = await snapshot();
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // 先合并 WAL，VACUUM 才能回收主库文件
      await db.exec('VACUUM');
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // 回收后的数据落回主库并截断 WAL
      const after = await snapshot();
      return {
        freed_bytes: Math.max(0, before.total_bytes - after.total_bytes),
        duration_ms: Date.now() - startedAt,
        stats: after
      };
    });
  }

  async function backup() {
    return await runExclusive(async () => {
      fs.mkdirSync(backupDir, { recursive: true });
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // 合并 WAL，保证备份文件可独立打开
      const name = nextBackupName();
      const target = path.join(backupDir, name);
      fs.copyFileSync(dbPath, target);
      const removed = pruneBackups();
      const entry = listBackups().find((item) => item.name === name)
        || { name, bytes: fileBytes(target), created_at: Date.now() };
      return {
        backup: entry,
        removed,
        stats: await snapshot()
      };
    });
  }

  async function integrityCheck() {
    const startedAt = Date.now();
    const result = await db.prepare('PRAGMA integrity_check').all();
    const rows = (result?.results || [])
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter((line) => line.length > 0);
    const ok = rows.length === 1 && rows[0].toLowerCase() === 'ok';
    return {
      ok,
      problems: ok ? [] : rows.slice(0, INTEGRITY_REPORT_MAX),
      problems_total: ok ? 0 : rows.length,
      truncated: !ok && rows.length > INTEGRITY_REPORT_MAX,
      duration_ms: Date.now() - startedAt
    };
  }

  return {
    stats,
    vacuum,
    backup,
    integrityCheck,
    isRunning: () => running,
    dbPath,
    backupDir
  };
}
