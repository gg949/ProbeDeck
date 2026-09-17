// ─────────────────────────────────────────────────────────────────────────────
// d1.js — Cloudflare D1 → better-sqlite3 兼容层
//
// D1 底层就是 SQLite，本项目只用到 prepare/bind/first/all/run 这几个 API，
// 这里用 better-sqlite3 实现同接口的适配器，SQL 语句无需任何修改。
//
// 语义对齐要点：
//   • first()  无结果时返回 null（D1 行为）
//   • all()    返回 { success, results, meta }（原代码取 .results）
//   • run()    返回 { success, meta: { changes, last_row_id }, changes }
//   • bind 参数自动归一化：undefined→null、boolean→0/1、Date→毫秒时间戳
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

function normalizeArgs(args) {
  return args.map((value) => {
    if (value === undefined) return null;
    if (value === true) return 1;
    if (value === false) return 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

export function createD1Database(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  const stmtCache = new Map();
  function getStmt(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      // 限制缓存规模，避免极端情况下无限增长
      if (stmtCache.size > 500) stmtCache.clear();
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  function makeStatement(sql, boundArgs) {
    return {
      bind: (...args) => makeStatement(sql, normalizeArgs(args)),
      first: async (column) => {
        const row = getStmt(sql).get(...(boundArgs || []));
        if (row === undefined || row === null) return null;
        if (column) return row[column] ?? null;
        return row;
      },
      all: async () => ({
        success: true,
        results: getStmt(sql).all(...(boundArgs || [])),
        meta: { duration: 0, changes: 0 },
      }),
      run: async () => {
        const result = getStmt(sql).run(...(boundArgs || []));
        return {
          success: true,
          meta: {
            changes: result.changes,
            last_row_id: Number(result.lastInsertRowid),
            duration: 0,
          },
          changes: result.changes,
        };
      },
    };
  }

  return {
    prepare(sql) {
      return makeStatement(sql, []);
    },
    // 多语句/事务控制（BEGIN IMMEDIATE / COMMIT / ROLLBACK 等）：直接透传 better-sqlite3。
    // src 侧的在库操作（如表轮换）据此获得原子性保障；D1 环境没有 exec，调用方需自行降级。
    async exec(sql) {
      db.exec(sql);
      return { success: true };
    },
    // 预留：原项目目前未使用 batch/exec，如上游新增可在此扩展实现
    async batch(statements) {
      return Promise.all(statements.map((stmt) => stmt.all()));
    },
    close() {
      try {
        db.close();
      } catch (_) {}
    },
  };
}
