import assert from 'node:assert/strict';
import {
  ALL_PROBE_SLOTS,
  MAX_PROBES,
  flattenServerProbeFields,
  normalizeProbeSlotFields,
  serializeExtraHosts,
  serializeExtraNames,
  serializeExtraPingLoss,
  mergeExtraPingLoss,
  buildPublicProbes,
  attachResolvedProbeNames,
  probeCliFlag,
  pingSlotColor
} from '../src/utils/probes.js';
import { buildAgentConfig, serializeAgentConfig } from '../src/utils/agentConfig.js';

assert.equal(ALL_PROBE_SLOTS.length, MAX_PROBES);
assert.equal(MAX_PROBES, 24);

const normalized = normalizeProbeSlotFields({
  custom_ct: '1.1.1.1:53',
  custom_ct_name: '电信v4',
  node_5: '8.8.8.8:53',
  node_5_name: 'Google DNS'
});
assert.equal(normalized.valid, true);
assert.equal(normalized.values.custom_ct, '1.1.1.1:53');
assert.equal(normalized.values.custom_ct_name, '电信v4');
assert.equal(normalized.values.node_5, '8.8.8.8:53');
assert.equal(normalized.values.node_5_name, 'Google DNS');

const extraHosts = serializeExtraHosts(normalized.values);
assert.equal(JSON.parse(extraHosts).node_5, '8.8.8.8:53');
const extraNames = serializeExtraNames(normalized.values);
assert.equal(JSON.parse(extraNames).node_5_name, 'Google DNS');

const flattened = flattenServerProbeFields({
  custom_ct: '1.1.1.1:53',
  extra_probe_hosts: extraHosts,
  extra_probe_names: extraNames
});
assert.equal(flattened.node_5, '8.8.8.8:53');
assert.equal(flattened.node_5_name, 'Google DNS');

const probes = buildPublicProbes(flattened, { custom_ct_name: '站点电信' });
assert.equal(probes[0].id, 'ct');
assert.equal(probes[0].name, '站点电信');
assert.equal(probes.at(-1).id, 'node_5');
assert.equal(probes.at(-1).name, 'Google DNS');

const named = attachResolvedProbeNames({ custom_ct_name: '本机电信' }, { custom_ct_name: '站点电信' });
assert.equal(named.custom_ct_name, '本机电信');

const extraJson = serializeExtraPingLoss({ ping_node_5: 12, loss_node_5: 0, ping_node_6: false });
assert.equal(JSON.parse(extraJson).ping_node_5, 12);
assert.equal(JSON.parse(extraJson).loss_node_5, 0);
assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(extraJson), 'ping_node_6'), false);

const merged = mergeExtraPingLoss({ ping_ct: 10 }, extraJson);
assert.equal(merged.ping_node_5, 12);
assert.equal(merged.loss_node_5, 0);

const schema8 = serializeAgentConfig(buildAgentConfig({ node_5: '8.8.8.8' }, null, 8));
assert.equal(schema8.includes('node_5='), false);
const schema9 = serializeAgentConfig(buildAgentConfig({ node_5: '8.8.8.8' }, null, 9));
assert.equal(schema9.includes('node_5=8.8.8.8'), true);
assert.equal(schema9.includes('schema_version=9'), true);

assert.equal(probeCliFlag(ALL_PROBE_SLOTS[0]), 'ct');
assert.equal(probeCliFlag(ALL_PROBE_SLOTS[4]), 'node_1');
assert.equal(probeCliFlag(ALL_PROBE_SLOTS[8]), 'node_5');
assert.equal(pingSlotColor(0), '#00d4aa');
assert.equal(pingSlotColor(8), '#d2a8ff');

console.log('probes.test.js ok');
