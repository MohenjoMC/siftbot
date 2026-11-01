import { parseInput } from './parse-input.js'
import {
  formatCoords,
  formatDuration,
  normalizeItemName,
  randomInt
} from './util.js'

const MOVEMENT_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint']

export class BotCommands {
  constructor ({ runtime, config, logger, print = null, onQuit = null }) {
    this.runtime = runtime
    this.config = config
    this.logger = logger
    this.print = print ?? (text => this.logger.raw(text))
    this.onQuit = onQuit
    this.closing = false
    this.commands = new Map()
    this.commandList = []

    this.registerCommands()
  }

  async handleInput (line) {
    const parsed = parseInput(line)
    if (!parsed) return

    try {
      if (parsed.type === 'command') {
        await this.runCommand(parsed)
      } else if (parsed.type === 'server') {
        const bot = this.requireBot()
        bot.chat(parsed.raw)
      } else {
        this.sendChat(parsed.text)
      }
    } catch (err) {
      this.logger.error(err?.message ?? String(err))
      if (this.logger.level === 'debug' && err?.stack) this.print(err.stack)
    }
  }

  sendChat (text) {
    if (!this.config.console.chatPassthrough) {
      throw new Error('Chat passthrough is off; use .say <text>')
    }
    const bot = this.requireBot()
    bot.chat(text)
  }

  requireBot () {
    const bot = this.runtime.bot
    if (!bot || !bot.entity) throw new Error('Bot is not connected')
    return bot
  }

  requireSession () {
    const session = this.runtime.session
    if (!session || !this.runtime.bot?.entity) throw new Error('Bot is not connected')
    return session
  }

  assertNoWindow (bot) {
    if (bot.currentWindow) throw new Error('Close the open container first')
  }

  async runCommand ({ name, args }) {
    const command = this.commands.get(name)
    if (!command) {
      throw new Error(`Unknown command .${name} — try .help`)
    }
    await command.run(args)
  }

  register (name, { usage, description, run, aliases = [] }) {
    const command = { name, usage, description, run }
    this.commands.set(name, command)
    for (const alias of aliases) this.commands.set(alias, command)
    this.commandList.push(command)
  }

  registerCommands () {
    this.register('help', {
      usage: '.help [command]',
      description: 'Show commands or details for one command',
      run: args => this.showHelp(args[0])
    })

    this.register('status', {
      usage: '.status',
      description: 'Health, hunger, position, connection and feature state',
      run: () => this.showStatus(),
      aliases: ['stat', 'info']
    })

    this.register('say', {
      usage: '.say <text>',
      description: 'Send a chat message',
      run: args => {
        const text = args.join(' ').trim()
        if (!text) throw new Error('Usage: .say <text>')
        this.requireBot().chat(text)
      },
      aliases: ['chat']
    })

    this.register('msg', {
      usage: '.msg <player> <text>',
      description: 'Whisper a player',
      run: args => {
        if (args.length < 2) throw new Error('Usage: .msg <player> <text>')
        const [player, ...rest] = args
        this.requireBot().whisper(player, rest.join(' '))
      },
      aliases: ['w', 'whisper']
    })

    this.register('players', {
      usage: '.players',
      description: 'List online players and ping',
      run: () => this.showPlayers(),
      aliases: ['who']
    })

    this.register('inventory', {
      usage: '.inventory [filter]',
      description: 'List carried items, optionally filtered',
      run: args => this.showInventory(args[0]),
      aliases: ['inv']
    })

    this.register('eat', {
      usage: '.eat [food]',
      description: 'Eat now, optionally a specific food',
      run: async args => {
        const session = this.requireSession()
        await session.autoEat.eat({ force: true, itemName: args[0] ?? null })
      }
    })

    this.register('autoeat', {
      usage: '.autoeat [on|off|status]',
      description: 'Control automatic eating',
      run: args => this.controlAutoEat(args[0])
    })

    this.register('hold', {
      usage: '.hold <item>',
      description: 'Equip an item in the main hand',
      run: async args => {
        if (!args[0]) throw new Error('Usage: .hold <item>')
        const bot = this.requireBot()
        this.assertNoWindow(bot)
        const item = this.findItem(bot, args[0])
        await bot.equip(item, 'hand')
        this.print(`holding ${bot.heldItem?.name ?? item.name}`)
      },
      aliases: ['equip']
    })

    this.register('drop', {
      usage: '.drop <item> [count]',
      description: 'Drop an item (all of it by default)',
      run: async args => {
        if (!args[0]) throw new Error('Usage: .drop <item> [count]')
        const bot = this.requireBot()
        this.assertNoWindow(bot)
        const item = this.findItem(bot, args[0])
        let count = item.count
        if (args[1] !== undefined) {
          count = Number(args[1])
          if (!Number.isInteger(count) || count < 1) throw new Error('Count must be a positive integer')
          count = Math.min(count, item.count)
        }
        await bot.toss(item.type, null, count)
        this.print(`dropped ${count} ${item.name}`)
      },
      aliases: ['toss']
    })

    this.register('sneak', {
      usage: '.sneak [on|off|status|toggle]',
      description: 'Control the held shift / sneak key',
      run: args => this.controlSneak(args[0]),
      aliases: ['shift']
    })

    this.register('afk', {
      usage: '.afk [on|off|status|now]',
      description: 'Control anti-AFK activity, or trigger an action now',
      run: args => this.controlAfk(args[0])
    })

    this.register('look', {
      usage: '.look <yaw°> <pitch°> | .look at <player>',
      description: 'Turn the bot, or look at a player',
      run: async args => {
        const bot = this.requireBot()
        if (args[0]?.toLowerCase() === 'at') {
          const name = args[1]
          if (!name) throw new Error('Usage: .look at <player>')
          const player = bot.players[name] ?? Object.values(bot.players)
            .find(candidate => candidate.username?.toLowerCase() === name.toLowerCase())
          if (!player?.entity) throw new Error(`Player ${name} is not visible`)
          await bot.lookAt(player.entity.position.offset(0, player.entity.height ?? 1.6, 0), true)
          this.print(`looking at ${player.username}`)
          return
        }

        if (args.length < 2) throw new Error('Usage: .look <yaw°> <pitch°> or .look at <player>')
        const yaw = Number(args[0])
        const pitch = Number(args[1])
        if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
          throw new Error('Yaw and pitch must be numbers')
        }
        await bot.look(yaw * Math.PI / 180, pitch * Math.PI / 180, true)
        this.print(`yaw ${yaw}° pitch ${pitch}°`)
      }
    })

    this.register('move', {
      usage: '.move <forward|back|left|right|jump> [ms]',
      description: 'Hold a movement key for a moment',
      run: args => this.move(args),
      aliases: ['walk']
    })

    this.register('stop', {
      usage: '.stop',
      description: 'Release all movement keys (sneak stays held)',
      run: () => {
        const bot = this.requireBot()
        for (const key of MOVEMENT_KEYS) {
          try {
            bot.setControlState(key, false)
          } catch {
            // Ignore keys unsupported by this version.
          }
        }
        this.print('movement stopped')
      }
    })

    this.register('jump', {
      usage: '.jump',
      description: 'Jump once',
      run: () => this.jump()
    })

    this.register('respawn', {
      usage: '.respawn',
      description: 'Ask the server to respawn',
      run: () => {
        const bot = this.requireBot()
        bot.respawn()
        this.print('respawn requested')
      }
    })

    this.register('reconnect', {
      usage: '.reconnect',
      description: 'Drop the connection and reconnect immediately',
      run: () => {
        this.runtime.reconnectNow()
        this.print('reconnecting…')
      },
      aliases: ['rc']
    })

    this.register('credentials', {
      usage: '.credentials',
      description: 'Show whether a password is saved for this account',
      run: () => {
        const status = this.runtime.status()
        if (status.hasStoredPassword) {
          this.print(`password saved for ${status.username}@${status.host}`)
        } else {
          this.print(`no password saved for ${status.username}@${status.host} — use /register, or edit the credentials file`)
        }
      },
      aliases: ['pass']
    })

    this.register('login', {
      usage: '.login',
      description: 'Run /login now with the saved password',
      run: () => {
        const bot = this.runtime.bot
        const auth = this.runtime.session?.auth
        if (!bot) throw new Error('Bot is not connected')
        const password = auth?.storedPassword?.()
        if (!password) throw new Error('No password saved for this bot')
        bot.chat(`/login ${password}`)
        this.print('login command sent')
      }
    })

    this.register('log', {
      usage: '.log <debug|info|warn|error>',
      description: 'Change the console log level',
      run: args => {
        if (!args[0]) {
          this.print(`log level: ${this.logger.level}`)
          return
        }
        this.logger.setLevel(args[0])
        this.print(`log level: ${this.logger.level}`)
      }
    })

    this.register('quit', {
      usage: '.quit',
      description: 'Disconnect this bot',
      run: () => this.quit(),
      aliases: ['exit']
    })
  }

  showHelp (query) {
    if (query) {
      const command = this.commands.get(query.replace(/^\./, '').toLowerCase())
      if (!command) throw new Error(`Unknown command .${query}`)
      this.print(`${command.usage}\n  ${command.description}`)
      return
    }

    this.print('Commands:')
    const rows = this.commandList
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(command => [command.usage, command.description])
    const width = Math.max(...rows.map(row => row[0].length))
    for (const [usage, description] of rows) {
      this.print(`  ${usage.padEnd(width)}  ${description}`)
    }
    this.print('')
    this.print('Raw input: /command sends a server command, anything else sends chat.')
  }

  showStatus () {
    const status = this.runtime.status()
    const lines = []
    const put = (label, value) => lines.push(`${label.padEnd(9)} ${value}`)

    if (!status.connected) {
      put('state', status.connecting ? 'connecting…' : 'offline')
      put('server', `${status.host}:${status.port}`)
      if (status.reconnectInMs != null) {
        put('retry', `${formatDuration(status.reconnectInMs)} (attempt ${Math.max(1, status.reconnectAttempt)})`)
      }
    } else {
      put('state', `connected · ${status.gameMode ?? '?'} · ${status.version}`)
      put('server', `${status.host}:${status.port}`)
      put('health', `${this.fmt(status.health)}/20`)
      put('food', `${this.fmt(status.food)}/20 (sat ${this.fmt(status.saturation)})`)
      put('position', `${formatCoords(status.position)} · ${this.dimension(status.dimension)}`)
      put('held', status.heldItem ?? 'empty')
      if (status.clientBrand) {
        put('client', `${status.clientBrand}${status.clientTickEnd ? ' · tick_end' : ''}`)
      }
      put('players', `${status.players} online${Number.isFinite(status.ping) ? ` · ping ${status.ping}ms` : ''}`)
      put('features', this.featureLine(status))
      put('uptime', formatDuration(status.uptimeMs))
    }

    this.print(lines.join('\n'))
  }

  featureLine (status) {
    const parts = [
      `autoeat ${status.autoEatEnabled ? 'on' : 'off'}`,
      `sneak ${status.sneak ? 'held' : 'released'}`,
      `afk ${status.afkEnabled ? 'on' : 'off'}`
    ]
    if (status.afkEnabled && status.nextAfkMs != null) {
      parts.push(`next in ${formatDuration(status.nextAfkMs)}`)
    }
    if (status.eating) parts.push('eating')
    return parts.join(' · ')
  }

  dimension (dimension) {
    return dimension ? String(dimension).replace(/^minecraft:/, '') : 'unknown'
  }

  fmt (value) {
    return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '—'
  }

  showPlayers () {
    const bot = this.requireBot()
    const players = Object.values(bot.players)
      .map(player => ({
        name: player.username,
        ping: player.ping,
        self: player.username === bot.username
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    if (players.length === 0) {
      this.print('no players tracked')
      return
    }
    this.print(players
      .map(player => `${player.name}${player.self ? ' (you)' : ''}${Number.isFinite(player.ping) ? ` — ${player.ping}ms` : ''}`)
      .join('\n'))
  }

  showInventory (filter) {
    const bot = this.requireBot()
    const items = bot.inventory.items()
    if (items.length === 0) {
      this.print('inventory is empty')
      return
    }

    const needle = filter ? normalizeItemName(filter) : null
    const counts = new Map()
    for (const item of items) {
      if (needle && !item.name.includes(needle)) continue
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
    }

    if (counts.size === 0) {
      this.print(`no items matching "${filter}"`)
      return
    }

    const held = bot.heldItem?.name
    const lines = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}${name === held ? ' (held)' : ''} × ${count}`)
    this.print(lines.join('\n'))
  }

  findItem (bot, query) {
    const wanted = normalizeItemName(query)
    const items = bot.inventory.items()
    let matches = items.filter(item => item.name === wanted)
    if (matches.length === 0) matches = items.filter(item => item.name.includes(wanted))
    if (matches.length === 0) throw new Error(`No "${query}" in inventory`)

    const names = [...new Set(matches.map(item => item.name))]
    if (names.length > 1) throw new Error(`Ambiguous "${query}": ${names.join(', ')}`)
    return matches[0]
  }

  controlSneak (arg = 'status') {
    const session = this.requireSession()
    const action = arg.toLowerCase()

    if (action === 'toggle') {
      const enabled = session.sneak.setEnabled(!session.sneak.enabled)
      this.print(`sneak ${enabled ? 'held' : 'released'}`)
      return
    }
    if (['on', 'true', '1'].includes(action)) {
      session.sneak.setEnabled(true)
      this.print('sneak held')
      return
    }
    if (['off', 'false', '0'].includes(action)) {
      session.sneak.setEnabled(false)
      this.print('sneak released')
      return
    }
    if (action !== 'status') throw new Error('Usage: .sneak [on|off|status|toggle]')
    this.print(`sneak ${session.sneak.held ? 'held' : 'released'} (feature ${session.sneak.enabled ? 'on' : 'off'})`)
  }

  controlAutoEat (arg = 'status') {
    const session = this.requireSession()
    const action = (arg ?? 'status').toLowerCase()

    if (action === 'toggle') {
      const enabled = session.autoEat.setEnabled(!session.autoEat.enabled)
      this.print(`autoeat ${enabled ? 'on' : 'off'}`)
      return
    }
    if (['on', 'true', '1'].includes(action)) {
      session.autoEat.setEnabled(true)
      this.print('autoeat on')
      return
    }
    if (['off', 'false', '0'].includes(action)) {
      session.autoEat.setEnabled(false)
      this.print('autoeat off')
      return
    }
    if (action !== 'status') throw new Error('Usage: .autoeat [on|off|status]')
    this.print(`autoeat ${session.autoEat.enabled ? 'on' : 'off'}`)
  }

  async controlAfk (arg = 'status') {
    const session = this.requireSession()
    const action = (arg ?? 'status').toLowerCase()

    if (action === 'now') {
      const actions = await session.afk.tick({ force: true })
      this.print(actions.length > 0 ? `afk: ${actions.join(' + ')}` : 'afk: nothing done (not spawned?)')
      return
    }
    if (action === 'toggle') {
      const enabled = session.afk.setEnabled(!session.afk.enabled)
      this.print(`afk ${enabled ? 'on' : 'off'}`)
      return
    }
    if (['on', 'true', '1'].includes(action)) {
      session.afk.setEnabled(true)
      this.print('afk on')
      return
    }
    if (['off', 'false', '0'].includes(action)) {
      session.afk.setEnabled(false)
      this.print('afk off')
      return
    }
    if (action !== 'status') throw new Error('Usage: .afk [on|off|status|now]')

    if (!session.afk.enabled) {
      this.print('afk off')
      return
    }
    const next = session.afk.nextRunIn()
    this.print(`afk on${next != null ? ` — next action in ${formatDuration(next)}` : ''}`)
  }

  move (args) {
    const directions = {
      forward: 'forward',
      f: 'forward',
      back: 'back',
      backward: 'back',
      b: 'back',
      left: 'left',
      l: 'left',
      right: 'right',
      r: 'right',
      jump: 'jump',
      j: 'jump'
    }
    const key = directions[(args[0] ?? '').toLowerCase()]
    if (!key) throw new Error('Usage: .move <forward|back|left|right|jump> [ms]')

    let ms = 500
    if (args[1] !== undefined) {
      ms = Number(args[1])
      if (!Number.isFinite(ms) || ms < 1 || ms > 10000) {
        throw new Error('Duration must be between 1 and 10000 ms')
      }
    }

    const bot = this.requireBot()
    if (key === 'jump' && !bot.entity.onGround) throw new Error('Bot is not on the ground')

    bot.setControlState(key, true)
    setTimeout(() => {
      if (this.runtime.bot === bot) {
        try {
          bot.setControlState(key, false)
        } catch {
          // Disconnected.
        }
      }
    }, ms)
    this.print(`${key} for ${ms}ms`)
  }

  jump () {
    const bot = this.requireBot()
    if (!bot.entity.onGround) throw new Error('Bot is not on the ground')
    bot.setControlState('jump', true)
    setTimeout(() => {
      if (this.runtime.bot === bot) {
        try {
          bot.setControlState('jump', false)
        } catch {
          // Disconnected.
        }
      }
    }, randomInt(180, 260))
    this.print('jump')
  }

  async quit () {
    if (this.closing) return
    this.closing = true
    this.print('disconnecting…')
    if (this.onQuit) {
      await this.onQuit()
    } else {
      await this.runtime.stop('console quit')
    }
  }

  complete (line) {
    const text = String(line ?? '')
    if (!text.startsWith('.') && !text.startsWith('!')) return [[], text]

    const leading = text.startsWith('!') ? '!' : '.'
    const body = text.slice(1)
    const parts = body.split(/\s+/)
    const commandName = (parts[0] ?? '').toLowerCase()

    if (parts.length <= 1) {
      const names = [...new Set(this.commandList.map(command => command.name))]
        .filter(name => name.startsWith(commandName))
        .sort()
      return [names.map(name => `${leading}${name}`), text]
    }

    const current = parts[parts.length - 1]
    const prefix = leading + parts.slice(0, -1).join(' ')
    let candidates = []

    if (['hold', 'drop', 'eat'].includes(commandName)) {
      const bot = this.runtime.bot
      candidates = [...new Set((bot?.inventory?.items?.() ?? []).map(item => item.name))]
        .filter(name => name.startsWith(current))
    } else if (
      (['msg', 'w', 'whisper'].includes(commandName) && parts.length === 2) ||
      (commandName === 'look' && parts[1]?.toLowerCase() === 'at' && parts.length === 3)
    ) {
      const players = Object.keys(this.runtime.bot?.players ?? {})
      candidates = players.filter(name => name.startsWith(current))
    } else if (commandName === 'log') {
      candidates = ['debug', 'info', 'warn', 'error'].filter(name => name.startsWith(current))
    } else if (['sneak', 'shift', 'afk', 'autoeat'].includes(commandName)) {
      candidates = ['on', 'off', 'status', 'toggle'].filter(name => name.startsWith(current))
      if (commandName === 'afk') candidates.push('now')
    }

    return [candidates.map(name => `${prefix} ${name}`.trim()), text]
  }
}
