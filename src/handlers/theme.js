import {
  THEME_STORE_CACHE_TTL_SECONDS,
  THEME_STORE_URL
} from '../utils/config.js'

let cachedThemeStore = null
let cacheTime = 0

const createEmptyThemeStore = () => ({ schema: 1, themes: [] })

const normalizeThemeStore = (data) => {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      ...data,
      schema: data.schema || 1,
      themes: Array.isArray(data.themes) ? data.themes : []
    }
  }

  return createEmptyThemeStore()
}

export async function handleTheme() {
  const now = Math.floor(Date.now() / 1000)
  if (cachedThemeStore && (now - cacheTime) < THEME_STORE_CACHE_TTL_SECONDS) {
    return { ok: true, themeStore: cachedThemeStore, cached: true }
  }

  try {
    const res = await fetch(THEME_STORE_URL, {
      headers: { 'User-Agent': 'CFSM-Theme-Store' }
    })

    if (!res.ok) {
      return { ok: false, status: res.status, error: 'themeStoreProxyFailed' }
    }

    const data = await res.json()
    const themeStore = normalizeThemeStore(data)

    cachedThemeStore = themeStore
    cacheTime = now
    return { ok: true, themeStore, cached: false }
  } catch (e) {
    return { ok: false, status: 0, error: 'themeStoreProxyFailed' }
  }
}
