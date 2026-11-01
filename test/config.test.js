import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ConfigError,
  defaultConfig,
  loadConfig,
  normalizeConfig,
  parseCli,
  redactConfig
} from '../src/config.js'

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('defaults are valid and complete', () => {
  const config = normalizeConfig(defaultConfig())
  assert.equal(config.host, 'localhost')
  assert.equal(config.port, 25565)
  assert.equal(config.auth, 'offline')
  assert.equal(config.sneak.enabled, true)
  assert.equal(config.autoEat.enabled, true)
  assert.equal(config.afk.enabled, true)
})

test('loads the example config without changes', () => {
  const example = path.resolve('config.example.json')
  const { config } = loadConfig(['--config', example], {}, process.cwd())
  assert.equal(config.username, 'siftbot')
  assert.equal(config.sneak.enabled, true)
  assert.equal(config.reconnect.stopOnBan, true)
  assert.equal(config.reconnect.stopOnVerification, true)
})

test('file, env and CLI precedence is applied in order', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ host: 'file-host', port: 25560, username: 'filebot' }))

  const { config } = loadConfig(
    ['--config', file, '--host', 'cli-host'],
    { SIFTBOT_HOST: 'env-host', SIFTBOT_PORT: '25570' },
    dir
  )
  assert.equal(config.host, 'cli-host')
  assert.equal(config.port, 25570)
  assert.equal(config.username, 'filebot')
})

test('automatically reads config.json from the working directory', t => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ username: 'autoload' }))
  const { config, configPath } = loadConfig([], {}, dir)
  assert.equal(config.username, 'autoload')
  assert.equal(configPath, path.join(dir, 'config.json'))
})

test('CLI toggles disable features and handle auto version', () => {
  const { config } = loadConfig(
    ['--no-afk', '--no-sneak', '--no-autoeat', '--no-chat-passthrough', '--mc-version', 'auto'],
    {},
    os.tmpdir()
  )
  assert.equal(config.afk.enabled, false)
  assert.equal(config.sneak.enabled, false)
  assert.equal(config.autoEat.enabled, false)
  assert.equal(config.console.chatPassthrough, false)
  assert.equal(config.version, false)
})

test('normalizes startup commands from strings and objects', () => {
  const config = normalizeConfig({
    startupCommands: ['/login ${password}', { command: '/register ${password} ${password}', delayMs: 1500 }]
  })
  assert.deepEqual(config.startupCommands, [
    { command: '/login ${password}', delayMs: 0 },
    { command: '/register ${password} ${password}', delayMs: 1500 }
  ])
})

test('redacts passwords before printing config', () => {
  const config = normalizeConfig({
    password: 'hunter2',
    startupCommands: ['/login ${password}']
  })
  const redacted = redactConfig(config)
  assert.equal(redacted.password, '***')
  assert.equal(redacted.startupCommands[0].command, '/login ***')

  const literal = redactConfig(normalizeConfig({
    password: 'hunter2',
    startupCommands: ['/login hunter2']
  }))
  assert.equal(literal.startupCommands[0].command, '/login ***')
})

test('rejects invalid settings with useful messages', () => {
  assert.throws(() => normalizeConfig({ port: 0 }), /port must be between/)
  assert.throws(() => normalizeConfig({ port: 'abc' }), /port must be a number/)
  assert.throws(() => normalizeConfig({ auth: 'mojang' }), /auth must be/)
  assert.throws(() => normalizeConfig({ username: 'bad name' }), /username must be/)
  assert.throws(() => normalizeConfig({ afk: { minIntervalMs: 5000, maxIntervalMs: 1000 } }), /maxIntervalMs/)
  assert.throws(() => normalizeConfig({ autoEat: { eatAtFood: 21 } }), /eatAtFood/)
  assert.throws(() => normalizeConfig({ startupCommands: [{ delayMs: 10 }] }), /startupCommands\[0\]/)
  assert.throws(() => normalizeConfig({ afk: null }), /afk must be an object/)
})

test('ignores prototype-polluting config keys', () => {
  normalizeConfig(JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}'))
  assert.equal({}.polluted, undefined)
})

test('parseCli rejects unknown and incomplete flags', () => {
  assert.throws(() => parseCli(['--nope']), ConfigError)
  assert.throws(() => parseCli(['--host']), ConfigError)
  assert.throws(() => parseCli(['stray']), ConfigError)
  assert.deepEqual(parseCli(['--port', '25566']).flags, { port: '25566' })
})

test('help and version short-circuit config loading', () => {
  const help = loadConfig(['--help'], {}, os.tmpdir())
  assert.equal(help.help, true)
  assert.equal(help.config, null)

  const version = loadConfig(['-v'], {}, os.tmpdir())
  assert.equal(version.version, true)
})
