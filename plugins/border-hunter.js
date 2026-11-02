export const name = 'border-hunter'
export const version = '1.0.0'

const DEFAULT_BORDER = 40000 // 80k world border => +/-40k
const DEFAULT_MIN = 1000 // "close to up to 1k-2k blocks from the border"
const DEFAULT_MAX = 2000

const BAD_BIOME = /ocean|river|beach|lava|void|nether|end/i
const BAD_GROUND = /lava|magma|fire|soul_sand|cactus|powder_snow|water/i

/**
 * Pure scoring used by the plugin (exported for tests).
 * `edgeDistance` is how far inside the border the spot is.
 * The window [min, max] is "close to the border"; anything else is kept only
 * as a fallback so the command can always report the best spot seen.
 */
export function evaluateLocation ({ x, z, ground, biome }, {
  border = DEFAULT_BORDER,
  min = DEFAULT_MIN,
  max = DEFAULT_MAX
} = {}) {
  const edgeDistance = border - Math.max(Math.abs(x), Math.abs(z))
  const inWindow = edgeDistance >= min && edgeDistance <= max
  const safeGround = Boolean(ground && ground.safe)
  const goodBiome = !biome || !BAD_BIOME.test(biome)

  let score = 0
  if (inWindow) {
    score += 1000
    // Inside the window, closer to the border is better (edgeDistance ~= min).
    score += (max - edgeDistance) / 10
  } else {
    // Outside the window: closer to the target band is better as a fallback.
    score += Math.max(0, 200 - Math.abs(edgeDistance - (min + max) / 2) / 50)
  }
  if (safeGround) score += 200
  if (goodBiome) score += 50

  return { edgeDistance, inWindow, safeGround, goodBiome, score }
}

/**
 * `.border [tries]` — run /rtp repeatedly, score every landing, and stop as soon
 * as one lands 1000-2000 blocks from the 80k border on solid land. Otherwise the
 * best candidate seen is reported.
 */
export default function create (ctx) {
  let busy = false
  let lastMessage = ''

  ctx.on('message', message => {
    try {
      lastMessage = message?.toString?.() ?? ''
    } catch {
      lastMessage = ''
    }
  })

  ctx.registerCommand('border', {
    usage: '.border [tries]',
    description: 'RTP repeatedly and find the best spot 1k-2k from the 40k border',
    aliases: ['border-hunt'],
    run: args => hunt(ctx, { tries: Math.min(Math.max(Number(args[0]) || 10, 1), 100) })
  })

  async function hunt (context, { tries }) {
    if (busy) return context.log('border-hunter: already running')
    if (!context.connected) return context.log('border-hunter: bot is not connected')
    busy = true
    const border = Number(process.env.SIFT_BORDER ?? DEFAULT_BORDER)
    let best = null

    try {
      for (let attempt = 1; attempt <= tries; attempt++) {
        lastMessage = ''
        const before = context.bot.entity.position.clone()
        context.chat('/rtp')

        if (!(await waitForTeleport(context, before))) {
          const cooldown = /rtp.*(?:wait|cooldown|slow|again|seconds)/i.test(lastMessage)
          context.log(`border-hunter: /rtp did not move the bot${cooldown ? ' (cooldown)' : ''}`)
          if (cooldown && attempt < tries) {
            context.log('border-hunter: waiting 30s for the cooldown…')
            await sleep(30000)
            continue
          }
          break
        }

        await sleep(1500)
        try {
          await context.bot.waitForChunksToLoad?.()
        } catch {
          // Best effort.
        }

        const spot = inspect(context, border)
        const label = `#${attempt} ${spot.x.toFixed(0)}, ${spot.z.toFixed(0)} — ${spot.edgeDistance.toFixed(0)} blocks inside the border` +
          `${spot.inWindow ? ' (IN WINDOW)' : ''}${spot.ground ? `, on ${spot.ground.name}` : ''}${spot.biome ? `, ${spot.biome}` : ''}`
        context.log(`border-hunter: ${label}`)

        if (!best || spot.score > best.score) best = spot
        if (spot.inWindow && spot.safeGround && spot.goodBiome) {
          context.log(`border-hunter: found it — ${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}`)
          return
        }
      }

      if (best) {
        context.log(`border-hunter: best of ${tries} — ${best.x.toFixed(0)}, ${best.z.toFixed(0)}, ` +
          `${best.edgeDistance.toFixed(0)} blocks inside the border` +
          `${best.ground ? `, on ${best.ground.name}` : ', no safe ground found'}` +
          `${best.biome ? `, ${best.biome}` : ''}`)
      } else {
        context.log('border-hunter: no usable location found')
      }
    } catch (err) {
      context.log(`border-hunter: failed — ${err.message}`)
    } finally {
      busy = false
      try {
        context.actions.stop()
      } catch {
        // Disconnected.
      }
    }
  }

  async function waitForTeleport (context, before) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await sleep(250)
      if (!context.connected) throw new Error('disconnected during /rtp')
      if (before.distanceTo(context.bot.entity.position) > 16) return true
    }
    return false
  }

  function inspect (context, border) {
    const bot = context.bot
    const position = bot.entity.position
    const ground = groundUnder(bot, position)
    const biome = biomeName(bot, position)
    const result = evaluateLocation(
      { x: position.x, z: position.z, ground, biome },
      { border }
    )
    return { x: position.x, z: position.z, biome, ground, ...result }
  }

  function groundUnder (bot, position) {
    for (let dy = 1; dy <= 6; dy++) {
      const block = bot.blockAt(position.offset(0, -dy, 0))
      if (!block) continue
      if (block.boundingBox === 'block') {
        return { name: block.name, y: block.position.y, safe: !BAD_GROUND.test(block.name) }
      }
    }
    return null
  }

  function biomeName (bot, position) {
    try {
      const block = bot.blockAt(position)
      if (block?.biome == null) return null
      if (typeof block.biome === 'string') return block.biome
      const registry = bot.registry?.biomes
      const biome = Array.isArray(registry) ? registry[block.biome] : registry?.[block.biome]
      return biome?.name ?? null
    } catch {
      return null
    }
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
