import test from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from '../src/logger.js'

test('sends structured records to a sink', () => {
  const records = []
  const logger = new Logger({ level: 'debug', sink: record => records.push(record) })

  logger.debug('debug line')
  logger.info('info %s', 'line')
  logger.warn('careful')
  logger.error('broken')
  logger.chat('Steve', 'hello')
  logger.whisper('Alex', 'psst')
  logger.system('server says hi')
  logger.raw('command output')

  assert.equal(records.length, 8)
  assert.deepEqual(records.map(record => record.kind), [
    'log', 'log', 'log', 'log', 'chat', 'whisper', 'system', 'output'
  ])
  assert.equal(records[1].text, 'info line')
  assert.equal(records[4].text, '<Steve> hello')
  assert.equal(records[7].text, 'command output')
  assert.ok(records.every(record => Number.isFinite(record.time)))
})

test('respects the log level for sink records', () => {
  const records = []
  const logger = new Logger({ level: 'warn', sink: record => records.push(record) })

  logger.debug('hidden')
  logger.info('hidden')
  logger.warn('shown')
  logger.error('shown too')

  assert.deepEqual(records.map(record => record.text), ['shown', 'shown too'])
})

test('strips terminal escapes and splits control characters from player text', () => {
  const records = []
  const logger = new Logger({ level: 'debug', sink: record => records.push(record) })

  logger.chat('bad\u001b[31mname', 'hello\nworld\u001b[0m')
  logger.system('line one\nline two')

  assert.equal(records[0].text, '<badname> hello world')
  assert.equal(records[1].text, 'line one')
  assert.equal(records[2].text, 'line two')
})

test('writes formatted lines to a stream when there is no sink', () => {
  const lines = []
  const stream = { isTTY: false, write: line => lines.push(line) }
  const logger = new Logger({ level: 'info', stream, color: false })

  logger.info('hello')
  logger.chat('Steve', 'hi')
  logger.raw('raw line')

  assert.match(lines[0], /INFO\s+hello\n$/)
  assert.match(lines[1], /CHAT\s+<Steve> hi\n$/)
  assert.equal(lines[2], 'raw line\n')
})
