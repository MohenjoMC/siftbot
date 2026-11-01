import http from 'node:http'
import https from 'node:https'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { instanceDetail, instanceSummary, recordsFor } from './serialize.js'

const PREFIX = '/api/v1'
const MAX_BODY_BYTES = 1024 * 1024
const HEARTBEAT_MS = 15000
const MAX_SSE_BUFFER = 2 * 1024 * 1024

class ApiError extends Error {
  constructor (status, code, message, headers = {}) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
  }
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge (base, patch) {
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? deepMerge(out[key], value)
      : value
  }
  return out
}

function safeEqual (a, b) {
  const left = createHash('sha256').update(String(a)).digest()
  const right = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(left, right)
}

function parseInteger (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) return fallback
  return number
}

export class ApiServer {
  constructor ({
    manager,
    hub,
    webhooks,
    token,
    host = '127.0.0.1',
    port = 8787,
    tls = null,
    logger = null,
    version = '1.0.0'
  }) {
    if (typeof token !== 'string' || token.length < 16) {
      throw new Error('API token must be at least 16 characters')
    }
    if (tls && (!tls.key || !tls.cert)) {
      throw new Error('TLS requires both a key and a certificate')
    }

    this.manager = manager
    this.hub = hub
    this.webhooks = webhooks
    this.token = token
    this.host = host
    this.port = port
    this.tls = tls
    this.logger = logger
    this.version = version
    this.clients = new Set()
    this.heartbeat = null
    this.listening = false

    const handler = (req, res) => { void this.handle(req, res) }
    this.server = tls
      ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, handler)
      : http.createServer(handler)

    this.server.headersTimeout = 15000
    this.server.keepAliveTimeout = 65000
    this.server.on('error', err => this.logger?.error?.(`api server: ${err.message}`))
  }

  get protocol () {
    return this.tls ? 'https' : 'http'
  }

  get url () {
    const address = this.server.address()
    const port = typeof address === 'object' && address ? address.port : this.port
    let host = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host
    if (host.includes(':')) host = `[${host}]`
    return `${this.protocol}://${host}:${port}`
  }

  async start () {
    if (this.listening) return this
    await new Promise((resolve, reject) => {
      const onError = err => {
        this.server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.port, this.host)
    })
    this.listening = true
    this.heartbeat = setInterval(() => this.pingClients(), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    return this
  }

  async stop () {
    clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) {
      try {
        client.res.end()
      } catch {
        // Ignore.
      }
    }
    this.clients.clear()
    if (!this.listening) return
    this.listening = false
    await new Promise(resolve => {
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
  }

  pingClients () {
    for (const client of this.clients) {
      try {
        if (!client.res.writableEnded) client.res.write(`: ping ${Date.now()}\n\n`)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  isAuthorized (req, url) {
    const header = req.headers.authorization
    let supplied = null
    if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
      supplied = header.replace(/^Bearer\s+/i, '').trim()
    } else if (typeof req.headers['x-siftbot-token'] === 'string') {
      supplied = req.headers['x-siftbot-token']
    } else if (url && url.searchParams.has('token')) {
      supplied = url.searchParams.get('token')
    }
    return Boolean(supplied) && safeEqual(supplied, this.token)
  }

  async handle (req, res) {
    const requestId = randomUUID()
    res.setHeader('x-request-id', requestId)
    res.setHeader('x-siftbot-version', this.version)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')

    let url
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
      this.logger?.debug?.(`api ${req.method} ${url.pathname}`)
      await this.route(req, res, url, requestId)
    } catch (err) {
      this.respondError(res, err, requestId)
    }
  }

  respondError (res, err, requestId) {
    if (res.writableEnded) return
    const status = err instanceof ApiError ? err.status : 500
    const code = err instanceof ApiError ? err.code : 'internal_error'
    const message = err instanceof ApiError ? err.message : 'internal server error'
    if (!(err instanceof ApiError)) {
      this.logger?.error?.(`api error: ${err?.stack ?? err}`)
    }
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        // Ignore.
      }
      return
    }
    const headers = { ...(err?.headers ?? {}) }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    })
    res.end(JSON.stringify({
      error: { code, message, requestId }
    }))
  }

  sendJson (res, status, payload, headers = {}) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    })
    if (status === 204) {
      res.end()
      return
    }
    res.end(JSON.stringify(payload))
  }

  async readJson (req) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json')
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        throw new ApiError(413, 'payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes`)
      }
      chunks.push(chunk)
    }
    if (size === 0) return {}
    let parsed
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON')
    }
    if (!isPlainObject(parsed)) {
      throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object')
    }
    return parsed
  }

  requireMethod (req, ...methods) {
    if (!methods.includes(req.method)) {
      throw new ApiError(405, 'method_not_allowed', `Expected ${methods.join(' or ')}`, {
        allow: methods.join(', ')
      })
    }
  }

  requireInstance (id) {
    const instance = this.manager.get(id)
    if (!instance) throw new ApiError(404, 'instance_not_found', `Unknown bot instance: ${id}`)
    return instance
  }

  requireWebhook (id) {
    try {
      return this.webhooks.get(id)
    } catch {
      throw new ApiError(404, 'webhook_not_found', `Unknown webhook: ${id}`)
    }
  }

  async route (req, res, url, requestId) {
    if (url.pathname === '/healthz') {
      this.requireMethod(req, 'GET')
      this.sendJson(res, 200, {
        ok: true,
        service: 'siftbot',
        version: this.version,
        time: new Date().toISOString()
      })
      return
    }

    if (!url.pathname.startsWith(PREFIX)) {
      throw new ApiError(404, 'not_found', 'Not found')
    }

    const relative = url.pathname.slice(PREFIX.length)
    let parts
    try {
      parts = relative.split('/').filter(Boolean).map(part => decodeURIComponent(part))
    } catch {
      throw new ApiError(400, 'invalid_path', 'Path contains invalid percent-encoding')
    }
    const isStream = parts[0] === 'events' ||
      (parts[0] === 'instances' && parts.length === 3 && parts[2] === 'events')

    if (!this.isAuthorized(req, isStream ? url : null)) {
      throw new ApiError(401, 'unauthorized', 'A valid API token is required', {
        'www-authenticate': 'Bearer'
      })
    }

    if (parts.length === 0) {
      this.requireMethod(req, 'GET')
      this.sendJson(res, 200, {
        name: 'siftbot',
        version: this.version,
        apiVersion: 'v1',
        protocol: this.protocol,
        capabilities: {
          sse: true,
          webhooks: true,
          tls: Boolean(this.tls)
        },
        links: {
          instances: `${PREFIX}/instances`,
          events: `${PREFIX}/events`,
          webhooks: `${PREFIX}/webhooks`,
          docs: 'docs/API.md'
        },
        serverTime: new Date().toISOString()
      })
      return
    }

    if (parts[0] === 'events' && parts.length === 1) {
      this.requireMethod(req, 'GET')
      this.openStream(req, res, url, requestId, null)
      return
    }

    if (parts[0] === 'instances') {
      await this.routeInstances(req, res, url, parts, requestId)
      return
    }

    if (parts[0] === 'webhooks') {
      await this.routeWebhooks(req, res, url, parts, requestId)
      return
    }

    throw new ApiError(404, 'not_found', 'Not found')
  }

  async routeInstances (req, res, url, parts, requestId) {
    const id = parts[1]

    if (!id) {
      if (req.method === 'GET') {
        this.sendJson(res, 200, {
          instances: this.manager.list().map(instance => instanceSummary(this.manager, instance))
        })
        return
      }
      if (req.method === 'POST') {
        const body = await this.readJson(req)
        if (!isPlainObject(body.config)) {
          throw new ApiError(400, 'invalid_body', 'config must be an object')
        }
        if (body.label !== undefined && typeof body.label !== 'string') {
          throw new ApiError(400, 'invalid_body', 'label must be a string')
        }
        let instance
        try {
          instance = this.manager.add({ label: body.label, config: body.config })
        } catch (err) {
          if (err.name !== 'ConfigError' && err.code) throw err
          throw new ApiError(400, 'invalid_config', err.message)
        }
        const detail = instanceDetail(this.manager, instance)
        this.hub.publish('instance.created', detail, { instanceId: instance.id })
        this.sendJson(res, 201, { instance: detail }, {
          location: `${PREFIX}/instances/${encodeURIComponent(instance.id)}`
        })
        return
      }
      throw new ApiError(405, 'method_not_allowed', 'Expected GET or POST', { allow: 'GET, POST' })
    }

    const instance = this.requireInstance(id)

    if (parts.length === 2) {
      if (req.method === 'GET') {
        const reveal = url.searchParams.get('reveal') === 'true'
        this.sendJson(res, 200, { instance: instanceDetail(this.manager, instance, { reveal }) })
        return
      }
      if (req.method === 'PATCH') {
        const body = await this.readJson(req)
        if (body.label !== undefined && typeof body.label !== 'string') {
          throw new ApiError(400, 'invalid_body', 'label must be a string')
        }
        if (body.config !== undefined && !isPlainObject(body.config)) {
          throw new ApiError(400, 'invalid_body', 'config must be an object')
        }
        if (body.label === undefined && body.config === undefined) {
          throw new ApiError(400, 'invalid_body', 'Provide label and/or config')
        }

        let config = instance.config
        if (body.config !== undefined) {
          const patch = JSON.parse(JSON.stringify(body.config))
          if (patch.password === null || patch.password === '***') delete patch.password
          config = deepMerge(instance.config, patch)
        }

        let updated
        try {
          updated = this.manager.update(id, { label: body.label, config })
        } catch (err) {
          if (/Stop the bot before editing/.test(err.message)) {
            throw new ApiError(409, 'conflict', err.message)
          }
          if (err.name !== 'ConfigError' && err.code) throw err
          throw new ApiError(400, 'invalid_config', err.message)
        }
        const detail = instanceDetail(this.manager, updated)
        this.hub.publish('instance.updated', detail, { instanceId: id })
        this.sendJson(res, 200, { instance: detail })
        return
      }
      if (req.method === 'DELETE') {
        await this.manager.remove(id)
        this.hub.publish('instance.deleted', { id }, { instanceId: id })
        this.sendJson(res, 204, null)
        return
      }
      throw new ApiError(405, 'method_not_allowed', 'Expected GET, PATCH or DELETE', {
        allow: 'GET, PATCH, DELETE'
      })
    }

    if (parts.length === 3 && parts[2] === 'input') {
      this.requireMethod(req, 'POST')
      if (!instance.commands) throw new ApiError(409, 'offline', 'Start this bot first')
      const body = await this.readJson(req)
      if (typeof body.line !== 'string' || body.line.trim() === '') {
        throw new ApiError(400, 'invalid_body', 'line must be a non-empty string')
      }
      if (body.line.length > 1000) {
        throw new ApiError(400, 'invalid_body', 'line must be at most 1000 characters')
      }
      if (/[\r\n]/.test(body.line)) {
        throw new ApiError(400, 'invalid_body', 'line must not contain newlines')
      }
      try {
        await this.manager.send(id, body.line.trim())
      } catch (err) {
        throw new ApiError(409, 'conflict', err.message)
      }
      this.sendJson(res, 202, { accepted: true })
      return
    }

    if (parts.length === 3 && parts[2] === 'logs') {
      if (req.method === 'GET') {
        const since = parseInteger(url.searchParams.get('since'), 0, { min: 0 })
        const limit = parseInteger(url.searchParams.get('limit'), 100, { min: 1, max: 800 })
        this.sendJson(res, 200, {
          instanceId: id,
          records: recordsFor(instance, { since, limit }),
          lastSeq: instance.recordSeq
        })
        return
      }
      if (req.method === 'DELETE') {
        this.manager.clearRecords(id)
        this.sendJson(res, 204, null)
        return
      }
      throw new ApiError(405, 'method_not_allowed', 'Expected GET or DELETE', { allow: 'GET, DELETE' })
    }

    if (parts.length === 3 && parts[2] === 'events') {
      this.requireMethod(req, 'GET')
      this.requireInstance(id)
      this.openStream(req, res, url, requestId, id)
      return
    }

    if (parts.length === 3 && ['start', 'stop', 'restart', 'reconnect'].includes(parts[2])) {
      this.requireMethod(req, 'POST')
      const action = parts[2]
      if (action === 'start') {
        this.manager.start(id)
        this.hub.publish('instance.started', instanceSummary(this.manager, this.requireInstance(id)), { instanceId: id })
        this.sendJson(res, 202, { instance: instanceSummary(this.manager, this.requireInstance(id)) })
        return
      }
      if (action === 'stop') {
        await this.manager.stop(id)
        this.hub.publish('instance.stopped', instanceSummary(this.manager, this.requireInstance(id)), { instanceId: id })
        this.sendJson(res, 200, { instance: instanceSummary(this.manager, this.requireInstance(id)) })
        return
      }
      if (action === 'restart') {
        await this.manager.restart(id)
        this.hub.publish('instance.started', instanceSummary(this.manager, this.requireInstance(id)), { instanceId: id })
        this.sendJson(res, 202, { instance: instanceSummary(this.manager, this.requireInstance(id)) })
        return
      }
      if (action === 'reconnect') {
        if (instance.runtime?.active) instance.runtime.reconnectNow()
        else this.manager.start(id)
        this.hub.publish('instance.started', instanceSummary(this.manager, this.requireInstance(id)), { instanceId: id })
        this.sendJson(res, 202, { instance: instanceSummary(this.manager, this.requireInstance(id)) })
        return
      }
    }

    throw new ApiError(404, 'not_found', 'Not found')
  }

  async routeWebhooks (req, res, url, parts, requestId) {
    if (parts.length === 1) {
      if (req.method === 'GET') {
        this.sendJson(res, 200, { webhooks: this.webhooks.list() })
        return
      }
      if (req.method === 'POST') {
        const body = await this.readJson(req)
        if (typeof body.url !== 'string') {
          throw new ApiError(400, 'invalid_body', 'url must be a string')
        }
        if (body.instanceId && !this.manager.get(body.instanceId)) {
          throw new ApiError(400, 'invalid_body', `Unknown instance: ${body.instanceId}`)
        }
        let webhook
        try {
          webhook = this.webhooks.add(body)
        } catch (err) {
          if (err.code) throw err
          throw new ApiError(400, 'invalid_webhook', err.message)
        }
        this.sendJson(res, 201, { webhook }, {
          location: `${PREFIX}/webhooks/${encodeURIComponent(webhook.id)}`
        })
        return
      }
      throw new ApiError(405, 'method_not_allowed', 'Expected GET or POST', { allow: 'GET, POST' })
    }

    const id = parts[1]
    const existing = this.requireWebhook(id)

    if (parts.length === 2) {
      if (req.method === 'GET') {
        this.sendJson(res, 200, { webhook: existing })
        return
      }
      if (req.method === 'PATCH') {
        const body = await this.readJson(req)
        if (body.instanceId !== undefined && body.instanceId && !this.manager.get(body.instanceId)) {
          throw new ApiError(400, 'invalid_body', `Unknown instance: ${body.instanceId}`)
        }
        let webhook
        try {
          webhook = this.webhooks.update(id, body)
        } catch (err) {
          if (err.code) throw err
          throw new ApiError(400, 'invalid_webhook', err.message)
        }
        this.sendJson(res, 200, { webhook })
        return
      }
      if (req.method === 'DELETE') {
        this.webhooks.remove(id)
        this.sendJson(res, 204, null)
        return
      }
      throw new ApiError(405, 'method_not_allowed', 'Expected GET, PATCH or DELETE', {
        allow: 'GET, PATCH, DELETE'
      })
    }

    if (parts.length === 3 && parts[2] === 'test') {
      this.requireMethod(req, 'POST')
      const result = await this.webhooks.test(id)
      this.sendJson(res, 200, { result })
      return
    }

    throw new ApiError(404, 'not_found', 'Not found')
  }

  openStream (req, res, url, requestId, instanceId) {
    let ready = false
    const pending = []
    let closed = false

    const client = { res, instanceId }
    this.clients.add(client)

    const cursor = req.headers['last-event-id'] ?? url.searchParams.get('after')
    const hasCursor = cursor !== null && cursor !== undefined && cursor !== ''
    const after = parseInteger(cursor, 0, { min: 0 })

    // Subscribe before headers are flushed so an event cannot slip through
    // between the snapshot and the live listener.
    const writeEvent = event => {
      if (event.instanceId != null && instanceId != null && event.instanceId !== instanceId) return
      if (!ready) {
        pending.push(event)
        return
      }
      this.writeSse(client, event)
    }
    this.hub.on('event', writeEvent)

    const cleanup = () => {
      if (closed) return
      closed = true
      this.hub.off('event', writeEvent)
      this.clients.delete(client)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
      'x-siftbot-version': this.version
    })
    res.flushHeaders?.()
    res.write('retry: 3000\n\n')

    if (hasCursor) {
      for (const event of this.hub.replay({ after, instanceId, limit: 500 })) {
        this.writeSse(client, event)
      }
    }

    const snapshot = this.hub.snapshot({ instanceId })
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)

    // Records are not part of the snapshot, so flush those as well. Other
    // buffered state events are already represented by the snapshot.
    for (const event of pending) {
      if (event.type === 'record' || event.id > snapshot.lastEventId) {
        this.writeSse(client, event)
      }
    }
    pending.length = 0

    res.write(`id: ${this.hub.lastEventId}\nevent: cursor\ndata: ${JSON.stringify({ lastEventId: this.hub.lastEventId })}\n\n`)
    ready = true
  }

  writeSse (client, event) {
    const res = client.res
    if (res.writableEnded || res.destroyed) return
    if (res.writableLength > MAX_SSE_BUFFER) {
      // Tell the client that its cursor is about to skip events. A comment is
      // invisible to clients that do not parse it and keeps the connection open.
      client.dropped = (client.dropped ?? 0) + 1
      return
    }
    if (client.dropped) {
      try {
        res.write(`: dropped ${client.dropped}\n\n`)
      } catch {
        // The socket may have closed; the next event will notice.
      }
      client.dropped = 0
    }
    const lines = [
      `id: ${event.id}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify(event)}`,
      '',
      ''
    ]
    try {
      res.write(lines.join('\n'))
    } catch {
      // The socket may have closed between the writable check and this write.
    }
  }
}
