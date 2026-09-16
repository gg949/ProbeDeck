import assert from 'node:assert/strict'
import test from 'node:test'

import { createServer } from 'vite'

class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.closeCalls = []
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event)
  }

  send(message) {
    this.sent.push(message)
  }

  close(code, reason = '') {
    this.closeCalls.push({ code, reason })
    this.emit('close', { code, reason })
  }
}

test('frontend WebSocket closes at its lifetime limit without reconnecting', async () => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  })
  const { createLiveSocket, normalizeLiveSocketTimeoutMinutes } = await vite.ssrLoadModule('/src/frontend/utils/api.js')
  const originalWindow = globalThis.window
  const originalLocalStorage = globalThis.localStorage
  const originalWebSocket = globalThis.WebSocket
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  globalThis.window = {
    location: {
      origin: 'https://example.com',
      protocol: 'https:',
      host: 'example.com'
    }
  }
  globalThis.localStorage = { getItem: () => '' }
  globalThis.WebSocket = FakeWebSocket
  const timers = []
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = timer => {
    if (timer) timer.cleared = true
  }
  FakeWebSocket.instances = []

  let liveSocket = null
  let unlimitedSocket = null
  try {
    const statuses = []
    const timeouts = []
    liveSocket = createLiveSocket('all', {
      timeoutMinutes: 1,
      onStatus: status => statuses.push(status),
      onTimeout: timeout => timeouts.push(timeout)
    }, 0, ['server-1'])

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 60 * 1000)
    timers[0].callback()

    assert.deepEqual(socket.closeCalls, [{
      code: 1000,
      reason: 'connection lifetime exceeded'
    }])
    assert.equal(FakeWebSocket.instances.length, 1)
    assert.equal(liveSocket.isConnected, false)
    assert.deepEqual(timeouts, [{ durationMs: 60 * 1000 }])
    assert.deepEqual(statuses.at(-1), {
      connected: false,
      reason: 'connection lifetime exceeded'
    })

    unlimitedSocket = createLiveSocket('all')
    const unlimitedWebSocket = FakeWebSocket.instances[1]
    unlimitedWebSocket.emit('open')
    assert.equal(timers.length, 1)
    assert.deepEqual(unlimitedWebSocket.closeCalls, [])
    assert.equal(normalizeLiveSocketTimeoutMinutes(0), 0)
    assert.equal(normalizeLiveSocketTimeoutMinutes(20), 20)
    assert.equal(normalizeLiveSocketTimeoutMinutes(-1), 0)
    assert.equal(normalizeLiveSocketTimeoutMinutes(1441), 0)
  } finally {
    liveSocket?.close()
    unlimitedSocket?.close()
    globalThis.window = originalWindow
    globalThis.localStorage = originalLocalStorage
    globalThis.WebSocket = originalWebSocket
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    await vite.close()
  }
})
