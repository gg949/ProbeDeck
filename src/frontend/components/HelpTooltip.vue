<template>
  <span
    class="help-tooltip"
    :class="[`help-tooltip-${resolvedPlacement}`, { 'is-open': open }]"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
    @keydown.esc="closeTooltip"
  >
    <button
      v-if="!passive"
      ref="triggerRef"
      type="button"
      class="help-tooltip-trigger"
      :aria-label="ariaLabel"
      :aria-expanded="open ? 'true' : 'false'"
      @click.stop="toggle"
      @focus="handleFocus"
      @blur="closeSoon"
    >?</button>
    <span
      v-else
      ref="triggerRef"
      class="help-tooltip-trigger"
      role="button"
      tabindex="0"
      :aria-label="ariaLabel"
      :aria-expanded="open ? 'true' : 'false'"
      @click.prevent.stop="toggle"
      @focus="handleFocus"
      @keydown.enter.prevent.stop="toggle"
      @keydown.space.prevent.stop="toggle"
      @blur="closeSoon"
    >?</span>
    <Teleport to="body">
      <span
        v-if="open"
        ref="panelRef"
        class="help-tooltip-panel help-tooltip-floating"
        :class="`help-tooltip-floating-${resolvedPlacement}`"
        :style="panelStyle"
        role="tooltip"
        @mouseenter="clearCloseTimer"
        @mouseleave="closeSoon"
      >
        <slot>
          <span class="help-tooltip-text">{{ text }}</span>
        </slot>
      </span>
    </Teleport>
  </span>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref } from 'vue'

const props = defineProps({
  text: { type: String, default: '' },
  ariaLabel: { type: String, default: 'Help' },
  passive: { type: Boolean, default: false },
  placement: {
    type: String,
    default: 'top',
    validator: value => ['top', 'bottom'].includes(value)
  }
})

const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const resolvedPlacement = ref(props.placement)
const panelStyle = ref({})
let closeTimer = 0

const toggle = () => {
  if (open.value) {
    closeTooltip()
  } else {
    openTooltip()
  }
}

const isMobileViewport = () => window.matchMedia?.('(max-width: 768px)').matches

const updatePosition = async () => {
  if (!open.value || !triggerRef.value || isMobileViewport()) {
    panelStyle.value = {}
    return
  }

  await nextTick()
  const triggerRect = triggerRef.value.getBoundingClientRect()
  const panelRect = panelRef.value?.getBoundingClientRect()
  if (!panelRect) return

  const margin = 12
  const gap = 9
  const centerX = triggerRect.left + triggerRect.width / 2
  const maxLeft = window.innerWidth - panelRect.width - margin
  const left = Math.max(margin, Math.min(centerX - panelRect.width / 2, maxLeft))
  const preferredTop = triggerRect.top - panelRect.height - gap
  const canUseTop = preferredTop >= margin
  resolvedPlacement.value = props.placement === 'bottom' || !canUseTop ? 'bottom' : 'top'
  const top = resolvedPlacement.value === 'top'
    ? preferredTop
    : Math.min(window.innerHeight - panelRect.height - margin, triggerRect.bottom + gap)

  panelStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(Math.max(margin, top))}px`,
    '--tooltip-arrow-left': `${Math.round(centerX - left)}px`
  }
}

const openTooltip = () => {
  clearCloseTimer()
  if (!open.value) {
    open.value = true
  }
  updatePosition()
}

const isHoverCapable = () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

const handleMouseEnter = () => {
  if (!isHoverCapable()) return
  openTooltip()
}

const handleMouseLeave = () => {
  if (!isHoverCapable()) return
  closeSoon()
}

const handleFocus = event => {
  if (!event.currentTarget.matches(':focus-visible')) return
  openTooltip()
}

const closeTooltip = () => {
  clearCloseTimer()
  open.value = false
}

const clearCloseTimer = () => {
  if (closeTimer) {
    window.clearTimeout(closeTimer)
    closeTimer = 0
  }
}

const closeSoon = () => {
  clearCloseTimer()
  closeTimer = window.setTimeout(() => {
    closeTooltip()
  }, 120)
}

const handleDocumentPointerDown = event => {
  if (!open.value) return

  const target = event.target
  if (triggerRef.value?.contains(target) || panelRef.value?.contains(target)) return
  closeTooltip()
}

window.addEventListener('resize', updatePosition)
window.addEventListener('scroll', updatePosition, true)
document.addEventListener('pointerdown', handleDocumentPointerDown)

onBeforeUnmount(() => {
  clearCloseTimer()
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
})
</script>
