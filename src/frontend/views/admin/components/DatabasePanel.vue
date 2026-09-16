<template>
  <div id="tab-database" class="tab-content" :class="{ active: activeTab === 'database' }">
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.dbManagement }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.upgradeDatabase }}</label>
          <p class="text-muted mb-2">{{ trans.upgradeDesc }}</p>
          <button @click="$emit('open-db-modal', 'upgrade')" class="btn btn-primary btn-lg" :disabled="dbLoading">⬆️ {{ trans.upgradeDatabase }}</button>
        </div>

        <div class="form-group">
          <label class="form-label danger-label">⚠️ {{ trans.clearHistory }}</label>
          <p class="text-muted mb-2">{{ trans.clearHistoryDesc }}</p>
          <button @click="$emit('open-db-modal', 'clearHistory')" class="btn btn-red btn-lg" :disabled="dbLoading">🗑️ {{ trans.clearHistory }}</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.exportServers }} / {{ trans.importServers }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.exportServers }}</label>
          <p class="text-muted mb-2">{{ trans.exportServersDesc }}</p>
          <button @click="handleExport" class="btn btn-primary btn-lg" :disabled="dbLoading || exporting">
            {{ exporting ? trans.exporting : '📤 ' + trans.exportServers }}
          </button>
        </div>

        <div class="form-group">
          <label class="form-label">{{ trans.importServers }}</label>
          <p class="text-muted mb-2">{{ trans.importServersDesc }}</p>
          <input
            ref="fileInput"
            type="file"
            accept=".json"
            style="display: none"
            @change="handleFileSelect"
          />
          <button @click="$refs.fileInput.click()" class="btn btn-lg" :disabled="dbLoading || importing">
            {{ importing ? trans.importing : '📥 ' + trans.importServers }}
          </button>
        </div>
      </div>

      <div v-if="importResult" class="mt-3">
        <div :class="importResult.success ? 'warning-box' : 'danger-box'" class="mb-2">
          <div class="flex-center-gap-sm">
            <span :style="{ color: importResult.success ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '600' }">
              {{ importResult.success ? '✅' : '❌' }} {{ trans.importResult }}
            </span>
          </div>
          <div class="mt-2 text-sm">
            <span style="color: var(--accent-green)">{{ trans.importedCount }}: {{ importResult.imported }}</span>
            <span class="ml-3" style="color: var(--accent-yellow)">{{ trans.skippedCount }}: {{ importResult.skipped }}</span>
          </div>
          <div v-if="importResult.skippedIds && importResult.skippedIds.length > 0" class="mt-2 text-sm text-muted">
            {{ trans.skippedIds }}: {{ importResult.skippedIds.join(', ') }}
          </div>
        </div>
      </div>
    </div>

    <!-- 从 Cloudflare 一键迁移（仅 Docker/VPS 版支持，页面自动探测显示） -->
    <div v-if="cfMigrateAvailable" class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.cfMigrateTitle }}</div>
      <p class="text-muted mb-2">{{ trans.cfMigrateDesc }}</p>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.cfMigrateAccountId }}</label>
          <input v-model="cfAccountId" type="text" class="form-input" placeholder="023e105f4ecef8ad9ca31a8372d0c353" :disabled="cfMigrating" autocomplete="off" spellcheck="false">
          <p class="text-muted mt-1 text-sm">{{ trans.cfMigrateAccountIdTip }}</p>
        </div>

        <div class="form-group">
          <label class="form-label">{{ trans.cfMigrateDatabaseId }}</label>
          <input v-model="cfDatabaseId" type="text" class="form-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" :disabled="cfMigrating" autocomplete="off" spellcheck="false">
          <p class="text-muted mt-1 text-sm">{{ trans.cfMigrateDatabaseIdTip }}</p>
        </div>

        <div class="form-group">
          <label class="form-label">{{ trans.cfMigrateToken }}</label>
          <input v-model="cfApiToken" type="password" class="form-input" placeholder="••••••••••••" :disabled="cfMigrating" autocomplete="off" spellcheck="false">
          <p class="text-muted mt-1 text-sm">{{ trans.cfMigrateTokenTip }}</p>
        </div>
      </div>

      <button @click="handleCfMigrate" class="btn btn-primary btn-lg" :disabled="cfMigrating || !cfAccountId || !cfDatabaseId || !cfApiToken">
        {{ cfMigrating ? '⏳ …' : '☁️ ' + trans.cfMigrateStart }}
      </button>

      <div v-if="cfMigrating || cfMigrateStatus" class="mt-3">
        <div v-if="cfMigrating" class="warning-box">{{ trans.cfMigrateRunning }}</div>
        <div v-else :class="cfMigrateStatus.ok ? 'warning-box' : 'danger-box'">
          <span :style="{ color: cfMigrateStatus.ok ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '600' }">
            {{ cfMigrateStatus.ok ? '✅' : '❌' }} {{ cfMigrateStatus.text }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { adminApi } from '../../../utils/api'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: 'database' },
  dbLoading: { type: Boolean, default: false },
  selectedApiIndex: { type: Number, default: 0 }
})

defineEmits(['open-db-modal'])

const fileInput = ref(null)
const exporting = ref(false)
const importing = ref(false)
const importResult = ref(null)

// ── 从 Cloudflare 一键迁移（Docker/VPS 版专属）──────────────
const cfMigrateAvailable = ref(false)
const cfAccountId = ref('')
const cfDatabaseId = ref('')
const cfApiToken = ref('')
const cfMigrating = ref(false)
const cfMigrateStatus = ref(null) // { ok: boolean, text: string }

// 探测后端是否支持该功能（Cloudflare Workers 版没有此端点）
onMounted(async () => {
  try {
    const res = await fetch('/_pd/cf-migrate', { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    cfMigrateAvailable.value = !!(data && data.available === true)
  } catch (_) {}
})

const waitForPanelRestart = async () => {
  // 迁移成功后服务端会自动重启，轮询探测直到恢复再刷新页面
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      const res = await fetch('/_pd/cf-migrate', { cache: 'no-store' })
      if (res.ok) {
        window.location.reload()
        return
      }
    } catch (_) {}
  }
  window.location.reload()
}

const handleCfMigrate = async () => {
  const accountId = cfAccountId.value.trim()
  const databaseId = cfDatabaseId.value.trim()
  const apiToken = cfApiToken.value.trim()

  if (!accountId || !databaseId || !apiToken) {
    cfMigrateStatus.value = { ok: false, text: props.trans.cfMigrateMissingFields }
    return
  }
  if (!window.confirm(props.trans.cfMigrateConfirm)) return

  cfMigrating.value = true
  cfMigrateStatus.value = null

  try {
    let token = ''
    try { token = localStorage.getItem('jwt_token') || '' } catch (_) {}

    const res = await fetch('/_pd/cf-migrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ accountId, databaseId, apiToken })
    })

    let data = null
    try { data = await res.json() } catch (_) {}

    if (res.ok && data && data.success) {
      cfApiToken.value = ''
      cfMigrateStatus.value = {
        ok: true,
        text: String(props.trans.cfMigrateSuccess).replace('{n}', String(data.tables || ''))
      }
      waitForPanelRestart()
    } else {
      const err = data && data.error
      let msg = ''
      if (err === 'unauthorized') msg = props.trans.cfMigrateUnauthorized
      else if (err === 'missingFields') msg = props.trans.cfMigrateMissingFields
      else if (data && data.message) msg = data.message
      else if (err) msg = err
      else msg = `HTTP ${res.status}`
      cfMigrateStatus.value = {
        ok: false,
        text: String(props.trans.cfMigrateFailed).replace('{msg}', String(msg))
      }
    }
  } catch (e) {
    cfMigrateStatus.value = {
      ok: false,
      text: String(props.trans.cfMigrateFailed).replace('{msg}', e?.message || 'network error')
    }
  } finally {
    cfMigrating.value = false
  }
}

const handleExport = async () => {
  exporting.value = true
  importResult.value = null
  try {
    const result = await adminApi({ action: 'export_servers' }, props.selectedApiIndex)
    if (!result.error && result.data && result.data.servers) {
      const blob = new Blob([JSON.stringify(result.data.servers, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `servers-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    console.error('Export failed:', e)
  } finally {
    exporting.value = false
  }
}

const handleFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  importing.value = true
  importResult.value = null

  try {
    const text = await file.text()
    const servers = JSON.parse(text)

    if (!Array.isArray(servers)) {
      importResult.value = { success: false, imported: 0, skipped: 0, skippedIds: [] }
      return
    }

    const result = await adminApi({ action: 'import_servers', servers }, props.selectedApiIndex)
    if (!result.error && result.data) {
      importResult.value = {
        success: result.data.success,
        imported: result.data.imported || 0,
        skipped: result.data.skipped || 0,
        skippedIds: result.data.skippedIds || []
      }
      if (result.data.imported > 0) {
        window.location.reload()
      }
    } else {
      importResult.value = { success: false, imported: 0, skipped: 0, skippedIds: [] }
    }
  } catch (e) {
    console.error('Import failed:', e)
    importResult.value = { success: false, imported: 0, skipped: 0, skippedIds: [] }
  } finally {
    importing.value = false
    if (fileInput.value) {
      fileInput.value.value = ''
    }
  }
}
</script>
