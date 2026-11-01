import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_RETRIES = 2
const MAX_PENDING = 100

function isLoopback (hostname) {
  const host = String(hostname).toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

export function validateWebhookUrl (value, { allowInsecure = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('webhook url must be a string of 1-2048 characters')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('webhook url is not a valid absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('webhook url must use https')
  }
  if (url.username || url.password) {
    throw new Error('webhook url must not contain credentials')
  }
  if (url.protocol === 'http:' && !(allowInsecure && isLoopback(url.hostname))) {
    throw new Error('http webhooks are only allowed for loopback when insecure webhooks are enabled')
  }
  return url.toString()
}

function normalizeEvents (events) {
  if (events === undefined) return ['*']
  if (!Array.isArray(events) || events.length === 0 || events.length > 32) {
    throw new Error('events must be a non-empty array of at most 32 patterns')
  }
  return events.map(pattern => {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 64) {
      throw new Error('each event pattern must be a string of 1-64 characters')
    }
    return pattern
  })
}

function matchesPattern (pattern, type) {
  if (pattern === '*') return true
  if (pattern === 'instance') return type.startsWith('instance.')
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

function publicWebhook (webhook) {
  return {
    id: webhook.id,
    url: webhook.url,
    description: webhook.description,
    events: webhook.events,
    instanceId: webhook.instanceId,
    active: webhook.active,
    createdAt: webhook.createdAt,
    hasSecret: true,
    lastDeliveryAt: webhook.lastDeliveryAt,
    lastStatus: webhook.lastStatus,
    lastError: webhook.lastError,
    failureCount: webhook.failureCount
  }
}

/**
 * Persistent webhook subscriptions plus signed, retrying delivery.
 * Every event from the hub is considered; each subscription can filter by
 * event pattern and instance id.
 */
export class WebhookService {
  constructor ({
    file,
    hub,
    logger,
    allowInsecure = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  }) {
    this.file = file
    this.hub = hub
    this.logger = logger
    this.allowInsecure = allowInsecure
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.webhooks = new Map()
    this.controllers = new Set()
    this.stopped = false
    this.onEvent = event => {
      try {
        this.dispatch(event)
      } catch (err) {
        this.logger?.error?.(`webhook dispatch failed: ${err.message}`)
      }
    }
    this.load()
    hub.on('event', this.onEvent)
  }

  load () {
    if (!fs.existsSync(this.file)) return
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (!raw || !Array.isArray(raw.webhooks)) {
      throw new Error(`${this.file} must contain a "webhooks" array`)
    }
    for (const entry of raw.webhooks) {
      try {
        const webhook = {
          id: entry.id ?? randomUUID(),
          url: validateWebhookUrl(entry.url, { allowInsecure: this.allowInsecure }),
          description: String(entry.description ?? '').slice(0, 160),
          events: normalizeEvents(entry.events),
          instanceId: entry.instanceId ?? null,
          active: entry.active !== false,
          secret: typeof entry.secret === 'string' && entry.secret.length >= 16
            ? entry.secret
            : randomBytes(24).toString('hex'),
          createdAt: entry.createdAt ?? new Date().toISOString(),
          lastDeliveryAt: entry.lastDeliveryAt ?? null,
          lastStatus: entry.lastStatus ?? null,
          lastError: entry.lastError ?? null,
          failureCount: Number.isInteger(entry.failureCount) ? entry.failureCount : 0,
          queue: Promise.resolve(),
          pending: 0
        }
        this.webhooks.set(webhook.id, webhook)
      } catch (err) {
        this.logger?.warn?.(`ignoring invalid webhook ${entry.id ?? '(no id)'}: ${err.message}`)
      }
    }
  }

  save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const payload = {
      version: 1,
      webhooks: [...this.webhooks.values()].map(webhook => ({
        id: webhook.id,
        url: webhook.url,
        description: webhook.description,
        events: webhook.events,
        instanceId: webhook.instanceId,
        active: webhook.active,
        secret: webhook.secret,
        createdAt: webhook.createdAt
      }))
    }
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  list () {
    return [...this.webhooks.values()].map(publicWebhook)
  }

  get (id) {
    return publicWebhook(this.require(id))
  }

  require (id) {
    const webhook = this.webhooks.get(id)
    if (!webhook) throw new Error(`Unknown webhook: ${id}`)
    return webhook
  }

  add ({ url, description = '', events, instanceId = null, secret = null, active = true }) {
    const cleanUrl = validateWebhookUrl(url, { allowInsecure: this.allowInsecure })
    if (secret != null && (typeof secret !== 'string' || secret.length < 16 || secret.length > 128)) {
      throw new Error('secret must be a string of 16-128 characters, or omitted to generate one')
    }
    const webhook = {
      id: randomUUID(),
      url: cleanUrl,
      description: String(description).slice(0, 160),
      events: normalizeEvents(events),
      instanceId: instanceId || null,
      active: Boolean(active),
      secret: secret ?? randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
      lastDeliveryAt: null,
      lastStatus: null,
      lastError: null,
      failureCount: 0,
      queue: Promise.resolve(),
      pending: 0
    }
    this.webhooks.set(webhook.id, webhook)
    this.save()
    return { ...publicWebhook(webhook), secret: webhook.secret }
  }

  update (id, patch) {
    const webhook = this.require(id)
    if (patch.url !== undefined) {
      webhook.url = validateWebhookUrl(patch.url, { allowInsecure: this.allowInsecure })
    }
    if (patch.description !== undefined) {
      webhook.description = String(patch.description).slice(0, 160)
    }
    if (patch.events !== undefined) {
      webhook.events = normalizeEvents(patch.events)
    }
    if (patch.instanceId !== undefined) {
      webhook.instanceId = patch.instanceId || null
    }
    if (patch.active !== undefined) {
      webhook.active = Boolean(patch.active)
    }
    this.save()
    return publicWebhook(webhook)
  }

  remove (id) {
    this.require(id)
    this.webhooks.delete(id)
    this.save()
  }

  async test (id) {
    const webhook = this.require(id)
    const event = {
      id: 0,
      type: 'test',
      at: new Date().toISOString(),
      instanceId: webhook.instanceId,
      data: { message: 'siftbot webhook test' }
    }
    return this.deliver(webhook, event, { attempts: 1 })
  }

  stop () {
    this.stopped = true
    this.hub.off('event', this.onEvent)
    for (const controller of this.controllers) {
      try {
        controller.abort()
      } catch {
        // Ignore.
      }
    }
    this.controllers.clear()
  }

  dispatch (event) {
    if (this.stopped) return
    for (const webhook of this.webhooks.values()) {
      if (!webhook.active) continue
      if (webhook.instanceId && webhook.instanceId !== event.instanceId) continue
      if (!webhook.events.some(pattern => matchesPattern(pattern, event.type))) continue

      if (webhook.pending >= MAX_PENDING) {
        this.logger?.warn?.(`webhook ${webhook.id} queue is full; dropping ${event.type} event`)
        continue
      }

      webhook.pending += 1
      webhook.queue = webhook.queue
        .then(() => this.deliver(webhook, event))
        .catch(err => {
          this.logger?.error?.(`webhook ${webhook.id} delivery crashed: ${err.message}`)
        })
        .finally(() => {
          webhook.pending -= 1
        })
    }
  }

  async deliver (webhook, event, { attempts = DEFAULT_RETRIES + 1 } = {}) {
    if (this.stopped) return { delivered: false, error: 'service stopped' }

    const payload = {
      id: randomUUID(),
      type: event.type,
      sequence: event.id,
      createdAt: new Date().toISOString(),
      instanceId: event.instanceId ?? null,
      data: event.data
    }
    const body = JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = createHmac('sha256', webhook.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')

    let lastError = null
    let lastStatus = null

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.stopped) break
      const controller = new AbortController()
      this.controllers.add(controller)
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      timer.unref?.()

      try {
        const response = await this.fetchImpl(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'siftbot-webhook/1',
            'x-siftbot-event': event.type,
            'x-siftbot-delivery': payload.id,
            'x-siftbot-timestamp': timestamp,
            'x-siftbot-signature': `sha256=${signature}`
          },
          body,
          redirect: 'manual',
          signal: controller.signal
        })

        lastStatus = response.status
        try {
          await response.body?.cancel?.()
        } catch {
          // Ignore a body that is already closed.
        }
        if (response.ok) {
          webhook.lastDeliveryAt = new Date().toISOString()
          webhook.lastStatus = response.status
          webhook.lastError = null
          webhook.failureCount = 0
          this.logger?.debug?.(`webhook ${webhook.id} delivered ${event.type} (${response.status})`)
          return { delivered: true, status: response.status, deliveryId: payload.id }
        }

        lastError = `HTTP ${response.status}`
        if (response.status < 500 && response.status !== 429) break
      } catch (err) {
        lastError = err?.name === 'AbortError' ? 'timeout' : (err?.message ?? String(err))
      } finally {
        clearTimeout(timer)
        this.controllers.delete(controller)
      }

      if (attempt < attempts - 1) {
        const delay = 500 * 2 ** attempt
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delay)
          timer.unref?.()
        })
      }
    }

    webhook.lastDeliveryAt = new Date().toISOString()
    webhook.lastStatus = lastStatus
    webhook.lastError = lastError
    webhook.failureCount += 1
    this.logger?.warn?.(`webhook ${webhook.id} delivery failed for ${event.type}: ${lastError}`)
    return { delivered: false, status: lastStatus, error: lastError, deliveryId: payload.id }
  }
}
