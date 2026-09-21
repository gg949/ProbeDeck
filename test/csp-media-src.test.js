import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCspHeader } from '../src/utils/csp.js'

test('media-src falls back to self only when csp_static is empty', () => {
  const csp = buildCspHeader({})

  assert.match(csp, /(^|;)\s*media-src 'self'(?=;|$)/)
  assert.doesNotMatch(csp, /media-src [^;]*https:/)
})

test('csp_static domains are allowed for media-src (video/audio backgrounds)', () => {
  const csp = buildCspHeader({
    staticDomains: ['https://cdn.example', 'https://media.other.test']
  })

  assert.match(csp, /(^|;)\s*media-src 'self' https:\/\/cdn\.example https:\/\/media\.other\.test(?=;|$)/)
})

test('media-src does not leak csp_api domains', () => {
  const csp = buildCspHeader({
    staticDomains: ['https://static.example'],
    apiDomains: ['https://api.example', 'wss://api.example']
  })

  assert.doesNotMatch(csp, /media-src [^;]*api\.example/)
})
