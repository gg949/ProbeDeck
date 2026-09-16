import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AGENT_CONFIG_CONNECTION_MODE_SCHEMA_VERSION,
  AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
  AGENT_CONFIG_SCHEMA_VERSION,
  buildAgentConfig,
  describeAgentConfig,
  isValidTrafficCorrection,
  serializeAgentConfig,
  serializeCorrection,
  validateAgentConfigInput,
  validateNetworkInterfaces,
  validatePingNode
} from '../src/utils/agentConfig.js';
import { md5Hash } from '../src/utils/common.js';
import { clearSiteSettingsCache, isWssReportEnabled, loadSiteSettings, normalizeWssReportHours, saveSiteOptions } from '../src/utils/settings.js';

const server = {
  collect_interval: 1,
  report_interval: 60,
  reset_day: 15,
  ping_mode: 'tcp'
};
const expected = 'collect_interval=1&report_interval=60&reset_day=15&schema_version=7&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&node_1=&node_2=&node_3=&node_4=&connection_mode=http&ping_mode=tcp';
const expectedWssEnabled = 'collect_interval=1&report_interval=60&reset_day=15&schema_version=7&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&node_1=&node_2=&node_3=&node_4=&connection_mode=auto&wss_report_interval=2&ping_mode=tcp';
const expectedLegacy = 'collect_interval=1&report_interval=60&reset_day=15&schema_version=3&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=';

const config = buildAgentConfig(server);
assert.equal(serializeAgentConfig(config), expected);
assert.equal(serializeAgentConfig(buildAgentConfig(server, { wss_report_enabled: 'true' })), expectedWssEnabled);
assert.equal(serializeAgentConfig(buildAgentConfig(server, { wss_report_enabled: 'true', wss_report_hours: [] })), expectedWssEnabled);
assert.equal(serializeAgentConfig(buildAgentConfig(server, null, AGENT_CONFIG_LEGACY_SCHEMA_VERSION)), expectedLegacy);

const descriptor = await describeAgentConfig(server);
assert.equal(descriptor.serialized, expected);
assert.equal(descriptor.md5, createHash('md5').update(expected).digest('hex'));
assert.equal(descriptor.correction, null);

const legacyDescriptor = await describeAgentConfig(server, null, AGENT_CONFIG_LEGACY_SCHEMA_VERSION);
assert.equal(legacyDescriptor.serialized, expectedLegacy);
assert.equal(Object.prototype.hasOwnProperty.call(legacyDescriptor.config, 'connection_mode'), false);

const schema4Server = { ...server, collect_interval: 0, reset_day: 1 };
const schema4Expected = 'collect_interval=0&report_interval=60&reset_day=1&schema_version=4&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto';
const schema4Descriptor = await describeAgentConfig(
  schema4Server,
  { wss_report_enabled: 'true' },
  AGENT_CONFIG_CONNECTION_MODE_SCHEMA_VERSION
);
assert.equal(schema4Descriptor.serialized, schema4Expected);
assert.equal(schema4Descriptor.md5, createHash('md5').update(schema4Expected).digest('hex'));
assert.equal(schema4Descriptor.config.collect_interval, 0);
assert.equal(Object.prototype.hasOwnProperty.call(schema4Descriptor.config, 'wss_report_interval'), false);

const schema5Expected = 'collect_interval=1&report_interval=60&reset_day=15&schema_version=5&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto&wss_report_interval=2';
const schema5Descriptor = await describeAgentConfig(server, { wss_report_enabled: 'true' }, 5);
assert.equal(schema5Descriptor.serialized, schema5Expected);
assert.equal(Object.prototype.hasOwnProperty.call(schema5Descriptor.config, 'ping_mode'), false);

const autoUpdateDescriptor = await describeAgentConfig({ ...server, auto_update: '1' });
assert.equal(autoUpdateDescriptor.serialized, expected);
assert.equal(autoUpdateDescriptor.md5, descriptor.md5);

const correctionDescriptor = await describeAgentConfig({ ...server, rx_correction: null, tx_correction: 5 });
assert.deepEqual(correctionDescriptor.correction, {
  rx_correction: 0,
  tx_correction: 5
});
assert.equal(serializeCorrection(correctionDescriptor.correction), '&rx_correction=0&tx_correction=5');
assert.equal(isValidTrafficCorrection('0'), true);
assert.equal(isValidTrafficCorrection('0.5'), true);
assert.equal(isValidTrafficCorrection('1000000'), true);
assert.equal(isValidTrafficCorrection('-1'), false);
assert.equal(isValidTrafficCorrection('1e3'), false);
assert.equal(isValidTrafficCorrection('0x10'), false);
assert.equal(isValidTrafficCorrection('1000000.1'), false);
assert.deepEqual(validateNetworkInterfaces('eth0, ens3,eth0'), { valid: true, value: 'eth0,ens3' });
assert.equal(validateNetworkInterfaces('eth0/1').valid, false);

for (const value of ['', 'abc', '中文', 'a'.repeat(1000)]) {
  assert.equal(await md5Hash(value), createHash('md5').update(value).digest('hex'));
}

assert.equal(validateAgentConfigInput(server).valid, true);
assert.equal(validateAgentConfigInput({ ...server, collect_interval: '1' }).valid, false);
assert.equal(validateAgentConfigInput({ ...server, reset_day: 32 }).valid, false);
assert.deepEqual(buildAgentConfig({}), {
  collect_interval: 0,
  report_interval: 60,
  reset_day: 1,
  custom_ct: '',
  custom_cu: '',
  custom_cm: '',
  custom_bd: '',
  interface: '',
  schema_version: AGENT_CONFIG_SCHEMA_VERSION,
  node_1: '',
  node_2: '',
  node_3: '',
  node_4: '',
  connection_mode: 'http',
  ping_mode: 'tcp'
});
assert.equal(buildAgentConfig({ ping_mode: 'icmp' }).ping_mode, 'icmp');
assert.equal(buildAgentConfig({ ping_mode: 'bad' }).ping_mode, 'tcp');
assert.equal(buildAgentConfig({ connection_mode: 'post' }).connection_mode, 'http');
assert.equal(buildAgentConfig({ connection_mode: 'auto' }, { wss_report_enabled: 'true' }).connection_mode, 'auto');
assert.equal(buildAgentConfig({ connection_mode: 'auto' }, { wss_report_enabled: 'true' }).wss_report_interval, 2);
assert.equal(buildAgentConfig({ collect_interval: 0, connection_mode: 'auto' }, { wss_report_enabled: 'true' }).collect_interval, 2);
assert.equal(buildAgentConfig({ collect_interval: 10, wss_report_interval: 2, connection_mode: 'auto' }, { wss_report_enabled: 'true' }).collect_interval, 2);
assert.equal(buildAgentConfig({ collect_interval: 10, wss_report_interval: 2, connection_mode: 'http' }, { wss_report_enabled: 'true' }).collect_interval, 10);
assert.equal(buildAgentConfig({ connection_mode: 'http' }, { wss_report_enabled: 'true' }).connection_mode, 'http');
assert.equal(Object.prototype.hasOwnProperty.call(
  buildAgentConfig({ connection_mode: 'http' }, { wss_report_enabled: 'true' }),
  'wss_report_interval'
), false);
assert.deepEqual(normalizeWssReportHours(undefined), Array.from({ length: 24 }, (_, hour) => hour));
assert.deepEqual(normalizeWssReportHours('[23, 2, 2, 99, "4"]'), [2, 4, 23]);
assert.deepEqual(normalizeWssReportHours([]), []);
clearSiteSettingsCache();
{
  const createEmptySettingsDb = () => {
    let persistedSiteOptions = null;
    return {
      get persistedSiteOptions() {
        return persistedSiteOptions;
      },
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            if (sql.includes("WHERE key = 'site_options'")) {
              return persistedSiteOptions ? { value: persistedSiteOptions } : null;
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (sql.includes('INSERT INTO settings') && Array.isArray(this.args)) {
              if (this.args[0] === 'site_options' && typeof this.args[1] === 'string') {
                persistedSiteOptions = this.args[1];
              } else if (sql.includes('json_object')) {
                persistedSiteOptions = JSON.stringify({ jwt_secret: this.args[0] });
              }
            }
            return { success: true };
          }
        };
      }
    };
  };
  const emptySettingsDb = createEmptySettingsDb();
  const defaultSettings = await loadSiteSettings(emptySettingsDb, { forceRefresh: true });
  assert.equal(defaultSettings.show_three_net_details, 'true');
  assert.equal(defaultSettings.wss_report_enabled, 'true');
  assert.deepEqual(defaultSettings.wss_report_hours, Array.from({ length: 24 }, (_, hour) => hour));
  assert.equal(isWssReportEnabled(defaultSettings, new Date('2026-08-20T10:00:00Z')), true);

  clearSiteSettingsCache();
  const initializedSiteOptions = await saveSiteOptions(createEmptySettingsDb(), { servers_optimized: 'true' });
  assert.equal(initializedSiteOptions.show_three_net_details, 'true');
  assert.equal(initializedSiteOptions.wss_report_enabled, 'true');
  assert.deepEqual(initializedSiteOptions.wss_report_hours, Array.from({ length: 24 }, (_, hour) => hour));
}
assert.equal(isWssReportEnabled(
  { wss_report_enabled: 'true', wss_report_hours: [8, 9] },
  new Date('2026-08-20T08:30:00Z')
), true);
assert.equal(isWssReportEnabled(
  { wss_report_enabled: 'true', wss_report_hours: [8, 9] },
  new Date('2026-08-20T10:00:00Z')
), false);
assert.equal(isWssReportEnabled(
  { wss_report_enabled: 'false', wss_report_hours: [8] },
  new Date('2026-08-20T08:30:00Z')
), false);
assert.equal(validateAgentConfigInput({ ...server, connection_mode: 'http' }).config.connection_mode, 'http');
assert.equal(validateAgentConfigInput({ ...server, connection_mode: 'bad' }).valid, false);
assert.equal(validateAgentConfigInput({ ...server, ping_mode: 'icmp' }).config.ping_mode, 'icmp');
assert.equal(validateAgentConfigInput({ ...server, ping_mode: 'bad' }).valid, false);
assert.equal(validateAgentConfigInput({ ...server, wss_report_interval: 1 }).valid, true);
assert.equal(validateAgentConfigInput({ ...server, wss_report_interval: 5 }).valid, true);
assert.equal(validateAgentConfigInput({ ...server, wss_report_interval: 0 }).valid, false);
assert.equal(validateAgentConfigInput({ ...server, wss_report_interval: 6 }).valid, false);

// Test server-level ping node priority
const serverWithCustomPing = {
  collect_interval: 0,
  report_interval: 60,
  reset_day: 1,
  custom_ct: 'ct-server.example.com',
  custom_cu: '',
  custom_cm: '',
  custom_bd: ''
};
const settings = { custom_ct: 'ct-global.example.com', custom_cu: 'cu-global.example.com', custom_cm: 'cm-global.example.com', custom_bd: 'bd-global.example.com' };
const resolvedConfig = buildAgentConfig(serverWithCustomPing, settings);
assert.equal(resolvedConfig.custom_ct, 'ct-server.example.com');
assert.equal(resolvedConfig.custom_cu, 'cu-global.example.com');
assert.equal(resolvedConfig.custom_cm, 'cm-global.example.com');
assert.equal(resolvedConfig.custom_bd, 'bd-global.example.com');
for (const explicitEmpty of [0, '0']) {
  const explicitEmptyConfig = buildAgentConfig({ custom_ct: explicitEmpty }, settings);
  assert.equal(explicitEmptyConfig.custom_ct, '', `custom_ct=${String(explicitEmpty)} must override the global node`);
  const explicitEmptyDescriptor = await describeAgentConfig({ custom_ct: explicitEmpty }, settings);
  assert.match(explicitEmptyDescriptor.serialized, /(?:^|&)custom_ct=(?:&|$)/);
}
assert.equal(buildAgentConfig({ custom_ct: null }, settings).custom_ct, 'ct-global.example.com');
assert.equal(buildAgentConfig({ custom_ct: '' }, settings).custom_ct, 'ct-global.example.com');
assert.equal(buildAgentConfig({}, settings).custom_ct, 'ct-global.example.com');
assert.equal(buildAgentConfig({ interface: 'eth0, ens3,eth0' }).interface, 'eth0,ens3');
assert.equal(buildAgentConfig({ custom_ct: 'gd-ct-v4.ip.zstaticcdn.com:80' }).custom_ct, 'gd-ct-v4.ip.zstaticcdn.com:80');
assert.equal(buildAgentConfig({ custom_ct: 'GD-CT-V4.IP.ZSTATICCDN.COM:080' }).custom_ct, 'gd-ct-v4.ip.zstaticcdn.com:80');
assert.equal(buildAgentConfig({ custom_ct: 'a'.repeat(100) }).custom_ct, '');
assert.equal(buildAgentConfig({ custom_ct: 'gd-ct-v4.ip.zstaticcdn.com:99999' }).custom_ct, '');
assert.equal(buildAgentConfig({ custom_ct: 'foo:bar' }).custom_ct, '');
assert.equal(buildAgentConfig({ custom_ct: '2001:db8::1' }).custom_ct, '[2001:db8::1]');
assert.equal(buildAgentConfig({ custom_ct: '[2001:db8::1]:443' }).custom_ct, '[2001:db8::1]:443');
assert.deepEqual(validatePingNode('foo:443'), { valid: true, value: 'foo:443' });
assert.equal(validatePingNode('foo:bar').valid, false);
assert.deepEqual(validatePingNode('2001:db8::1'), { valid: true, value: '[2001:db8::1]' });
assert.deepEqual(validatePingNode('[2001:db8::1]:443'), { valid: true, value: '[2001:db8::1]:443' });
assert.deepEqual(validatePingNode('2001:db8::1:443'), { valid: true, value: '[2001:db8::1:443]' });

console.log('agent config tests passed');
