import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProgress, parseTarget } from '../plugins/border-walker.js'

test('parseTarget maps corners against the border', () => {
  assert.deepEqual(parseTarget('ne'), { corner: 'ne', x: 39000, z: -39000 })
  assert.deepEqual(parseTarget('sw'), { corner: 'sw', x: -39000, z: 39000 })
  assert.deepEqual(parseTarget('se', { border: 40000, margin: 1500 }), { corner: 'se', x: 38500, z: 38500 })
  assert.deepEqual(parseTarget('100,-200'), { corner: 'custom', x: 100, z: -200 })
  assert.throws(() => parseTarget('middle'), /usage/)
})

test('buildProgress reports distance, speed, eta and vitals', () => {
  const state = {
    username: 'manchulla',
    server: 'play.example.com:25565',
    corner: 'ne',
    target: { x: 39000, z: -39000 },
    position: { x: 38000, y: 64, z: -38000 },
    travelled: 12345,
    speed: 5,
    health: 20,
    food: 17,
    sprinting: true,
    eating: false,
    status: 'walking',
    startedAt: Date.now() - 60000,
    trail: [{ t: 1, x: 38000, z: -38000 }]
  }
  const progress = buildProgress(state)
  assert.equal(progress.plugin, 'border-walker')
  assert.equal(progress.username, 'manchulla')
  assert.ok(Math.abs(progress.distance - Math.hypot(1000, 1000)) < 1e-6)
  assert.equal(progress.etaSeconds, progress.distance / 5)
  assert.equal(progress.trail.length, 1)
  assert.equal(progress.status, 'walking')
  assert.ok(progress.updatedAt)
})

test('buildProgress has no eta when stopped', () => {
  const state = {
    username: 'a', server: 'h:1', corner: 'ne', target: { x: 10, z: 10 },
    position: { x: 0, y: 64, z: 0 }, travelled: 0, speed: 0,
    health: 20, food: 20, sprinting: false, eating: false, status: 'stopped',
    startedAt: Date.now(), trail: []
  }
  assert.equal(buildProgress(state).etaSeconds, null)
})
