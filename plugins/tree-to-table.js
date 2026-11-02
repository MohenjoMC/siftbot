export const name = 'tree-to-table'
export const version = '1.0.0'

const LOG_PATTERN = /^(?:stripped_)?[a-z_]+(?:_log|_stem|_wood|_hyphae)$/

/**
 * `.rtp-tree` — run /rtp, walk to the nearest tree, chop one log, craft four
 * planks, then a crafting table.
 * `.tree` — the same without the /rtp step (useful on servers without RTP).
 *
 * Navigation is a small waypoint walker (face target, hold forward, jump and
 * strafe when stuck) because mineflayer-pathfinder does not work with the 26.x
 * protocol yet.
 */
export default function create (ctx) {
  let busy = false

  ctx.registerCommand('rtp-tree', {
    usage: '.rtp-tree',
    description: 'Random-teleport, find a tree, craft planks and a crafting table',
    aliases: ['t2t'],
    run: () => run(ctx, { rtp: true })
  })

  ctx.registerCommand('tree', {
    usage: '.tree',
    description: 'Find a tree, craft planks and a crafting table (no /rtp)',
    run: () => run(ctx, { rtp: false })
  })

  ctx.on('death', () => {
    if (!busy) return
    busy = false
    ctx.log('tree-to-table: bot died — aborting')
    try {
      ctx.actions.stop()
    } catch {
      // Disconnected.
    }
  })

  async function run (context, { rtp }) {
    if (busy) return context.log('tree-to-table: already running')
    if (!context.connected) return context.log('tree-to-table: bot is not connected')
    busy = true
    const bot = context.bot

    try {
      if (rtp) {
        context.log('tree-to-table: running /rtp…')
        await randomTeleport(context)
      }

      let block = findNearestLog(bot, 64)
      if (!block) {
        context.log('tree-to-table: no tree within 64 blocks, scanning 128…')
        block = findNearestLog(bot, 128)
      }
      if (!block) throw new Error('no tree found nearby')

      context.log(`tree-to-table: nearest ${block.name} at ${fmt(block.position)}`)
      await walkNear(context, block.position, 2)
      const logName = await chopAndCollect(context, block)
      if (!logName) throw new Error('did not pick up a log')

      const wood = logName
        .replace(/^stripped_/, '')
        .replace(/_(?:log|stem|wood|hyphae)$/, '')
      const planks = `${wood}_planks`

      context.log(`tree-to-table: collected ${logName}`)

      const plankItem = itemByName(bot, planks) ?? itemByName(bot, 'oak_planks')
      if (!plankItem) throw new Error(`this version has no ${planks} item`)
      await craft(context, plankItem.id, null)
      context.log(`tree-to-table: crafted 4 ${plankItem.name}`)

      const tableItem = itemByName(bot, 'crafting_table')
      if (!tableItem) throw new Error('this version has no crafting_table item')
      await craft(context, tableItem.id, null)
      context.log('tree-to-table: crafted 1 crafting_table')

      const summary = ['crafting_table', plankItem.name]
        .map(name => `${name} x${countItem(bot, name)}`)
        .join(', ')
      context.log(`tree-to-table: done — ${summary}`)
    } catch (err) {
      context.log(`tree-to-table: failed — ${err.message}`)
    } finally {
      busy = false
      try {
        context.actions.stop()
      } catch {
        // Disconnected.
      }
    }
  }

  async function randomTeleport (context) {
    const bot = context.bot
    const before = bot.entity.position.clone()
    context.chat('/rtp')

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await sleep(250)
      if (!context.connected) throw new Error('disconnected during /rtp')
      if (before.distanceTo(bot.entity.position) > 16) break
    }
    if (before.distanceTo(bot.entity.position) <= 16) {
      throw new Error('/rtp did not move the bot (no permission or on cooldown?)')
    }

    // Let chunks arrive and the fall settle.
    await sleep(2500)
    try {
      await bot.waitForChunksToLoad?.()
    } catch {
      // Older/odd versions may not expose it; the sleep above is the fallback.
    }
  }

  function findNearestLog (bot, maxDistance) {
    const ids = []
    for (const [name, def] of Object.entries(bot.registry.blocksByName)) {
      if (LOG_PATTERN.test(name)) ids.push(def.id)
    }
    if (ids.length === 0) throw new Error('this version has no log blocks')
    return bot.findBlock({ matching: ids, maxDistance })
  }

  /** Walk to within `range` blocks of a position, avoiding drops and walls. */
  async function walkNear (context, target, range) {
    const bot = context.bot
    const deadline = Date.now() + 90000
    let last = bot.entity.position.clone()
    let lastProgress = Date.now()
    let lastJumpAt = 0
    let lastLog = 0
    let strafe = 1

    try {
      while (Date.now() < deadline) {
        if (!busy) throw new Error('aborted')
        if (!context.connected) throw new Error('disconnected while walking')
        const position = bot.entity.position
        const dx = target.x + 0.5 - position.x
        const dz = target.z + 0.5 - position.z
        const horizontal = Math.hypot(dx, dz)
        const dy = target.y + 0.5 - position.y

        if (horizontal <= range && Math.abs(dy) <= 2) return

        const yaw = Math.atan2(-dx, -dz)
        await bot.look(yaw, 0, true)

        bot.setControlState('forward', true)

        // Jump only when the bot has stopped making progress (a step or fence).
        if (Date.now() - lastProgress > 700 && bot.entity.onGround &&
          Date.now() - lastJumpAt > 500) {
          lastJumpAt = Date.now()
          bot.setControlState('jump', true)
          setTimeout(() => {
            try {
              bot.setControlState('jump', false)
            } catch {
              // Disconnected.
            }
          }, 150)
        }

        if (position.distanceTo(last) > 0.5) {
          last = position.clone()
          lastProgress = Date.now()
        }

        // Still blocked after hopping: strafe around the obstacle.
        if (Date.now() - lastProgress > 2500) {
          bot.setControlState('forward', false)
          await sidestep(bot, strafe)
          strafe = -strafe
          last = bot.entity.position.clone()
          lastProgress = Date.now()
        }

        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now()
          context.log(`tree-to-table: walking… ${horizontal.toFixed(1)}m to the tree`)
        }

        await sleep(100)
      }
      throw new Error('walking to the tree timed out')
    } finally {
      try {
        context.actions.stop()
      } catch {
        // Disconnected.
      }
    }
  }

  async function sidestep (bot, direction) {
    const key = direction > 0 ? 'left' : 'right'
    bot.setControlState(key, true)
    await sleep(600)
    try {
      bot.setControlState(key, false)
    } catch {
      // Disconnected.
    }
  }

  async function chopAndCollect (context, block) {
    const bot = context.bot
    let target = block

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true)
        await bot.dig(target, true)
      } catch (err) {
        context.debug(`tree-to-table: dig failed: ${err.message}`)
      }

      await sleep(700)
      // Step onto the drop; the server hands items over at close range.
      try {
        await walkNear(context, target.position, 0.6)
      } catch {
        // Pickup may still succeed from here.
      }

      const found = await waitForAnyLog(context, 6000)
      if (found) return found

      // Keep going up the trunk if the first log did not drop anything useful.
      const above = bot.blockAt(target.position.offset(0, 1, 0))
      if (above && LOG_PATTERN.test(above.name)) {
        target = above
        continue
      }
      break
    }
    return null
  }

  async function waitForAnyLog (context, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const item = (context.bot.inventory?.items?.() ?? [])
        .find(candidate => LOG_PATTERN.test(candidate.name))
      if (item) return item.name
      await sleep(200)
    }
    return null
  }

  async function craft (context, itemId, table) {
    const bot = context.bot
    const recipe = bot.recipesFor(itemId, null, 1, table)[0]
    if (!recipe) throw new Error(`no crafting recipe available for item ${itemId}`)
    await withTimeout(bot.craft(recipe, 1, table), 15000, 'crafting timed out')
  }
}

function itemByName (bot, name) {
  return bot.registry.itemsByName[name] ?? null
}

function countItem (bot, name) {
  return (bot.inventory?.items?.() ?? [])
    .filter(item => item.name === name)
    .reduce((total, item) => total + item.count, 0)
}

function fmt (position) {
  return `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout (promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
}
