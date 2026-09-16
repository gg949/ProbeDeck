import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import mkcert from 'vite-plugin-mkcert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseCspOrigins, buildBackgroundStyle, injectTitle, injectApiBase, stripCspMeta } from './src/utils/csp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devProxyTarget = process.env.VITE_DEV_PROXY_TARGET || 'https://localhost:8787'

const createWorkerProxy = () => ({
  target: devProxyTarget,
  changeOrigin: true,
  secure: false,
  ws: true
})

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '.env')
  const env = {}
  if (!fs.existsSync(envPath)) return env
  const content = fs.readFileSync(envPath, 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function envPlugin() {
  const env = loadEnvFile()
  const apiBaseRaw = env.API_BASE || ''
  const cspApiRaw = env.CSP_API || ''
  const backgroundImage = env.BACKGROUND_IMAGE || ''
  const mobileBackgroundImage = env.BACKGROUND_IMAGE_MOBILE || ''
  const title = env.TITLE || ''

  // API_BASE 与 CSP_API 合并，写入运行时 apiBase meta。
  const rawApiDomains = [
    ...parseCspOrigins(apiBaseRaw),
    ...parseCspOrigins(cspApiRaw)
  ]

  return {
    name: 'env-inject',
    transformIndexHtml(html) {
      html = stripCspMeta(html)
      html = injectTitle(html, title)
      html = injectApiBase(html, rawApiDomains)
      if (backgroundImage || mobileBackgroundImage) {
        const bgStyle = buildBackgroundStyle(backgroundImage, mobileBackgroundImage)
        html = html.replace('</head>', `${bgStyle}\n</head>`)
      }
      return html
    }
  }
}

export default defineConfig({
  plugins: [vue(), mkcert(), envPlugin()],
  base: process.env.VITE_BASE || '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/frontend')
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'static/[name]-[hash].js',
        chunkFileNames: 'static/[name]-[hash].js',
        assetFileNames: 'static/[name]-[hash].[ext]'
      }
    }
  },
  server: {
    https: true,
    port: 5173,
    proxy: {
      '/api': createWorkerProxy(),
      '/admin/api': createWorkerProxy(),
      '/theme': createWorkerProxy(),
      '/update': createWorkerProxy(),
      '/updateDatabase': createWorkerProxy(),
      '/clearHistory': createWorkerProxy(),
      '/__do': createWorkerProxy()
    }
  }
})
