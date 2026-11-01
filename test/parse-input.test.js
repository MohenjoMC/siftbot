import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInput, tokenize } from '../src/parse-input.js'

test('ignores blank lines', () => {
  assert.equal(parseInput(''), null)
  assert.equal(parseInput('   '), null)
  assert.equal(parseInput('.'), null)
})

test('parses dotted and bang commands', () => {
  assert.deepEqual(parseInput('.say hello world'), {
    type: 'command',
    name: 'say',
    args: ['hello', 'world'],
    raw: '.say hello world'
  })
  assert.deepEqual(parseInput('  !EAT  '), {
    type: 'command',
    name: 'eat',
    args: [],
    raw: '!EAT'
  })
})

test('keeps quoted arguments together', () => {
  assert.deepEqual(parseInput('.say "hello there"').args, ['hello there'])
  assert.deepEqual(parseInput(".say 'it works'").args, ['it works'])
  assert.deepEqual(tokenize('a "b c" d'), ['a', 'b c', 'd'])
  assert.deepEqual(tokenize('he said "hi"'), ['he', 'said', 'hi'])
  assert.deepEqual(tokenize('"a \\"quote\\""'), ['a "quote"'])
  assert.deepEqual(tokenize(''), [])
})

test('forwards slash input to the server and plain text to chat', () => {
  assert.deepEqual(parseInput('/login hunter2'), { type: 'server', raw: '/login hunter2' })
  assert.deepEqual(parseInput('hello everyone'), { type: 'chat', text: 'hello everyone' })
})

test('a bare dot is not a command', () => {
  assert.equal(parseInput(' . '), null)
})
