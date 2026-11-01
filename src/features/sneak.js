/**
 * Keeps the sneak (shift) key held for the whole session. mineflayer resets
 * client-side input on respawn, so the state is forced again on every spawn
 * and checked by a watchdog.
 */
export class SneakKeeper {
  constructor (bot, options, logger) {
    this.bot = bot
    this.options = options
    this.logger = logger
    this.enabled = options.enabled
    this.stopped = false

    this.onSpawn = () => {
      if (!this.enabled) return
      // Force a fresh packet even if the local control state survived respawn.
      this.release()
      this.apply()
    }
    this.onDeath = () => {
      // Death resets input server-side; the spawn handler re-applies it.
    }

    bot.on('spawn', this.onSpawn)
    bot.on('death', this.onDeath)

    this.timer = setInterval(() => this.watchdog(), options.watchdogMs)
    this.timer.unref?.()

    this.apply()
  }

  get held () {
    try {
      return this.bot.getControlState('sneak')
    } catch {
      return false
    }
  }

  apply () {
    if (this.stopped || !this.enabled) return false
    if (!this.bot.entity || !this.bot.isAlive) return false
    try {
      if (!this.bot.getControlState('sneak')) this.bot.setControlState('sneak', true)
      return true
    } catch (err) {
      this.logger.debug(`sneak: ${err.message}`)
      return false
    }
  }

  release () {
    try {
      if (this.bot.getControlState?.('sneak')) this.bot.setControlState('sneak', false)
    } catch {
      // Bot may already be disconnected.
    }
  }

  watchdog () {
    if (this.stopped || !this.enabled) return
    if (!this.bot.entity || !this.bot.isAlive) return
    if (this.held) return
    this.logger.debug('sneak: re-applying held shift')
    this.apply()
  }

  setEnabled (enabled) {
    this.enabled = Boolean(enabled)
    if (this.enabled) {
      this.apply()
      this.logger.info('sneak: holding shift')
    } else {
      this.release()
      this.logger.info('sneak: released shift')
    }
    return this.enabled
  }

  stop () {
    this.stopped = true
    clearInterval(this.timer)
    this.bot.removeListener('spawn', this.onSpawn)
    this.bot.removeListener('death', this.onDeath)
    this.release()
  }
}
