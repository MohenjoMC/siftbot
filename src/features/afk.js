import { clamp, randomInt, sleep } from '../util.js'

const MOVEMENT_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint']

/**
 * Small, human-looking actions that keep AFK timers from firing a kick.
 * Looking and arm swings are safe anywhere; jumping is skipped while eating,
 * in liquids, in a vehicle and mid-air.
 */
export class AfkController {
  constructor (bot, options, logger, { isBusy = () => false } = {}) {
    this.bot = bot
    this.options = options
    this.logger = logger
    this.isBusy = isBusy
    this.enabled = options.enabled
    this.stopped = false
    this.timer = null
    this.nextAt = null
    this.lastChatAt = 0
    this.heldKeys = new Set()

    if (this.enabled) this.schedule()
  }

  schedule (delay = randomInt(this.options.minIntervalMs, this.options.maxIntervalMs)) {
    if (this.stopped || !this.enabled) return
    clearTimeout(this.timer)
    this.nextAt = Date.now() + delay
    this.timer = setTimeout(() => {
      this.nextAt = null
      void this.tick().finally(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }

  nextRunIn () {
    return this.nextAt == null ? null : Math.max(0, this.nextAt - Date.now())
  }

  async tick ({ force = false } = {}) {
    if (this.stopped) return []
    if (!force && !this.enabled) return []
    const bot = this.bot
    if (!bot.entity || !bot.isAlive) return []

    const actions = []
    const busy = this.isBusy()

    if (this.options.look) {
      const yaw = (bot.entity.yaw ?? 0) + (Math.random() * 1.2 - 0.6)
      const pitch = clamp((bot.entity.pitch ?? 0) + (Math.random() * 0.5 - 0.25), -1.2, 1.2)
      try {
        await bot.look(yaw, pitch, true)
        actions.push('look')
      } catch (err) {
        this.logger.debug(`afk look: ${err.message}`)
      }
    }

    if (this.options.swing && Math.random() < 0.6) {
      try {
        bot.swingArm('right')
        actions.push('swing')
      } catch (err) {
        this.logger.debug(`afk swing: ${err.message}`)
      }
    }

    if (this.options.jump && !busy && Math.random() < 0.3 && this.canJump()) {
      try {
        await this.holdKey('jump', 220)
        actions.push('jump')
      } catch (err) {
        this.logger.debug(`afk jump: ${err.message}`)
      }
    }

    if (this.options.move && !busy && Math.random() < 0.15 && this.canJump()) {
      try {
        await this.holdKey('forward', randomInt(350, 700))
        actions.push('step')
      } catch (err) {
        this.logger.debug(`afk step: ${err.message}`)
      }
    }

    this.maybeChat(actions)

    if (actions.length > 0) this.logger.debug(`afk: ${actions.join(' + ')}`)
    return actions
  }

  canJump () {
    const entity = this.bot.entity
    if (!entity) return false
    if (!entity.onGround) return false
    if (entity.isInWater || entity.isInLava) return false
    if (entity.elytraFlying) return false
    if (this.bot.vehicle) return false
    return true
  }

  async holdKey (key, ms) {
    const bot = this.bot
    bot.setControlState(key, true)
    this.heldKeys.add(key)
    try {
      await sleep(ms)
    } finally {
      if (this.bot === bot) {
        try {
          bot.setControlState(key, false)
        } catch {
          // Disconnected mid-action.
        }
      }
      this.heldKeys.delete(key)
    }
  }

  maybeChat (actions) {
    const messages = this.options.chat
    if (!Array.isArray(messages) || messages.length === 0) return
    if (Date.now() - this.lastChatAt < this.options.chatIntervalMs) return

    const template = messages[Math.floor(Math.random() * messages.length)]
    const message = this.interpolate(template)
    if (!message) return

    try {
      this.bot.chat(message)
      this.lastChatAt = Date.now()
      actions.push('chat')
    } catch (err) {
      this.logger.debug(`afk chat: ${err.message}`)
    }
  }

  interpolate (template) {
    const bot = this.bot
    const entity = bot.entity
    return template
      .replace(/\$\{username\}/g, bot.username ?? '')
      .replace(/\$\{health\}/g, String(bot.health ?? '?'))
      .replace(/\$\{food\}/g, String(bot.food ?? '?'))
      .replace(/\$\{x\}/g, entity ? Math.floor(entity.position.x).toString() : '?')
      .replace(/\$\{y\}/g, entity ? Math.floor(entity.position.y).toString() : '?')
      .replace(/\$\{z\}/g, entity ? Math.floor(entity.position.z).toString() : '?')
  }

  clearHeldKeys () {
    for (const key of MOVEMENT_KEYS) {
      try {
        if (this.bot.getControlState?.(key)) this.bot.setControlState(key, false)
      } catch {
        // Disconnected.
      }
    }
    this.heldKeys.clear()
  }

  setEnabled (enabled) {
    this.enabled = Boolean(enabled)
    clearTimeout(this.timer)
    this.timer = null
    if (this.enabled) {
      this.logger.info('afk: activity enabled')
      this.schedule()
    } else {
      this.logger.info('afk: activity paused')
      this.nextAt = null
      this.clearHeldKeys()
    }
    return this.enabled
  }

  stop () {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
    this.nextAt = null
    this.clearHeldKeys()
  }
}
