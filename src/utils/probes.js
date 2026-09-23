import { validatePingNode } from './agentConfig.js';

export const MAX_PROBES = 24;
export const LEGACY_PROBE_SLOT_COUNT = 8;
export const MAX_PROBE_NAME_LENGTH = 16;

export const LEGACY_PROBE_SLOTS = Object.freeze([
  { id: 'ct', hostField: 'custom_ct', nameField: 'custom_ct_name', pingField: 'ping_ct', lossField: 'loss_ct', defaultName: '电信' },
  { id: 'cu', hostField: 'custom_cu', nameField: 'custom_cu_name', pingField: 'ping_cu', lossField: 'loss_cu', defaultName: '联通' },
  { id: 'cm', hostField: 'custom_cm', nameField: 'custom_cm_name', pingField: 'ping_cm', lossField: 'loss_cm', defaultName: '移动' },
  { id: 'bd', hostField: 'custom_bd', nameField: 'custom_bd_name', pingField: 'ping_bd', lossField: 'loss_bd', defaultName: 'BGP' },
  { id: 'node_1', hostField: 'node_1', nameField: 'node_1_name', pingField: 'ping_node_1', lossField: 'loss_node_1', defaultName: 'Node 1' },
  { id: 'node_2', hostField: 'node_2', nameField: 'node_2_name', pingField: 'ping_node_2', lossField: 'loss_node_2', defaultName: 'Node 2' },
  { id: 'node_3', hostField: 'node_3', nameField: 'node_3_name', pingField: 'ping_node_3', lossField: 'loss_node_3', defaultName: 'Node 3' },
  { id: 'node_4', hostField: 'node_4', nameField: 'node_4_name', pingField: 'ping_node_4', lossField: 'loss_node_4', defaultName: 'Node 4' }
]);

export const EXTRA_PROBE_SLOTS = Object.freeze(
  Array.from({ length: MAX_PROBES - LEGACY_PROBE_SLOT_COUNT }, (_, index) => {
    const n = index + 5;
    return {
      id: `node_${n}`,
      hostField: `node_${n}`,
      nameField: `node_${n}_name`,
      pingField: `ping_node_${n}`,
      lossField: `loss_node_${n}`,
      defaultName: `Node ${n}`
    };
  })
);

export const ALL_PROBE_SLOTS = Object.freeze([...LEGACY_PROBE_SLOTS, ...EXTRA_PROBE_SLOTS]);
export const ALL_PROBE_HOST_FIELDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.hostField));
export const ALL_PROBE_NAME_FIELDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.nameField));
export const EXTRA_PROBE_HOST_FIELDS = Object.freeze(EXTRA_PROBE_SLOTS.map(slot => slot.hostField));
export const EXTRA_PROBE_NAME_FIELDS = Object.freeze(EXTRA_PROBE_SLOTS.map(slot => slot.nameField));
export const EXTRA_PING_FIELDS = Object.freeze(EXTRA_PROBE_SLOTS.map(slot => slot.pingField));
export const EXTRA_LOSS_FIELDS = Object.freeze(EXTRA_PROBE_SLOTS.map(slot => slot.lossField));
export const ALL_PING_FIELDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.pingField));
export const ALL_LOSS_FIELDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.lossField));
export const LATENCY_NODE_IDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.id));

const NAME_SAFE = /[^\p{L}\p{N} ._\-]/gu;

export function sanitizeProbeName(value) {
  return String(value ?? '')
    .trim()
    .replace(NAME_SAFE, '')
    .slice(0, MAX_PROBE_NAME_LENGTH);
}

export function emptyProbeSlotValues() {
  const values = {};
  for (const slot of ALL_PROBE_SLOTS) {
    values[slot.hostField] = '';
    values[slot.nameField] = '';
  }
  return values;
}

export function normalizeProbeSlotFields(source = {}) {
  const values = emptyProbeSlotValues();
  for (const slot of ALL_PROBE_SLOTS) {
    const hostResult = validatePingNode(source[slot.hostField]);
    if (!hostResult.valid) {
      return { valid: false, field: slot.hostField };
    }
    values[slot.hostField] = source[slot.hostField] === 0 || source[slot.hostField] === '0'
      ? '0'
      : hostResult.value;
    values[slot.nameField] = sanitizeProbeName(source[slot.nameField]);
  }
  return { valid: true, values };
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function extraHostsFromJson(raw) {
  const obj = parseJsonObject(raw);
  const values = {};
  for (const slot of EXTRA_PROBE_SLOTS) {
    values[slot.hostField] = obj[slot.hostField] ?? '';
  }
  return values;
}

export function extraNamesFromJson(raw) {
  const obj = parseJsonObject(raw);
  const values = {};
  for (const slot of EXTRA_PROBE_SLOTS) {
    values[slot.nameField] = obj[slot.nameField] ?? '';
  }
  return values;
}

export function serializeExtraHosts(values = {}) {
  const obj = {};
  let any = false;
  for (const slot of EXTRA_PROBE_SLOTS) {
    const value = values[slot.hostField];
    if (value !== undefined && value !== null && String(value) !== '') {
      obj[slot.hostField] = String(value);
      any = true;
    }
  }
  return any ? JSON.stringify(obj) : '';
}

export function serializeExtraNames(values = {}) {
  const obj = {};
  let any = false;
  for (const slot of EXTRA_PROBE_SLOTS) {
    const value = sanitizeProbeName(values[slot.nameField]);
    if (value) {
      obj[slot.nameField] = value;
      any = true;
    }
  }
  return any ? JSON.stringify(obj) : '';
}

export function flattenServerProbeFields(server = {}) {
  return {
    ...server,
    ...extraHostsFromJson(server.extra_probe_hosts),
    ...extraNamesFromJson(server.extra_probe_names)
  };
}

export function siteDefaultNames(settings = {}) {
  const names = {};
  for (const slot of ALL_PROBE_SLOTS) {
    const raw = sanitizeProbeName(settings[slot.nameField]);
    names[slot.nameField] = raw || slot.defaultName;
  }
  return names;
}

export function resolveProbeName(server = {}, settings = {}, slot) {
  const own = sanitizeProbeName(server[slot.nameField]);
  if (own) return own;
  return siteDefaultNames(settings)[slot.nameField];
}

export function buildPublicProbes(server = {}, settings = {}, metrics = server) {
  const probes = [];
  for (const slot of ALL_PROBE_SLOTS) {
    const host = String(server[slot.hostField] ?? '').trim();
    if (!host || host === '0') continue;
    probes.push({
      id: slot.id,
      name: resolveProbeName(server, settings, slot),
      host,
      ping: metrics[slot.pingField],
      loss: metrics[slot.lossField]
    });
  }
  return probes;
}

export function attachResolvedProbeNames(server = {}, settings = {}) {
  for (const slot of ALL_PROBE_SLOTS) {
    server[slot.nameField] = resolveProbeName(server, settings, slot);
  }
  return server;
}

export function extraPingLossFromJson(raw) {
  return parseJsonObject(raw);
}

function hasStoredExtraProbeValue(value) {
  return value !== undefined && value !== '' && value !== false && value !== 'false';
}

export function serializeExtraPingLoss(metrics = {}) {
  const obj = {};
  let any = false;
  for (const slot of EXTRA_PROBE_SLOTS) {
    if (hasStoredExtraProbeValue(metrics[slot.pingField])) {
      obj[slot.pingField] = metrics[slot.pingField];
      any = true;
    }
    if (hasStoredExtraProbeValue(metrics[slot.lossField]) || metrics[slot.lossField] === 0 || metrics[slot.lossField] === '0') {
      obj[slot.lossField] = metrics[slot.lossField];
      any = true;
    }
  }
  return any ? JSON.stringify(obj) : '';
}

export function mergeExtraPingLoss(target = {}, raw) {
  const extra = extraPingLossFromJson(raw ?? target.extra_probes);
  for (const slot of EXTRA_PROBE_SLOTS) {
    if (Object.prototype.hasOwnProperty.call(extra, slot.pingField)) {
      target[slot.pingField] = extra[slot.pingField];
    }
    if (Object.prototype.hasOwnProperty.call(extra, slot.lossField)) {
      target[slot.lossField] = extra[slot.lossField];
    }
  }
  return target;
}

export function agentHostFieldsForSchema(schemaVersion) {
  if (Number(schemaVersion) >= 9) return ALL_PROBE_HOST_FIELDS;
  return LEGACY_PROBE_SLOTS.map(slot => slot.hostField);
}
