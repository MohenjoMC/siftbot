export function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function randomInt (min, max) {
  const low = Math.ceil(min)
  const high = Math.floor(max)
  return Math.floor(Math.random() * (high - low + 1)) + low
}

export function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function formatDuration (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function formatCoords (position) {
  if (!position) return '—'
  return `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
}

/** Unwrap the NBT type/value wrappers used by modern kick packets. */
function unwrapNbt (value) {
  if (Array.isArray(value)) return value.map(unwrapNbt)
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'type') && Object.hasOwn(value, 'value')) {
      return unwrapNbt(value.value)
    }
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = unwrapNbt(entry)
    return out
  }
  return value
}

/** Turn a kick reason (string, chat component or NBT compound) into readable text. */
export function chatComponentToText (reason) {
  if (reason == null) return 'unknown reason'
  if (typeof reason === 'string') return reason
  if (typeof reason === 'number') return String(reason)

  const parts = []
  const visit = node => {
    if (node == null) return
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node === 'object') {
      if (typeof node.text === 'string' || typeof node.text === 'number') {
        parts.push(String(node.text))
      }
      // Modern NBT chat components store bare text under an empty key.
      if (Object.hasOwn(node, '')) {
        if (typeof node[''] === 'string' || typeof node[''] === 'number') parts.push(String(node['']))
        else visit(node[''])
      }
      if (typeof node.translate === 'string' && parts.length === 0) parts.push(node.translate)
      if (node.extra) visit(node.extra)
      if (node.with) visit(node.with)
    }
  }
  visit(unwrapNbt(reason))

  const text = parts.join('').trim()
  if (text) return text
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/** Kick reasons that mean the server wants a human/account verification step. */
export function isVerificationKick (text) {
  return /bot verification|verification failed|human verification|verify (?:that )?you(?:'re| are) human|failed verification|temporarily blocked|anti-?bot|bot check|captcha|security check/i
    .test(String(text ?? ''))
}

/** Normalize a user-typed item name: "Cooked Beef" -> "cooked_beef". */
export function normalizeItemName (input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_')
}
