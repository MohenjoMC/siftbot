import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProxy } from '../src/socks5.js'

test('parseProxy handles host:port, bare host and blanks', () => {
  assert.deepEqual(parseProxy('127.0.0.1:9050'), { host: '127.0.0.1', port: 9050 })
  assert.deepEqual(parseProxy('tor.local'), { host: 'tor.local', port: 9050 })
  assert.deepEqual(parseProxy('  10.0.0.5:1080 '), { host: '10.0.0.5', port: 1080 })
  assert.equal(parseProxy(''), null)
  assert.equal(parseProxy(undefined), null)
})
