import { test } from 'node:test'
import assert from 'node:assert/strict'
import { componentText, describeWindow } from '../src/window.js'

test('componentText flattens NBT text components', () => {
  const component = {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            { text: { type: 'string', value: 'Homes ' } },
            { text: { type: 'string', value: '& Teleports' } }
          ]
        }
      }
    }
  }
  assert.equal(componentText(component), 'Homes & Teleports')
  assert.equal(componentText('plain'), 'plain')
  assert.equal(componentText(null), '')
})

test('describeWindow maps slots, labels and counts', () => {
  const win = {
    id: 7,
    type: 'minecraft:generic_9x6',
    title: { type: 'compound', value: { text: { type: 'string', value: 'Homes & Teleports' } } },
    slots: [
      null,
      {
        name: 'ender_pearl',
        count: 1,
        customName: { type: 'compound', value: { text: { type: 'string', value: 'Random Teleport' } } }
      },
      { name: 'diamond', count: 3 }
    ]
  }

  const data = describeWindow(win)
  assert.equal(data.id, 7)
  assert.equal(data.title, 'Homes & Teleports')
  assert.equal(data.size, 3)
  assert.equal(data.slots[0], null)
  assert.deepEqual(data.slots[1], {
    slot: 1,
    name: 'ender_pearl',
    count: 1,
    label: 'Random Teleport'
  })
  assert.equal(data.slots[2].label, 'diamond')
  assert.equal(describeWindow(null), null)
})
