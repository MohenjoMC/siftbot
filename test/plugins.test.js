import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PluginManager } from '../src/plugins/manager.js'
import { PluginContext } from '../src/plugins/context.js'

const silentLogger = { debug () {}, info () {}, warn () {}, error () {} }

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-plugins-'))
}

function fakeBot () {
  const bot = new EventEmitter()
  bot.username = 'alice'
  bot.entity = {
    id: 1,
    onGround: true,
    position: { x: 1, y: 64, z: 3, clone: () => ({ set () {} }) }
  }
  bot.registry = { blocksByName: { chest: { id: 54 }, barrel: { id: 55 } } }
  bot.controls = []
  bot.setControlState = (key, state) => bot.controls.push([key, state])
  bot.inventory = { items: () => [{ name: 'bread', count: 2 }] }
  bot.blockAt = () => null
  bot.findBlock = () => null
  bot.openContainer = async () => ({ slots: [], close () {} })
  return bot
}

function fakeCommands () {
  const map = new Map()
  return {
    map,
    registerExternal (name, spec) {
      if (map.has(name)) throw new Error(`Command .${name} already exists`)
      map.set(name, spec)
    },
    unregisterCommand (name) {
      map.delete(name)
    }
  }
}

function writePlugin (dir, body) {
  fs.writeFileSync(path.join(dir, 'demo.js'), body)
}

const DEMO_PLUGIN = `
export const name = 'demo'
export const version = '1.0.0'
export default function create (ctx) {
  globalThis.__pluginCreated = (globalThis.__pluginCreated ?? 0) + 1
  ctx.on('spawn', () => {})
  ctx.every(60000, () => {})
  ctx.registerCommand('hello', {
    usage: '.hello',
    description: 'demo',
    run: (args, c) => c.log('hello from plugin')
  })
  return { unload () { globalThis.__pluginUnloaded = (globalThis.__pluginUnloaded ?? 0) + 1 } }
}
`

test('plugin manager loads, binds sessions, reloads and cleans up', async () => {
  globalThis.__pluginCreated = 0
  globalThis.__pluginUnloaded = 0
  const dir = tempDir()
  writePlugin(dir, DEMO_PLUGIN)

  const manager = new PluginManager({ dir, logger: silentLogger, hotReload: false })
  await manager.start()
  assert.deepEqual(manager.list().map(p => p.name), ['demo'])

  const runtime = new EventEmitter()
  runtime.config = { host: 'example.com' }
  runtime.bot = fakeBot()
  const commands = fakeCommands()
  manager.attachSession({ id: 'a', runtime, commands, logger: silentLogger })
  await manager.ready

  assert.equal(globalThis.__pluginCreated, 1)
  assert.equal(commands.map.has('hello'), true)
  assert.equal(runtime.bot.listenerCount('spawn'), 1)

  // Reconnect: a new bot rebinds and drops the old listeners.
  const nextBot = fakeBot()
  runtime.bot = nextBot
  runtime.emit('session', nextBot)
  assert.equal(globalThis.__pluginCreated, 2)
  assert.equal(globalThis.__pluginUnloaded, 1)
  assert.equal(runtime.bot.listenerCount('spawn'), 1)

  // Hot reload: dispose the old instance, load the new file, rebind.
  writePlugin(dir, DEMO_PLUGIN.replace("version = '1.0.0'", "version = '1.0.1'"))
  await manager.reload()
  assert.equal(globalThis.__pluginUnloaded, 2)
  assert.equal(globalThis.__pluginCreated, 3)
  assert.equal(manager.list()[0].version, '1.0.1')
  assert.equal(commands.map.has('hello'), true)

  manager.stop()
  assert.equal(globalThis.__pluginUnloaded, 3)
  assert.equal(commands.map.has('hello'), false)
  assert.equal(runtime.bot.listenerCount('spawn'), 0)
})

test('a broken plugin keeps the previous working version', async () => {
  globalThis.__pluginCreated = 0
  const dir = tempDir()
  writePlugin(dir, DEMO_PLUGIN)
  const manager = new PluginManager({ dir, logger: silentLogger, hotReload: false })
  await manager.start()

  writePlugin(dir, 'export default function (ctx) { this is not javascript ')
  await manager.reload()

  assert.equal(manager.list().length, 1)
  assert.equal(manager.list()[0].name, 'demo')
  manager.stop()
})

test('plugin context actions, inventory and container reading', async () => {
  const bot = fakeBot()
  bot.findBlock = ({ matching }) => matching.includes(54)
    ? { name: 'chest', position: { x: 5, y: 64, z: 5 } }
    : null
  bot.openContainer = async () => ({
    slots: [{ name: 'diamond', count: 3 }, null, { name: 'iron_ingot', count: 7 }],
    close () {}
  })

  const runtime = { bot }
  const commands = fakeCommands()
  const ctx = new PluginContext({
    name: 'test',
    runtime,
    bot,
    commands,
    logger: silentLogger,
    config: { host: 'example.com' }
  })

  assert.equal(ctx.connected, true)
  assert.equal(ctx.inventory.count('bread'), 2)

  ctx.actions.move('forward', 40)
  assert.deepEqual(bot.controls[0], ['forward', true])
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(bot.controls.at(-1), ['forward', false])

  const contents = await ctx.containers.nearest(16)
  assert.equal(contents.block.name, 'chest')
  assert.deepEqual(contents.items, [
    { slot: 0, name: 'diamond', count: 3 },
    { slot: 2, name: 'iron_ingot', count: 7 }
  ])

  ctx.registerCommand('hello', { run: () => {} })
  assert.equal(commands.map.has('hello'), true)
  assert.throws(() => ctx.registerCommand('hello', { run: () => {} }), /already exists/)

  ctx.cleanup()
  assert.equal(commands.map.has('hello'), false)
  assert.equal(ctx.connected, false)
})

test('plugin context rejects unknown movement directions', () => {
  const bot = fakeBot()
  const ctx = new PluginContext({
    name: 'test',
    runtime: { bot },
    bot,
    commands: null,
    logger: silentLogger,
    config: {}
  })
  assert.throws(() => ctx.actions.move('sideways'), /unknown direction/)
  ctx.cleanup()
})
