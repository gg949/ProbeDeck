<template>
  <div id="editModal" class="modal-overlay" :class="{ active: show }">
    <div class="modal-dialog edit-server-modal">
      <div class="modal-header">
        <div class="modal-title">{{ currentServerName }}</div>
        <button class="modal-close" @click="$emit('close')">✕</button>
      </div>
      <input type="hidden" v-model="editForm.id">

      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.hostnameLabel }} <span class="required">*</span></label>
          <input type="text" name="edit_name" autocomplete="off" v-model="editForm.name" class="form-input" placeholder="e.g. My Server">
        </div>

        <div class="form-group flex-1">
          <label class="form-label">{{ trans.groupName }}</label>
          <input type="text" name="edit_server_group" autocomplete="off" v-model="editForm.server_group" class="form-input" placeholder="e.g. US VPS">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.tags }}</label>
          <input type="text" name="edit_tags" autocomplete="off" v-model="editForm.tags" class="form-input" :placeholder="trans.tagsPlaceholder">
        </div>

        <div class="form-group flex-1">
          <label class="form-label">{{ trans.region }} CN/US/GB</label>
          <input type="text" name="edit_region" autocomplete="off" v-model.trim="editForm.region" class="form-input" :placeholder="trans.regionPlaceholder">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ trans.note }}</label>
        <textarea name="edit_note" autocomplete="off" v-model="editForm.note" class="form-textarea" rows="2" :placeholder="trans.notePlaceholder"></textarea>
      </div>

      <div class="form-row mobile-two-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.currency }}</label>
          <select v-model="editForm.currency" class="form-select">
            <option v-for="item in currencySelectOptions" :key="item.symbol" :value="item.symbol">{{ currencyLabel(item) }}</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">{{ trans.price }}</label>
          <input type="text" name="edit_price" autocomplete="off" inputmode="decimal" v-model="editForm.price" class="form-input" placeholder="40.00" @blur="normalizePriceInput">
        </div>

        <div class="form-group flex-1">
          <label class="form-label">{{ trans.billingCycle }}</label>
          <select v-model="editForm.billing_cycle" class="form-select">
            <option v-for="item in billingCycleOptions" :key="item.value" :value="item.value">{{ cycleLabel(item) }}</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">{{ trans.autoRenewal }}</label>
          <div class="checkbox-item no-margin">
            <input type="checkbox" v-model="editForm.auto_renewal">
            <label>
              <b>{{ trans.enabled }}</b>
            </label>
          </div>
        </div>
      </div>

      <div class="form-row mobile-two-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.trafficLimit }} (GB)</label>
          <input type="number" name="edit_traffic_limit" autocomplete="off" v-model="editForm.traffic_limit" class="form-input" placeholder="e.g. 1000" min="0" step="1">
        </div>
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.trafficCalcType }}</label>
          <select v-model="editForm.traffic_calc_type" class="form-select">
            <option value="total">{{ trans.trafficCalcTotal }}</option>
            <option value="ul">{{ trans.trafficCalcUl }}</option>
            <option value="dl">{{ trans.trafficCalcDl }}</option>
            <option value="max">{{ trans.trafficCalcMax }}</option>
          </select>
        </div>
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.expirationDate }}</label>
          <input type="date" name="edit_expire_date" autocomplete="off" v-model="editForm.expire_date" class="form-input" @click="openDatePicker">
        </div>
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.trafficResetDay }}
            <HelpTooltip :text="trans.trafficResetDayTip" />
          </label>
          <select ref="editResetDayRef" name="edit_reset_day" v-model="editForm.reset_day" class="form-select">
            <option :value="0">0</option>
            <option v-for="day in 31" :key="day" :value="day">{{ day }}</option>
          </select>
        </div>
      </div>

      <div class="form-row mobile-two-row">
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.collectInterval }}
            <HelpTooltip :text="trans.collectIntervalHint" />
          </label>
          <select v-model="editForm.collect_interval" class="form-select">
            <option :value="0">0</option>
            <option :value="1">1</option>
            <option :value="2">2</option>
            <option :value="5">5</option>
            <option :value="10">10</option>
          </select>
        </div>
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.reportInterval }}</label>
          <select v-model="editForm.report_interval" class="form-select">
            <option :value="1">1</option>
            <option :value="3">3</option>
            <option :value="5">5</option>
            <option :value="10">10</option>
            <option :value="15">15</option>
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="60">60</option>
            <option :value="120">120</option>
            <option :value="180">180</option>
          </select>
        </div>
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.connectionMode }}
            <HelpTooltip v-if="!isWssReportEnabled" :text="trans.wssReportDisabledConnectionHint" />
          </label>
          <select v-model="editForm.connection_mode" class="form-select" :disabled="!isWssReportEnabled">
            <option value="auto">{{ trans.connectionModeAuto }}</option>
            <option value="http">{{ trans.connectionModeHttp }}</option>
          </select>
        </div>
        <div v-if="isWssReportEnabled && editForm.connection_mode === 'auto'" class="form-group flex-1">
          <label class="form-label">{{ trans.wssReportInterval }}</label>
          <select v-model="editForm.wss_report_interval" class="form-select">
            <option v-for="second in 5" :key="second" :value="second">{{ second }}</option>
          </select>
        </div>
      </div>

      <div class="form-row mobile-two-row">
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.pingMode }}
            <HelpTooltip :text="trans.pingModeIcmpRootHint" />
          </label>
          <select v-model="editForm.ping_mode" class="form-select">
            <option value="tcp">TCP</option>
            <option value="icmp">ICMP (root)</option>
          </select>
        </div>
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.networkInterface }}</label>
          <input type="text" name="edit_interface" autocomplete="off" v-model.trim="editForm.interface" class="form-input" :placeholder="trans.networkInterfacePlaceholder">
        </div>
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.rxCorrection }} (GB)
            <HelpTooltip :text="trans.correctionHint" />
          </label>
          <input type="number" name="edit_rx_correction" autocomplete="off" v-model="editForm.rx_correction" class="form-input" placeholder="0" min="0" step="0.1">
        </div>
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.txCorrection }} (GB)
            <HelpTooltip :text="trans.correctionHint" />
          </label>
          <input type="number" name="edit_tx_correction" autocomplete="off" v-model="editForm.tx_correction" class="form-input" placeholder="0" min="0" step="0.1">
        </div>
      </div>

      <div v-for="(pair, pairIndex) in visibleProbePairs" :key="pairIndex" class="form-row">
        <div v-for="slot in pair" :key="slot.hostField" class="form-group flex-1">
          <label class="form-label">
            {{ settings[slot.nameField] || slot.defaultName }}
            <HelpTooltip :text="trans.pingNodeTip" />
          </label>
          <div class="ping-node-fields">
            <input type="text" :name="`edit_${slot.nameField}`" autocomplete="off" v-model.trim="editForm[slot.nameField]" class="form-input ping-node-name" :placeholder="settings[slot.nameField] || slot.defaultName">
            <span class="ping-node-arrow">→</span>
            <input type="text" :name="`edit_${slot.hostField}`" autocomplete="off" v-model.trim="editForm[slot.hostField]" :class="['form-input', { 'input-invalid': pingNodeErrors[slot.hostField] }]" :placeholder="settings[slot.hostField] || 'host[:port] / [IPv6]:port'">
          </div>
          <p v-if="pingNodeErrors[slot.hostField]" class="text-red text-sm mt-1">{{ pingNodeErrors[slot.hostField] }}</p>
        </div>
      </div>
      <div class="form-row probe-slot-actions">
        <button type="button" class="btn btn-sm" :disabled="!canAddProbeSlot" @click="addProbeSlot">+ {{ trans.addProbeSlot || '增加探测点' }}</button>
        <button v-if="canRemoveProbeSlot" type="button" class="btn btn-sm" @click="removeProbeSlot">− {{ trans.removeProbeSlot || '去掉最后一个' }}</button>
        <span class="text-secondary text-sm">{{ visibleProbeCount }}/{{ maxProbes }}</span>
      </div>
      <div class="form-row">
        <div class="form-group">
          <div class="checkbox-item no-margin">
            <input type="checkbox" :checked="editForm.auto_update" @change="handleAutoUpdateChange">
            <label>
              <b>{{ trans.autoUpdate }}</b>
            </label>
          </div>
        </div>

        <div class="form-group">
          <div class="checkbox-item no-margin">
            <input type="checkbox" v-model="editForm.is_hidden">
            <label>
              <b>{{ trans.hideFromPublic }}</b>
            </label>
          </div>
        </div>

        <div v-if="hasNodeNotificationOptions" class="form-group">
          <div class="checkbox-item no-margin">
            <input type="checkbox" v-model="editForm.offline_notify_disabled">
            <label>
              <b>{{ trans.disableOfflineNotify }}</b>
            </label>
          </div>
        </div>
      </div>
      <div class="modal-footer flex-justify-between">
        <button @click="$emit('save')" class="btn btn-primary" :disabled="hasPingNodeErrors">{{ trans.save }}</button>
        <button @click="$emit('close')" class="btn">{{ trans.cancel }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import HelpTooltip from '../../../components/HelpTooltip.vue'
import { validatePingNode } from '../../../utils/pingNode.js'
import { ALL_PROBE_SLOTS, ALL_PROBE_HOST_FIELDS, LEGACY_PROBE_SLOT_COUNT, MAX_PROBES, filledProbeSlotCount } from '../../../utils/probes.js'
import { currentLang } from '../../../utils/i18n.js'
import { BILLING_CYCLES, CURRENCY_OPTIONS, normalizePrice, renewExpireDateIfNeeded } from '../../../utils/server.js'

const editForm = defineModel('editForm', { type: Object, required: true })

const props = defineProps({
  trans: { type: Object, required: true },
  show: { type: Boolean, default: false },
  currentServerName: { type: String, default: '' },
  settings: { type: Object, required: true }
})

const pingNodeErrorMessage = computed(() => (
  props.trans.invalidPingNodeFormat || 'Use domain, IPv4, or host:port. Port must be 1-65535.'
))

const visibleProbeCount = ref(LEGACY_PROBE_SLOT_COUNT)
const maxProbes = MAX_PROBES

const visibleProbeSlots = computed(() => ALL_PROBE_SLOTS.slice(0, visibleProbeCount.value))
const visibleProbePairs = computed(() => {
  const pairs = []
  for (let i = 0; i < visibleProbeSlots.value.length; i += 2) {
    pairs.push(visibleProbeSlots.value.slice(i, i + 2))
  }
  return pairs
})
const canAddProbeSlot = computed(() => visibleProbeCount.value < MAX_PROBES)
const canRemoveProbeSlot = computed(() => visibleProbeCount.value > LEGACY_PROBE_SLOT_COUNT)

const addProbeSlot = () => {
  visibleProbeCount.value = Math.min(MAX_PROBES, visibleProbeCount.value + 2)
}

const removeProbeSlot = () => {
  if (visibleProbeCount.value <= LEGACY_PROBE_SLOT_COUNT) return
  const next = Math.max(LEGACY_PROBE_SLOT_COUNT, visibleProbeCount.value - 2)
  for (let i = next; i < visibleProbeCount.value; i += 1) {
    const slot = ALL_PROBE_SLOTS[i]
    if (!slot) continue
    editForm.value[slot.hostField] = ''
    editForm.value[slot.nameField] = ''
  }
  visibleProbeCount.value = next
}

watch(
  () => [props.show, editForm.value?.id],
  () => {
    if (!props.show) return
    const filled = filledProbeSlotCount(editForm.value)
    const rounded = filled > LEGACY_PROBE_SLOT_COUNT && filled % 2 === 1 ? filled + 1 : filled
    visibleProbeCount.value = Math.min(MAX_PROBES, Math.max(LEGACY_PROBE_SLOT_COUNT, rounded))
  }
)

const pingNodeErrors = computed(() => Object.fromEntries(
  ALL_PROBE_HOST_FIELDS.map(field => [
    field,
    validatePingNode(editForm.value[field]).valid ? '' : pingNodeErrorMessage.value
  ])
))

const hasPingNodeErrors = computed(() => Object.values(pingNodeErrors.value).some(Boolean))

const billingCycleOptions = BILLING_CYCLES
const currencyOptions = CURRENCY_OPTIONS
const currencySelectOptions = computed(() => {
  const currentCurrency = String(editForm.value.currency || '').trim()
  if (!currentCurrency || currencyOptions.some(item => item.symbol === currentCurrency)) {
    return currencyOptions
  }
  return [
    { symbol: currentCurrency, nameZh: currentCurrency, nameEn: currentCurrency },
    ...currencyOptions
  ]
})

const cycleLabel = (item) => currentLang.value === 'zh' ? item.labelZh : item.labelEn
const currencyLabel = (item) => currentLang.value === 'zh'
  ? `${item.symbol} ${item.nameZh}`
  : `${item.symbol} ${item.nameEn}`

const normalizeTgNotifySetting = (value) => {
  if (value === true || value === 'true') return '5'
  if (value === false || value === 'false' || value === undefined || value === null || value === '') return '0'

  const minutes = Number(value)
  if (Number.isInteger(minutes) && (minutes === 0 || (minutes >= 2 && minutes <= 30))) {
    return String(minutes)
  }

  return '0'
}

const isOfflineNotifyEnabled = computed(() => normalizeTgNotifySetting(props.settings.tg_notify) !== '0')
const hasNodeNotificationOptions = computed(() => (
  !!props.settings.tg_bot_token &&
  isOfflineNotifyEnabled.value
))
const isWssReportEnabled = computed(() => props.settings.wss_report_enabled === true)

const normalizePriceInput = () => {
  editForm.value.price = normalizePrice(editForm.value.price)
}

const openDatePicker = (event) => {
  const input = event?.currentTarget
  if (typeof input?.showPicker !== 'function') return
  try {
    input.showPicker()
  } catch (_) {}
}

watch(
  () => [editForm.value.auto_renewal, editForm.value.billing_cycle, editForm.value.expire_date],
  () => {
    if (!editForm.value.auto_renewal) return
    const renewal = renewExpireDateIfNeeded(
      editForm.value.expire_date,
      editForm.value.billing_cycle,
      editForm.value.auto_renewal
    )
    if (renewal.renewed) {
      editForm.value.expire_date = renewal.expire_date
    }
  }
)

watch(
  isWssReportEnabled,
  (enabled) => {
    if (!enabled) {
      editForm.value.connection_mode = 'http'
    }
  },
  { immediate: true }
)

const emit = defineEmits(['save', 'close', 'toggle-auto-update'])

const handleAutoUpdateChange = (event) => {
  const nextValue = event.target.checked
  if (nextValue) {
    event.target.checked = false
  }
  emit('toggle-auto-update', nextValue)
}
</script>
