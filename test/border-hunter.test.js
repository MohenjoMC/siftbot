import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateLocation, findSlot, foldLabel } from '../plugins/border-hunter.js'

const GROUND = { name: 'grass_block', safe: true }

test('a landing 1-2k inside the border is in the window', () => {
  const spot = evaluateLocation({ x: 38500, z: 1200, ground: GROUND, biome: 'minecraft:plains' })
  assert.equal(spot.edgeDistance, 1500)
  assert.equal(spot.inWindow, true)
  assert.equal(spot.safeGround, true)
  assert.equal(spot.goodBiome, true)
})

test('closer to the border scores higher within the window', () => {
  const near = evaluateLocation({ x: 39000, z: 0, ground: GROUND, biome: 'minecraft:plains' })
  const far = evaluateLocation({ x: 38000, z: 0, ground: GROUND, biome: 'minecraft:plains' })
  assert.equal(near.inWindow, true)
  assert.equal(far.inWindow, true)
  assert.ok(near.score > far.score)
})

test('landings away from the border are not in the window', () => {
  const middle = evaluateLocation({ x: 0, z: 0, ground: GROUND, biome: 'minecraft:plains' })
  const justOutside = evaluateLocation({ x: 37000, z: 0, ground: GROUND, biome: 'minecraft:plains' })
  assert.equal(middle.inWindow, false)
  assert.equal(justOutside.inWindow, false)
  assert.ok(justOutside.score > middle.score)
})

test('unsafe ground and bad biomes are penalised', () => {
  const good = evaluateLocation({ x: 38500, z: 0, ground: GROUND, biome: 'minecraft:forest' })
  const lava = evaluateLocation({ x: 38500, z: 0, ground: { name: 'lava', safe: false }, biome: 'minecraft:forest' })
  const ocean = evaluateLocation({ x: 38500, z: 0, ground: GROUND, biome: 'minecraft:ocean' })
  assert.ok(good.score > lava.score)
  assert.ok(good.score > ocean.score)
  assert.equal(lava.safeGround, false)
  assert.equal(ocean.goodBiome, false)
})

test('missing ground or biome is handled', () => {
  const spot = evaluateLocation({ x: 38500, z: 0, ground: null, biome: null })
  assert.equal(spot.safeGround, false)
  assert.equal(spot.goodBiome, true)
  assert.equal(spot.inWindow, true)
})

test('foldLabel normalises stylised menu labels', () => {
  assert.equal(foldLabel('ʜᴏᴍᴇs & ᴛᴇʟᴇᴘᴏʀᴛs'), 'homes teleports')
  assert.equal(foldLabel('Random Teleport'), 'random teleport')
  assert.equal(foldLabel('ɢᴇᴛᴛɪɴɢ sᴛᴀʀᴛᴇᴅ'), 'getting started')
})

test('findSlot locates menu entries by folded label', () => {
  const slots = []
  slots[11] = { name: 'compass', count: 1, customName: { type: 'compound', value: { text: { type: 'string', value: 'ɢᴇᴛᴛɪɴɢ sᴛᴀʀᴛᴇᴅ' } } } }
  slots[24] = { name: 'ender_pearl', count: 1, customName: { type: 'compound', value: { text: { type: 'string', value: 'ʜᴏᴍᴇs & ᴛᴇʟᴇᴘᴏʀᴛs' } } } }
  const window = { slots }

  assert.equal(findSlot(window, /homes/), 24)
  assert.equal(findSlot(window, /getting started/), 11)
  assert.equal(findSlot(window, /random teleport/), -1)
  assert.equal(findSlot({ slots: [] }, /anything/), -1)
})
