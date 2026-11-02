import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SiftBot } from './bot.js'
import { BotCommands } from './commands.js'
import { Logger } from './logger.js'
import { CredentialStore } from './credentials.js'
import { defaultConfig, normalizeConfig } from './config.js'

const MAX_RECORDS = 800

function defaultLabel (config) {
  return config.username
}

function cleanLabel (label, config) {
  const clean = String(label ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 48)
  return clean || defaultLabel(config)
}

/**
 * Holds every bot instance, its runtime, console buffer and persisted config.
 * The TUI is a thin view over this manager.
 */
export class InstanceManager extends EventEmitter {
  constructor ({ file, credentialsFile = null, plugins = null }) {
    super()
    this.file = file
    this.instances = new Map()
    this.plugins = plugins
    this.credentials = new CredentialStore(
      credentialsFile ?? path.join(path.dirname(file), 'credentials.json')
    )
  }

  load () {
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || !Array.isArray(raw.instances)) {
        throw new Error(`${this.file} must contain an "instances" array`)
      }
      for (const entry of raw.instances) {
        try {
          const config = normalizeConfig(entry.config ?? {})
          const instance = this.createInstance({
            id: entry.id,
            label: entry.label,
            config
          })
          this.instances.set(instance.id, instance)
        } catch (err) {
          throw new Error(`invalid instance ${entry.id ?? '(no id)'}: ${err.message}`)
        }
      }
      return
    }

    // First run: adopt an existing single-bot config.json if there is one.
    const legacy = path.join(path.dirname(this.file), 'config.json')
    if (fs.existsSync(legacy)) {
      try {
        const config = normalizeConfig(JSON.parse(fs.readFileSync(legacy, 'utf8')))
        const instance = this.createInstance({ config, label: defaultLabel(config) })
        this.instances.set(instance.id, instance)
        this.save()
      } catch {
        // A broken legacy file should not stop the TUI from starting.
      }
    }
  }

  createInstance ({ id, label, config }) {
    return {
      id: id ?? randomUUID(),
      label: cleanLabel(label, config),
      config,
      runtime: null,
      commands: null,
      records: [],
      recordSeq: 0,
      fatal: null,
      startedAt: null,
      stopping: false,
      stopPromise: null,
      queue: Promise.resolve()
    }
  }

  save () {
    const payload = {
      version: 1,
      instances: [...this.instances.values()].map(instance => ({
        id: instance.id,
        label: instance.label,
        config: instance.config
      }))
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  list () {
    return [...this.instances.values()]
  }

  get (id) {
    return this.instances.get(id) ?? null
  }

  add ({ label, config }) {
    const normalized = normalizeConfig(config)
    const instance = this.createInstance({ label, config: normalized })
    this.instances.set(instance.id, instance)
    this.save()
    this.emit('change')
    return instance
  }

  update (id, { label, config }) {
    const instance = this.require(id)
    if (instance.runtime?.active) {
      throw new Error('Stop the bot before editing it')
    }
    const normalized = normalizeConfig(config)
    instance.config = normalized
    instance.label = cleanLabel(label, normalized)
    instance.fatal = null
    this.save()
    this.emit('change')
    return instance
  }

  async remove (id) {
    const instance = this.require(id)
    await this.stop(id)
    this.instances.delete(id)
    this.save()
    this.emit('change')
  }

  require (id) {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Unknown bot instance: ${id}`)
    return instance
  }

  pushRecord (instance, record) {
    const stored = { ...record, seq: ++instance.recordSeq }
    instance.records.push(stored)
    if (instance.records.length > MAX_RECORDS) {
      instance.records.splice(0, instance.records.length - MAX_RECORDS)
    }
    this.emit('record', instance, stored)
  }

  clearRecords (id) {
    const instance = this.require(id)
    instance.records = []
    this.emit('change')
  }

  start (id) {
    const instance = this.require(id)
    if (instance.runtime?.active) return instance

    if (instance.runtime && !instance.runtime.active) {
      instance.runtime = null
      instance.commands = null
    }

    instance.fatal = null
    instance.startedAt = Date.now()

    const logger = new Logger({
      level: instance.config.logLevel,
      sink: record => this.pushRecord(instance, record)
    })

    const runtime = new SiftBot(instance.config, logger, { credentials: this.credentials })
    const commands = new BotCommands({
      runtime,
      config: instance.config,
      logger,
      print: text => this.pushRecord(instance, {
        time: Date.now(),
        level: 'info',
        kind: 'output',
        text
      }),
      onQuit: () => this.stop(id)
    })

    instance.runtime = runtime
    instance.commands = commands

    this.plugins?.attachSession({ id, runtime, commands, logger })

    runtime.on('spawn', () => this.emit('change'))
    runtime.on('disconnect', () => this.emit('change'))
    runtime.on('fatal', message => {
      instance.fatal = message
      this.plugins?.detachSession(id)
      instance.runtime = null
      instance.commands = null
      instance.startedAt = null
      this.pushRecord(instance, {
        time: Date.now(),
        level: 'error',
        kind: 'system',
        text: `stopped: ${message}`
      })
      this.emit('change')
    })

    this.emit('change')
    runtime.start()
    return instance
  }

  async stop (id) {
    const instance = this.require(id)
    if (instance.stopping) return instance.stopPromise
    const runtime = instance.runtime
    if (!runtime) return

    instance.stopping = true
    instance.stopPromise = (async () => {
      try {
        await runtime.stop('stopped from siftbot ui')
      } catch {
        // Shutdown errors should not block the UI.
      } finally {
        this.plugins?.detachSession(id)
        instance.runtime = null
        instance.commands = null
        instance.stopping = false
        instance.startedAt = null
        instance.stopPromise = null
        this.emit('change')
      }
    })()

    this.emit('change')
    return instance.stopPromise
  }

  async restart (id) {
    await this.stop(id)
    this.start(id)
  }

  async stopAll () {
    await Promise.allSettled([...this.instances.keys()].map(id => this.stop(id)))
  }

  async send (id, line) {
    const instance = this.require(id)
    if (!instance.commands) throw new Error('Start this bot first')
    const commands = instance.commands
    instance.queue = instance.queue
      .then(() => commands.handleInput(line))
      .catch(err => {
        this.pushRecord(instance, {
          time: Date.now(),
          level: 'error',
          kind: 'output',
          text: err?.message ?? String(err)
        })
      })
    await instance.queue
  }

  statusOf (instance) {
    if (instance.stopping) return 'stopping'
    if (instance.fatal) return 'error'
    if (!instance.runtime) return 'offline'
    const status = instance.runtime.status()
    if (status.connected) return 'online'
    if (status.connecting) return 'connecting'
    if (status.reconnectInMs != null) return 'retrying'
    return 'offline'
  }

  details (instance) {
    if (instance.runtime) return instance.runtime.status()
    return {
      connected: false,
      username: instance.config.username,
      host: instance.config.host,
      port: instance.config.port,
      version: instance.config.version || 'auto',
      gameMode: null,
      dimension: null,
      health: null,
      food: null,
      saturation: null,
      position: null,
      ping: null,
      players: 0,
      heldItem: null,
      clientBrand: null,
      clientTickEnd: null,
      hasStoredPassword: this.credentials.has(instance.config.host, instance.config.username),
      sneak: false,
      autoEatEnabled: instance.config.autoEat.enabled,
      afkEnabled: instance.config.afk.enabled,
      nextAfkMs: null,
      eating: false,
      lastEaten: null,
      uptimeMs: 0,
      reconnectInMs: null,
      reconnectAttempt: 0
    }
  }
}
