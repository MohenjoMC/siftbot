import { chooseFood, foodTableFromRegistry, MAX_FOOD } from '../foods.js'
import { normalizeItemName, sleep } from '../util.js'

/**
 * Keeps hunger topped up so natural regeneration can keep working while AFK.
 * Eating is deliberately conservative: it never burns golden apples, never
 * eats risky foods, and picks the smallest meal that fills the missing hunger.
 */
export class AutoEat {
  constructor (bot, options, logger, { isBusy = () => false } = {}) {
    this.bot = bot
    this.options = options
    this.logger = logger
    this.isBusy = isBusy
    this.eating = false
    this.stopped = false
    this.lastAttempt = 0
    this.lastEatAt = null
    this.lastEaten = null
    this.lastNoFoodWarning = 0

    this.onHealth = () => this.check()
    this.onSpawn = () => {
      this.lastAttempt = 0
      this.check()
    }

    bot.on('health', this.onHealth)
    bot.on('spawn', this.onSpawn)

    this.timer = setInterval(() => this.check(), 1000)
    this.timer.unref?.()
  }

  get enabled () {
    return this.options.enabled
  }

  setEnabled (enabled) {
    this.options.enabled = Boolean(enabled)
    if (this.options.enabled) {
      this.logger.info('auto-eat: enabled')
      this.check()
    } else {
      this.logger.info('auto-eat: disabled')
    }
    return this.options.enabled
  }

  stop () {
    this.stopped = true
    clearInterval(this.timer)
    this.bot.removeListener('health', this.onHealth)
    this.bot.removeListener('spawn', this.onSpawn)
  }

  getFoodTable () {
    return foodTableFromRegistry(this.bot.registry)
  }

  /** Called by health updates and a 1s poll. */
  check () {
    if (this.stopped || !this.options.enabled || this.eating) return
    if (!this.bot.entity || !this.bot.isAlive) return
    if (this.isBusy()) return
    if (Date.now() - this.lastAttempt < this.options.cooldownMs) return

    const gameMode = this.bot.game?.gameMode
    if (gameMode === 'creative' || gameMode === 'spectator') return

    const food = this.bot.food
    const health = this.bot.health
    if (typeof food !== 'number' || typeof health !== 'number') return
    if (food >= MAX_FOOD) return

    const hungry = food <= this.options.eatAtFood
    const hurt = health <= this.options.eatAtHealth
    if (!hungry && !hurt) return

    const foodItem = this.pickFood()
    if (!foodItem) {
      this.warnNoFood()
      return
    }

    void this.eat({ automatic: true })
  }

  pickFood () {
    const items = this.bot.inventory?.items?.() ?? []
    const table = this.getFoodTable()
    return chooseFood(items, table, {
      foodLevel: this.bot.food ?? MAX_FOOD,
      maxFood: MAX_FOOD,
      exclude: this.options.exclude
    })
  }

  findFoodByName (name, items) {
    const wanted = normalizeItemName(name)
    const table = this.getFoodTable()
    const matches = items.filter(item => normalizeItemName(item.name) === wanted)
    if (matches.length === 0) return null
    if (!table[wanted]) {
      throw new Error(`${wanted} is not a food`)
    }
    return matches[0]
  }

  /**
   * Eat food. Automatic calls respect cooldowns and never throw; manual calls
   * (force: true) surface their errors to the console.
   * @param {{force?: boolean, automatic?: boolean, itemName?: string|null}} [opts]
   * @returns {Promise<boolean>} true when something was eaten
   */
  async eat ({ force = false, automatic = false, itemName = null } = {}) {
    if (!automatic && !force) force = true
    if (this.eating) {
      if (force) throw new Error('Already eating')
      return false
    }
    if (this.stopped) throw new Error('Auto-eat is stopped')

    const bot = this.bot
    if (!bot.entity || !bot.isAlive) throw new Error('Bot is not spawned')
    if (bot.currentWindow) throw new Error('Cannot eat while a container is open')

    const gameMode = bot.game?.gameMode
    if (gameMode === 'creative' || gameMode === 'spectator') {
      throw new Error(`Cannot eat in ${gameMode} mode`)
    }

    const items = bot.inventory?.items?.() ?? []
    let foodItem
    if (itemName) {
      foodItem = this.findFoodByName(itemName, items)
      if (!foodItem) throw new Error(`No ${normalizeItemName(itemName)} in inventory`)
    } else {
      foodItem = chooseFood(items, this.getFoodTable(), {
        foodLevel: bot.food ?? MAX_FOOD,
        maxFood: MAX_FOOD,
        exclude: this.options.exclude
      })
      if (!foodItem) throw new Error('No safe food in inventory')
    }

    if (bot.food >= MAX_FOOD && !['golden_apple', 'enchanted_golden_apple'].includes(foodItem.name)) {
      throw new Error('Hunger is already full')
    }

    const previous = bot.heldItem ? { type: bot.heldItem.type, name: bot.heldItem.name } : null
    const before = { food: bot.food, health: bot.health }
    const eatenName = foodItem.name

    this.eating = true
    this.lastAttempt = Date.now()

    try {
      await bot.equip(foodItem, 'hand')
      if (!bot.heldItem || bot.heldItem.name !== eatenName) {
        throw new Error(`Failed to hold ${eatenName}`)
      }

      await bot.consume()
      await sleep(50)

      const after = { food: bot.food, health: bot.health }
      this.lastEatAt = Date.now()
      this.lastEaten = eatenName
      this.logger.info(
        `ate ${eatenName}  (food ${before.food}→${after.food}, health ${before.health}→${after.health})`
      )

      if (this.options.restoreHeldItem && previous && previous.name !== eatenName) {
        const replacement = bot.inventory.items().find(item => item.type === previous.type)
        if (replacement) {
          await bot.equip(replacement, 'hand').catch(err => {
            this.logger.debug(`could not restore held item: ${err.message}`)
          })
        }
      }
      return true
    } catch (err) {
      const message = err?.message ?? String(err)
      if (force) throw new Error(`Could not eat: ${message}`)
      if (/food is full/i.test(message)) {
        this.logger.debug('auto-eat: hunger is full')
      } else {
        this.logger.warn(`auto-eat failed: ${message}`)
      }
      return false
    } finally {
      this.eating = false
    }
  }

  warnNoFood () {
    const now = Date.now()
    if (now - this.lastNoFoodWarning < 60000) return
    this.lastNoFoodWarning = now
    this.logger.warn('hungry but there is no safe food in the inventory')
  }
}
