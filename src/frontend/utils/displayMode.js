export const DEFAULT_DISPLAY_MODE = 'bar'
export const ADMIN_DISPLAY_MODES = ['bar', 'ring', 'table']
export const DASHBOARD_VIEWS = ['bar', 'ring', 'table', 'map']

export const normalizeDisplayMode = (value, fallback = DEFAULT_DISPLAY_MODE) => {
  const mode = String(value || '').trim().toLowerCase()
  if (mode === 'list') return 'table'
  if (ADMIN_DISPLAY_MODES.includes(mode)) return mode
  return ADMIN_DISPLAY_MODES.includes(fallback) ? fallback : DEFAULT_DISPLAY_MODE
}

export const normalizeDashboardView = (value, fallback = DEFAULT_DISPLAY_MODE) => {
  const view = String(value || '').trim().toLowerCase()
  if (view === 'card') return normalizeDisplayMode(fallback)
  if (view === 'list') return 'table'
  if (DASHBOARD_VIEWS.includes(view)) return view
  return normalizeDisplayMode(fallback)
}

export const resolveDisplayMode = (source, fallback = DEFAULT_DISPLAY_MODE) => {
  if (source?.display_mode) {
    return normalizeDisplayMode(source.display_mode, fallback)
  }
  return normalizeDisplayMode(fallback)
}
