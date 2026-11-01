import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AutoEat } from '../src/features/auto-eat.js'
import { SneakKeeper } from '../src/features/sneak.js'
import { AfkController } from '../src/features/afk.js'

const foods = {
  bread: { foodPoints: 5, saturation: 6, effectiveQuality: 11 },
  cooked_beef: { foodPoints: 8, saturation: 12.8, effectiveQuality: 20.8 },
  dried_kelp: { foodPoints: 1, saturation: 0.6, effectiveQuality: 1.6 }
}

function stubLogger () {
  return { info () {}, warn () {}, error () {}, debug () {} }
}

class FakeBot extends EventEmitter {
  constructor () {
    super()
    this.registry = { foodsByName: foods }
    this.entity = {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      isInWater: false,
      isInLava: false
    }
    this.isAlive = true
    this.health = 20
    this.food = 16
    this.foodSaturation = 0
    this.game = { gameMode: 'survival' }
    this.currentWindow = null
    this.heldItem = null
    this.items = [{ name: 'bread', count: 3, type: 1, slot: 36 }]
    this.inventory = { items: () => this.items }
    this.controls = {}
    this.equips = []
    this.consumes = 0
  }

  async equip (item) {
    this.equips.push(item.name)
    this.heldItem = item
  }

  async consume () {
    this.consumes += 1
    const food = foods[this.heldItem.name]
    this.food = Math.min(20, this.food + (food?.foodPoints ?? 0))
  }

  setControlState (key, value) {
    this.controls[key] = value
  }

  getControlState (key) {
    return Boolean(this.controls[key])
  }

  async look (yaw, pitch) {
    this.entity.yaw = yaw
    this.entity.pitch = pitch
  }

  swingArm () {
    this.swings = (this.swings ?? 0) + 1
  }

  chat (message) {
    this.chats = [...(this.chats ?? []), message]
  }
}

function eatOptions (overrides = {}) {
  return {
    enabled: true,
    eatAtFood: 17,
    eatAtHealth: 14,
    cooldownMs: 0,
    restoreHeldItem: true,
    exclude: [],
    ...overrides
  }
}

async function waitFor (predicate, timeoutMs = 500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('auto-eat eats when hunger is below the threshold', async t => {
  const bot = new FakeBot()
  const eater = new AutoEat(bot, eatOptions(), stubLogger())
  t.after(() => eater.stop())

  eater.check()
  await waitFor(() => eater.lastEaten === 'bread')

  assert.equal(bot.consumes, 1)
  assert.equal(bot.food, 20)
  assert.deepEqual(bot.equips, ['bread'])
  assert.equal(eater.eating, false)
})

test('auto-eat does nothing at full hunger or in creative', async t => {
  const bot = new FakeBot()
  bot.food = 20
  const eater = new AutoEat(bot, eatOptions(), stubLogger())
  t.after(() => eater.stop())

  eater.check()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(bot.consumes, 0)

  bot.food = 10
  bot.game.gameMode = 'creative'
  eater.lastAttempt = 0
  eater.check()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(bot.consumes, 0)
})

test('auto-eat stays quiet with no safe food', async t => {
  const bot = new FakeBot()
  bot.items = [{ name: 'stone', count: 64, type: 1, slot: 36 }]
  const eater = new AutoEat(bot, eatOptions(), stubLogger())
  t.after(() => eater.stop())

  eater.check()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(bot.consumes, 0)
  assert.equal(eater.lastEaten, null)
})

test('manual eat can pick a specific food and restores the held item', async t => {
  const bot = new FakeBot()
  bot.food = 10
  bot.items = [
    { name: 'bread', count: 3, type: 1, slot: 36 },
    { name: 'diamond_pickaxe', count: 1, type: 2, slot: 37 }
  ]
  bot.heldItem = bot.items[1]

  const eater = new AutoEat(bot, eatOptions(), stubLogger())
  t.after(() => eater.stop())

  await eater.eat({ force: true, itemName: 'bread' })
  assert.equal(bot.food, 15)
  assert.equal(bot.heldItem.name, 'diamond_pickaxe')
})

test('manual eat reports a missing item', async t => {
  const bot = new FakeBot()
  const eater = new AutoEat(bot, eatOptions(), stubLogger())
  t.after(() => eater.stop())

  await assert.rejects(eater.eat({ force: true, itemName: 'stone' }), /No stone in inventory/)
  await assert.rejects(eater.eat({ force: true, itemName: 'cooked_beef' }), /No cooked_beef in inventory/)
})

test('stop removes listeners and interval', async t => {
  const bot = new FakeBot()
  const eater = new AutoEat(bot, eatOptions(), stubLogger())
  assert.equal(bot.listenerCount('health'), 1)
  eater.stop()
  assert.equal(bot.listenerCount('health'), 0)
  assert.equal(bot.listenerCount('spawn'), 0)
})

test('sneak keeper holds, re-applies and releases shift', () => {
  const bot = new FakeBot()
  const sneak = new SneakKeeper(bot, { enabled: true, watchdogMs: 1000 }, stubLogger())

  assert.equal(bot.getControlState('sneak'), true)

  // Simulate a respawn / client-side input reset.
  bot.setControlState('sneak', false)
  sneak.watchdog()
  assert.equal(bot.getControlState('sneak'), true)

  bot.emit('spawn')
  assert.equal(bot.getControlState('sneak'), true)

  sneak.setEnabled(false)
  assert.equal(bot.getControlState('sneak'), false)
  sneak.stop()
})

test('afk controller performs a look action and pauses', async () => {
  const bot = new FakeBot()
  const afk = new AfkController(bot, {
    enabled: false,
    minIntervalMs: 20000,
    maxIntervalMs: 45000,
    look: true,
    swing: false,
    jump: false,
    move: false,
    chat: [],
    chatIntervalMs: 0
  }, stubLogger())

  const actions = await afk.tick({ force: true })
  assert.deepEqual(actions, ['look'])
  assert.ok(Number.isFinite(bot.entity.yaw))

  afk.setEnabled(true)
  assert.ok(afk.nextRunIn() > 0)
  afk.setEnabled(false)
  assert.equal(afk.nextRunIn(), null)
  afk.stop()
})

test('afk chat templates interpolate live state', () => {
  const bot = new FakeBot()
  const afk = new AfkController(bot, {
    enabled: false,
    minIntervalMs: 20000,
    maxIntervalMs: 45000,
    look: false,
    swing: false,
    jump: false,
    move: false,
    chat: [],
    chatIntervalMs: 0
  }, stubLogger())

  assert.equal(
    afk.interpolate('${username} has ${health}hp and ${food} food at ${x},${y},${z}'),
    ' has 20hp and 16 food at 0,64,0'
  )
  afk.stop()
})
