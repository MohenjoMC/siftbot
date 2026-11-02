import { EventEmitter } from 'node:events'
import mineflayer from 'mineflayer'
import { AutoEat } from './features/auto-eat.js'
import { AfkController } from './features/afk.js'
import { AutoLogin } from './features/auth.js'
import { ClientIdentity, viewDistanceChunks } from './features/client-identity.js'
import { SneakKeeper } from './features/sneak.js'
import { parseProxy, socks5Client } from './socks5.js'
import { chatComponentToText, formatCoords, isVerificationKick, sleep } from './util.js'

const BAN_PATTERN = /banned|blacklist|whitelist|suspended/i
const AUTH_PATTERN = /auth|credential|token|profile|msa/i

/**
 * Owns the mineflayer connection, its reconnect loop and the feature set for
 * the current session. The console reads live state from here.
 */
export class SiftBot extends EventEmitter {
  constructor (config, logger, { credentials = null } = {}) {
    super()
    this.config = config
    this.logger = logger
    this.credentials = credentials
    this.bot = null
    this.session = null
    this.connecting = false
    this.stopping = false
    this.forceReconnect = false
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.nextReconnectAt = null
    this.transferTarget = null
    this.startedAt = null
  }

  start () {
    if (this.startedAt) return
    this.startedAt = Date.now()
    this.connect()
  }

  connect () {
    if (this.stopping || this.connecting || this.bot) return
    this.connecting = true
    this.nextReconnectAt = null

    const { config, logger } = this
    const transfer = this.transferTarget
    this.transferTarget = null
    const host = transfer?.host ?? config.host
    const port = transfer?.port ?? config.port
    if (transfer) logger.info(`following server transfer to ${host}:${port}`)
    logger.info(
      `connecting to ${host}:${port} as ${config.username} ` +
      `(${config.auth}${config.version ? `, ${config.version}` : ', auto version'})`
    )

    let bot
    try {
      const options = {
        host,
        port,
        username: config.username,
        auth: config.auth,
        version: config.version || false,
        respawn: true,
        hideErrors: false,
        logErrors: false,
        viewDistance: config.client.viewDistance,
        locale: config.client.locale,
        brand: config.client.brand,
        // Keep the configuration-state settings packet (1.20.2+, written by
        // minecraft-protocol) identical to the play-state one mineflayer sends
        // on login — the values below are vanilla's. docs/research/client-spoofing.md §2.
        clientSettings: {
          locale: config.client.locale,
          viewDistance: viewDistanceChunks(config.client.viewDistance),
          chatFlags: 0,
          chatColors: true,
          skinParts: 127,
          mainHand: 1,
          enableTextFiltering: false,
          enableServerListing: true
        }
      }

      // Optional SOCKS5 egress (e.g. Tor) so tests never use the local public
      // address. Set SIFTBOT_SOCKS=127.0.0.1:9050. When proxying, point host and
      // port at the SRV target explicitly: the SRV lookup is a local DNS query.
      const proxy = parseProxy(process.env.SIFTBOT_SOCKS)
      if (proxy) {
        logger.info(`routing through SOCKS5 proxy ${proxy.host}:${proxy.port}`)
        options.connect = socks5Client(options, proxy)
      }

      bot = mineflayer.createBot(options)
    } catch (err) {
      this.connecting = false
      const message = err?.message ?? String(err)
      logger.error(`could not create bot: ${message}`)
      if (/version|protocol/i.test(message)) {
        this.emit('fatal', `unsupported Minecraft version: ${message}`)
      } else {
        this.scheduleReconnect()
      }
      return
    }

    const session = {
      bot,
      connectedAt: Date.now(),
      spawns: 0,
      startupRan: false,
      kicked: false,
      kickReason: null,
      fatal: false,
      closed: false,
      ended: false,
      stableTimer: null,
      identity: null,
      auth: null,
      autoEat: null,
      afk: null,
      sneak: null
    }

    this.bot = bot
    this.session = session
    this.connecting = false

    session.identity = new ClientIdentity(bot, config.client, logger)
    session.auth = new AutoLogin(bot, config, logger, { credentials: this.credentials })
    session.autoEat = new AutoEat(bot, config.autoEat, logger)
    session.afk = new AfkController(bot, config.afk, logger, {
      isBusy: () => session.autoEat.eating
    })
    session.sneak = new SneakKeeper(bot, config.sneak, logger)

    // Announce the session to plugins once mineflayer has injected its plugins,
    // so they receive a bot with chat, inventory and world helpers available.
    const announceSession = () => {
      if (this.session === session) this.emit('session', bot)
    }
    if (typeof bot.chat === 'function') announceSession()
    else bot.once('inject_allowed', announceSession)

    bot.on('onMsaCode', data => {
      logger.info(
        `Microsoft login: open ${data.verification_uri ?? 'https://microsoft.com/link'} ` +
        `and enter code ${data.user_code ?? data.code ?? '?'}`
      )
    })

    bot.once('login', () => {
      logger.info(`logged in as ${bot.username} on ${bot.version}`)
      this.emit('login', bot)
    })

    bot.on('spawn', () => this.onSpawn(session))

    bot.on('chat', (username, message) => {
      if (username === bot.username) {
        logger.ownChat(message)
        return
      }
      logger.chat(username, message)
    })

    bot.on('whisper', (username, message) => {
      if (username === bot.username) return
      logger.whisper(username, message)
    })

    bot.on('message', (message, position) => {
      if (position !== 'system') return
      try {
        const text = message?.toString?.().trim()
        if (text) logger.system(text)
      } catch {
        // Malformed chat component from the server; not worth crashing over.
      }
    })

    bot.on('playerJoined', player => logger.debug(`+ ${player.username}`))
    bot.on('playerLeft', player => logger.debug(`- ${player.username}`))

    bot.on('windowOpen', window => this.emit('window', window))
    bot.on('windowClose', () => this.emit('window', null))

    bot.on('death', () => {
      logger.warn(`died at ${formatCoords(bot.entity?.position)}; respawning`)
    })

    bot.on('kicked', reason => {
      const text = chatComponentToText(reason).replace(/\s+/g, ' ').trim()
      session.kicked = true
      session.kickReason = text
      logger.warn(`kicked: ${text}`)
    })

    let lastErrorAt = 0
    let lastErrorMessage = ''
    bot.on('error', err => {
      const message = err?.message ?? String(err)
      const now = Date.now()
      if (message === lastErrorMessage && now - lastErrorAt < 2000) return
      lastErrorAt = now
      lastErrorMessage = message

      logger.error(`connection error: ${message}`)
      if (!session.spawns && config.auth === 'microsoft' && AUTH_PATTERN.test(message)) {
        session.fatal = true
        logger.error('authentication failed; fix the Microsoft login and restart')
      }
    })

    bot.once('end', reason => this.onEnd(session, reason))
  }

  onSpawn (session) {
    if (this.session !== session) return
    session.spawns += 1
    const bot = session.bot
    const dimension = bot.game?.dimension ?? 'unknown'
    if (session.spawns === 1) {
      this.logger.info(`spawned in ${dimension} at ${formatCoords(bot.entity?.position)}`)
    } else {
      this.logger.info(`respawned in ${dimension} at ${formatCoords(bot.entity?.position)}`)
    }

    clearTimeout(session.stableTimer)
    session.stableTimer = setTimeout(() => {
      if (this.session === session) {
        this.reconnectAttempt = 0
        this.logger.debug('connection stable; reconnect backoff reset')
      }
    }, 60000)
    session.stableTimer.unref?.()

    if (!session.startupRan) {
      session.startupRan = true
      void this.runStartupCommands(session)
    }

    this.emit('spawn', bot)
  }

  async runStartupCommands (session) {
    const commands = this.config.startupCommands
    if (commands.length === 0) return

    for (const { command, delayMs } of commands) {
      if (delayMs > 0) await sleep(delayMs)
      if (this.session !== session || session.closed) return

      const text = command
        .replace(/\$\{password\}/g, this.config.password ?? '')
        .replace(/\$\{username\}/g, this.config.username ?? '')

      try {
        session.bot.chat(text)
        this.logger.info(`startup command sent: ${this.redact(text)}`)
      } catch (err) {
        this.logger.warn(`startup command failed: ${err.message}`)
      }
    }
  }

  redact (text) {
    const password = this.config.password
    if (!password) return text
    return text.split(password).join('***')
  }

  onEnd (session, reason) {
    if (this.session !== session) return

    session.ended = true
    this.teardownSession(session)
    this.bot = null
    this.session = null

    const transferTarget = session.identity?.transferTarget
    const detail = session.kickReason ?? (reason ? chatComponentToText(reason) : 'connection closed')
    if (!this.stopping && !session.kickReason && !transferTarget) {
      this.logger.warn(`disconnected: ${detail}`)
    }
    this.emit('disconnect', detail)

    if (this.stopping) return

    if (transferTarget) {
      this.transferTarget = transferTarget
      this.reconnectAttempt = 0
      this.scheduleReconnect(250)
      return
    }

    if (session.fatal) {
      this.emit('fatal', session.kickReason ?? 'authentication failed')
      return
    }

    if (session.kicked &&
      this.config.reconnect.stopOnVerification &&
      isVerificationKick(session.kickReason)) {
      const message = `server requires manual verification: ${session.kickReason}`
      this.logger.error(message)
      this.logger.error('not reconnecting automatically; complete the server verification with a normal client or ask staff to allow the bot')
      this.emit('fatal', message)
      return
    }

    if (session.kicked && this.config.reconnect.stopOnBan && BAN_PATTERN.test(session.kickReason ?? '')) {
      const message = `server rejected the bot (${session.kickReason}); not reconnecting`
      this.logger.error(message)
      this.emit('fatal', message)
      return
    }

    if (!this.config.reconnect.enabled) {
      this.logger.warn('reconnect is disabled; bot is offline')
      return
    }

    if (session.kicked && !this.config.reconnect.onKick) {
      this.logger.warn('kicked; reconnect.onKick is false, staying offline')
      return
    }

    if (this.forceReconnect) {
      this.forceReconnect = false
      this.reconnectAttempt = 0
      this.scheduleReconnect(250)
      return
    }

    this.scheduleReconnect()
  }

  scheduleReconnect (explicitDelay = null) {
    if (this.stopping) return
    if (!this.config.reconnect.enabled) return

    const { baseDelayMs, maxDelayMs } = this.config.reconnect
    let delay
    if (explicitDelay != null) {
      delay = explicitDelay
    } else {
      const exponential = Math.min(baseDelayMs * 2 ** this.reconnectAttempt, maxDelayMs)
      const jitter = 0.8 + Math.random() * 0.4
      delay = Math.round(Math.min(Math.max(exponential * jitter, 500), maxDelayMs))
      this.reconnectAttempt += 1
    }

    clearTimeout(this.reconnectTimer)
    this.nextReconnectAt = Date.now() + delay
    this.logger.info(
      `reconnecting in ${(delay / 1000).toFixed(1)}s ` +
      `(attempt ${Math.max(1, this.reconnectAttempt)})`
    )
    // Keep this timer referenced: with --no-console it is the only thing that
    // keeps the process alive while waiting to reconnect.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.nextReconnectAt = null
      this.connect()
    }, delay)
  }

  reconnectNow () {
    if (this.stopping) throw new Error('Bot is shutting down')
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.nextReconnectAt = null
    this.reconnectAttempt = 0

    if (!this.bot) {
      this.connect()
      return
    }

    const session = this.session
    if (session) this.teardownSession(session)
    this.forceReconnect = true
    try {
      this.bot.quit('siftbot reconnecting')
    } catch {
      // The end handler still schedules the reconnect.
    }
  }

  teardownSession (session) {
    if (!session || session.closed) return
    session.closed = true
    clearTimeout(session.stableTimer)
    for (const feature of [session.auth, session.identity, session.autoEat, session.afk, session.sneak]) {
      try {
        feature?.stop()
      } catch (err) {
        this.logger.debug(`feature teardown: ${err.message}`)
      }
    }
  }

  async stop (reason = 'siftbot shutting down') {
    if (this.stopping) return
    this.stopping = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.nextReconnectAt = null

    const session = this.session
    if (session) {
      let ended = null
      if (!session.ended) {
        ended = new Promise(resolve => {
          const timer = setTimeout(resolve, 3000)
          timer.unref?.()
          session.bot.once('end', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }

      this.teardownSession(session)
      if (!session.ended) {
        try {
          session.bot.quit(reason)
        } catch {
          // Ignore; the socket may already be gone.
        }
      }
      if (ended) await ended
    }

    this.bot = null
    this.session = null
    this.emit('stopped')
  }

  get connected () {
    return Boolean(this.bot?.entity)
  }

  /** True while connected, connecting, or waiting to reconnect. */
  get active () {
    return Boolean(this.bot || this.connecting || this.reconnectTimer)
  }

  status () {
    const bot = this.bot
    const session = this.session
    return {
      connected: this.connected,
      connecting: this.connecting,
      username: bot?.username ?? this.config.username,
      host: this.config.host,
      port: this.config.port,
      version: bot?.version ?? (this.config.version || 'auto'),
      gameMode: bot?.game?.gameMode ?? null,
      dimension: bot?.game?.dimension ?? null,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      saturation: bot?.foodSaturation ?? null,
      position: bot?.entity?.position ?? null,
      ping: bot?.player?.ping ?? null,
      players: bot?.players ? Object.keys(bot.players).length : 0,
      heldItem: bot?.heldItem?.name ?? null,
      clientBrand: session?.identity?.brand ?? null,
      clientTickEnd: session?.identity?.hasTickEnd ?? null,
      hasStoredPassword: this.credentials
        ? this.credentials.has(this.config.host, this.config.username)
        : Boolean(this.config.password),
      sneak: session?.sneak?.held ?? false,
      autoEatEnabled: session?.autoEat?.enabled ?? this.config.autoEat.enabled,
      afkEnabled: session?.afk?.enabled ?? this.config.afk.enabled,
      nextAfkMs: session?.afk?.nextRunIn?.() ?? null,
      eating: session?.autoEat?.eating ?? false,
      lastEaten: session?.autoEat?.lastEaten ?? null,
      uptimeMs: session ? Date.now() - session.connectedAt : 0,
      reconnectInMs: this.nextReconnectAt == null
        ? null
        : Math.max(0, this.nextReconnectAt - Date.now()),
      reconnectAttempt: this.reconnectAttempt
    }
  }
}
