import test from 'node:test'
import assert from 'node:assert/strict'
import { chatComponentToText, isVerificationKick } from '../src/util.js'

test('renders plain strings and JSON chat components', () => {
  assert.equal(chatComponentToText('plain reason'), 'plain reason')
  assert.equal(chatComponentToText({ text: 'hello', extra: [{ text: ' world' }] }), 'hello world')
  assert.equal(chatComponentToText({ text: 'warn', color: 'red' }), 'warn')
})

test('renders NBT-wrapped kick reasons from modern servers', () => {
  const reason = {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: [
          { type: 'compound', value: { text: { type: 'string', value: 'SculkSMP' } } },
          { type: 'compound', value: { '': { type: 'string', value: '\n\n' } } },
          { type: 'compound', value: { text: { type: 'string', value: 'Bot Verification Failed!' } } },
          { type: 'compound', value: { '': { type: 'string', value: '\n' } } },
          { type: 'compound', value: { text: { type: 'string', value: 'discord.sculksmp.xyz' } } }
        ]
      },
      text: { type: 'string', value: '' }
    }
  }

  const text = chatComponentToText(reason)
  assert.match(text, /SculkSMP/)
  assert.match(text, /SculkSMP\s+Bot Verification Failed!/)
  assert.match(text, /Bot Verification Failed!/)
  assert.match(text, /discord\.sculksmp\.xyz/)
  assert.equal(isVerificationKick(text), true)
})

test('detects verification kicks without matching generic reasons', () => {
  assert.equal(isVerificationKick('Bot Verification Failed! Please wait a few seconds.'), true)
  assert.equal(isVerificationKick('Please complete the human verification'), true)
  assert.equal(isVerificationKick('anti-bot check failed'), true)
  assert.equal(isVerificationKick('Too many failed verification attempts. Please wait 10 minutes before trying again.'), true)
  // The second live kick shape seen on sculksmp.xyz: a rate-limit escalation.
  const blocked = chatComponentToText(JSON.parse('{"extra":[{"bold":true,"color":"#FF4B4B","text":"Temporarily Blocked!"}],"text":""}'))
  assert.equal(isVerificationKick(blocked), true)
  assert.equal(isVerificationKick('Server is full'), false)
  assert.equal(isVerificationKick('You are not whitelisted'), false)
  assert.equal(isVerificationKick(null), false)
})
