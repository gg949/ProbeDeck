import assert from 'node:assert/strict'
import test from 'node:test'

import { serveFrontend } from '../src/handlers/frontend.js'

const dashboardHtml = '<!doctype html><html><head><title>Old</title><meta name="apiBase" content=""></head><body></body></html>'

const settings = {
  site_title: 'CFSM',
  favicon: '',
  csp_static: '',
  csp_api: 'https://extra.example',
  custom_head: '',
  custom_script: '',
  custom_bg: '',
  custom_bg_mobile: '',
  theme_url: ''
}

test('Workers API_BASE env is injected into frontend runtime config and CSP', async () => {
  const response = await serveFrontend(
    new Request('https://dashboard.example/'),
    {
      API_BASE: 'https://api-a.example, https://api-b.example/, http://invalid.example',
      ASSETS: {
        fetch: async () => new Response(dashboardHtml, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        })
      }
    },
    settings
  )

  assert.equal(response.status, 200)

  const html = await response.text()
  assert.match(html, /<meta name="apiBase" content="https:\/\/api-a\.example,https:\/\/api-b\.example">/)
  assert.doesNotMatch(html, /http:\/\/invalid\.example/)

  const csp = response.headers.get('Content-Security-Policy') || ''
  assert.match(csp, /connect-src[^;]*https:\/\/api-a\.example/)
  assert.match(csp, /connect-src[^;]*wss:\/\/api-a\.example/)
  assert.match(csp, /connect-src[^;]*https:\/\/api-b\.example/)
  assert.match(csp, /connect-src[^;]*wss:\/\/api-b\.example/)
  assert.match(csp, /connect-src[^;]*https:\/\/extra\.example/)
  assert.match(csp, /connect-src[^;]*wss:\/\/extra\.example/)
})
