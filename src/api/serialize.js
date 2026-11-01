import { redactConfig } from '../config.js'

function iso (time) {
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function instanceSummary (manager, instance) {
  return {
    id: instance.id,
    label: instance.label,
    status: manager.statusOf(instance),
    fatal: instance.fatal,
    startedAt: iso(instance.startedAt),
    connection: {
      username: instance.config.username,
      host: instance.config.host,
      port: instance.config.port,
      auth: instance.config.auth,
      version: instance.config.version || 'auto'
    },
    features: {
      autoEat: instance.config.autoEat.enabled,
      sneak: instance.config.sneak.enabled,
      afk: instance.config.afk.enabled,
      client: instance.config.client.enabled
    },
    hasPassword: Boolean(instance.config.password),
    lastRecordSeq: instance.recordSeq
  }
}

export function instanceConfig (instance, { reveal = false } = {}) {
  if (reveal) return JSON.parse(JSON.stringify(instance.config))
  return redactConfig(instance.config)
}

export function instanceDetail (manager, instance, { reveal = false } = {}) {
  return {
    ...instanceSummary(manager, instance),
    config: instanceConfig(instance, { reveal }),
    details: manager.details(instance)
  }
}

export function instanceStatus (manager, instance) {
  return {
    ...instanceSummary(manager, instance),
    details: manager.details(instance)
  }
}

export function recordsFor (instance, { since = 0, limit = 100 } = {}) {
  const records = instance.records.filter(record => record.seq > since)
  return records.slice(-limit)
}
