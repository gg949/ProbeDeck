export const normalizeThemeOptions = (options) => {
  return options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {}
}

const MIKUS_ASSET_BASE = '/mikus'
const MIKUS_SAKURA_ID = 'mikus-global-sakura-background'
const MIKUS_SAKURA_COUNT = 15
const MIKUS_PETAL_SIZE = 40

let mikusSakuraFrame = null
let mikusSakuraResizeHandler = null

export const isThemeOptionEnabled = (options, key) => {
  const normalizedOptions = normalizeThemeOptions(options)
  if (!Object.prototype.hasOwnProperty.call(normalizedOptions, key)) return false

  const value = normalizedOptions[key]
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase()
    if (!normalizedValue) return false
    return !['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(normalizedValue)
  }

  return true
}

export const isMikusThemeEnabled = (options) => isThemeOptionEnabled(options, 'mikus')

export const getMikusAssetUrl = (filename) => {
  const normalizedFilename = String(filename || '').replace(/^\/+/, '')
  return `${MIKUS_ASSET_BASE}/${normalizedFilename}`
}

const getViewportSize = () => ({
  width: window.innerWidth || document.documentElement.clientWidth || 0,
  height: window.innerHeight || document.documentElement.clientHeight || 0
})

const randomSakuraMotion = () => ({
  x: (Math.random() - 0.5) * 0.5 - 1.7,
  y: 1.5 + 0.7 * Math.random(),
  r: 0.03 * Math.random()
})

const resetSakuraPetal = (petal, fromRight = Math.random() <= 0.4) => {
  const { width, height } = getViewportSize()
  petal.x = fromRight ? width : Math.random() * width
  petal.y = fromRight ? Math.random() * height : 0
  petal.scale = 0.35 + Math.random() * 0.75
  petal.rotation = 6 * Math.random()
  petal.motion = randomSakuraMotion()
}

const createSakuraPetal = () => {
  const { width, height } = getViewportSize()
  const petal = {
    x: Math.random() * width,
    y: Math.random() * height,
    scale: 0.35 + Math.random() * 0.75,
    rotation: 6 * Math.random(),
    motion: randomSakuraMotion()
  }
  return petal
}

const resizeSakuraCanvas = (canvas, context) => {
  const { width, height } = getViewportSize()
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.width = Math.max(1, Math.floor(width * ratio))
  canvas.height = Math.max(1, Math.floor(height * ratio))
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

const stopMikusSakuraAnimation = () => {
  if (mikusSakuraFrame !== null && typeof window !== 'undefined') {
    window.cancelAnimationFrame(mikusSakuraFrame)
  }
  mikusSakuraFrame = null

  if (mikusSakuraResizeHandler && typeof window !== 'undefined') {
    window.removeEventListener('resize', mikusSakuraResizeHandler)
  }
  mikusSakuraResizeHandler = null
}

const startMikusSakuraAnimation = (canvas, context, image) => {
  stopMikusSakuraAnimation()
  resizeSakuraCanvas(canvas, context)
  context.imageSmoothingEnabled = true

  const petals = Array.from({ length: MIKUS_SAKURA_COUNT }, createSakuraPetal)
  mikusSakuraResizeHandler = () => resizeSakuraCanvas(canvas, context)
  window.addEventListener('resize', mikusSakuraResizeHandler, { passive: true })

  const drawFrame = () => {
    const { width, height } = getViewportSize()
    context.clearRect(0, 0, width, height)

    for (const petal of petals) {
      const drawSize = MIKUS_PETAL_SIZE * petal.scale
      context.save()
      context.translate(petal.x, petal.y)
      context.rotate(petal.rotation)
      context.drawImage(image, 0, 0, drawSize, drawSize)
      context.restore()

      petal.x += petal.motion.x
      petal.y += petal.motion.y
      petal.rotation += petal.motion.r

      if (petal.x > width || petal.x < -drawSize || petal.y > height || petal.y < -drawSize) {
        resetSakuraPetal(petal)
      }
    }

    mikusSakuraFrame = window.requestAnimationFrame(drawFrame)
  }

  mikusSakuraFrame = window.requestAnimationFrame(drawFrame)
}

const ensureMikusSakuraBackground = () => {
  if (typeof document === 'undefined' || !document.body) return
  if (document.getElementById(MIKUS_SAKURA_ID)) return

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return

  canvas.id = MIKUS_SAKURA_ID
  canvas.className = 'mikus-sakura-canvas mikus-global-sakura'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.insertBefore(canvas, document.body.firstChild)

  const image = new Image()
  image.onload = () => {
    if (document.getElementById(MIKUS_SAKURA_ID) === canvas) {
      startMikusSakuraAnimation(canvas, context, image)
    }
  }
  image.src = getMikusAssetUrl('sakura.png')
  if (image.complete) {
    image.onload()
  }
}

const removeMikusSakuraBackground = () => {
  if (typeof document === 'undefined') return
  stopMikusSakuraAnimation()
  document.getElementById(MIKUS_SAKURA_ID)?.remove()
}

export const setMikusThemeClass = (enabled) => {
  if (typeof document === 'undefined') return
  const shouldEnable = Boolean(enabled)
  document.body.classList.toggle('mikus-theme', shouldEnable)
  if (shouldEnable) {
    ensureMikusSakuraBackground()
  } else {
    removeMikusSakuraBackground()
  }
}

export const applyMikusThemeOptions = (options) => {
  setMikusThemeClass(isMikusThemeEnabled(options))
}
