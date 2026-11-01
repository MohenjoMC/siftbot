/**
 * Foods that are never picked automatically: risky, magic, or too valuable to
 * burn while AFK. Users can add their own with autoEat.exclude.
 */
export const DEFAULT_EXCLUDED_FOODS = Object.freeze([
  'golden_apple',
  'enchanted_golden_apple',
  'pufferfish',
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'chicken',
  'suspicious_stew',
  'chorus_fruit',
  'ominous_bottle'
])

export const MAX_FOOD = 20

/**
 * minecraft-data exposes food stats as foodsByName. Older data sets may only
 * have foodsArray, so accept either.
 */
export function foodTableFromRegistry (registry) {
  if (!registry) return {}
  if (registry.foodsByName) return registry.foodsByName
  if (Array.isArray(registry.foodsArray)) {
    return Object.fromEntries(registry.foodsArray.map(food => [food.name, food]))
  }
  return {}
}

function foodQuality (food) {
  if (typeof food.effectiveQuality === 'number') return food.effectiveQuality
  return (food.foodPoints ?? 0) + (food.saturation ?? 0)
}

/**
 * Pick the food that best tops up hunger with the least waste.
 *
 * Vanilla eating caps hunger at 20, so at food 18 a steak wastes seven points
 * while a piece of dried kelp is enough. When nothing is large enough, the
 * biggest available meal wins.
 *
 * @param {Array<{name: string, count: number}>} items
 * @param {Record<string, {foodPoints?: number, saturation?: number, effectiveQuality?: number}>} foodsByName
 * @param {{foodLevel?: number, maxFood?: number, exclude?: string[]}} [options]
 * @returns {{name: string, count: number} | null}
 */
export function chooseFood (items, foodsByName, options = {}) {
  const {
    foodLevel = MAX_FOOD,
    maxFood = MAX_FOOD,
    exclude = []
  } = options

  const excluded = new Set([...DEFAULT_EXCLUDED_FOODS, ...exclude])
  const candidates = []

  for (const item of items ?? []) {
    if (!item || typeof item.name !== 'string' || (item.count ?? 0) <= 0) continue
    if (excluded.has(item.name)) continue
    const food = foodsByName?.[item.name]
    if (!food || !((food.foodPoints ?? 0) > 0)) continue
    candidates.push({
      item,
      foodPoints: food.foodPoints,
      quality: foodQuality(food)
    })
  }

  if (candidates.length === 0) return null

  const needed = Math.max(1, maxFood - foodLevel)
  const sufficient = candidates.filter(candidate => candidate.foodPoints >= needed)

  if (sufficient.length > 0) {
    sufficient.sort((a, b) =>
      a.foodPoints - b.foodPoints ||
      b.quality - a.quality ||
      a.item.name.localeCompare(b.item.name)
    )
    return sufficient[0].item
  }

  candidates.sort((a, b) =>
    b.foodPoints - a.foodPoints ||
    b.quality - a.quality ||
    a.item.name.localeCompare(b.item.name)
  )
  return candidates[0].item
}

export function isEdible (name, foodsByName, exclude = []) {
  if (DEFAULT_EXCLUDED_FOODS.includes(name) || exclude.includes(name)) return false
  const food = foodsByName?.[name]
  return Boolean(food && (food.foodPoints ?? 0) > 0)
}
