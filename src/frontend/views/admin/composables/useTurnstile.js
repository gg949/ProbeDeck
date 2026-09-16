import { ref } from 'vue'
import {
  clearTurnstileToken,
  fetchTurnstileConfigByIndex,
  getTurnstileToken,
  hasSharedTurnstileVerified,
  isTurnstileValueEnabled,
  loadTurnstileScript,
  setTurnstileToken
} from '../../../utils/turnstile'

export function useTurnstile() {
  const turnstileEnabled = ref(false)
  const turnstileLoginEnabled = ref(false)
  const turnstileSiteKey = ref('')
  const turnstileToken = ref('')
  const turnstileVerified = ref(false)
  let widgetId = null

  const removeTurnstile = (containerSelector) => {
    if (typeof window !== 'undefined' && window.turnstile && widgetId) {
      try {
        window.turnstile.remove(widgetId)
      } catch (e) {
        // Ignore stale widget ids and clear the container below.
      }
    }
    widgetId = null

    if (typeof document === 'undefined') return
    const container = document.querySelector(containerSelector)
    if (container) container.innerHTML = ''
  }

  const renderTurnstile = (containerSelector, siteKey, callbacks = {}) => {
    if (typeof window !== 'undefined' && window.turnstile) {
      removeTurnstile(containerSelector)
      widgetId = window.turnstile.render(containerSelector, {
        sitekey: siteKey,
        callback: (token) => {
          turnstileToken.value = token
          setTurnstileToken(token)
          callbacks.onSuccess?.(token)
        },
        errorCallback: () => {
          turnstileToken.value = ''
          clearTurnstileToken()
          callbacks.onError?.()
        },
        expiredCallback: () => {
          turnstileToken.value = ''
          clearTurnstileToken()
          callbacks.onExpired?.()
        }
      })
    }
  }

  const resetTurnstile = (containerSelector) => {
    if (typeof window !== 'undefined' && window.turnstile) {
      window.turnstile.reset(widgetId || containerSelector)
    }
  }

  const applyTurnstileConfig = async (config) => {
    if (!config) return false

    turnstileEnabled.value = isTurnstileValueEnabled(config.turnstile_enabled)
    turnstileLoginEnabled.value = isTurnstileValueEnabled(config.turnstile_login_enabled)

    const requiresTurnstile = turnstileEnabled.value || turnstileLoginEnabled.value
    turnstileSiteKey.value = requiresTurnstile ? (config.turnstile_site_key || '') : ''
    turnstileVerified.value = turnstileEnabled.value && (config.verified === true || hasSharedTurnstileVerified())

    if (turnstileSiteKey.value && (turnstileLoginEnabled.value || (turnstileEnabled.value && !turnstileVerified.value))) {
      await loadTurnstileScript()
      return true
    }
    return false
  }

  const loadTurnstileConfig = async (selectedApiIndex, _isMultipleMode, loginError) => {
    try {
      turnstileEnabled.value = false
      turnstileLoginEnabled.value = false
      turnstileSiteKey.value = ''
      turnstileToken.value = getTurnstileToken()
      turnstileVerified.value = false
      if (loginError) loginError.value = ''
      removeTurnstile('#admin-turnstile-container')

      const result = await fetchTurnstileConfigByIndex(selectedApiIndex)
      if (!result.error) {
        await applyTurnstileConfig(result.data)
      }
      turnstileToken.value = getTurnstileToken()
    } catch (e) {
      turnstileToken.value = getTurnstileToken()
      console.error('Failed to load Turnstile config:', e)
    }
  }

  const clearTurnstile = () => {
    turnstileToken.value = ''
    clearTurnstileToken()
  }

  return {
    turnstileEnabled,
    turnstileLoginEnabled,
    turnstileSiteKey,
    turnstileToken,
    turnstileVerified,
    hasSharedTurnstileVerified,
    loadTurnstileConfig,
    renderTurnstile,
    resetTurnstile,
    clearTurnstile
  }
}
