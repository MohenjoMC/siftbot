import { normalizeItemName } from '../util.js'

const CONTROL_KEYS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
const CONTAINER_BLOCKS = ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest']

/**
 * Per-bot API handed to a plugin factory. Everything registered through the
 * context (listeners, timers, console commands) is tracked and torn down on
 * unload or hot reload, so plugins cannot leak between sessions.
 *
 * Actions throw when the bot is not connected; plugins should call them from
 * `onSpawn` or guard with `ctx.connected`.
 */
export class PluginContext {
  constructor ({ name, runtime, bot, commands = null, logger, config }) {
    this.name = name
    this.runtime = runtime
    this.bot = bot
    this.commands = commands
    this.logger = logger
    this.config = config
    this.stopped = false
    this.listeners = []
    this.timers = new Set()
    this.registeredCommands = []
    this.prefix = `plugin:${name}`

    this.actions = {
      move: (direction, ms = 500) => this.move(direction, ms),
      stop: () => this.stopMovement(),
      jump: () => this.jump(),
      look: (yaw, pitch) => this.look(yaw, pitch),
      lookAtPlayer: (username, force = true) => this.lookAtPlayer(username, force),
      equip: name => this.equip(name),
      drop: (name, count = null) => this.drop(name, count)
    }

    this.inventory = {
      items: () => this.bot?.inventory?.items?.() ?? [],
      count: name => this.count(name),
      held: () => this.bot?.heldItem?.name ?? null
    }

    this.containers = {
      nearest: (maxDistance = 32) => this.readNearestContainer(maxDistance),
      read: (x, y, z) => this.readContainerAt(x, y, z)
    }
  }

  get connected () {
    return Boolean(this.bot?.entity) && !this.stopped
  }

  requireBot () {
    if (!this.connected) throw new Error(`plugin ${this.name}: bot is not connected`)
    return this.bot
  }

  chat (text) {
    this.requireBot().chat(String(text))
  }

  command (text) {
    this.chat(text.startsWith('/') ? text : `/${text}`)
  }

  log (...args) {
    this.logger.info(...args)
  }

  debug (...args) {
    this.logger.debug(...args)
  }

  warn (...args) {
    this.logger.warn(...args)
  }

  /** Listen on the bot; removed automatically on unload. */
  on (event, handler) {
    if (this.stopped) return this
    this.bot.on(event, handler)
    this.listeners.push([event, handler])
    return this
  }

  /** Repeat a callback; cleared automatically on unload. */
  every (ms, fn) {
    if (this.stopped) return this
    const timer = setInterval(() => {
      try {
        fn()
      } catch (err) {
        this.logger.error(`${this.prefix}: ${err.message}`)
      }
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
    return this
  }

  after (ms, fn) {
    if (this.stopped) return this
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      try {
        fn()
      } catch (err) {
        this.logger.error(`${this.prefix}: ${err.message}`)
      }
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
    return this
  }

  /** Register a console command, e.g. `.chest`. Removed on unload. */
  registerCommand (name, { usage, description, aliases = [], run }) {
    if (!this.commands) throw new Error(`plugin ${this.name}: console commands are not available`)
    const clean = String(name).replace(/^\./, '').toLowerCase()
    this.commands.registerExternal(clean, {
      usage: usage ?? `.${clean}`,
      description: description ?? `Plugin command from ${this.name}`,
      aliases,
      run: args => run(args, this)
    })
    this.registeredCommands.push(clean)
    return this
  }

  move (direction, ms = 500) {
    const bot = this.requireBot()
    const key = String(direction).toLowerCase()
    if (!CONTROL_KEYS.has(key)) throw new Error(`plugin ${this.name}: unknown direction "${direction}"`)
    bot.setControlState(key, true)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      try {
        if (this.runtime.bot === bot) bot.setControlState(key, false)
      } catch {
        // Disconnected.
      }
    }, Math.max(1, Math.min(Number(ms) || 500, 60000)))
    timer.unref?.()
    this.timers.add(timer)
  }

  stopMovement () {
    const bot = this.requireBot()
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try {
        bot.setControlState(key, false)
      } catch {
        // Ignore keys unsupported by this version.
      }
    }
  }

  jump () {
    const bot = this.requireBot()
    if (!bot.entity.onGround) throw new Error(`plugin ${this.name}: bot is not on the ground`)
    bot.setControlState('jump', true)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      try {
        bot.setControlState('jump', false)
      } catch {
        // Disconnected.
      }
    }, 220)
    timer.unref?.()
    this.timers.add(timer)
  }

  look (yaw, pitch) {
    const bot = this.requireBot()
    if (!Number.isFinite(Number(yaw)) || !Number.isFinite(Number(pitch))) {
      throw new Error(`plugin ${this.name}: yaw and pitch must be numbers (degrees)`)
    }
    return bot.look(Number(yaw) * Math.PI / 180, Number(pitch) * Math.PI / 180, true)
  }

  lookAtPlayer (username, force = true) {
    const bot = this.requireBot()
    const player = bot.players?.[username] ?? Object.values(bot.players ?? {})
      .find(candidate => candidate.username?.toLowerCase() === String(username).toLowerCase())
    if (!player?.entity) throw new Error(`plugin ${this.name}: player ${username} is not visible`)
    return bot.lookAt(player.entity.position.offset(0, player.entity.height ?? 1.6, 0), force)
  }

  findItem (query) {
    const wanted = normalizeItemName(query)
    const items = this.bot?.inventory?.items?.() ?? []
    let matches = items.filter(item => item.name === wanted)
    if (matches.length === 0) matches = items.filter(item => item.name.includes(wanted))
    if (matches.length === 0) throw new Error(`plugin ${this.name}: no "${query}" in inventory`)
    const names = [...new Set(matches.map(item => item.name))]
    if (names.length > 1) throw new Error(`plugin ${this.name}: ambiguous "${query}": ${names.join(', ')}`)
    return matches[0]
  }

  equip (query) {
    const bot = this.requireBot()
    return bot.equip(this.findItem(query), 'hand')
  }

  drop (query, count = null) {
    const bot = this.requireBot()
    const item = this.findItem(query)
    const amount = count == null ? item.count : Math.min(Math.max(1, Number(count)), item.count)
    return bot.toss(item.type, null, amount)
  }

  count (query) {
    const wanted = normalizeItemName(query)
    return (this.bot?.inventory?.items?.() ?? [])
      .filter(item => item.name === wanted)
      .reduce((total, item) => total + item.count, 0)
  }

  blockAt (x, y, z) {
    const bot = this.requireBot()
    const target = bot.entity.position.clone()
    target.set(Number(x), Number(y), Number(z))
    return bot.blockAt(target)
  }

  containerIds () {
    const ids = CONTAINER_BLOCKS
      .map(name => this.bot?.registry?.blocksByName?.[name]?.id)
      .filter(id => id != null)
    return ids.length > 0 ? ids : null
  }

  async readNearestContainer (maxDistance = 32) {
    const bot = this.requireBot()
    const matching = this.containerIds()
    if (!matching) throw new Error(`plugin ${this.name}: no container blocks in this version`)
    const block = bot.findBlock({ matching, maxDistance: Math.max(1, Number(maxDistance) || 32) })
    if (!block) return null
    return this.readContainerBlock(block)
  }

  async readContainerAt (x, y, z) {
    const block = this.blockAt(x, y, z)
    if (!block) throw new Error(`plugin ${this.name}: no block at ${x},${y},${z}`)
    if (!CONTAINER_BLOCKS.some(name => block.name === name || block.name?.endsWith(`_${name}`))) {
      throw new Error(`plugin ${this.name}: ${block.name} is not a container`)
    }
    return this.readContainerBlock(block)
  }

  async readContainerBlock (block) {
    const bot = this.requireBot()
    const container = await bot.openContainer(block)
    try {
      const items = (container.slots ?? [])
        .map((item, slot) => item
          ? { slot, name: item.name, count: item.count }
          : null)
        .filter(Boolean)
      return {
        block: { name: block.name, x: block.position.x, y: block.position.y, z: block.position.z },
        items
      }
    } finally {
      try {
        container.close()
      } catch {
        // The window may already be closed.
      }
    }
  }

  cleanup () {
    if (this.stopped) return
    this.stopped = true

    for (const [event, handler] of this.listeners) {
      try {
        this.bot?.removeListener(event, handler)
      } catch {
        // Bot already gone.
      }
    }
    this.listeners = []

    for (const timer of this.timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.timers.clear()

    if (this.commands) {
      for (const command of this.registeredCommands) {
        try {
          this.commands.unregisterCommand(command)
        } catch {
          // Command already replaced.
        }
      }
    }
    this.registeredCommands = []
  }
}
