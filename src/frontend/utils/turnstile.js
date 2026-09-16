import { http } from './http'

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
const TURNSTILE_TOKEN_KEY = 'turnstile_token'
const TURNSTILE_VERIFIED_KEY = 'turnstile_verified'

let turnstileScriptPromise = null

export const isTurnstileValueEnabled = (value) => value === true || value === 'true'

export const normalizeTurnstileSiteKey = (value) => String(value || '').trim()

export const setTurnstileToken = (token) => {
  if (token) {
    localStorage.setItem(TURNSTILE_TOKEN_KEY, token)
  }
}

export const getTurnstileToken = () => localStorage.getItem(TURNSTILE_TOKEN_KEY) || ''

export const clearTurnstileToken = () => {
  localStorage.removeItem(TURNSTILE_TOKEN_KEY)
}

export const hasSharedTurnstileVerified = () => !!localStorage.getItem(TURNSTILE_VERIFIED_KEY)

export const getTurnstileEnabledSites = (results, mode = 'global') => {
  return results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => {
      if (result.error || !result.data) return false
      if (mode === 'login') {
        return isTurnstileValueEnabled(result.data.turnstile_enabled) || isTurnstileValueEnabled(result.data.turnstile_login_enabled)
      }
      return isTurnstileValueEnabled(result.data.turnstile_enabled)
    })
    .map(({ result, index }) => ({
      index,
      data: result.data,
      siteKey: normalizeTurnstileSiteKey(result.data.turnstile_site_key),
      verified: result.data.verified === true
    }))
}

export const hasTurnstileSiteKeyMismatch = (sites) => {
  const keys = [...new Set(sites.map(site => site.siteKey).filter(Boolean))]
  return sites.some(site => !site.siteKey) || keys.length > 1
}

export const fetchAllTurnstileConfigs = async () => {
  let results = await http.getAll('/api/config', { includeAuth: true, includeTurnstile: true, autoRedirect: false })
  if (results.some(result => result.status === 403)) {
    results = await http.getAll('/api/config', { includeAuth: true, includeTurnstile: false, autoRedirect: false })
  }
  return results
}

export const fetchTurnstileConfigByIndex = async (apiIndex = 0) => {
  return http.getByIndex('/api/config', apiIndex, {
    includeAuth: true,
    includeTurnstile: false,
    includeTurnstileVerified: false,
    autoRedirect: false
  })
}

export const loadTurnstileScript = () => {
  if (typeof window !== 'undefined' && window.turnstile) {
    return Promise.resolve()
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_SRC
    script.async = true
    script.onload = resolve
    script.onerror = (error) => {
      turnstileScriptPromise = null
      reject(error)
    }
    document.head.appendChild(script)
  })

  return turnstileScriptPromise
}
