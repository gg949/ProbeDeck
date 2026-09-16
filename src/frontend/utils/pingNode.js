const HOST_PATTERN = /^[a-zA-Z0-9._-]+$/
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV4_LIKE_PATTERN = /^(?:\d+\.){3}\d+$/
const IPV6_PATTERN = /^(?:(?:[0-9a-f]{1,4}:){1,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})|:(?:(?::[0-9a-f]{1,4}){1,7}|:))$/i

export const PING_NODE_FIELDS = ['custom_ct', 'custom_cu', 'custom_cm', 'custom_bd', 'node_1', 'node_2', 'node_3', 'node_4']

const isValidIpv4 = (host) => {
  if (!IPV4_PATTERN.test(host)) return false
  return host.split('.').every(part => {
    const number = Number(part)
    return Number.isInteger(number) && number >= 0 && number <= 255
  })
}

const isValidHostname = (host) => {
  if (!HOST_PATTERN.test(host) || host.length > 50) return false
  if (IPV4_LIKE_PATTERN.test(host)) return false
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false
  return host.split('.').every(label => {
    if (!label || label.length > 63) return false
    return /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?$/.test(label)
  })
}
const isValidIpv6 = (host) => IPV6_PATTERN.test(host)

export const validatePingNode = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return { valid: true, value: '' }
  if (raw.length > 60 || raw.includes('://') || /[\s/@?#\\]/.test(raw)) {
    return { valid: false }
  }

  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/)
    if (!match || !isValidIpv6(match[1])) return { valid: false }
    const port = match[2] ? Number(match[2]) : null
    if (port !== null && (port < 1 || port > 65535)) return { valid: false }
    return { valid: true, value: `[${match[1].toLowerCase()}]${port !== null ? `:${port}` : ''}` }
  }
  if (raw.includes(']')) return { valid: false }
  const colonCount = (raw.match(/:/g) || []).length
  if (colonCount > 1) {
    const host = raw.toLowerCase()
    return isValidIpv6(host) ? { valid: true, value: `[${host}]` } : { valid: false }
  }

  let host = raw
  let port = ''
  if (colonCount === 1) {
    const parts = raw.split(':')
    host = parts[0]
    port = parts[1]
    if (!port || !/^\d{1,5}$/.test(port)) return { valid: false }
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return { valid: false }
    }
    port = String(portNumber)
  }

  host = host.toLowerCase()
  if (!host) return { valid: false }
  if (isValidIpv4(host) || isValidHostname(host)) {
    return { valid: true, value: port ? `${host}:${port}` : host }
  }
  return { valid: false }
}
