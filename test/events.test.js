import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InstanceManager } from '../src/instances.js'
import { EventHub } from '../src/api/events.js'
import { defaultConfig } from '../src/config.js'

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-events-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('emits records and deduplicates status events', t => {
  const dir = tempDir(t)
  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()
  const instance = manager.add({
    label: 'Events',
    config: { ...defaultConfig(), username: 'events', host: 'events.example.com' }
  })

  const hub = new EventHub({ manager, statusIntervalMs: 0 })
  hub.start()
  t.after(() => hub.stop())

  const events = []
  hub.on('event', event => events.push(event))

  manager.pushRecord(instance, { time: Date.now(), level: 'info', kind: 'chat', text: 'hello' })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'record')
  assert.equal(events[0].instanceId, instance.id)
  assert.equal(events[0].data.seq, 1)
  assert.equal(events[0].id, 1)

  // The initial keys were populated in start(), so no status event yet.
  assert.equal(events.filter(event => event.type === 'status').length, 0)

  instance.config.autoEat.enabled = false
  hub.refreshStatus()
  const statuses = events.filter(event => event.type === 'status')
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].data.details.autoEatEnabled, false)

  hub.refreshStatus()
  assert.equal(events.filter(event => event.type === 'status').length, 1)

  const replay = hub.replay({ after: 0, instanceId: instance.id })
  assert.equal(replay.length, 2)
  assert.deepEqual(replay.map(event => event.type), ['record', 'status'])
})

test('snapshot redacts secrets and can be scoped to one instance', t => {
  const dir = tempDir(t)
  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()
  const first = manager.add({
    label: 'First',
    config: { ...defaultConfig(), username: 'first', password: 'hunter2' }
  })
  manager.add({
    label: 'Second',
    config: { ...defaultConfig(), username: 'second' }
  })

  const hub = new EventHub({ manager, statusIntervalMs: 0 })
  hub.start()
  t.after(() => hub.stop())

  const scoped = hub.snapshot({ instanceId: first.id })
  assert.equal(scoped.instances.length, 1)
  assert.equal(scoped.instances[0].id, first.id)
  assert.equal(scoped.instances[0].config.password, '***')
  assert.equal(scoped.instances[0].hasPassword, true)

  const all = hub.snapshot()
  assert.equal(all.instances.length, 2)
})
