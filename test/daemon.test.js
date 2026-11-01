import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-daemon-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function waitFor (predicate, timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          reject(new Error('timed out'))
        }
      } catch (err) {
        clearInterval(timer)
        reject(err)
      }
    }, 50)
  })
}

test('daemon generates a token, serves the API and shuts down cleanly', async t => {
  const dir = tempDir(t)
  const instancesFile = path.join(dir, 'instances.json')
  const webhooksFile = path.join(dir, 'webhooks.json')

  const child = spawn(process.execPath, [
    'src/daemon.js',
    '--port', '0',
    '--instances', instancesFile,
    '--webhooks', webhooksFile,
    '--log-level', 'info'
  ], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGKILL')
  })

  await waitFor(() => /listening on (https?:\/\/[^\s]+)/.test(output))
  const url = output.match(/listening on (https?:\/\/[^\s]+)/)[1]
  const tokenFile = path.join(dir, 'api-token')
  assert.ok(fs.existsSync(tokenFile))
  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  assert.ok(token.length >= 64)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600)
  }

  const health = await fetch(`${url}/healthz`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)

  const unauthorized = await fetch(`${url}/api/v1/instances`)
  assert.equal(unauthorized.status, 401)

  const authorized = await fetch(`${url}/api/v1/instances`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(authorized.status, 200)
  assert.deepEqual((await authorized.json()).instances, [])

  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  child.kill('SIGTERM')
  const code = await exited
  assert.equal(code, 0)
})
