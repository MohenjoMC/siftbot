import fs from 'node:fs'
import path from 'node:path'

export class ConfigError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function defaultConfig () {
  return {
    host: 'localhost',
    port: 25565,
    username: 'siftbot',
    version: false,
    auth: 'offline',
    password: '',
    logLevel: 'info',
    startupCommands: [],
    client: {
      enabled: true,
      brand: 'vanilla',
      viewDistance: 'normal',
      locale: 'en_US'
    },
    autoEat: {
      enabled: true,
      eatAtFood: 17,
      eatAtHealth: 14,
      cooldownMs: 1500,
      restoreHeldItem: true,
      exclude: []
    },
    sneak: {
      enabled: true,
      watchdogMs: 3000
    },
    afk: {
      enabled: true,
      minIntervalMs: 20000,
      maxIntervalMs: 45000,
      look: true,
      swing: true,
      jump: true,
      move: false,
      chat: [],
      chatIntervalMs: 300000
    },
    reconnect: {
      enabled: true,
      baseDelayMs: 3000,
      maxDelayMs: 60000,
      onKick: true,
      stopOnBan: true,
      stopOnVerification: true
    },
    console: {
      enabled: true,
      chatPassthrough: true
    }
  }
}

export const USAGE = `siftbot — an AFK Minecraft bot with auto-eat, held sneak and a live console.

Usage:
  npm start -- [options]
  node src/index.js [options]

Options:
  -c, --config <file>        JSON config file (default: ./config.json if present)
      --host <host>          Server host                     (default: localhost)
      --port <port>          Server port                     (default: 25565)
  -u, --username <name>      Bot username                    (default: siftbot)
      --mc-version <ver>     Minecraft version, or "auto"    (default: auto)
      --auth <mode>          offline or microsoft            (default: offline)
      --password <password>  Password used by startupCommands
      --log-level <level>    debug, info, warn or error      (default: info)
      --no-autoeat           Disable auto-eat
      --no-sneak             Disable holding sneak
      --no-afk               Disable anti-AFK activity
      --no-client            Disable vanilla client presentation
      --no-console           Disable the interactive console
      --no-reconnect         Do not reconnect after disconnects
      --no-chat-passthrough  Treat plain console lines as commands, not chat
      --print-config         Print the resolved config and exit
  -h, --help                 Show this help
  -v, --version              Show the siftbot version

Environment variables (lowest to highest precedence: file, env, CLI):
  SIFTBOT_CONFIG, SIFTBOT_HOST, SIFTBOT_PORT, SIFTBOT_USERNAME,
  SIFTBOT_MC_VERSION, SIFTBOT_AUTH, SIFTBOT_PASSWORD, SIFTBOT_LOG_LEVEL,
  SIFTBOT_AUTOEAT, SIFTBOT_SNEAK, SIFTBOT_AFK, SIFTBOT_CLIENT, SIFTBOT_CONSOLE, SIFTBOT_RECONNECT
`

const VALUE_FLAGS = new Set([
  'config',
  'host',
  'port',
  'username',
  'mc-version',
  'auth',
  'password',
  'log-level'
])

const BOOLEAN_FLAGS = new Set([
  'afk',
  'autoeat',
  'sneak',
  'client',
  'console',
  'reconnect',
  'chat-passthrough',
  'no-afk',
  'no-autoeat',
  'no-sneak',
  'no-client',
  'no-console',
  'no-reconnect',
  'no-chat-passthrough',
  'help',
  'version',
  'print-config'
])

/**
 * Parse CLI arguments without touching process state.
 * @param {string[]} argv
 */
export function parseCli (argv) {
  const flags = {}
  let help = false
  let version = false
  let printConfig = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      if (token === '-h') { help = true; continue }
      if (token === '-v') { version = true; continue }
      if (token === '-c' || token === '-u') {
        const value = argv[++i]
        if (value == null) throw new ConfigError(`Missing value for ${token}`)
        flags[token === '-c' ? 'config' : 'username'] = value
        continue
      }
      throw new ConfigError(`Unexpected argument: ${token}`)
    }

    const eq = token.indexOf('=')
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase()
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
      throw new ConfigError(`Unknown option: --${name}`)
    }

    if (name === 'help') { help = true; continue }
    if (name === 'version') { version = true; continue }
    if (name === 'print-config') { printConfig = true; continue }

    let value = eq === -1 ? undefined : token.slice(eq + 1)
    if (VALUE_FLAGS.has(name) && value === undefined) {
      value = argv[++i]
      if (value == null) throw new ConfigError(`Missing value for --${name}`)
    }
    if (BOOLEAN_FLAGS.has(name) && value === undefined) value = true
    flags[name] = value
  }

  return { flags, help, version, printConfig }
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge (base, override) {
  if (!isPlainObject(override)) return override
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? deepMerge(out[key], value)
      : value
  }
  return out
}

function fromEnv (env) {
  const out = {}
  const map = {
    SIFTBOT_HOST: 'host',
    SIFTBOT_PORT: 'port',
    SIFTBOT_USERNAME: 'username',
    SIFTBOT_MC_VERSION: 'version',
    SIFTBOT_AUTH: 'auth',
    SIFTBOT_PASSWORD: 'password',
    SIFTBOT_LOG_LEVEL: 'logLevel'
  }
  for (const [key, target] of Object.entries(map)) {
    if (env[key] !== undefined && env[key] !== '') out[target] = env[key]
  }

  const features = {
    SIFTBOT_AUTOEAT: 'autoEat',
    SIFTBOT_SNEAK: 'sneak',
    SIFTBOT_AFK: 'afk',
    SIFTBOT_CLIENT: 'client',
    SIFTBOT_CONSOLE: 'console',
    SIFTBOT_RECONNECT: 'reconnect'
  }
  for (const [key, section] of Object.entries(features)) {
    if (env[key] === undefined || env[key] === '') continue
    out[section] = { ...(out[section] || {}), enabled: parseBool(env[key], key) }
  }
  return out
}

function fromFlags (flags) {
  const out = {}
  if (flags.host !== undefined) out.host = flags.host
  if (flags.port !== undefined) out.port = flags.port
  if (flags.username !== undefined) out.username = flags.username
  if (flags.password !== undefined) out.password = flags.password
  if (flags.auth !== undefined) out.auth = flags.auth
  if (flags['log-level'] !== undefined) out.logLevel = flags['log-level']
  if (flags['mc-version'] !== undefined) {
    out.version = String(flags['mc-version']).toLowerCase() === 'auto'
      ? false
      : String(flags['mc-version'])
  }

  const toggles = {
    afk: 'afk',
    autoeat: 'autoEat',
    sneak: 'sneak',
    client: 'client',
    console: 'console',
    reconnect: 'reconnect'
  }
  for (const [flag, section] of Object.entries(toggles)) {
    if (flags[flag] !== undefined) {
      out[section] = { ...(out[section] || {}), enabled: parseBool(flags[flag], `--${flag}`) }
    }
    if (flags[`no-${flag}`] !== undefined) {
      const disabled = parseBool(flags[`no-${flag}`], `--no-${flag}`)
      out[section] = { ...(out[section] || {}), enabled: !disabled }
    }
  }

  if (flags['chat-passthrough'] !== undefined) {
    out.console = {
      ...(out.console || {}),
      chatPassthrough: parseBool(flags['chat-passthrough'], '--chat-passthrough')
    }
  }
  if (flags['no-chat-passthrough'] !== undefined) {
    const disabled = parseBool(flags['no-chat-passthrough'], '--no-chat-passthrough')
    out.console = { ...(out.console || {}), chatPassthrough: !disabled }
  }
  return out
}

function parseBool (value, name) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  throw new ConfigError(`${name} must be true or false`)
}

function numberInRange (value, name, { min, max, integer = true }) {
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(number)) throw new ConfigError(`${name} must be a number`)
  if (integer && !Number.isInteger(number)) throw new ConfigError(`${name} must be an integer`)
  if (number < min || number > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}`)
  }
  return number
}

function stringArray (value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new ConfigError(`${name} must be an array of non-empty strings`)
  }
  return value.map(item => item.trim())
}

function normalizeStartupCommands (value) {
  if (!Array.isArray(value)) throw new ConfigError('startupCommands must be an array')
  return value.map((entry, index) => {
    const where = `startupCommands[${index}]`
    if (typeof entry === 'string') {
      if (entry.trim() === '') throw new ConfigError(`${where} must not be empty`)
      return { command: entry.trim(), delayMs: 0 }
    }
    if (!isPlainObject(entry) || typeof entry.command !== 'string' || entry.command.trim() === '') {
      throw new ConfigError(`${where} must be a command string or an object with a "command" field`)
    }
    const delayMs = entry.delayMs === undefined
      ? 0
      : numberInRange(entry.delayMs, `${where}.delayMs`, { min: 0, max: 600000 })
    return { command: entry.command.trim(), delayMs }
  })
}

/**
 * Validate and coerce a merged config object.
 * @param {object} input
 */
export function normalizeConfig (input) {
  if (!isPlainObject(input)) throw new ConfigError('Config must be a JSON object')
  const config = deepMerge(defaultConfig(), input)

  for (const section of ['autoEat', 'sneak', 'afk', 'reconnect', 'console', 'client']) {
    if (!isPlainObject(config[section])) {
      throw new ConfigError(`${section} must be an object`)
    }
  }

  if (typeof config.host !== 'string' || config.host.trim() === '') {
    throw new ConfigError('host must be a non-empty string')
  }
  config.host = config.host.trim()

  if (typeof config.username !== 'string' || config.username.trim() === '') {
    throw new ConfigError('username must be a non-empty string')
  }
  config.username = config.username.trim()

  config.port = numberInRange(config.port, 'port', { min: 1, max: 65535 })

  config.auth = String(config.auth).trim().toLowerCase()
  if (!['offline', 'microsoft'].includes(config.auth)) {
    throw new ConfigError('auth must be "offline" or "microsoft"')
  }

  if (config.auth === 'offline' && !/^[A-Za-z0-9_]{1,16}$/.test(config.username)) {
    throw new ConfigError('username must be 1-16 characters (letters, numbers or _) for offline auth')
  }

  if (config.version === null || config.version === false) {
    config.version = false
  } else if (typeof config.version === 'string' && config.version.trim().toLowerCase() === 'auto') {
    config.version = false
  } else if (typeof config.version === 'number') {
    config.version = String(config.version)
  } else if (typeof config.version !== 'string' || config.version.trim() === '') {
    throw new ConfigError('version must be a Minecraft version string or "auto"')
  } else {
    config.version = config.version.trim()
  }

  if (config.password === null || config.password === undefined) config.password = ''
  if (typeof config.password !== 'string') throw new ConfigError('password must be a string')

  const levels = ['debug', 'info', 'warn', 'error']
  config.logLevel = String(config.logLevel).trim().toLowerCase()
  if (!levels.includes(config.logLevel)) {
    throw new ConfigError(`logLevel must be one of: ${levels.join(', ')}`)
  }

  config.startupCommands = normalizeStartupCommands(config.startupCommands)

  const client = config.client
  client.enabled = parseBool(client.enabled, 'client.enabled')

  if (typeof client.brand !== 'string') throw new ConfigError('client.brand must be a string')
  client.brand = client.brand.trim()
  if (client.brand === '') throw new ConfigError('client.brand must be a non-empty string')
  if (client.brand.length > 64) throw new ConfigError('client.brand must be at most 64 characters')

  if (typeof client.viewDistance === 'number') {
    client.viewDistance = numberInRange(client.viewDistance, 'client.viewDistance', { min: 2, max: 32 })
  } else if (typeof client.viewDistance === 'string') {
    const normalized = client.viewDistance.trim().toLowerCase()
    if (!['far', 'normal', 'short', 'tiny'].includes(normalized)) {
      throw new ConfigError('client.viewDistance must be "far", "normal", "short", "tiny" or a chunk count of 2-32')
    }
    client.viewDistance = normalized
  } else {
    throw new ConfigError('client.viewDistance must be "far", "normal", "short", "tiny" or a chunk count of 2-32')
  }

  client.locale = String(client.locale ?? '').trim()
  if (!/^[A-Za-z0-9_-]{2,16}$/.test(client.locale)) {
    throw new ConfigError('client.locale must be 2-16 characters (letters, numbers, _ or -)')
  }

  const autoEat = config.autoEat
  autoEat.enabled = parseBool(autoEat.enabled, 'autoEat.enabled')
  autoEat.eatAtFood = numberInRange(autoEat.eatAtFood, 'autoEat.eatAtFood', { min: 0, max: 20 })
  autoEat.eatAtHealth = numberInRange(autoEat.eatAtHealth, 'autoEat.eatAtHealth', { min: 0, max: 20 })
  autoEat.cooldownMs = numberInRange(autoEat.cooldownMs, 'autoEat.cooldownMs', { min: 0, max: 600000 })
  autoEat.restoreHeldItem = parseBool(autoEat.restoreHeldItem, 'autoEat.restoreHeldItem')
  autoEat.exclude = stringArray(autoEat.exclude, 'autoEat.exclude')

  const sneak = config.sneak
  sneak.enabled = parseBool(sneak.enabled, 'sneak.enabled')
  sneak.watchdogMs = numberInRange(sneak.watchdogMs, 'sneak.watchdogMs', { min: 250, max: 60000 })

  const afk = config.afk
  afk.enabled = parseBool(afk.enabled, 'afk.enabled')
  afk.minIntervalMs = numberInRange(afk.minIntervalMs, 'afk.minIntervalMs', { min: 1000, max: 3600000 })
  afk.maxIntervalMs = numberInRange(afk.maxIntervalMs, 'afk.maxIntervalMs', { min: 1000, max: 3600000 })
  if (afk.maxIntervalMs < afk.minIntervalMs) {
    throw new ConfigError('afk.maxIntervalMs must be greater than or equal to afk.minIntervalMs')
  }
  for (const action of ['look', 'swing', 'jump', 'move']) {
    afk[action] = parseBool(afk[action], `afk.${action}`)
  }
  afk.chat = stringArray(afk.chat, 'afk.chat')
  afk.chatIntervalMs = numberInRange(afk.chatIntervalMs, 'afk.chatIntervalMs', { min: 0, max: 86400000 })

  const reconnect = config.reconnect
  reconnect.enabled = parseBool(reconnect.enabled, 'reconnect.enabled')
  reconnect.baseDelayMs = numberInRange(reconnect.baseDelayMs, 'reconnect.baseDelayMs', { min: 100, max: 600000 })
  reconnect.maxDelayMs = numberInRange(reconnect.maxDelayMs, 'reconnect.maxDelayMs', { min: 100, max: 3600000 })
  if (reconnect.maxDelayMs < reconnect.baseDelayMs) {
    throw new ConfigError('reconnect.maxDelayMs must be greater than or equal to reconnect.baseDelayMs')
  }
  reconnect.onKick = parseBool(reconnect.onKick, 'reconnect.onKick')
  reconnect.stopOnBan = parseBool(reconnect.stopOnBan, 'reconnect.stopOnBan')
  reconnect.stopOnVerification = parseBool(reconnect.stopOnVerification, 'reconnect.stopOnVerification')

  const consoleConfig = config.console
  consoleConfig.enabled = parseBool(consoleConfig.enabled, 'console.enabled')
  consoleConfig.chatPassthrough = parseBool(consoleConfig.chatPassthrough, 'console.chatPassthrough')

  return config
}

function readConfigFile (filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${filePath}: ${err.message}`)
  }
  raw = raw.replace(/^\uFEFF/, '')
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${filePath}: ${err.message}`)
  }
}

/**
 * Resolve config from defaults, a JSON file, environment variables and CLI flags.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
export function loadConfig (argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const { flags, help, version, printConfig } = parseCli(argv)
  if (help || version) {
    return { config: null, help, version, printConfig, configPath: null, warnings: [] }
  }

  let configPath = null
  if (flags.config !== undefined) {
    configPath = path.resolve(cwd, String(flags.config))
    if (!fs.existsSync(configPath)) throw new ConfigError(`Config file not found: ${configPath}`)
  } else if (env.SIFTBOT_CONFIG) {
    configPath = path.resolve(cwd, env.SIFTBOT_CONFIG)
    if (!fs.existsSync(configPath)) throw new ConfigError(`Config file not found: ${configPath}`)
  } else {
    const candidate = path.resolve(cwd, 'config.json')
    if (fs.existsSync(candidate)) configPath = candidate
  }

  const fileConfig = configPath ? readConfigFile(configPath) : {}
  if (!isPlainObject(fileConfig)) throw new ConfigError('Config file must contain a JSON object')

  const merged = deepMerge(
    deepMerge(deepMerge(defaultConfig(), fileConfig), fromEnv(env)),
    fromFlags(flags)
  )
  const config = normalizeConfig(merged)

  return { config, help, version, printConfig, configPath, warnings: [] }
}

export function redactConfig (config) {
  const copy = JSON.parse(JSON.stringify(config))
  const password = copy.password
  if (password) copy.password = '***'
  for (const entry of copy.startupCommands) {
    if (password) entry.command = entry.command.split(password).join('***')
    entry.command = entry.command.replace(/\$\{password\}/g, password ? '***' : '${password}')
  }
  return copy
}
