<template>
  <footer class="footer status-bar">
    <span
      class="footer-version"
      :aria-label="updateTitle || undefined"
      :tabindex="hasWorkersUpdate ? 0 : undefined"
    >
      <span>V{{ VERSION }}</span>
      <span
        v-if="hasWorkersUpdate"
        class="version-update-dot"
        aria-hidden="true"
      ></span>
      <span
        v-if="hasWorkersUpdate"
        class="version-update-tooltip"
        role="tooltip"
      >{{ updateTitle }}</span>
    </span>
    <span>Powered by <a href="https://github.com/huilang-me/CF-Server-Monitor" target="_blank">CF-Server-Monitor</a></span>
  </footer>
</template>

<script setup>
import { computed } from 'vue'
import { LAST_WORKERS_VERSION, VERSION } from '../utils/api'
import { useTranslation } from '../utils/i18n'

const trans = useTranslation()
const currentVersion = computed(() => String(VERSION.value || '').trim())
const latestWorkersVersion = computed(() => String(LAST_WORKERS_VERSION.value || '').trim())
const hasWorkersUpdate = computed(() => latestWorkersVersion.value && currentVersion.value && latestWorkersVersion.value !== currentVersion.value)
const updateTitle = computed(() => {
  if (!hasWorkersUpdate.value) return ''
  return `${trans.value.workersUpdateAvailable || 'New version'} V${latestWorkersVersion.value}`
})
</script>
