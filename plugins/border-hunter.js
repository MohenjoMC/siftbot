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

const SMALL_CAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz'

/** Fold stylised Minecraft labels (small caps, punctuation) to plain lower-case. */
export function foldLabel (text) {
  let out = ''
  for (const character of String(text ?? '')) {
    const index = SMALL_CAPS.indexOf(character)
    out += index >= 0 ? ASCII_LOWER[index] : character
  }
  return out.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Flatten a 1.20.5+ NBT text component (type/value wrappers) to plain text. */
export function componentText (node) {
  const out = []
  const visit = n => {
    if (n == null) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (typeof n !== 'object') return
    if (typeof n.text === 'string') out.push(n.text)
    else if (n.text && typeof n.text === 'object') visit(n.text)
    if (typeof n.value === 'string' || typeof n.value === 'number') out.push(String(n.value))
    else if (n.value && typeof n.value === 'object') visit(n.value)
    if (n.extra) visit(n.extra)
  }
  visit(node)
  return out.join('')
}

export function slotName (window, slot) {
  const item = window?.slots?.[slot]
  if (!item) return ''
  return componentText(item.customName) || item.name || ''
}

/** First slot whose folded label matches the regex, or -1. */
export function findSlot (window, pattern) {
  if (!Array.isArray(window?.slots)) return -1
  for (let slot = 0; slot < window.slots.length; slot++) {
    const name = slotName(window, slot)
    if (name && pattern.test(foldLabel(name))) return slot
  }
  return -1
}

function menuLabel (window) {
  return componentText(window?.title) || window?.type || 'menu'
}

function logMenu (context, window) {
  const slots = window?.slots ?? []
  context.log(`rtp: menu "${menuLabel(window)}" (${slots.length} slots)`)
  let shown = 0
  for (let slot = 0; slot < slots.length && shown < 12; slot++) {
    const name = slotName(window, slot)
    if (!name) continue
    const count = slots[slot]?.count > 1 ? ` x${slots[slot].count}` : ''
    context.log(`  ${slot}: ${name}${count}`)
    shown++
  }
}

/**
 * `.border [tries]` — run /rtp repeatedly, score every landing, and stop as soon
 * as one lands 1000-2000 blocks from the 80k border on solid land. Otherwise the
 * best candidate seen is reported.
 */
export default function create (ctx) {
  let busy = false
  let lastMessage = ''
  let recent = []

  ctx.on('message', (message, position) => {
    try {
      const text = (message?.toString?.() ?? '').trim()
      if (!text) return
      if (position && position !== 'chat') {
        recent.push(`${position}: ${text}`)
        if (recent.length > 8) recent.shift()
      }
      if (/rtp|teleport|random|cooldown|wait|permission|denied|unknown command/i.test(text)) {
        lastMessage = text
      }
    } catch {
      // Ignore malformed chat components.
    }
  })

  ctx.registerCommand('border', {
    usage: '.border [tries]',
    description: 'RTP repeatedly and find the best spot 1k-2k from the 40k border',
    aliases: ['border-hunt'],
    run: args => hunt(ctx, { tries: Math.min(Math.max(Number(args[0]) || 10, 1), 100) })
  })

  ctx.registerCommand('rtp', {
    usage: '.rtp',
    description: 'Trigger RTP through the server menu',
    run: async () => {
      if (!ctx.connected) return ctx.log('rtp: bot is not connected')
      ctx.log('rtp: opening the server menu…')
      const moved = await runRtp(ctx)
      ctx.log(moved ? 'rtp: teleported' : 'rtp: could not trigger a teleport')
    }
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
        recent = []
        const before = context.bot.entity.position.clone()
        context.log(`border-hunter: attempt ${attempt}/${tries} — running RTP…`)

        const started = await runRtp(context)
        if (!started && !(await waitForTeleport(context, before))) {
          const cooldown = /rtp.*(?:wait|cooldown|slow|again|seconds)/i.test(lastMessage)
          context.log(`border-hunter: /rtp did not move the bot${cooldown ? ' (cooldown)' : ''}`)
          if (lastMessage.trim()) {
            context.log(`border-hunter: server said: ${lastMessage.trim().slice(0, 160)}`)
          }
          if (recent.length > 0) {
            context.log(`border-hunter: recent messages: ${recent.join(' | ').slice(0, 300)}`)
          }
          // This server's RTP is on a ~5 minute cooldown: wait it out.
          if (attempt < tries) {
            const waitMs = cooldown ? 30000 : 305000
            context.log(`border-hunter: waiting ${Math.round(waitMs / 1000)}s for the RTP cooldown…`)
            await sleep(waitMs)
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

        if (attempt < tries) {
          context.log('border-hunter: waiting 305s for the RTP cooldown…')
          await sleep(305000)
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

  async function runRtp (context) {
    const bot = context.bot

    if (bot.currentWindow) {
      try {
        await bot.closeWindow(bot.currentWindow)
      } catch {
        // Already closed.
      }
      await sleep(300)
    }

    const before = bot.entity.position.clone()

    // 1) /rtp usually opens the RTP menu directly on this server
    context.chat('/rtp')
    let menu = await waitForWindow(context, 3500)
    if (menu) {
      context.log(`rtp: opened "${menuLabel(menu)}"`)
      let slot = findSlot(menu, /^rtp\b|random\s*(?:teleport|tp)|wilderness|wild/)
      if (slot >= 0) {
        context.log(`rtp: clicking "${slotName(menu, slot)}"`)
        menu = await clickSlotAndWait(context, slot)
        if (menu) {
          const world = findSlot(menu, /overworld|survival|world|confirm|accept|teleport/)
          if (world >= 0) {
            context.log(`rtp: choosing "${slotName(menu, world)}"`)
            await bot.clickWindow(world, 0, 0)
          }
        }
        if (await waitForMove(context, before, 12000)) return true
        context.log('rtp: menu clicked but no teleport happened')
        return false
      }

      const fallback = findSlot(menu, /overworld|survival|world/)
      if (fallback >= 0) {
        context.log(`rtp: clicking "${slotName(menu, fallback)}"`)
        await bot.clickWindow(fallback, 0, 0)
        if (await waitForMove(context, before, 12000)) return true
      }
      logMenu(context, menu)
      return false
    }

    // 2) no menu from the command: fall back to the held menu item
    menu = await openMenu(context)
    if (!menu) {
      return waitForMove(context, before, 3000)
    }

    let slot = findSlot(menu, /^rtp\b|random\s*(?:teleport|tp)|wilderness|wild/)
    if (slot < 0) slot = findSlot(menu, /homes?.*teleports?|teleports?|warps?/)
    if (slot < 0) {
      context.log('rtp: the menu has no teleport entry')
      logMenu(context, menu)
      return false
    }

    context.log(`rtp: opening "${slotName(menu, slot)}"`)
    menu = await clickSlotAndWait(context, slot)
    if (!menu) return false

    slot = findSlot(menu, /^rtp\b|random\s*(?:teleport|tp)|wilderness|wild/)
    if (slot < 0) slot = findSlot(menu, /teleport|\btp\b|overworld|survival/)
    if (slot < 0) {
      context.log(`rtp: no RTP entry on "${menuLabel(menu)}"`)
      logMenu(context, menu)
      return false
    }

    context.log(`rtp: clicking "${slotName(menu, slot)}"`)
    await bot.clickWindow(slot, 0, 0)
    return waitForMove(context, before, 12000)
  }

  /** Wait for a teleport, clicking a confirm/teleport button if one appears. */
  async function waitForMove (context, before, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      await sleep(300)
      if (!context.connected) return false
      if (before.distanceTo(context.bot.entity.position) > 16) return true
      const current = context.bot.currentWindow
      if (current) {
        const confirm = findSlot(current, /confirm|accept|^yes\b|teleport now/)
        if (confirm >= 0) {
          context.log(`rtp: confirming "${slotName(current, confirm)}"`)
          await context.bot.clickWindow(confirm, 0, 0)
        }
      }
    }
    return false
  }

  function waitForWindow (context, ms) {
    const bot = context.bot
    if (bot.currentWindow) return Promise.resolve(bot.currentWindow)
    return new Promise(resolve => {
      const timer = setTimeout(() => done(null), ms)
      timer.unref?.()
      const done = window => {
        clearTimeout(timer)
        bot.removeListener('windowOpen', onOpen)
        resolve(window ?? bot.currentWindow ?? null)
      }
      const onOpen = window => done(window)
      bot.once('windowOpen', onOpen)
    })
  }

  async function openMenu (context) {
    const bot = context.bot

    if (bot.currentWindow) {
      context.log(`rtp: closing stray window "${menuLabel(bot.currentWindow)}"`)
      try {
        await bot.closeWindow(bot.currentWindow)
      } catch {
        // Already closed.
      }
      await sleep(600)
    }

    // Pick a plausible menu item and hold it, otherwise activateItem does
    // nothing useful (or opens whatever happens to be in hand).
    const menuItems = ['player_head', 'compass', 'clock', 'nether_star', 'paper', 'enchanted_book', 'written_book', 'chest', 'ender_chest']
    const inventory = bot.inventory?.items?.() ?? []
    context.log(`rtp: held ${bot.heldItem?.name ?? 'nothing'}; carrying ${inventory.map(item => item.name).join(', ').slice(0, 140) || 'nothing'}`)
    const candidate = inventory.find(item => menuItems.includes(item.name))
    if (candidate && bot.heldItem?.name !== candidate.name) {
      try {
        await bot.equip(candidate, 'hand')
        context.log(`rtp: holding ${candidate.name}`)
      } catch (err) {
        context.log(`rtp: could not equip ${candidate.name}: ${err.message}`)
      }
    }

    bot.activateItem()
    const window = await waitForWindow(context, 4000)
    if (!window) context.log('rtp: no menu opened')
    else context.log(`rtp: opened "${menuLabel(window)}"`)
    return window
  }

  async function clickSlotAndWait (context, slot, ms = 1600) {
    const bot = context.bot
    const beforeId = bot.currentWindow?.id ?? null
    await bot.clickWindow(slot, 0, 0)
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      await sleep(150)
      if (!context.connected) return null
      if (bot.currentWindow && bot.currentWindow.id !== beforeId) return bot.currentWindow
    }
    return bot.currentWindow ?? null
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
