import { EventEmitter } from 'node:events'
import { instanceDetail, instanceStatus } from './serialize.js'

function round (value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function statusKey (status) {
  const details = status.details
  return JSON.stringify({
    status: status.status,
    fatal: status.fatal,
    connected: details.connected,
    gameMode: details.gameMode,
    dimension: details.dimension,
    version: details.version,
    health: round(details.health),
    food: round(details.food),
    saturation: round(details.saturation),
    position: details.position
      ? [round(details.position.x), round(details.position.y), round(details.position.z)]
      : null,
    players: details.players,
    heldItem: details.heldItem,
    sneak: details.sneak,
    eating: details.eating,
    autoEat: details.autoEatEnabled,
    afk: details.afkEnabled,
    reconnectAttempt: details.reconnectAttempt
  })
}

/**
 * Monotonic event log used by both SSE clients and webhook subscribers.
 * Events have a global id; log records also carry their per-instance seq.
 */
export class EventHub extends EventEmitter {
  constructor ({ manager, maxEvents = 2000, statusIntervalMs = 1000 }) {
    super()
    this.manager = manager
    this.maxEvents = maxEvents
    this.statusIntervalMs = statusIntervalMs
    this.events = []
    this.seq = 0
    this.started = false
    this.timer = null
    this.changeTimer = null
    this.statusKeys = new Map()

    this.onRecord = (instance, record) => {
      this.publish('record', record, { instanceId: instance.id })
    }
    this.onChange = () => this.scheduleRefresh()
  }

  start () {
    if (this.started) return
    this.started = true
    this.manager.on('record', this.onRecord)
    this.manager.on('change', this.onChange)
    this.refreshStatus({ emit: false })
    if (this.statusIntervalMs > 0) {
      this.timer = setInterval(() => this.refreshStatus(), this.statusIntervalMs)
      this.timer.unref?.()
    }
  }

  stop () {
    this.started = false
    this.manager.off('record', this.onRecord)
    this.manager.off('change', this.onChange)
    clearInterval(this.timer)
    clearTimeout(this.changeTimer)
    this.timer = null
    this.changeTimer = null
  }

  get lastEventId () {
    return this.seq
  }

  publish (type, data, { instanceId = null } = {}) {
    const event = {
      id: ++this.seq,
      type,
      at: new Date().toISOString(),
      instanceId,
      data
    }
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    this.emit('event', event)
    return event
  }

  snapshot ({ instanceId = null } = {}) {
    const instances = this.manager.list()
      .filter(instance => instanceId == null || instance.id === instanceId)
      .map(instance => ({
        ...instanceDetail(this.manager, instance),
        details: this.manager.details(instance)
      }))
    return {
      at: new Date().toISOString(),
      lastEventId: this.seq,
      instances
    }
  }

  replay ({ after = 0, instanceId = null, limit = 1000 } = {}) {
    return this.events
      .filter(event => event.id > after)
      .filter(event => instanceId == null || event.instanceId === instanceId)
      .slice(-limit)
  }

  scheduleRefresh () {
    if (!this.started || this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.refreshStatus()
    }, 50)
    this.changeTimer.unref?.()
  }

  refreshStatus ({ emit = true } = {}) {
    if (!this.started) return
    const seen = new Set()
    for (const instance of this.manager.list()) {
      seen.add(instance.id)
      const status = instanceStatus(this.manager, instance)
      const key = statusKey(status)
      if (this.statusKeys.get(instance.id) === key) continue
      this.statusKeys.set(instance.id, key)
      if (emit) this.publish('status', status, { instanceId: instance.id })
    }
    for (const id of this.statusKeys.keys()) {
      if (!seen.has(id)) this.statusKeys.delete(id)
    }
  }
}
