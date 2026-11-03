import fs from 'node:fs'
import path from 'node:path'

export const name = 'border-walker'
export const version = '1.0.0'

const CORNERS = {
  ne: { x: 1, z: -1 },
  nw: { x: -1, z: -1 },
  se: { x: 1, z: 1 },
  sw: { x: -1, z: 1 }
}

const FOOD = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'carrot', 'apple',
  'golden_carrot', 'melon_slice', 'sweet_berries', 'glow_berries', 'pumpkin_pie',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup'
])

/** Parse ".border-walk ne" / ".border-walk 39000,39000". */
export function parseTarget (input, { border = 40000, margin = 1000 } = {}) {
  const value = String(input ?? 'ne').trim().toLowerCase()
  if (!value || value === 'ne' || value === 'nw' || value === 'se' || value === 'sw') {
    const corner = value || 'ne'
    const sign = CORNERS[corner]
    return { corner, x: sign.x * (border - margin), z: sign.z * (border - margin) }
  }
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
  if (!match) throw new Error('usage: .border-walk [ne|nw|se|sw|x,z]')
  return { corner: 'custom', x: Number(match[1]), z: Number(match[2]) }
}

/** Pure snapshot used by the progress file and tests. */
export function buildProgress (state, now = Date.now()) {
  const position = state.position
  const dx = state.target.x - position.x
  const dz = state.target.z - position.z
  const distance = Math.hypot(dx, dz)
  return {
    plugin: 'border-walker',
    username: state.username,
    server: state.server,
    corner: state.corner,
    target: state.target,
    position,
    distance,
    travelled: state.travelled,
    speed: state.speed,
    etaSeconds: state.speed > 0.2 ? distance / state.speed : null,
    health: state.health,
    food: state.food,
    sprinting: state.sprinting,
    eating: state.eating,
    status: state.status,
    startedAt: new Date(state.startedAt).toISOString(),
    updatedAt: new Date(now).toISOString(),
    trail: state.trail
  }
}

export default function create (ctx) {
  let run = null
  const progressFile = process.env.SIFT_PROGRESS_FILE || path.join(process.cwd(), 'border-progress.json')
  const border = Number(process.env.SIFT_BORDER) || 40000
  const margin = Number(process.env.SIFT_BORDER_MARGIN) || 1000

  ctx.on('death', () => {
    if (run) finish('dead')
  })
  ctx.on('end', () => {
    if (run) finish('disconnected')
  })

  ctx.registerCommand('border-walk', {
    usage: '.border-walk [ne|nw|se|sw|x,z]',
    description: 'Walk (and sprint) to a world-border corner, eating on the way',
    aliases: ['walk-border'],
    run: args => start(args[0])
  })

  ctx.registerCommand('border-stop', {
    usage: '.border-stop',
    description: 'Stop the border walk',
    run: () => {
      if (!run) return ctx.log('border-walker: not walking')
      finish('stopped')
    }
  })

  ctx.registerCommand('border-status', {
    usage: '.border-status',
    description: 'Show the border walk progress',
    run: () => {
      if (!run) return ctx.log('border-walker: not walking')
      const now = snapshot()
      ctx.log(`border-walker: ${now.distance.toFixed(0)}m to ${run.corner} corner · ` +
        `${now.speed.toFixed(1)} m/s · eta ${formatEta(now.etaSeconds)} · ` +
        `food ${now.food}/20 · ${now.status}`)
    }
  })

  function snapshot () {
    const bot = ctx.bot
    const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 }
    return buildProgress({ ...run, position, health: bot.health, food: bot.food }, Date.now())
  }

  function writeProgress () {
    if (!run) return
    try {
      const payload = snapshot()
      fs.mkdirSync(path.dirname(progressFile), { recursive: true })
      const tmp = `${progressFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
      fs.renameSync(tmp, progressFile)
    } catch (err) {
      ctx.debug(`border-walker: cannot write progress: ${err.message}`)
    }
  }

  function finish (status) {
    if (!run) return
    run.status = status
    writeProgress()
    try {
      ctx.actions.stop()
      ctx.bot.setControlState('sprint', false)
    } catch {
      // Disconnected.
    }
    ctx.log(`border-walker: ${status}`)
    run = null
  }

  async function start (cornerArg) {
    if (run) return ctx.log('border-walker: already walking')
    if (!ctx.connected) return ctx.log('border-walker: bot is not connected')

    let target
    try {
      target = parseTarget(cornerArg, { border, margin })
    } catch (err) {
      return ctx.log(`border-walker: ${err.message}`)
    }

    const bot = ctx.bot
    const position = bot.entity.position
    run = {
      corner: target.corner,
      target: { x: target.x, z: target.z },
      username: bot.username,
      server: `${ctx.config.host}:${ctx.config.port}`,
      startedAt: Date.now(),
      status: 'walking',
      travelled: 0,
      speed: 0,
      sprinting: false,
      eating: false,
      trail: [],
      lastPos: position.clone(),
      lastPosAt: Date.now(),
      samplePos: position.clone(),
      sampleAt: Date.now(),
      lastMoveAt: Date.now(),
      lastWriteAt: 0,
      strafe: 1,
      lastJumpAt: 0
    }

    ctx.log(`border-walker: walking to the ${target.corner} corner (${target.x}, ${target.z})`)
    writeProgress()

    try {
      while (run) {
        if (!ctx.connected) {
          finish('disconnected')
          break
        }

        const current = bot.entity.position
        const dx = run.target.x - current.x
        const dz = run.target.z - current.z
        const distance = Math.hypot(dx, dz)
        if (distance <= 48) {
          finish('arrived')
          break
        }

        if (!run.eating && bot.food <= 17) {
          await maybeEat()
          if (!run) break
        }

        await bot.look(Math.atan2(-dx, -dz), 0, true)
        if (run.eating) {
          await sleep(150)
          continue
        }

        bot.setControlState('forward', true)
        bot.setControlState('sprint', bot.food > 6 && distance > 64)

        const moved = current.distanceTo(run.lastPos)
        if (moved > 0.8) {
          run.travelled += moved
          run.lastPos = current.clone()
          run.lastPosAt = Date.now()
          run.lastMoveAt = Date.now()
          run.sprinting = bot.food > 6 && distance > 64
        } else if (Date.now() - run.lastMoveAt > 1200 && bot.entity.onGround &&
          Date.now() - run.lastJumpAt > 600) {
          run.lastJumpAt = Date.now()
          bot.setControlState('jump', true)
          setTimeout(() => {
            try {
              bot.setControlState('jump', false)
            } catch {
              // Disconnected.
            }
          }, 160)
        }

        if (Date.now() - run.lastMoveAt > 4000) {
          // Blocked: sidestep, alternating sides, then keep pushing forward.
          bot.setControlState('forward', false)
          const key = run.strafe > 0 ? 'left' : 'right'
          bot.setControlState(key, true)
          await sleep(650)
          try {
            bot.setControlState(key, false)
          } catch {
            // Disconnected.
          }
          run.strafe = -run.strafe
          run.lastMoveAt = Date.now()
          run.lastPos = bot.entity.position.clone()
        }

        const now = Date.now()
        if (now - run.sampleAt >= 1000) {
          const delta = bot.entity.position.distanceTo(run.samplePos)
          const seconds = (now - run.sampleAt) / 1000
          const instant = delta / seconds
          run.speed = run.speed * 0.6 + instant * 0.4
          run.samplePos = bot.entity.position.clone()
          run.sampleAt = now
        }

        if (now - run.lastWriteAt >= 2000) {
          run.lastWriteAt = now
          run.trail.push({
            t: now,
            x: Math.round(bot.entity.position.x),
            z: Math.round(bot.entity.position.z)
          })
          if (run.trail.length > 720) run.trail.shift()
          writeProgress()
        }

        await sleep(100)
      }
    } catch (err) {
      if (run) {
        ctx.log(`border-walker: stopped — ${err.message}`)
        finish('error')
      }
    }
  }

  async function maybeEat () {
    const bot = ctx.bot
    const foods = (bot.inventory?.items?.() ?? []).filter(item => FOOD.has(item.name))
    if (foods.length === 0) return false
    foods.sort((a, b) => b.count - a.count)
    run.eating = true
    run.sprinting = false
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    const item = foods[0]
    ctx.log(`border-walker: eating ${item.name} (food ${bot.food}/20)`)
    try {
      await bot.equip(item, 'hand')
      await bot.consume()
    } catch (err) {
      ctx.debug(`border-walker: eat failed: ${err.message}`)
    } finally {
      run.eating = false
    }
    return true
  }
}

function formatEta (seconds) {
  if (!Number.isFinite(seconds) || seconds == null) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
