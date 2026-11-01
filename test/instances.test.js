import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InstanceManager } from '../src/instances.js'
import { defaultConfig } from '../src/config.js'

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-instances-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function baseConfig (overrides = {}) {
  return { ...defaultConfig(), ...overrides }
}

test('adds, persists and reloads instances', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'instances.json')
  const manager = new InstanceManager({ file })
  manager.load()

  const instance = manager.add({
    label: 'Builder',
    config: baseConfig({ username: 'builder', host: 'one.example.com' })
  })
  assert.ok(instance.id)
  assert.equal(manager.list().length, 1)
  assert.equal(instance.label, 'Builder')

  const reloaded = new InstanceManager({ file })
  reloaded.load()
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].id, instance.id)
  assert.equal(reloaded.list()[0].config.host, 'one.example.com')
})

test('defaults the label to the username and validates config', t => {
  const dir = tempDir(t)
  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()

  const instance = manager.add({ config: baseConfig({ username: 'quietbot' }) })
  assert.equal(instance.label, 'quietbot')
  assert.throws(
    () => manager.add({ config: baseConfig({ username: 'bad name' }) }),
    /username must be/
  )
  assert.equal(manager.list().length, 1)
})

test('updates labels and removes instances', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'instances.json')
  const manager = new InstanceManager({ file })
  manager.load()

  const instance = manager.add({ config: baseConfig({ username: 'one' }) })
  manager.update(instance.id, {
    label: 'Renamed',
    config: baseConfig({ username: 'one', host: 'two.example.com' })
  })
  assert.equal(manager.get(instance.id).label, 'Renamed')
  assert.equal(manager.get(instance.id).config.host, 'two.example.com')

  await manager.remove(instance.id)
  assert.equal(manager.list().length, 0)

  const reloaded = new InstanceManager({ file })
  reloaded.load()
  assert.equal(reloaded.list().length, 0)
})

test('adopts a legacy config.json on first load', t => {
  const dir = tempDir(t)
  const config = baseConfig({ username: 'legacy', host: 'legacy.example.com' })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))

  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()
  assert.equal(manager.list().length, 1)
  assert.equal(manager.list()[0].config.host, 'legacy.example.com')
  assert.equal(manager.list()[0].label, 'legacy')
  assert.ok(fs.existsSync(path.join(dir, 'instances.json')))
})

test('reports offline status and defaults for a stopped instance', t => {
  const dir = tempDir(t)
  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()
  const instance = manager.add({ config: baseConfig({ username: 'offline' }) })

  assert.equal(manager.statusOf(instance), 'offline')
  const details = manager.details(instance)
  assert.equal(details.connected, false)
  assert.equal(details.host, 'localhost')
  assert.equal(details.username, 'offline')
  assert.throws(() => manager.require('missing'), /Unknown bot instance/)
})

test('keeps only the newest console records', t => {
  const dir = tempDir(t)
  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()
  const instance = manager.add({ config: baseConfig({ username: 'logs' }) })

  for (let i = 0; i < 900; i++) {
    manager.pushRecord(instance, {
      time: Date.now(),
      level: 'info',
      kind: 'output',
      text: `line ${i}`
    })
  }
  assert.equal(instance.records.length, 800)
  assert.equal(instance.records[799].text, 'line 899')
  assert.equal(instance.records[0].text, 'line 100')
})
