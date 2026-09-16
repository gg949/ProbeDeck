import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrafficReportContent,
  buildTrafficReportPayloads,
  calculateTrafficDelta,
  getDueTrafficReportTypes,
  getTrafficPeriodKeys,
  normalizeTrafficSnapshots,
  updateTrafficSnapshots
} from '../src/services/notification.js';

const timezone = 'Asia/Shanghai';
const server = { id: 'server-1', name: 'Tokyo' };

test('traffic snapshots initialize the three lightweight JSON baselines', () => {
  const now = Date.UTC(2026, 8, 1, 1);
  const result = updateTrafficSnapshots('{}', 10_000, 20_000, now, ['daily', 'weekly', 'monthly']);

  assert.equal(result.changed, true);
  assert.deepEqual(result.usage, {});
  assert.deepEqual(Object.keys(result.snapshots), ['daily', 'weekly', 'monthly']);
  for (const snapshot of Object.values(result.snapshots)) {
    assert.deepEqual(snapshot, {
      time: Math.floor(now / 1000),
      rx_bytes: 10_000,
      tx_bytes: 20_000
    });
  }
});

test('traffic snapshots calculate usage and roll only crossed period boundaries', () => {
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, Date.UTC(2026, 8, 6, 1), ['daily', 'weekly', 'monthly']);
  const monday = updateTrafficSnapshots(first.snapshots, 15_000, 28_000, Date.UTC(2026, 8, 7, 1), ['daily', 'weekly']);

  assert.deepEqual(monday.usage.daily, { rx_bytes: 5_000, tx_bytes: 8_000 });
  assert.deepEqual(monday.usage.weekly, { rx_bytes: 5_000, tx_bytes: 8_000 });
  assert.equal(monday.usage.monthly, undefined);
  assert.equal(monday.snapshots.daily.rx_bytes, 15_000);
  assert.equal(monday.snapshots.weekly.rx_bytes, 15_000);
  assert.equal(monday.snapshots.monthly.rx_bytes, 10_000);
});

test('traffic snapshots mark missed report periods as unavailable instead of overcounting', () => {
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, Date.UTC(2026, 8, 1, 1), ['daily']);
  const afterMissedDays = updateTrafficSnapshots(
    first.snapshots,
    25_000,
    40_000,
    Date.UTC(2026, 8, 4, 1),
    ['daily']
  );

  assert.equal(afterMissedDays.usage.daily, undefined);
  assert.equal(afterMissedDays.snapshots.daily.rx_bytes, 25_000);
});

test('traffic snapshot period keys honor the configured notification timezone', () => {
  const sundayUtc = Date.UTC(2026, 8, 6, 16, 30);
  assert.deepEqual(getTrafficPeriodKeys(sundayUtc, timezone), {
    daily: '2026-09-07',
    weekly: '2026-09-07',
    monthly: '2026-09'
  });

  assert.deepEqual(getDueTrafficReportTypes(sundayUtc, timezone), ['daily', 'weekly']);

  const monthStart = updateTrafficSnapshots('{}', 1_000, 2_000, Date.UTC(2026, 8, 30, 15), ['monthly']);
  const october = updateTrafficSnapshots(monthStart.snapshots, 3_000, 5_000, Date.UTC(2026, 8, 30, 16), ['monthly']);
  assert.equal(october.snapshots.monthly.rx_bytes, 3_000);
  assert.equal(october.snapshots.monthly.tx_bytes, 5_000);
});

test('traffic snapshot parsing and counter reset handling are backward safe', () => {
  assert.deepEqual(normalizeTrafficSnapshots('invalid json'), {});
  assert.equal(calculateTrafficDelta(15_000, 10_000), 5_000);
  assert.equal(calculateTrafficDelta(2_048, 50_000), 2_048);
  assert.equal(calculateTrafficDelta(2_048, null), 0);
});

test('traffic report content formats per-server usage and totals', () => {
  const report = buildTrafficReportContent([server], [{
    server_id: server.id,
    rx_bytes: 5_000,
    tx_bytes: 8_000
  }], '每日');

  assert.match(report.context.event, /每日流量报告/);
  assert.match(report.msg, /Tokyo/);
  assert.match(report.msg, /↓ 4\.88 KB/);
  assert.match(report.msg, /↑ 7\.81 KB/);
  assert.match(report.msg, /总计/);
});

test('traffic report content explains missing previous-period baselines', () => {
  const labels = [
    ['每日', '暂无昨日数据'],
    ['每周', '暂无上周数据'],
    ['每月', '暂无上月数据']
  ];
  for (const [label, expected] of labels) {
    const report = buildTrafficReportContent([server], [{
      server_id: server.id,
      missing: true
    }], label);
    assert.match(report.msg, new RegExp(expected));
    assert.doesNotMatch(report.msg, /总计/);
  }
});

test('traffic report payloads split servers into batches of at most 50', () => {
  const servers = Array.from({ length: 101 }, (_, index) => ({
    id: `server-${index + 1}`,
    name: `Server ${index + 1}`
  }));
  const rows = servers.map(item => ({
    server_id: item.id,
    rx_bytes: 1_000,
    tx_bytes: 2_000
  }));

  const reports = buildTrafficReportPayloads(servers, rows, '每日');

  assert.equal(reports.length, 3);
  assert.equal(reports[0].context.count, 50);
  assert.equal(reports[1].context.count, 50);
  assert.equal(reports[2].context.count, 1);
  assert.equal(reports[0].context.event, '每日流量报告（1/3）');
  assert.equal(reports[2].context.event, '每日流量报告（3/3）');
});

test('traffic report payloads also split before the message soft limit', () => {
  const servers = Array.from({ length: 20 }, (_, index) => ({
    id: `long-server-${index + 1}`,
    name: `${index + 1}-${'x'.repeat(180)}`
  }));
  const rows = servers.map(item => ({
    server_id: item.id,
    rx_bytes: 1_000,
    tx_bytes: 2_000
  }));

  const reports = buildTrafficReportPayloads(servers, rows, '每日');

  assert.ok(reports.length > 1);
  assert.ok(reports.every(report => report.msg.length <= 3000));
});
