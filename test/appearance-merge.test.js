import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createD1Database } from '../server/d1.js';
import { initDatabase } from '../src/database/schema.js';
import { loadSettings, loadSiteSettings } from '../src/utils/settings.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';

// 回归用例：主题商店「启用主题 / Mikus 开关」的部分保存会把手机背景图等
// 未提交的外观字段整段冲掉（appearance_options 被整体替换，v2.12.0 及之前）。
// 修复后：保存改为「合并已有 appearance_options」，未提交字段保持原值；
// 显式提交空字符串仍可正常清空。

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-appearance-merge-'));
  return { db: createD1Database(path.join(dir, 'monitor.db')), dir };
}

async function adminPost(env, sys, payload) {
  const token = await generateToken(env, sys);
  const request = new Request('http://localhost/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  return await handleAdminAPI(request, env, sys, async () => loadSettings(env.DB), null);
}

async function readAppearance(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'appearance_options'").first();
  return row && row.value ? JSON.parse(row.value) : {};
}

test('partial appearance save preserves unsubmitted fields', async () => {
  const { db } = makeTempDb();
  await initDatabase(db);
  const env = { DB: db, API_SECRET: 'test-secret-0123456789abcdef' };
  const sys = await loadSiteSettings(db);

  // 1) 完整保存：设定手机背景图 / 深色外观 / 中文
  let res = await adminPost(env, sys, {
    action: 'save_settings',
    settings: {
      site_title: 'ProbeDeck',
      custom_bg: 'https://example.com/a.jpg',
      custom_bg_mobile: 'https://example.com/m.jpg',
      preferred_theme: 'dark',
      default_language: 'zh',
      display_mode: 'bar',
      appearance_options: { theme_options: {} }
    }
  });
  assert.equal(res.status, 200);
  let appearance = await readAppearance(db);
  assert.equal(appearance.custom_bg_mobile, 'https://example.com/m.jpg');
  assert.equal(appearance.preferred_theme, 'dark');
  assert.equal(appearance.default_language, 'zh');

  // 2) 主题商店式部分保存：请求里没有 custom_bg_mobile / preferred_theme / default_language
  res = await adminPost(env, sys, {
    action: 'save_settings',
    settings: {
      site_title: 'ProbeDeck',
      custom_bg: 'https://example.com/a.jpg',
      favicon: '',
      custom_head: '',
      custom_script: '',
      csp_static: '',
      csp_api: '',
      display_mode: 'bar',
      appearance_options: { theme_options: { style: 'default' } }
    }
  });
  assert.equal(res.status, 200);
  appearance = await readAppearance(db);
  assert.equal(appearance.custom_bg_mobile, 'https://example.com/m.jpg', '手机背景图不能被部分保存冲掉');
  assert.equal(appearance.preferred_theme, 'dark', 'preferred_theme 不能被部分保存冲掉');
  assert.equal(appearance.default_language, 'zh', 'default_language 不能被部分保存冲掉');
  assert.deepEqual(appearance.theme_options, { style: 'default' });

  // 3) 显式提交空字符串仍应清空
  res = await adminPost(env, sys, {
    action: 'save_settings',
    settings: { custom_bg_mobile: '' }
  });
  assert.equal(res.status, 200);
  appearance = await readAppearance(db);
  assert.equal(appearance.custom_bg_mobile, '');
});
