export const MAX_PROBES = 24
export const LEGACY_PROBE_SLOT_COUNT = 8

export const LEGACY_PROBE_SLOTS = Object.freeze([
  { id: 'ct', hostField: 'custom_ct', nameField: 'custom_ct_name', pingField: 'ping_ct', lossField: 'loss_ct', defaultName: '电信' },
  { id: 'cu', hostField: 'custom_cu', nameField: 'custom_cu_name', pingField: 'ping_cu', lossField: 'loss_cu', defaultName: '联通' },
  { id: 'cm', hostField: 'custom_cm', nameField: 'custom_cm_name', pingField: 'ping_cm', lossField: 'loss_cm', defaultName: '移动' },
  { id: 'bd', hostField: 'custom_bd', nameField: 'custom_bd_name', pingField: 'ping_bd', lossField: 'loss_bd', defaultName: 'BGP' },
  { id: 'node_1', hostField: 'node_1', nameField: 'node_1_name', pingField: 'ping_node_1', lossField: 'loss_node_1', defaultName: 'Node 1' },
  { id: 'node_2', hostField: 'node_2', nameField: 'node_2_name', pingField: 'ping_node_2', lossField: 'loss_node_2', defaultName: 'Node 2' },
  { id: 'node_3', hostField: 'node_3', nameField: 'node_3_name', pingField: 'ping_node_3', lossField: 'loss_node_3', defaultName: 'Node 3' },
  { id: 'node_4', hostField: 'node_4', nameField: 'node_4_name', pingField: 'ping_node_4', lossField: 'loss_node_4', defaultName: 'Node 4' }
])

export const EXTRA_PROBE_SLOTS = Object.freeze(
  Array.from({ length: MAX_PROBES - LEGACY_PROBE_SLOT_COUNT }, (_, index) => {
    const n = index + 5
    return {
      id: `node_${n}`,
      hostField: `node_${n}`,
      nameField: `node_${n}_name`,
      pingField: `ping_node_${n}`,
      lossField: `loss_node_${n}`,
      defaultName: `Node ${n}`
    }
  })
)

export const ALL_PROBE_SLOTS = Object.freeze([...LEGACY_PROBE_SLOTS, ...EXTRA_PROBE_SLOTS])
export const ALL_PROBE_HOST_FIELDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.hostField))
export const ALL_PROBE_NAME_FIELDS = Object.freeze(ALL_PROBE_SLOTS.map(slot => slot.nameField))
export const PING_SLOT_COLORS = Object.freeze([
  '#00d4aa', '#ffb870', '#4da6ff', '#b392f0',
  '#ff7b72', '#79c0ff', '#7ee787', '#ffa657',
  '#d2a8ff', '#ffa198', '#56d4dd', '#f2cc60',
  '#bc8cff', '#58a6ff', '#3fb950', '#e3b341',
  '#f85149', '#a5d6ff', '#39d353', '#ffc680',
  '#2f81f7', '#d29922', '#db61a2', '#6e7681'
])

export function pingSlotColor(index) {
  return PING_SLOT_COLORS[index % PING_SLOT_COLORS.length]
}

export function probeCliFlag(slot) {
  if (slot.id === 'ct') return 'ct'
  if (slot.id === 'cu') return 'cu'
  if (slot.id === 'cm') return 'cm'
  if (slot.id === 'bd') return 'bd'
  return slot.hostField
}

export function filledProbeSlotCount(form = {}) {
  let count = LEGACY_PROBE_SLOT_COUNT
  ALL_PROBE_SLOTS.forEach((slot, index) => {
    const host = String(form[slot.hostField] ?? '').trim()
    const name = String(form[slot.nameField] ?? '').trim()
    if ((host && host !== '0') || name) count = Math.max(count, index + 1)
  })
  return count
}
