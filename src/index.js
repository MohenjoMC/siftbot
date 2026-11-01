#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { ConfigError, USAGE, loadConfig, redactConfig } from './config.js'
import { CredentialStore } from './credentials.js'
import { Logger } from './logger.js'
import { SiftBot } from './bot.js'
import { LiveConsole } from './console.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

async function main () {
  let loaded
  try {
    loaded = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`siftbot: ${err.message}\n`)
      console.error(USAGE)
      process.exitCode = 2
      return
    }
    throw err
  }

  const { config, help, version, printConfig, configPath } = loaded

  if (help) {
    console.log(USAGE)
    return
  }
  if (version) {
    console.log(`siftbot ${pkg.version}`)
    return
  }
  if (printConfig) {
    console.log(JSON.stringify(redactConfig(config), null, 2))
    return
  }

  const logger = new Logger({ level: config.logLevel })
  if (configPath) logger.debug(`config: ${configPath}`)
  logger.info(`siftbot ${pkg.version} · ${config.host}:${config.port} as ${config.username}`)
  logger.info(
    `features: autoeat ${config.autoEat.enabled ? 'on' : 'off'} · ` +
    `sneak ${config.sneak.enabled ? 'held' : 'off'} · ` +
    `afk ${config.afk.enabled ? 'on' : 'off'} · ` +
    `client ${config.client.enabled ? 'on' : 'off'} · ` +
    `console ${config.console.enabled ? 'on' : 'off'}`
  )

  const runtime = new SiftBot(config, logger, {
    credentials: new CredentialStore(process.env.SIFTBOT_CREDENTIALS || 'credentials.json')
  })

  let shuttingDown = false

  const shutdown = async (code = 0, message = null) => {
    if (shuttingDown) return
    shuttingDown = true
    if (message) logger.info(message)
    try {
      await runtime.stop()
    } catch (err) {
      logger.error(`shutdown: ${err.message}`)
    }
    live.stop()
    process.exitCode = code
    setTimeout(() => process.exit(code), 100)
  }

  const live = new LiveConsole({
    runtime,
    config,
    logger,
    onQuit: () => shutdown(0)
  })

  runtime.on('fatal', message => {
    logger.error(`stopping: ${message}`)
    void shutdown(1)
  })

  process.on('SIGINT', () => void shutdown(0, 'received SIGINT'))
  process.on('SIGTERM', () => void shutdown(0, 'received SIGTERM'))
  process.on('unhandledRejection', err => {
    logger.error(`unhandled rejection: ${err?.stack ?? err}`)
  })
  process.on('uncaughtException', err => {
    logger.error(`uncaught exception: ${err?.stack ?? err}`)
    void shutdown(1)
  })

  live.start()
  runtime.start()
}

void main()
