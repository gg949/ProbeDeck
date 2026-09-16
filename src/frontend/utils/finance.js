import {
  detectBillingCycle,
  detectCurrencySymbol,
  getBillingCycleOption,
  isFreePrice,
  normalizeCurrency,
  normalizePrice
} from './server.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MONTH_DAYS = 30
const LONG_TERM_YEARS = 100
const EXCHANGE_RATE_CACHE_KEY = 'cfsm_finance_exchange_rates_cny_v1'
const FINANCE_CURRENCY_KEY = 'cfsm_finance_currency_v1'

const FINANCE_CURRENCY_CONFIG = Object.freeze({
  AED: { rate: 0.5435, symbol: 'د.إ' },
  AUD: { rate: 0.20941, symbol: 'A$' },
  BDT: { rate: 18.02, symbol: '৳' },
  BRL: { rate: 0.74734, symbol: 'R$' },
  CAD: { rate: 0.20691, symbol: 'C$' },
  CHF: { rate: 0.11746, symbol: 'CHF' },
  CNY: { rate: 1, symbol: '¥' },
  CZK: { rate: 3.0787, symbol: 'Kč' },
  DKK: { rate: 0.95296, symbol: 'kr' },
  EGP: { rate: 7.15, symbol: 'EGP' },
  EUR: { rate: 0.1275, symbol: '€' },
  GBP: { rate: 0.11027, symbol: '£' },
  GTQ: { rate: 1.14, symbol: 'Q' },
  HKD: { rate: 1.1594, symbol: 'HK$' },
  HUF: { rate: 44.688, symbol: 'Ft' },
  IDR: { rate: 2622.37, symbol: 'Rp' },
  ILS: { rate: 0.43085, symbol: '₪' },
  INR: { rate: 14.0178, symbol: '₹' },
  ISK: { rate: 18.4626, symbol: 'kr' },
  JPY: { rate: 23.707, symbol: '¥' },
  KRW: { rate: 224.11, symbol: '₩' },
  KZT: { rate: 64, symbol: '₸' },
  LKR: { rate: 44.4, symbol: 'LKR' },
  MXN: { rate: 2.5472, symbol: 'Mex$' },
  MYR: { rate: 0.59945, symbol: 'RM' },
  MNT: { rate: 530, symbol: '₮' },
  NGN: { rate: 225.6, symbol: '₦' },
  NOK: { rate: 1.4096, symbol: 'kr' },
  NZD: { rate: 0.2535, symbol: 'NZ$' },
  PHP: { rate: 8.9288, symbol: '₱' },
  PKR: { rate: 41.5, symbol: '₨' },
  PLN: { rate: 0.54138, symbol: 'zł' },
  RON: { rate: 0.66769, symbol: 'lei' },
  RUB: { rate: 11.9, symbol: '₽' },
  SAR: { rate: 0.555, symbol: '﷼' },
  SEK: { rate: 1.3895, symbol: 'kr' },
  SGD: { rate: 0.18975, symbol: 'S$' },
  THB: { rate: 4.8172, symbol: '฿' },
  TRY: { rate: 6.849, symbol: '₺' },
  UAH: { rate: 3.6, symbol: '₴' },
  USD: { rate: 0.14799, symbol: '$' },
  VND: { rate: 3500, symbol: '₫' },
  ZAR: { rate: 2.3995, symbol: 'R' }
})

const BILLING_CYCLE_DAYS = Object.freeze({
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  two_years: 730,
  three_years: 1095,
  four_years: 1460,
  five_years: 1825
})

export const SUPPORTED_FINANCE_CURRENCIES = Object.freeze(Object.keys(FINANCE_CURRENCY_CONFIG))
export const DISPLAY_FINANCE_CURRENCIES = Object.freeze(['CNY', 'USD', 'HKD', 'EUR', 'GBP', 'JPY'])
export const DEFAULT_EXCHANGE_RATES = Object.freeze(
  Object.fromEntries(Object.entries(FINANCE_CURRENCY_CONFIG).map(([code, config]) => [code, config.rate]))
)
export const CURRENCY_SYMBOLS = Object.freeze(
  Object.fromEntries(Object.entries(FINANCE_CURRENCY_CONFIG).map(([code, config]) => [code, config.symbol]))
)

const EXCHANGE_RATE_APIS = Object.freeze([
  {
    url: 'https://api.frankfurter.dev/v1/latest?base=CNY',
    parse: data => data?.rates
  },
  {
    url: 'https://open.er-api.com/v6/latest/CNY',
    parse: data => data?.rates
  }
])

const CURRENCY_ALIASES = Object.freeze({
  '$': 'USD',
  'US$': 'USD',
  USD: 'USD',
  '¥': 'CNY',
  '￥': 'CNY',
  CNY: 'CNY',
  RMB: 'CNY',
  'CN¥': 'CNY',
  '¥JPY': 'JPY',
  'JP¥': 'JPY',
  JPY: 'JPY',
  '€': 'EUR',
  EUR: 'EUR',
  '£': 'GBP',
  GBP: 'GBP',
  'HK$': 'HKD',
  HKD: 'HKD',
  'A$': 'AUD',
  AUD: 'AUD',
  'C$': 'CAD',
  CAD: 'CAD',
  'S$': 'SGD',
  SGD: 'SGD',
  'NZ$': 'NZD',
  NZD: 'NZD',
  '₣': 'CHF',
  CHF: 'CHF',
  '₩': 'KRW',
  KRW: 'KRW',
  '₹': 'INR',
  INR: 'INR',
  '฿': 'THB',
  THB: 'THB',
  '₫': 'VND',
  VND: 'VND',
  '₱': 'PHP',
  PHP: 'PHP',
  RP: 'IDR',
  IDR: 'IDR',
  RM: 'MYR',
  MYR: 'MYR',
  '₺': 'TRY',
  TRY: 'TRY',
  '₪': 'ILS',
  ILS: 'ILS',
  '৳': 'BDT',
  BDT: 'BDT',
  '₨': 'PKR',
  PKR: 'PKR',
  LKR: 'LKR',
  '₮': 'MNT',
  MNT: 'MNT',
  '₽': 'RUB',
  RUB: 'RUB',
  'R$': 'BRL',
  BRL: 'BRL',
  KR: 'SEK',
  SEK: 'SEK',
  NOK: 'NOK',
  DKK: 'DKK',
  'ZŁ': 'PLN',
  'zł': 'PLN',
  PLN: 'PLN',
  '₴': 'UAH',
  UAH: 'UAH',
  '₸': 'KZT',
  KZT: 'KZT',
  R: 'ZAR',
  ZAR: 'ZAR',
  '₦': 'NGN',
  NGN: 'NGN',
  EGP: 'EGP',
  'د.إ': 'AED',
  AED: 'AED',
  '﷼': 'SAR',
  SAR: 'SAR',
  Q: 'GTQ',
  GTQ: 'GTQ'
})

export function normalizeFinanceCurrency(value) {
  const raw = String(value || 'CNY').trim()
  if (!raw) return 'CNY'

  const upper = raw.toUpperCase()
  const code = CURRENCY_ALIASES[raw] || CURRENCY_ALIASES[upper] || upper
  return DEFAULT_EXCHANGE_RATES[code] ? code : 'CNY'
}

export function getStoredFinanceCurrency() {
  return normalizeFinanceCurrency(getLocalStorageItem(FINANCE_CURRENCY_KEY) || 'CNY')
}

export function setStoredFinanceCurrency(currency) {
  setLocalStorageItem(FINANCE_CURRENCY_KEY, normalizeFinanceCurrency(currency))
}

export async function getDailyExchangeRates() {
  const today = getTodayDateKey()
  const cached = readCachedExchangeRates()

  if (cached?.date === today) {
    return { rates: cached.rates, source: 'cache' }
  }

  const fetchedRates = await fetchExchangeRates()
  if (fetchedRates) {
    writeCachedExchangeRates(fetchedRates, today)
    return { rates: fetchedRates, source: 'network' }
  }

  if (cached) {
    return { rates: cached.rates, source: 'stale-cache' }
  }

  return { rates: DEFAULT_EXCHANGE_RATES, source: 'default' }
}

export function calculateFinanceSummary(servers, exchangeRates = DEFAULT_EXCHANGE_RATES, now = Date.now()) {
  const summary = {
    totalValueCNY: 0,
    remainingValueCNY: 0,
    monthlyAverageCostCNY: 0,
    configuredCount: 0,
    expiredCount: 0,
    missingExpireCount: 0
  }

  for (const server of Array.isArray(servers) ? servers : []) {
    if (hasFreeTag(server)) continue

    const priceCNY = getPriceCNY(server, exchangeRates)
    if (priceCNY <= 0) continue

    summary.configuredCount++
    summary.totalValueCNY += priceCNY
    summary.monthlyAverageCostCNY += calculateMonthlyAverageCostCNY(server, priceCNY)

    const expireDate = String(server?.expire_date || server?.expired_at || '').trim()
    if (!expireDate) {
      summary.missingExpireCount++
      continue
    }

    const remainingValue = calculateRemainingValueCNY(server, priceCNY, now)
    if (remainingValue <= 0) summary.expiredCount++
    summary.remainingValueCNY += remainingValue
  }

  return summary
}

export function calculateRemainingValueCNY(server, priceCNY, now = Date.now()) {
  const expireDate = String(server?.expire_date || server?.expired_at || '').trim()
  if (!expireDate || priceCNY <= 0) return 0

  const expiredAt = new Date(expireDate).getTime()
  if (!Number.isFinite(expiredAt)) return 0

  const diffMs = expiredAt - Number(now)
  if (diffMs <= 0) return 0

  const diffYears = diffMs / (MS_PER_DAY * 365)
  if (diffYears > LONG_TERM_YEARS) return priceCNY

  const billingCycleMs = getBillingCycleDays(server) * MS_PER_DAY
  if (billingCycleMs <= 0) return priceCNY

  return Math.min(priceCNY, priceCNY * (diffMs / billingCycleMs))
}

export function calculateMonthlyAverageCostCNY(server, priceCNY) {
  if (priceCNY <= 0) return 0
  const billingCycleDays = getBillingCycleDays(server)
  return billingCycleDays > 0 ? priceCNY / billingCycleDays * MONTH_DAYS : 0
}

export function formatFinanceAmount(amount, currency) {
  const code = normalizeFinanceCurrency(currency)
  const safeAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0
  const value = new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: Math.abs(safeAmount) < 100000 ? 2 : 0,
    notation: Math.abs(safeAmount) >= 100000 ? 'compact' : 'standard'
  }).format(safeAmount)

  return {
    currency: code,
    symbol: CURRENCY_SYMBOLS[code] || '',
    value
  }
}

export function convertCnyAmount(amountCNY, currency, exchangeRates = DEFAULT_EXCHANGE_RATES) {
  const code = normalizeFinanceCurrency(currency)
  const rate = exchangeRates[code] || DEFAULT_EXCHANGE_RATES[code] || 1
  return Number(amountCNY || 0) * rate
}

function getPriceCNY(server, exchangeRates) {
  const priceText = normalizePrice(server?.price)
  if (!priceText || isFreePrice(priceText)) return 0

  const price = Number(priceText)
  if (!Number.isFinite(price) || price <= 0) return 0

  const currency = normalizeServerCurrency(server)
  if (currency === 'CNY') return price

  const rate = exchangeRates[currency] || DEFAULT_EXCHANGE_RATES[currency] || 0
  return rate > 0 ? price / rate : 0
}

function normalizeServerCurrency(server) {
  const normalizedSymbol = normalizeCurrency(server?.currency || detectCurrencySymbol(server?.price))
  return normalizeFinanceCurrency(normalizedSymbol || server?.currency || detectCurrencySymbol(server?.price))
}

function getBillingCycleDays(server) {
  const cycleValue = detectBillingCycle(server?.price) || server?.billing_cycle
  const cycle = getBillingCycleOption(cycleValue)
  return BILLING_CYCLE_DAYS[cycle.value] || (cycle.months * MONTH_DAYS)
}

function hasFreeTag(server) {
  const tags = String(server?.tags || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
  return tags.includes('白嫖中')
}

async function fetchExchangeRates() {
  for (const api of EXCHANGE_RATE_APIS) {
    try {
      const response = await fetchWithTimeout(api.url)
      if (!response.ok) continue

      const data = await response.json()
      const rates = sanitizeExchangeRates(api.parse(data))
      if (rates) return rates
    } catch (error) {
      console.warn('[Finance] Failed to fetch exchange rates:', api.url, error)
    }
  }

  return null
}

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function sanitizeExchangeRates(rates) {
  if (!rates || typeof rates !== 'object') return null

  const result = { ...DEFAULT_EXCHANGE_RATES, CNY: 1 }
  for (const currency of SUPPORTED_FINANCE_CURRENCIES) {
    if (currency === 'CNY') continue
    const value = Number(rates[currency])
    if (Number.isFinite(value) && value > 0) result[currency] = value
  }

  return result
}

function readCachedExchangeRates() {
  try {
    const raw = getLocalStorageItem(EXCHANGE_RATE_CACHE_KEY)
    if (!raw) return null

    const cache = JSON.parse(raw)
    const rates = sanitizeExchangeRates(cache?.rates)
    if (cache?.base !== 'CNY' || !cache?.date || !rates) return null

    return { date: cache.date, rates }
  } catch (_) {
    return null
  }
}

function writeCachedExchangeRates(rates, date) {
  setLocalStorageItem(EXCHANGE_RATE_CACHE_KEY, JSON.stringify({
    base: 'CNY',
    date,
    fetchedAt: Date.now(),
    rates
  }))
}

function getTodayDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getLocalStorageItem(key) {
  try {
    return localStorage.getItem(key)
  } catch (_) {
    return null
  }
}

function setLocalStorageItem(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch (_) {
    // 汇率缓存失败不影响前端统计，下一次刷新会重新请求或使用内置汇率。
  }
}
