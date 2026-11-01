#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { randomBytes } from 'node:crypto'
import { Logger } from './logger.js'
import { InstanceManager } from './instances.js'
import { EventHub } from './api/events.js'
import { WebhookService } from './api/webhooks.js'
import { ApiServer } from './api/server.js'
import { instanceSummary } from './api/serialize.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const USAGE = `siftbot api — HTTP(S) daemon for the Minecraft mod and other clients.

Usage:
  npm run api -- [options]
  node src/daemon.js [options]

Options:
      --host <host>              Bind address                  (default: 127.0.0.1)
      --port <port>              Port                          (default: 8787)
      --token <token>            API bearer token (min 16 chars)
      --instances <file>         Instance file                 (default: ./instances.json)
      --credentials <file>       Password store                (default: next to instances)
      --webhooks <file>          Webhook store                 (default: ./webhooks.json)
      --tls-cert <file>          PEM certificate for HTTPS
      --tls-key <file>           PEM private key for HTTPS
      --insecure-webhooks        Allow http:// webhooks to loopback only
      --start-all                Start every configured bot
      --show-token               Print the API token at startup
      --log-level <level>        debug, info, warn or error    (default: info)
  -h, --help                     Show this help
  -v, --version                  Show the siftbot version

Environment:
  SIFT_API_HOST, SIFT_API_PORT, SIFT_API_TOKEN, SIFT_API_INSTANCES,
  SIFT_API_CREDENTIALS, SIFT_API_WEBHOOKS, SIFT_API_TLS_CERT, SIFT_API_TLS_KEY,
  SIFT_API_INSECURE_WEBHOOKS, SIFT_API_START_ALL, SIFT_API_LOG_LEVEL

Without --token / SIFT_API_TOKEN a token is generated at api-token next to
the instance file and written with mode 0600. Read it with:

  cat api-token
`

function parseArgs (argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-h' || token === '--help') return { help: true }
    if (token === '-v' || token === '--version') return { version: true }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)

    const eq = token.indexOf('=')
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase()
    const booleanFlags = new Set(['insecure-webhooks', 'start-all', 'show-token'])
    const valueFlags = new Set([
      'host', 'port', 'token', 'instances', 'credentials', 'webhooks',
      'tls-cert', 'tls-key', 'log-level'
    ])
    if (!booleanFlags.has(name) && !valueFlags.has(name)) {
      throw new Error(`Unknown option: --${name}`)
    }
    if (booleanFlags.has(name)) {
      flags[name] = eq === -1 ? true : argv[i].slice(eq + 1) !== 'false'
      continue
    }
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1)
    if (value == null) throw new Error(`Missing value for --${name}`)
    flags[name] = value
  }
  return { flags }
}

function envBool (value) {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function resolveToken ({ token, instancesFile }) {
  if (token) return { token, source: '--token' }
  if (process.env.SIFT_API_TOKEN) {
    return { token: process.env.SIFT_API_TOKEN, source: 'SIFT_API_TOKEN' }
  }

  const file = path.join(path.dirname(path.resolve(instancesFile)), 'api-token')
  if (fs.existsSync(file)) {
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Best effort on platforms without chmod.
    }
    return { token: fs.readFileSync(file, 'utf8').trim(), source: file, file }
  }

  const generated = randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, generated + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort on platforms without chmod.
  }
  return { token: generated, source: file, file, generated: true }
}

async function main () {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`siftbot api: ${err.message}\n`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  if (parsed.help) {
    console.log(USAGE)
    return
  }
  if (parsed.version) {
    console.log(`siftbot ${pkg.version}`)
    return
  }

  const flags = parsed.flags
  const instancesFile = path.resolve(
    flags.instances ?? process.env.SIFT_API_INSTANCES ?? 'instances.json'
  )
  const webhooksFile = path.resolve(
    flags.webhooks ?? process.env.SIFT_API_WEBHOOKS ?? path.join(path.dirname(instancesFile), 'webhooks.json')
  )
  const credentialsFile = flags.credentials ?? process.env.SIFT_API_CREDENTIALS
    ? path.resolve(flags.credentials ?? process.env.SIFT_API_CREDENTIALS)
    : path.join(path.dirname(instancesFile), 'credentials.json')
  const host = flags.host ?? process.env.SIFT_API_HOST ?? '127.0.0.1'
  const port = Number(flags.port ?? process.env.SIFT_API_PORT ?? 8787)
  const logLevel = flags['log-level'] ?? process.env.SIFT_API_LOG_LEVEL ?? 'info'
  const startAll = flags['start-all'] === true || envBool(process.env.SIFT_API_START_ALL)
  const allowInsecureWebhooks = flags['insecure-webhooks'] === true ||
    envBool(process.env.SIFT_API_INSECURE_WEBHOOKS)

  let logger
  try {
    logger = new Logger({ level: logLevel })
  } catch (err) {
    console.error(`siftbot api: ${err.message}`)
    process.exitCode = 2
    return
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    logger.error(`invalid port: ${port}`)
    process.exitCode = 2
    return
  }

  let tls = null
  const certPath = flags['tls-cert'] ?? process.env.SIFT_API_TLS_CERT
  const keyPath = flags['tls-key'] ?? process.env.SIFT_API_TLS_KEY
  if (Boolean(certPath) !== Boolean(keyPath)) {
    logger.error('--tls-cert and --tls-key must be provided together')
    process.exitCode = 2
    return
  }
  if (certPath && keyPath) {
    try {
      tls = {
        cert: fs.readFileSync(path.resolve(certPath), 'utf8'),
        key: fs.readFileSync(path.resolve(keyPath), 'utf8')
      }
    } catch (err) {
      logger.error(`cannot read TLS material: ${err.message}`)
      process.exitCode = 2
      return
    }
  }

  const manager = new InstanceManager({ file: instancesFile, credentialsFile })
  try {
    manager.load()
  } catch (err) {
    logger.error(`cannot load instances: ${err.message}`)
    process.exitCode = 1
    return
  }

  const resolved = resolveToken({ token: flags.token, instancesFile })
  if (resolved.token.length < 16) {
    logger.error('API token must be at least 16 characters')
    process.exitCode = 2
    return
  }

  const hub = new EventHub({ manager })
  let webhooks
  try {
    webhooks = new WebhookService({
      file: webhooksFile,
      hub,
      logger,
      allowInsecure: allowInsecureWebhooks
    })
  } catch (err) {
    logger.error(`cannot load webhooks: ${err.message}`)
    hub.stop()
    process.exitCode = 1
    return
  }

  let server
  try {
    server = new ApiServer({
      manager,
      hub,
      webhooks,
      token: resolved.token,
      host,
      port,
      tls,
      logger,
      version: pkg.version
    })
  } catch (err) {
    logger.error(`cannot configure API: ${err.message}`)
    webhooks.stop()
    hub.stop()
    process.exitCode = 2
    return
  }

  let shuttingDown = false
  const shutdown = async code => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await server.stop()
      await manager.stopAll()
    } catch (err) {
      logger.error(`shutdown: ${err.message}`)
    } finally {
      webhooks.stop()
      hub.stop()
      setTimeout(() => process.exit(code), 50)
    }
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))
  process.on('uncaughtException', err => {
    logger.error(`uncaught exception: ${err?.stack ?? err}`)
    void shutdown(1)
  })
  process.on('unhandledRejection', err => {
    logger.error(`unhandled rejection: ${err?.stack ?? err}`)
  })

  hub.start()
  try {
    await server.start()
  } catch (err) {
    logger.error(`cannot start API: ${err.message}`)
    webhooks.stop()
    hub.stop()
    process.exitCode = 1
    return
  }

  logger.info(`siftbot api listening on ${server.url}`)
  logger.info(`instances: ${instancesFile}`)
  logger.info(`credentials: ${credentialsFile} (${manager.credentials.summary().length} saved)`)
  logger.info(`webhooks:  ${webhooksFile} (${webhooks.list().length})`)
  if (resolved.source === '--token' || resolved.source === 'SIFT_API_TOKEN') {
    logger.info(`token:     ${resolved.source}`)
  } else {
    logger.info(`token:     ${resolved.file}${resolved.generated ? ' (generated)' : ''}`)
  }
  if (flags['show-token'] === true) logger.info(`API token: ${resolved.token}`)
  if (!tls && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    logger.warn('API is plain HTTP on a non-loopback address; put it behind TLS or a trusted tunnel')
  }
  if (allowInsecureWebhooks) {
    logger.warn('insecure webhooks enabled: http:// is allowed only for loopback targets')
  }
  logger.info(`docs:      docs/API.md  ·  ${server.url}/api/v1`)

  if (startAll) {
    for (const instance of manager.list()) {
      try {
        manager.start(instance.id)
        hub.publish('instance.started', instanceSummary(manager, manager.require(instance.id)), {
          instanceId: instance.id
        })
        logger.info(`started ${instance.label}`)
      } catch (err) {
        logger.error(`could not start ${instance.label}: ${err.message}`)
      }
    }
  }
}

main().catch(err => {
  console.error(`siftbot api: ${err?.stack ?? err}`)
  process.exit(1)
})
