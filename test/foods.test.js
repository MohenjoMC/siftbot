import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseFood, isEdible } from '../src/foods.js'

const foods = {
  apple: { foodPoints: 4, saturation: 2.4 },
  bread: { foodPoints: 5, saturation: 6 },
  cookie: { foodPoints: 2, saturation: 0.4 },
  cooked_beef: { foodPoints: 8, saturation: 12.8, effectiveQuality: 20.8 },
  dried_kelp: { foodPoints: 1, saturation: 0.6 },
  golden_carrot: { foodPoints: 6, saturation: 14.4 },
  golden_apple: { foodPoints: 4, saturation: 9.6 },
  rotten_flesh: { foodPoints: 4, saturation: 0.8 },
  pufferfish: { foodPoints: 1, saturation: 0.2 }
}

test('picks the smallest meal that fills the missing hunger', () => {
  const items = [
    { name: 'cooked_beef', count: 5 },
    { name: 'bread', count: 5 },
    { name: 'cookie', count: 5 }
  ]
  // At 17 food we need 3 points; bread (5) is the smallest sufficient meal.
  assert.equal(chooseFood(items, foods, { foodLevel: 17 }).name, 'bread')
})

test('picks a one-point food when only a little hunger is missing', () => {
  const items = [
    { name: 'cooked_beef', count: 1 },
    { name: 'dried_kelp', count: 10 }
  ]
  assert.equal(chooseFood(items, foods, { foodLevel: 19 }).name, 'dried_kelp')
})

test('falls back to the biggest food when nothing fills the gap', () => {
  const items = [
    { name: 'bread', count: 1 },
    { name: 'cooked_beef', count: 1 }
  ]
  assert.equal(chooseFood(items, foods, { foodLevel: 4 }).name, 'cooked_beef')
})

test('excludes risky and valuable foods by default', () => {
  const items = [
    { name: 'golden_apple', count: 1 },
    { name: 'rotten_flesh', count: 1 },
    { name: 'pufferfish', count: 1 }
  ]
  assert.equal(chooseFood(items, foods, { foodLevel: 5 }), null)
})

test('respects custom exclusions and picks the next best food', () => {
  const items = [
    { name: 'golden_carrot', count: 3 },
    { name: 'cooked_beef', count: 3 }
  ]
  assert.equal(
    chooseFood(items, foods, { foodLevel: 5, exclude: ['golden_carrot'] }).name,
    'cooked_beef'
  )
})

test('ignores non-food items, empty stacks and malformed entries', () => {
  const items = [
    { name: 'stone', count: 64 },
    { name: 'bread', count: 0 },
    null,
    { name: 'cooked_beef', count: 2 }
  ]
  assert.equal(chooseFood(items, foods, { foodLevel: 10 }).name, 'cooked_beef')
})

test('returns null for an empty inventory', () => {
  assert.equal(chooseFood([], foods, { foodLevel: 10 }), null)
  assert.equal(chooseFood([], {}, { foodLevel: 10 }), null)
})

test('isEdible uses the same safety rules', () => {
  assert.equal(isEdible('bread', foods), true)
  assert.equal(isEdible('golden_apple', foods), false)
  assert.equal(isEdible('cooked_beef', foods, ['cooked_beef']), false)
  assert.equal(isEdible('stone', foods), false)
})
