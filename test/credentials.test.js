import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  CredentialStore,
  credentialKey,
  credentialHost,
  isLoginPrompt,
  isRegisterPrompt,
  parsePasswordCommand
} from '../src/credentials.js'
import { AutoLogin } from '../src/features/auth.js'

const silentLogger = { debug () {}, info () {}, warn () {}, error () {} }

function tempFile () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-cred-'))
  return path.join(dir, 'credentials.json')
}

test('parsePasswordCommand understands register and login commands', () => {
  assert.deepEqual(parsePasswordCommand('/register hunter2 hunter2'), { type: 'register', password: 'hunter2' })
  assert.deepEqual(parsePasswordCommand('/reg hunter2'), { type: 'register', password: 'hunter2' })
  assert.deepEqual(parsePasswordCommand('/login hunter2'), { type: 'login', password: 'hunter2' })
  assert.deepEqual(parsePasswordCommand('  /REG Hunter2  '), { type: 'register', password: 'Hunter2' })
  assert.equal(parsePasswordCommand('/login <password>'), null)
  assert.equal(parsePasswordCommand('/login ${password}'), null)
  assert.equal(parsePasswordCommand('hello'), null)
  assert.equal(parsePasswordCommand(''), null)
})

test('login and register prompts are recognised', () => {
  assert.equal(isLoginPrompt('ꜱᴄᴜʟᴋ ┃ Login: /login <password> (3 left)'), true)
  assert.equal(isLoginPrompt('Please log in: /login <password>'), true)
  assert.equal(isLoginPrompt('Use /register <password> <password>'), false)
  assert.equal(isRegisterPrompt('Please register: /register <password> <password>'), true)
  assert.equal(isRegisterPrompt('Use /login <password>'), false)
  assert.equal(isLoginPrompt('Server is restarting'), false)
})

test('credential keys normalize host and username', () => {
  assert.equal(credentialHost('Play.Example.com.'), 'play.example.com')
  assert.equal(credentialHost('play.example.com:25565'), 'play.example.com')
  assert.equal(credentialKey('Play.Example.com', 'NotKillerMC'), 'notkillermc@play.example.com')
})

test('credential store persists to a private file', () => {
  const file = tempFile()
  const store = new CredentialStore(file, { logger: silentLogger })
  assert.equal(store.has('example.com', 'alice'), false)

  assert.equal(store.set('example.com', 'alice', 'hunter2'), true)
  assert.equal(store.get('example.com', 'alice'), 'hunter2')
  assert.equal(store.set('example.com', 'alice', 'hunter2'), false) // unchanged

  const reloaded = new CredentialStore(file, { logger: silentLogger })
  assert.equal(reloaded.get('example.com', 'alice'), 'hunter2')

  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
})

test('credential store rejects placeholders and accepts manual edits', () => {
  const file = tempFile()
  const store = new CredentialStore(file, { logger: silentLogger })
  assert.equal(store.set('example.com', 'alice', ''), false)
  assert.equal(store.set('example.com', 'alice', '${password}'), false)
  assert.equal(store.set('example.com', 'alice', '<password>'), false)

  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    credentials: {
      'bob@example.com': { username: 'bob', host: 'example.com', password: 'typed-by-hand' }
    }
  }))
  const edited = new CredentialStore(file, { logger: silentLogger })
  assert.equal(edited.get('example.com', 'bob'), 'typed-by-hand')
})

test('credential store tolerates a broken file without throwing', () => {
  const file = tempFile()
  fs.writeFileSync(file, '{ not json')
  const store = new CredentialStore(file, { logger: silentLogger })
  assert.equal(store.has('example.com', 'alice'), false)
  assert.equal(store.set('example.com', 'alice', 'hunter2'), true)
})

function fakeBot () {
  const bot = new EventEmitter()
  bot.sent = []
  bot.chat = text => bot.sent.push(text)
  return bot
}

function authFixture () {
  const file = tempFile()
  const credentials = new CredentialStore(file, { logger: silentLogger })
  const config = { host: 'example.com', username: 'alice', password: '' }
  const bot = fakeBot()
  const auth = new AutoLogin(bot, config, silentLogger, { credentials })
  return { bot, config, credentials, auth }
}

test('auto-login answers a login prompt with the stored password', () => {
  const { bot, config, credentials, auth } = authFixture()
  credentials.set(config.host, config.username, 'hunter2')

  bot.emit('message', { toString: () => 'Login: /login <password> (3 left)' })
  assert.deepEqual(bot.sent, ['/login hunter2'])

  // A repeated prompt within the cooldown must not double-send.
  bot.emit('message', { toString: () => 'Login: /login <password>' })
  assert.equal(bot.sent.length, 1)

  auth.stop()
})

test('auto-login captures a manual register command and logs in afterwards', () => {
  const { bot, config, credentials, auth } = authFixture()

  bot.chat('/register hunter2 hunter2')
  assert.equal(credentials.get(config.host, config.username), 'hunter2')
  assert.deepEqual(bot.sent, ['/register hunter2 hunter2'])

  auth.stop()
})

test('auto-login falls back to the configured password', () => {
  const file = tempFile()
  const credentials = new CredentialStore(file, { logger: silentLogger })
  const config = { host: 'example.com', username: 'alice', password: 'from-config' }
  const bot = fakeBot()
  const auth = new AutoLogin(bot, config, silentLogger, { credentials })

  bot.emit('message', { toString: () => 'Please log in with /login' })
  assert.deepEqual(bot.sent, ['/login from-config'])

  auth.stop()
})

test('auto-login is silent when no password is known', () => {
  const { bot, auth } = authFixture()
  bot.emit('message', { toString: () => 'Login: /login <password>' })
  assert.deepEqual(bot.sent, [])
  auth.stop()
})
