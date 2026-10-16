import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createD1Database } from '../server/d1.js';
import { initDatabase } from '../src/database/schema.js';
import { loadSiteSettings } from '../src/utils/settings.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import {
  buildPublicProbes,
  extraHostsFromJson,
  flattenServerProbeFields,
  normalizeProbeSlotFields,
  serializeExtraHosts
} from '../src/utils/probes.js';

// 回归用例：扩展槽删除写 '0'（v2.13.2-beta1 批次第 4 项）
// 背景：扩展槽（node_5 … node_20，存 extra_probe_hosts JSON）被删除/清空后，探针要等下一次
//   上报（默认 30–60s）才停测该线路，这期间历史延迟数值仍在——主题端按「有值就收」会把已删
//   除的线路继续画出来（Lumina「删了行还显示」）。统一修法：清空/删除已配置的扩展槽时写 '0'
//   （显式禁用，主题端按 host === '0' 判定禁用），'' 只留给「从未配置」。
// ⚠️ 只能对扩展槽这么做：前 8 槽（custom_ct … node_4）是独立列，'' 有「继承站点默认」含义。

const API_SECRET = 'test-secret-probe-slot-clear';
const SERVER_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SERVER_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

async function adminPost(env, sys, payload) {
  const request = new Request('http://localhost/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await generateToken(env, sys)}`
    },
    body: JSON.stringify(payload)
  });
  return await handleAdminAPI(request, env, sys, async () => loadSiteSettings(env.DB), null);
}

const editPayload = (id, overrides = {}) => ({
  action: 'edit',
  id,
  name: '删除测试机',
  server_group: 'Default',
  region: 'CN',
  tags: '',
  note: '',
  price: '0',
  billing_cycle: 'month',
  auto_renewal: '0',
  currency: '¥',
  expire_date: '',
  traffic_limit: '',
  traffic_calc_type: 'total',
  interface: '',
  reset_day: 1,
  collect_interval: 0,
  report_interval: 60,
  wss_report_interval: 2,
  connection_mode: 'auto',
  ping_mode: 'tcp',
  custom_ct: '', custom_cu: '', custom_cm: '', custom_bd: '',
  node_1: '', node_2: '', node_3: '', node_4: '',
  rx_correction: '',
  tx_correction: '',
  auto_update: '0',
  is_hidden: '0',
  offline_notify_disabled: '0',
  ...overrides
});

test('serializeExtraHosts：已配置的扩展槽清空/删除写 0，从未配置保持未配置', () => {
  // 正常值写入不受影响
  assert.deepEqual(
    JSON.parse(serializeExtraHosts({ node_5: '8.8.8.8:53', node_20: '1.1.1.1' })),
    { node_5: '8.8.8.8:53', node_20: '1.1.1.1' }
  );

  // 原本有值的扩展槽被清空 → '0'（显式禁用）
  assert.deepEqual(
    JSON.parse(serializeExtraHosts({ node_5: '' }, { node_5: '8.8.8.8:53' })),
    { node_5: '0' }
  );

  // 旧值已是 '0'（显式禁用）→ 保持 '0'（幂等，不会被清回「未配置」）
  assert.deepEqual(
    JSON.parse(serializeExtraHosts({ node_5: '' }, { node_5: '0' })),
    { node_5: '0' }
  );

  // payload 里字段缺失 = 清空（与「整行覆写」的既有语义一致）
  assert.deepEqual(
    JSON.parse(serializeExtraHosts({}, { node_6: '9.9.9.9:53' })),
    { node_6: '0' }
  );

  // 从未配置过（旧值为空 / 键不存在）→ 保持未配置：不写 '0'，也不进 JSON
  assert.equal(serializeExtraHosts({ node_5: '', node_6: '' }), '');
  assert.equal(serializeExtraHosts({ node_5: '' }, { node_5: '' }), '');
  assert.equal(serializeExtraHosts({ node_5: '' }, {}), '');

  // 显式传 '0'（不依赖旧值）照旧写 '0'
  assert.deepEqual(JSON.parse(serializeExtraHosts({ node_7: '0' })), { node_7: '0' });

  // 混合：一条改值、一条删除、一条新增
  assert.deepEqual(
    JSON.parse(serializeExtraHosts(
      { node_5: '8.8.4.4:53', node_6: '', node_7: '1.1.1.1' },
      { node_5: '8.8.8.8:53', node_6: '9.9.9.9:53' }
    )),
    { node_5: '8.8.4.4:53', node_6: '0', node_7: '1.1.1.1' }
  );

  // 前 8 槽不经过扩展槽序列化：'' 原样保留（有「继承站点默认」含义）
  const legacy = normalizeProbeSlotFields({ custom_ct: '', node_1: '' });
  assert.equal(legacy.valid, true);
  assert.equal(legacy.values.custom_ct, '');
  assert.equal(legacy.values.node_1, '');
});

test('管理端保存：前 8 槽清空仍写 ""，扩展槽删除写 "0"，从未配置的扩展槽不受影响', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-probe-slot-clear-'));
  const db = createD1Database(path.join(dir, 'monitor.db'));
  try {
    await initDatabase(db);
    const sys = await loadSiteSettings(db);
    const env = { DB: db, API_SECRET };

    // 行 A：前 8 槽（custom_ct）与扩展槽（node_5 / node_6）都已配置
    //（前 8 槽的 host 是独立列；前 8 槽没有按机器的名字列，名字只走站点设置）
    await db.prepare(
      `INSERT INTO servers
       (id, name, server_group, history_partition_id, timestamp, custom_ct, extra_probe_hosts, extra_probe_names)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      SERVER_A, '已配置机', 'Default', 1, Date.now(),
      '1.1.1.1:53',
      JSON.stringify({ node_5: '8.8.8.8:53', node_6: '9.9.9.9:53' }),
      JSON.stringify({ node_5_name: '线路5' })
    ).run();

    // 行 B：从未配置过任何探测点
    await db.prepare(
      `INSERT INTO servers (id, name, server_group, history_partition_id, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(SERVER_B, '未配置机', 'Default', 2, Date.now()).run();

    // 保存行 A：前 8 槽清空、node_5 删除、node_6 改值、node_7 显式禁用
    const resA = await adminPost(env, sys, editPayload(SERVER_A, {
      custom_ct: '',
      node_5: '',
      node_6: '8.8.4.4:53',
      node_7: '0',
      node_5_name: '',
      node_6_name: '线路6'
    }));
    assert.equal(resA.status, 200);

    const rowA = await db.prepare(
      'SELECT custom_ct, extra_probe_hosts, extra_probe_names FROM servers WHERE id = ?'
    ).bind(SERVER_A).first();

    // 前 8 槽：'' 仍是 ''（继承站点默认语义不变，绝不能写成 '0'）
    assert.equal(rowA.custom_ct, '', '前 8 槽清空后应保持空串');

    const hostsA = JSON.parse(rowA.extra_probe_hosts);
    assert.equal(hostsA.node_5, '0', '已配置的扩展槽被清空后应写 0（显式禁用）');
    assert.equal(hostsA.node_6, '8.8.4.4:53', '扩展槽改值应写入新值');
    assert.equal(hostsA.node_7, '0', '显式传 0 仍写 0');
    assert.equal('node_8' in hostsA, false, '从未配置的扩展槽不应写 0');

    const namesA = JSON.parse(rowA.extra_probe_names);
    assert.equal('node_5_name' in namesA, false, '清空的扩展槽名字应一并移除');
    assert.equal(namesA.node_6_name, '线路6');

    // 主题可见性：删除的槽位从 probes[] 消失（host === '0' 与 '' 都不出现）
    const flatA = flattenServerProbeFields(rowA);
    assert.equal(flatA.node_5, '0');
    assert.deepEqual(buildPublicProbes(flatA, {}).map(p => p.id), ['node_6']);

    // 幂等：再保存一次（node_5 依旧为空）仍是 '0'，不会退回 ''（未配置）
    const resA2 = await adminPost(env, sys, editPayload(SERVER_A, { node_6: '8.8.4.4:53' }));
    assert.equal(resA2.status, 200);
    const rowA2 = await db.prepare('SELECT extra_probe_hosts FROM servers WHERE id = ?').bind(SERVER_A).first();
    assert.equal(extraHostsFromJson(rowA2.extra_probe_hosts).node_5, '0');
    assert.equal(extraHostsFromJson(rowA2.extra_probe_hosts).node_6, '8.8.4.4:53');

    // 保存行 B（只改名）：从未配置过的扩展槽仍是未配置，不会被写成 '0'
    const resB = await adminPost(env, sys, editPayload(SERVER_B, { name: '未配置机（改名）' }));
    assert.equal(resB.status, 200);
    const rowB = await db.prepare(
      'SELECT name, custom_ct, extra_probe_hosts FROM servers WHERE id = ?'
    ).bind(SERVER_B).first();
    assert.equal(rowB.name, '未配置机（改名）');
    assert.equal(rowB.custom_ct, '', '前 8 槽未配置时仍为空串');
    assert.equal(rowB.extra_probe_hosts, '', '从未配置的扩展槽不应被写成 0');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
