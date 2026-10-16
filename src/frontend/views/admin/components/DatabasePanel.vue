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

    <!-- 数据库维护：数据库体积 / VACUUM / 常规备份 / 完整性检查
         （指数据库文件自身，与服务器资源占用无关；仅 Docker/VPS 版支持，自动探测显示） -->
    <div v-if="dbMaintenanceAvailable" class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.dbMaintenanceTitle }}</div>
      <p class="text-muted mb-2">{{ trans.dbMaintenanceDesc }}</p>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.dbStatsDbSize }}</label>
          <div class="db-stat-value">{{ formatBytes(dbStats ? dbStats.db_bytes : 0) }}</div>
          <p class="text-muted mt-1 mb-0 text-sm">
            {{ trans.dbStatsWalSize }}: {{ formatBytes(dbStats ? dbStats.wal_bytes : 0) }}
            · {{ trans.dbStatsTotalSize }}: {{ formatBytes(dbStats ? dbStats.total_bytes : 0) }}
          </p>
        </div>

        <div class="form-group">
          <label class="form-label">{{ trans.dbStatsPages }}</label>
          <div class="db-stat-value">{{ dbStats ? dbStats.page_count : '—' }}</div>
          <p class="text-muted mt-1 mb-0 text-sm">
            {{ trans.dbStatsFreePages }}: {{ dbStats ? dbStats.freelist_count : '—' }}
            ({{ formatBytes(dbStats ? dbStats.freelist_bytes : 0) }})
          </p>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ dbStatsBackupsLabel }}</label>
        <p v-if="!dbStats || dbStats.backups.length === 0" class="text-muted mb-0 text-sm">{{ trans.dbStatsNoBackups }}</p>
        <ul v-else class="db-backup-list text-sm">
          <li v-for="item in dbStats.backups" :key="item.name">
            <span class="db-backup-name">{{ item.name }}</span>
            <span class="text-muted"> · {{ formatBytes(item.bytes) }} · {{ formatTime(item.created_at) }}</span>
          </li>
        </ul>
      </div>

      <div class="db-maintenance-actions">
        <button @click="loadDbStats(false)" class="btn btn-lg" :disabled="!!dbMaintenanceBusy">🔄 {{ trans.dbStatsRefresh }}</button>
        <button @click="handleDbVacuum" class="btn btn-primary btn-lg" :disabled="!!dbMaintenanceBusy">🧹 {{ trans.dbStatsVacuum }}</button>
        <button @click="handleDbBackup" class="btn btn-primary btn-lg" :disabled="!!dbMaintenanceBusy">💾 {{ trans.dbStatsBackup }}</button>
        <button @click="handleDbIntegrityCheck" class="btn btn-lg" :disabled="!!dbMaintenanceBusy">🩺 {{ trans.dbStatsIntegrity }}</button>
      </div>

      <div v-if="dbMaintenanceBusy" class="mt-3">
        <div class="warning-box">{{ trans.dbMaintenanceRunning }}</div>
      </div>
      <div v-else-if="dbMaintenanceStatus" class="mt-3">
        <div :class="dbMaintenanceStatus.ok ? 'warning-box' : 'danger-box'">
          <span :style="{ color: dbMaintenanceStatus.ok ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '600' }">
            {{ dbMaintenanceStatus.ok ? '✅' : '❌' }} {{ dbMaintenanceStatus.text }}
          </span>
          <div v-if="dbMaintenanceStatus.details" class="mt-2 text-sm">{{ dbMaintenanceStatus.details }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
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
const cfAuthHeaders = () => {
  try {
    const token = localStorage.getItem('jwt_token') || ''
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (_) {
    return {}
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/_pd/cf-migrate', { headers: { Accept: 'application/json', ...cfAuthHeaders() } })
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
      const res = await fetch('/_pd/cf-migrate', { cache: 'no-store', headers: cfAuthHeaders() })
      // 任意 <500 响应（含导入后需重新登录的 401）都说明服务已恢复
      if (res.status < 500) {
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

// ── 数据库维护：数据库体积 / VACUUM / 常规备份 / 完整性检查（Docker/VPS 版专属）──
// 「数据库体积」指数据库文件自身（主库 + WAL + 碎片），与服务器资源占用无关。
const dbMaintenanceAvailable = ref(false)
const dbStats = ref(null)
const dbMaintenanceBusy = ref('') // '' | 'stats' | 'vacuum' | 'backup' | 'integrity'
const dbMaintenanceStatus = ref(null) // { ok: boolean, text: string, details?: string }

const dbStatsBackupsLabel = computed(() => {
  const keep = Number(dbStats.value && dbStats.value.keep_backups)
  const resolved = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 3
  return String(props.trans.dbStatsBackups || '').replace('{n}', String(resolved))
})

const formatBytes = (value) => {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  const rounded = index === 0 || size >= 100 ? Math.round(size) : Math.round(size * 10) / 10
  return `${rounded} ${units[index]}`
}

const formatTime = (value) => {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  try { return new Date(timestamp).toLocaleString() } catch (_) { return '—' }
}

// 后端错误码 → 当前语言文案；带 message（SQLite 原始报错）时拼接显示，方便排查
const dbMaintenanceErrorMessage = (result) => {
  const code = String((result && result.error) || '')
  const detail = String((result && result.message) || '').trim()
  const translated = props.trans[code]
  const base = translated && translated !== code ? translated : detail
  if (!base) return String(props.trans.dbMaintenanceFailed || '')
  if (detail && base !== detail) return `${base}: ${detail}`
  return base
}

const loadDbStats = async (silent = true) => {
  if (dbMaintenanceBusy.value) return
  dbMaintenanceBusy.value = 'stats'
  try {
    const result = await adminApi({ action: 'db_stats' }, props.selectedApiIndex)
    if (!result.error && result.data && result.data.success && result.data.stats) {
      dbStats.value = result.data.stats
      dbMaintenanceAvailable.value = true
    } else if (result.error === 'dbMaintenanceUnsupported') {
      // Cloudflare Workers 版没有本地数据库文件，整个区块不显示
      dbMaintenanceAvailable.value = false
      dbStats.value = null
    } else if (!silent) {
      dbMaintenanceStatus.value = { ok: false, text: dbMaintenanceErrorMessage(result) }
    }
  } catch (e) {
    if (!silent) {
      dbMaintenanceStatus.value = { ok: false, text: (e && e.message) || String(props.trans.dbMaintenanceFailed || '') }
    }
  } finally {
    dbMaintenanceBusy.value = ''
  }
}

const runDbMaintenance = async (kind, payload, buildStatus) => {
  if (dbMaintenanceBusy.value) return
  dbMaintenanceBusy.value = kind
  dbMaintenanceStatus.value = null
  try {
    const result = await adminApi(payload, props.selectedApiIndex)
    if (!result.error && result.data && result.data.success) {
      if (result.data.stats) dbStats.value = result.data.stats
      dbMaintenanceStatus.value = buildStatus(result.data)
    } else {
      dbMaintenanceStatus.value = { ok: false, text: dbMaintenanceErrorMessage(result) }
    }
  } catch (e) {
    dbMaintenanceStatus.value = { ok: false, text: (e && e.message) || String(props.trans.dbMaintenanceFailed || '') }
  } finally {
    dbMaintenanceBusy.value = ''
  }
}

const handleDbVacuum = () => {
  if (dbMaintenanceBusy.value) return
  if (!window.confirm(props.trans.dbStatsVacuumConfirm)) return
  return runDbMaintenance('vacuum', { action: 'db_vacuum' }, (data) => ({
    ok: true,
    text: String(props.trans.dbStatsVacuumDone)
      .replace('{freed}', formatBytes(data.freed_bytes))
      .replace('{ms}', String(data.duration_ms === undefined ? '' : data.duration_ms))
  }))
}

const handleDbBackup = () => {
  if (dbMaintenanceBusy.value) return
  return runDbMaintenance('backup', { action: 'db_backup' }, (data) => {
    const backup = data.backup || {}
    const removedCount = Array.isArray(data.removed) ? data.removed.length : 0
    let text = String(props.trans.dbStatsBackupDone)
      .replace('{name}', String(backup.name || ''))
      .replace('{size}', formatBytes(backup.bytes))
    if (removedCount > 0) {
      text += ` · ${String(props.trans.dbStatsBackupPruned).replace('{n}', String(removedCount))}`
    }
    return { ok: true, text }
  })
}

const handleDbIntegrityCheck = () => {
  if (dbMaintenanceBusy.value) return
  return runDbMaintenance('integrity', { action: 'db_integrity_check' }, (data) => ({
    ok: !!data.ok,
    text: data.ok
      ? String(props.trans.dbStatsIntegrityOk).replace('{ms}', String(data.duration_ms === undefined ? '' : data.duration_ms))
      : String(props.trans.dbStatsIntegrityBad).replace('{n}', String(data.problems_total === undefined ? 0 : data.problems_total)),
    details: data.ok ? '' : (Array.isArray(data.problems) ? data.problems.join('; ').slice(0, 300) : '')
  }))
}

// 首次进入数据库 Tab 时探测能力并读取一次体积（CF 版 501 → 自动隐藏区块）
onMounted(() => {
  loadDbStats(true)
})

// 多站点模式下切换面板时，重新探测目标站点的能力与体积（避免显示上一个站点的数字）
watch(() => props.selectedApiIndex, () => {
  dbStats.value = null
  dbMaintenanceStatus.value = null
  loadDbStats(true)
})

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
