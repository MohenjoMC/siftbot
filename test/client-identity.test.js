import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ClientIdentity, viewDistanceChunks } from '../src/features/client-identity.js'
import { normalizeConfig } from '../src/config.js'

const silentLogger = { debug () {}, info () {}, warn () {}, error () {} }

class FakeClient extends EventEmitter {
  constructor () {
    super()
    this.state = 'play'
    this.writes = []
    this.channels = new Map()
  }

  write (name, data) {
    this.writes.push({ name, data })
  }

  end (reason) {
    this.ended = reason
  }

  // Mirrors minecraft-protocol's writeChannel: the registered schema serializes
  // the payload into a custom_payload packet. The brand channel uses a
  // varint-length-prefixed UTF-8 string (payloads stay < 128 bytes here).
  writeChannel (channel, data) {
    const payload = Buffer.from(String(data), 'utf8')
    this.write('custom_payload', { channel, data: Buffer.concat([Buffer.from([payload.length]), payload]) })
  }

  registerChannel (name, parser) {
    this.channels.set(name, parser)
  }
}

const MODERN_FEATURES = {
  customChannelIdentifier: true,
  customChannelMCPrefixed: false,
  hasConfigurationState: true
}
const LEGACY_FEATURES = {
  customChannelIdentifier: false,
  customChannelMCPrefixed: true,
  hasConfigurationState: false
}

function makeBot (protocolVersion = 775, features = MODERN_FEATURES) {
  const bot = new EventEmitter()
  bot.protocolVersion = protocolVersion
  bot.supportFeature = name => Boolean(features[name])
  bot._client = new FakeClient()
  bot.entity = { id: 42 }
  bot.quickBarSlot = 0
  bot.setQuickBarSlot = function (slot) {
    this.quickBarSlot = slot
    this._client.write('held_item_slot', { slotId: slot })
  }
  return bot
}

const writesTowards = (client, packetName) => client.writes.filter (write => write.name === packetName)
// custom_payload records look like { name, data: { channel, data: Buffer } }
const payloads = client => client.writes
  .filter(write => write.name === 'custom_payload')
  .map(write => write.data)

test('client identity: brand is announced in configuration state (1.20.2+)', () => {
  const bot = makeBot()
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.state = 'configuration'
  bot._client.emit('state', 'configuration', 'play')

  const brandPayloads = payloads(bot._client)
  assert.equal(brandPayloads.length, 1)
  assert.equal(brandPayloads[0].channel, 'minecraft:brand')
  // varint length prefix (7) + UTF-8 "vanilla"
  assert.deepEqual(Buffer.from(brandPayloads[0].data), Buffer.from([0x07, ...Buffer.from('vanilla', 'utf8')]))
})

test('client identity: custom brand value is used', () => {
  const bot = makeBot()
  new ClientIdentity(bot, { enabled: true, brand: 'siftbot/1.0' }, silentLogger)

  bot._client.state = 'configuration'
  bot._client.emit('state', 'configuration', 'play')

  const brandPayloads = payloads(bot._client)
  assert.equal(brandPayloads[0].channel, 'minecraft:brand')
  assert.ok(Buffer.from(brandPayloads[0].data).includes(Buffer.from('siftbot/1.0')))
})

test('client identity: play-state brand write is suppressed after configuration (mirrors mineflayer game plugin)', () => {
  const bot = makeBot()
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.state = 'configuration'
  bot._client.emit('state', 'configuration', 'play')
  bot._client.writes = []

  // This is exactly what mineflayer's game plugin does on every play 'login'.
  bot._client.writeChannel('minecraft:brand', 'vanilla')
  assert.equal(bot._client.writes.length, 0)

  identity.stop()
  bot._client.writeChannel('minecraft:brand', 'vanilla')
  assert.equal(bot._client.writes.length, 1)
})

test('client identity: legacy versions (≤1.20.1) keep the play-state brand', () => {
  const bot = makeBot(758, LEGACY_FEATURES)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  // A configuration-state listener exists upstream but vanilla 1.20.1 never
  // enters configuration; ours must stay silent.
  bot._client.state = 'configuration'
  bot._client.emit('state', 'configuration', 'play')
  assert.equal(bot._client.writes.length, 0)

  // mineflayer's own login write must pass through, every time.
  bot._client.writeChannel('MC|Brand', 'vanilla')
  bot._client.writeChannel('MC|Brand', 'vanilla')
  const brandPayloads = payloads(bot._client)
  assert.equal(brandPayloads.length, 2)
  assert.equal(brandPayloads[0].channel, 'MC|Brand')
})

test('client identity: tick_end follows every physics tick on protocol ≥ 767', async () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot.emit('physicsTick')
  bot.emit('physicsTick')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writesTowards(bot._client, 'tick_end').length, 2)
})

test('client identity: tick_end only written while in the play state', () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.state = 'configuration'
  bot.emit('physicsTick')
  assert.equal(writesTowards(bot._client, 'tick_end').length, 0)
})

test('client identity: no tick_end on 1.21.1 and older', () => {
  const bot = makeBot(761) // 1.20.4
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot.emit('physicsTick')
  assert.equal(writesTowards(bot._client, 'tick_end').length, 0)
})

test('client identity: select_known_packs answered on repeat requests only', () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  // First request: answered by minecraft-protocol itself; ours holds back.
  bot._client.emit('select_known_packs', { packs: [{ packId: 'minecraft:core' }] })
  assert.equal(writesTowards(bot._client, 'select_known_packs').length, 0)

  // Transfer: a second negotiation must not stall the server.
  bot._client.emit('select_known_packs', { packs: [] })
  const replies = writesTowards(bot._client, 'select_known_packs')
  assert.equal(replies.length, 1)
  assert.deepEqual(replies[0].data, { packs: [] })
})

test('client identity: disabled feature does not write or suppress anything', () => {
  const bot = makeBot()
  new ClientIdentity(bot, { enabled: false, brand: 'vanilla' }, silentLogger)

  bot._client.state = 'configuration'
  bot._client.emit('state', 'configuration', 'play')
  bot.emit('physicsTick')
  bot._client.emit('select_known_packs', { packs: [] })
  assert.deepEqual(bot._client.writes, [])

  // The passthrough patch is still a true identity when disabled: a direct
  // writeChannel lands unmodified, and suppression never applies.
  bot._client.writeChannel('minecraft:brand', 'vanilla')
  assert.deepEqual(payloads(bot._client), [{
    channel: 'minecraft:brand',
    data: Buffer.concat([Buffer.from([7]), Buffer.from('vanilla')])
  }])
})

test('client identity: defers version checks until auto-version has resolved', async () => {
  // Exactly the production shape: mineflayer.createBot() returns before the
  // server ping has resolved the protocol, so protocolVersion/supportFeature
  // are unavailable at construction time.
  const bot = makeBot(undefined, {})
  bot.protocolVersion = undefined
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  // Nothing must crash or fire while the version is unknown.
  bot.emit('physicsTick')
  assert.equal(bot._client.writes.length, 0)

  // The ping resolves, then the configuration state arrives.
  bot.protocolVersion = 775
  bot.supportFeature = name => Boolean(MODERN_FEATURES[name])
  bot._client.state = 'configuration'
  bot._client.emit('state', 'configuration', 'login')

  const brandPayloads = payloads(bot._client)
  assert.equal(brandPayloads.length, 1)
  assert.equal(brandPayloads[0].channel, 'minecraft:brand')

  // And tick_end now activates on the following physics ticks (written just
  // after the tick body, like vanilla).
  bot._client.state = 'play'
  bot.emit('physicsTick')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writesTowards(bot._client, 'tick_end').length, 1)
  assert.equal(identity.hasTickEnd, true)
})

test('client identity: duplicate play-state settings are suppressed once per login', () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.state = 'play'
  // This is mineflayer's settings plugin writing on play login; vanilla has
  // already sent Client Information during configuration.
  bot._client.write('settings', { locale: 'en_US' })
  assert.equal(writesTowards(bot._client, 'settings').length, 0)

  // A later deliberate change (bot.setSettings) must pass through.
  bot._client.write('settings', { locale: 'de_DE' })
  assert.equal(writesTowards(bot._client, 'settings').length, 1)

  // After the next play login the stack's automatic write is dropped again.
  bot._client.emit('login')
  bot._client.write('settings', { locale: 'en_US' })
  assert.equal(writesTowards(bot._client, 'settings').length, 1)
})

test('client identity: duplicate position after a teleport acknowledgement is promoted to position_look', () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.state = 'play'
  bot._client.write('position_look', { x: 8, y: 62, z: 8, yaw: 90, pitch: -90, onGround: false })
  bot._client.write('position', { x: 8, y: 62, z: 8, onGround: false })

  const looks = writesTowards(bot._client, 'position_look')
  assert.equal(looks.length, 2)
  assert.equal(looks[1].data.yaw, 90)
  assert.equal(writesTowards(bot._client, 'position').length, 0)

  // Real falling movement must always pass through untouched.
  bot._client.write('position', { x: 8, y: 61.92, z: 8, onGround: false })
  assert.equal(writesTowards(bot._client, 'position').length, 1)
})

test('client identity: invalid held item slots are ignored like vanilla', () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  // Sonar sends an intentionally invalid slot before the real one.
  assert.doesNotThrow(() => bot.setQuickBarSlot(-1))
  assert.equal(bot.quickBarSlot, 0)
  assert.equal(writesTowards(bot._client, 'held_item_slot').length, 0)

  bot.setQuickBarSlot(3)
  assert.equal(bot.quickBarSlot, 3)
  assert.equal(writesTowards(bot._client, 'held_item_slot').length, 1)
})

test('client identity: swing-arm animation is echoed for the own player before 26.3', () => {
  const bot = makeBot(775)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.emit('animation', { entityId: 42, animation: 0 })
  assert.equal(writesTowards(bot._client, 'arm_animation').length, 1)
  assert.deepEqual(writesTowards(bot._client, 'arm_animation')[0].data, { hand: 0 })

  // Other entities' animations are not echoed.
  bot._client.emit('animation', { entityId: 7, animation: 0 })
  assert.equal(writesTowards(bot._client, 'arm_animation').length, 1)
})

test('client identity: no swing-arm echo on 26.3+', () => {
  const bot = makeBot(777)
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.emit('animation', { entityId: 42, animation: 0 })
  assert.equal(writesTowards(bot._client, 'arm_animation').length, 0)
})

test('client identity: inventory patch installs when plugins are injected late', () => {
  const bot = makeBot(775)
  const injected = bot.setQuickBarSlot
  delete bot.setQuickBarSlot // mineflayer injects plugins after the version ping
  new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot.setQuickBarSlot = injected
  bot.emit('inject_allowed')

  assert.doesNotThrow(() => bot.setQuickBarSlot(-1))
  assert.equal(writesTowards(bot._client, 'held_item_slot').length, 0)
  bot.setQuickBarSlot(2)
  assert.equal(writesTowards(bot._client, 'held_item_slot').length, 1)
})

test('client identity: emulates a falling verification boat', () => {
  const bot = makeBot(775)
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)
  bot._client.state = 'play'

  bot._client.emit('spawn_entity', { entityId: 99, x: 8, y: 3000, z: 8 })
  bot._client.emit('set_passengers', { entityId: 99, passengers: [42] })
  clearInterval(identity.vehicleTimer) // drive ticks manually

  assert.ok(identity.vehicle, 'vehicle detected')
  assert.equal(identity.vehicle.stage, 'boat')

  identity.vehicleTick()
  identity.vehicleTick()
  identity.vehicleTick()

  const moves = writesTowards(bot._client, 'vehicle_move')
  assert.equal(moves.length, 3)
  // First boat move is exactly one boat-gravity step below the spawn altitude.
  assert.ok(Math.abs(moves[0].data.y - (3000 - 0.03999999910593033)) < 1e-12)
  assert.ok(Math.abs((moves[1].data.y - moves[0].data.y) - -0.07999999821186066) < 1e-12)
  assert.equal(writesTowards(bot._client, 'steer_boat').length, 3)
  assert.equal(writesTowards(bot._client, 'look').length, 3)

  identity.stop()
})

test('client identity: never emulates a real low-altitude vehicle', () => {
  const bot = makeBot(775)
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)
  bot._client.state = 'play'

  bot._client.emit('spawn_entity', { entityId: 7, x: 10, y: 64, z: 10 })
  bot._client.emit('set_passengers', { entityId: 7, passengers: [42] })

  assert.equal(identity.vehicle, null)
  assert.equal(writesTowards(bot._client, 'vehicle_move').length, 0)

  identity.stop()
})

test('client identity: sends a falling packet after a verification vehicle dismount', async () => {
  const bot = makeBot(775)
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)
  bot._client.state = 'play'

  bot._client.emit('spawn_entity', { entityId: 99, x: 8, y: 3000, z: 8 })
  bot._client.emit('set_passengers', { entityId: 99, passengers: [42] })
  clearInterval(identity.vehicleTimer)
  identity.vehicleTick() // y drops once
  const lastY = identity.vehicle.y

  bot._client.emit('entity_destroy', { entityIds: [99] })
  assert.equal(identity.vehicle, null)
  assert.equal(identity.vehicleStage, 'minecart')

  await new Promise(resolve => setTimeout(resolve, 180))
  const falling = writesTowards(bot._client, 'position')
  assert.equal(falling.length, 1)
  assert.ok(Math.abs(falling[0].data.y - (lastY - 0.5)) < 1e-12)
  assert.equal(falling[0].data.flags.onGround, false)

  identity.stop()
})

test('client identity: mineflayer movement is muted during vehicle emulation', () => {
  const bot = makeBot(775)
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)
  bot._client.state = 'play'

  bot._client.emit('spawn_entity', { entityId: 99, x: 8, y: 3000, z: 8 })
  bot._client.emit('set_passengers', { entityId: 99, passengers: [42] })
  clearInterval(identity.vehicleTimer)

  // Automatic physics packets must not slip through while emulating.
  bot._client.write('position', { x: 8, y: 116, z: 8, onGround: true })
  bot._client.write('look', { yaw: 1, pitch: 1, flags: { onGround: true } })
  assert.equal(writesTowards(bot._client, 'position').length, 0)
  assert.equal(writesTowards(bot._client, 'look').length, 0)

  identity.stop()
})

test('client identity: transfer packet records the target and ends the connection', () => {
  const bot = makeBot(775)
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)

  bot._client.emit('transfer', { host: 'backend.example.com', port: 25566 })

  assert.deepEqual(identity.transferTarget, { host: 'backend.example.com', port: 25566 })
  assert.equal(bot._client.ended, 'transfer')
  identity.stop()
})

test('client identity: stop() unwinds all handlers and the writeChannel patch', () => {
  const bot = makeBot()
  const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, silentLogger)
  const patched = bot._client.writeChannel

  identity.stop()
  assert.notEqual(bot._client.writeChannel, patched)

  bot._client.emit('state', 'configuration', 'play')
  bot.emit('physicsTick')
  bot._client.emit('select_known_packs', { packs: [] })
  assert.deepEqual(bot._client.writes, [])
})

test('viewDistanceChunks maps names and passes numbers through', () => {
  assert.equal(viewDistanceChunks('tiny'), 6)
  assert.equal(viewDistanceChunks('short'), 8)
  assert.equal(viewDistanceChunks('normal'), 10)
  assert.equal(viewDistanceChunks('far'), 12)
  assert.equal(viewDistanceChunks(18), 18)
})

test('config: client section defaults are vanilla', () => {
  const config = normalizeConfig({})
  assert.deepEqual(config.client, {
    enabled: true,
    brand: 'vanilla',
    viewDistance: 'normal',
    locale: 'en_US'
  })
})

test('config: client section accepts overrides and normalizes them', () => {
  const config = normalizeConfig({
    client: { brand: 'Siftbot 26.1', viewDistance: 'FAR', locale: 'en_us' }
  })
  assert.equal(config.client.brand, 'Siftbot 26.1')
  assert.equal(config.client.viewDistance, 'far')
  assert.equal(config.client.locale, 'en_us')

  const numeric = normalizeConfig({ client: { viewDistance: 16 } })
  assert.equal(numeric.client.viewDistance, 16)
})

test('config: invalid client values are rejected', () => {
  assert.throws(() => normalizeConfig({ client: { brand: '' } }), /brand/)
  assert.throws(() => normalizeConfig({ client: { brand: 42 } }), /brand/)
  assert.throws(() => normalizeConfig({ client: { brand: 'x'.repeat(65) } }), /at most 64/)
  assert.throws(() => normalizeConfig({ client: { viewDistance: 'ultra' } }), /viewDistance/)
  assert.throws(() => normalizeConfig({ client: { viewDistance: 1 } }), /viewDistance/)
  assert.throws(() => normalizeConfig({ client: { viewDistance: 33 } }), /viewDistance/)
  assert.throws(() => normalizeConfig({ client: { locale: 'e' } }), /locale/)
  assert.throws(() => normalizeConfig({ client: { enabled: 'maybe' } }), /client\.enabled/)
})
