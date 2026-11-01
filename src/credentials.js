import fs from 'node:fs'
import path from 'node:path'

const FILE_VERSION = 1

/** Normalize a host for storage: lower-case, no port, no trailing dot. */
export function credentialHost (host) {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
}

export function credentialKey (host, username) {
  return `${String(username ?? '').trim().toLowerCase()}@${credentialHost(host)}`
}

/**
 * Extract a password from a register/login command a player types.
 * Returns { type: 'register' | 'login', password } or null.
 */
export function parsePasswordCommand (text) {
  const match = String(text ?? '').trim().match(/^\/(register|reg|login)\s+(\S+)(?:\s+(\S+))?$/i)
  if (!match) return null
  const type = match[1].toLowerCase() === 'login' ? 'login' : 'register'
  const password = match[2]
  if (!password || password.startsWith('<') || password.includes('${')) return null
  return { type, password }
}

/** Server asks the player to authenticate with /login. */
export function isLoginPrompt (text) {
  return /\/login\b|please (?:log ?in|login)|type \/login|use \/login/i.test(String(text ?? '')) &&
    !/\/register\b/i.test(String(text ?? ''))
}

/** Server asks a new player to register. */
export function isRegisterPrompt (text) {
  return /\/register\b|\/reg\b|please register|type \/register/i.test(String(text ?? ''))
}

/**
 * Small JSON password store, keyed by username@host. The file is human-editable
 * (manual edits are picked up on the next start / reload) and created with mode
 * 0600. Passwords are never logged; only presence is reported.
 */
export class CredentialStore {
  constructor (file, { logger = null } = {}) {
    this.file = path.resolve(file)
    this.logger = logger
    this.entries = new Map()
    this.load()
  }

  load () {
    this.entries.clear()
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger?.warn(`credentials: cannot read ${this.file}: ${err.message}`)
      return
    }

    try {
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
      const credentials = parsed?.credentials
      if (credentials && typeof credentials === 'object') {
        for (const [key, entry] of Object.entries(credentials)) {
          if (!entry || typeof entry.password !== 'string' || entry.password === '') continue
          this.entries.set(key, {
            username: typeof entry.username === 'string' ? entry.username : key.split('@')[0],
            host: typeof entry.host === 'string' ? entry.host : key.split('@')[1] ?? '',
            password: entry.password,
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null
          })
        }
      }
    } catch (err) {
      this.logger?.warn(`credentials: invalid JSON in ${this.file}: ${err.message}`)
    }

    // Best effort: keep the file private even if it was created by hand.
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      // Platforms without chmod.
    }
  }

  get (host, username) {
    const entry = this.entries.get(credentialKey(host, username))
    return entry ? entry.password : null
  }

  has (host, username) {
    return this.entries.has(credentialKey(host, username))
  }

  set (host, username, password) {
    const clean = String(password ?? '')
    if (clean === '' || clean.startsWith('<') || clean.includes('${')) return false
    const key = credentialKey(host, username)
    const existing = this.entries.get(key)
    if (existing && existing.password === clean) return false
    this.entries.set(key, {
      username: String(username ?? ''),
      host: credentialHost(host),
      password: clean,
      updatedAt: new Date().toISOString()
    })
    this.save()
    this.logger?.info(`credentials: saved password for ${key}`)
    return true
  }

  remove (host, username) {
    const removed = this.entries.delete(credentialKey(host, username))
    if (removed) this.save()
    return removed
  }

  save () {
    const payload = {
      version: FILE_VERSION,
      credentials: Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)))
    }
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      // Platforms without chmod.
    }
  }

  /** Sanitized summary for status output: no passwords. */
  summary () {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      username: entry.username,
      host: entry.host,
      updatedAt: entry.updatedAt
    }))
  }
}
