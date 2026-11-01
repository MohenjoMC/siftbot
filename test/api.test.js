import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { InstanceManager } from '../src/instances.js'
import { EventHub } from '../src/api/events.js'
import { WebhookService } from '../src/api/webhooks.js'
import { ApiServer } from '../src/api/server.js'
import { defaultConfig } from '../src/config.js'

const TOKEN = 'test-token-1234567890'

const logger = {
  debug () {},
  info () {},
  warn () {},
  error () {}
}

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-api-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function config (username, extra = {}) {
  return {
    ...defaultConfig(),
    username,
    host: `${username}.example.com`,
    ...extra
  }
}

async function setup (t, { tls = null } = {}) {
  const dir = tempDir(t)
  const manager = new InstanceManager({ file: path.join(dir, 'instances.json') })
  manager.load()
  const alpha = manager.add({ label: 'Alpha', config: config('alpha') })
  const hub = new EventHub({ manager, statusIntervalMs: 0 })
  hub.start()
  const webhooks = new WebhookService({
    file: path.join(dir, 'webhooks.json'),
    hub,
    logger,
    allowInsecure: true
  })
  const server = new ApiServer({
    manager,
    hub,
    webhooks,
    token: TOKEN,
    host: '127.0.0.1',
    port: 0,
    tls,
    logger,
    version: 'test'
  })
  await server.start()
  t.after(async () => {
    await server.stop()
    await manager.stopAll()
    webhooks.stop()
    hub.stop()
  })
  return { dir, manager, alpha, hub, webhooks, server, origin: server.url, base: `${server.url}/api/v1` }
}

async function request (base, pathname, { method = 'GET', token = TOKEN, body, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { response, status: response.status, text, json }
}

async function readUntil (response, predicate, timeoutMs = 5000) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const started = Date.now()
  try {
    while (Date.now() - started < timeoutMs) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (predicate(text)) return text
    }
    throw new Error(`timed out waiting for stream content\n${text}`)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function httpsGet (url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    }).on('error', reject)
  })
}

function waitFor (predicate, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timed out'))
      }
    }, 25)
  })
}

test('health is public and the API requires a token', async t => {
  const { base, origin } = await setup(t)

  const health = await request(origin, '/healthz', { token: null })
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)

  const unauthorized = await request(base, '/instances', { token: null })
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.json.error.code, 'unauthorized')
  assert.equal(unauthorized.response.headers.get('www-authenticate'), 'Bearer')

  const badToken = await request(base, '/instances', { token: 'wrong-token-1234567890' })
  assert.equal(badToken.status, 401)

  const info = await request(base, '')
  assert.equal(info.status, 200)
  assert.equal(info.json.apiVersion, 'v1')
  assert.equal(info.json.capabilities.sse, true)
})

test('instance CRUD, redaction, patching and logs', async t => {
  const { base, manager, alpha } = await setup(t)

  const list = await request(base, '/instances')
  assert.equal(list.status, 200)
  assert.equal(list.json.instances.length, 1)
  assert.equal(list.json.instances[0].id, alpha.id)
  assert.equal(list.json.instances[0].status, 'offline')

  const created = await request(base, '/instances', {
    method: 'POST',
    body: {
      label: 'Beta',
      config: config('beta', { password: 'hunter2', host: 'beta.example.com' })
    }
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.instance.label, 'Beta')
  assert.equal(created.json.instance.hasPassword, true)
  assert.equal(created.json.instance.config.password, '***')
  assert.equal(created.json.instance.config.host, 'beta.example.com')

  const id = created.json.instance.id
  const detail = await request(base, `/instances/${id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.instance.config.password, '***')

  const reveal = await request(base, `/instances/${id}?reveal=true`)
  assert.equal(reveal.json.instance.config.password, 'hunter2')

  const patched = await request(base, `/instances/${id}`, {
    method: 'PATCH',
    body: { label: 'Beta Two', config: { host: 'two.example.com', autoEat: { eatAtFood: 12 } } }
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.instance.label, 'Beta Two')
  assert.equal(patched.json.instance.config.host, 'two.example.com')
  assert.equal(patched.json.instance.config.autoEat.eatAtFood, 12)
  assert.equal(patched.json.instance.hasPassword, true)

  const preserved = await request(base, `/instances/${id}?reveal=true`)
  assert.equal(preserved.json.instance.config.password, 'hunter2')

  const offlineInput = await request(base, `/instances/${id}/input`, {
    method: 'POST',
    body: { line: '.status' }
  })
  assert.equal(offlineInput.status, 409)

  manager.pushRecord(alpha, { time: Date.now(), level: 'info', kind: 'chat', text: 'hello <world>' })
  const logs = await request(base, `/instances/${alpha.id}/logs?limit=10`)
  assert.equal(logs.status, 200)
  assert.equal(logs.json.records.length, 1)
  assert.equal(logs.json.records[0].text, 'hello <world>')
  assert.ok(logs.json.records[0].seq > 0)
  assert.equal(logs.json.lastSeq, 1)

  const cleared = await request(base, `/instances/${alpha.id}/logs`, { method: 'DELETE' })
  assert.equal(cleared.status, 204)

  const deleted = await request(base, `/instances/${id}`, { method: 'DELETE' })
  assert.equal(deleted.status, 204)
  const missing = await request(base, `/instances/${id}`)
  assert.equal(missing.status, 404)

  const badMethod = await request(base, '/instances', { method: 'PUT' })
  assert.equal(badMethod.status, 405)
  assert.equal(badMethod.response.headers.get('allow'), 'GET, POST')

  const badBody = await request(base, '/instances', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: undefined
  })
  assert.equal(badBody.status, 415)
})

test('SSE sends a snapshot, live records and replays by Last-Event-ID', async t => {
  const { base, manager, alpha, hub } = await setup(t)

  const response = await fetch(`${base}/instances/${alpha.id}/events`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)

  manager.pushRecord(alpha, { time: Date.now(), level: 'info', kind: 'chat', text: 'live hello' })
  const text = await readUntil(response, value => value.includes('event: record') && value.includes('live hello'))
  assert.match(text, /event: snapshot/)
  assert.match(text, /"label":"Alpha"/)
  assert.match(text, /event: cursor/)

  const recorded = hub.replay({ after: 0, instanceId: alpha.id })
    .find(event => event.type === 'record')
  assert.ok(recorded)

  const replay = await fetch(`${base}/instances/${alpha.id}/events`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'last-event-id': String(recorded.id - 1)
    }
  })
  const replayText = await readUntil(replay, value => value.includes('live hello'))
  assert.match(replayText, /"seq":1/)

  const tokenQuery = await fetch(`${base}/instances/${alpha.id}/events?token=${TOKEN}`)
  assert.equal(tokenQuery.status, 200)
  await tokenQuery.body.cancel()

  const noToken = await fetch(`${base}/instances/${alpha.id}/events`)
  assert.equal(noToken.status, 401)
})

test('webhooks are signed, filtered and testable', async t => {
  const { base, manager, alpha, webhooks } = await setup(t)
  const received = []

  const receiver = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => receiver.close(resolve)))
  const port = receiver.address().port

  const created = await request(base, '/webhooks', {
    method: 'POST',
    body: {
      url: `http://127.0.0.1:${port}/hook`,
      events: ['record'],
      instanceId: alpha.id,
      description: 'test hook'
    }
  })
  assert.equal(created.status, 201)
  assert.ok(created.json.webhook.secret.length >= 32)
  assert.equal(created.json.webhook.hasSecret, true)
  const { id, secret } = created.json.webhook

  const listed = await request(base, '/webhooks')
  assert.equal(listed.json.webhooks[0].secret, undefined)

  manager.pushRecord(alpha, { time: Date.now(), level: 'info', kind: 'chat', text: 'webhook hello' })
  await waitFor(() => received.length === 1)

  const delivery = received[0]
  assert.equal(delivery.headers['x-siftbot-event'], 'record')
  assert.ok(delivery.headers['x-siftbot-delivery'])
  const timestamp = delivery.headers['x-siftbot-timestamp']
  const signature = createHmac('sha256', secret).update(`${timestamp}.${delivery.body}`).digest('hex')
  assert.equal(delivery.headers['x-siftbot-signature'], `sha256=${signature}`)
  const payload = JSON.parse(delivery.body)
  assert.equal(payload.type, 'record')
  assert.equal(payload.instanceId, alpha.id)
  assert.equal(payload.data.text, 'webhook hello')

  const tested = await request(base, `/webhooks/${id}/test`, { method: 'POST' })
  assert.equal(tested.status, 200)
  assert.equal(tested.json.result.delivered, true)
  await waitFor(() => received.length === 2)
  assert.equal(JSON.parse(received[1].body).type, 'test')

  const removed = await request(base, `/webhooks/${id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204)
  assert.equal(webhooks.list().length, 0)
})

test('serves HTTPS when TLS material is provided', async t => {
  const dir = tempDir(t)
  const cert = path.join(dir, 'cert.pem')
  const key = path.join(dir, 'key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'ignore' })

  const { server } = await setup(t, {
    tls: { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') }
  })
  assert.match(server.url, /^https:/)
  const response = await httpsGet(`${server.url}/healthz`)
  assert.equal(response.status, 200)
  assert.match(response.body, /"ok":true/)
})

test('SSE marks skipped live events with a dropped comment', () => {
  const server = new ApiServer({
    manager: {},
    hub: {},
    webhooks: {},
    token: TOKEN,
    logger
  })
  const writes = []
  const res = {
    writableEnded: false,
    destroyed: false,
    writableLength: 3 * 1024 * 1024,
    write (chunk) { writes.push(chunk) }
  }
  const client = { res, dropped: 0 }
  const event = {
    id: 7,
    type: 'record',
    at: '2026-10-31T12:00:00.000Z',
    instanceId: 'one',
    data: { seq: 1 }
  }

  server.writeSse(client, event)
  assert.equal(writes.length, 0)
  assert.equal(client.dropped, 1)

  res.writableLength = 0
  server.writeSse(client, { ...event, id: 8 })
  assert.equal(writes.length, 2)
  assert.match(writes[0], /^: dropped 1\n\n$/)
  assert.match(writes[1], /id: 8/)
  assert.equal(client.dropped, 0)
})
