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
  let lastExpedition = null
  const progressFile = process.env.SIFT_PROGRESS_FILE || path.join(process.cwd(), 'border-progress.json')
  const border = Number(process.env.SIFT_BORDER) || 40000
  const margin = Number(process.env.SIFT_BORDER_MARGIN) || 1000

  ctx.on('death', () => {
    if (run) finish('dead')
  })
  ctx.on('end', () => {
    if (run) finish('disconnected')
  })

  // Seed the last expedition so an idle heartbeat can keep the dashboard
  // showing the live position instead of a frozen file after a restart.
  try {
    const existing = JSON.parse(fs.readFileSync(progressFile, 'utf8'))
    if (Number.isFinite(existing?.target?.x) && Number.isFinite(existing?.target?.z)) {
      lastExpedition = {
        corner: existing.corner ?? 'custom',
        target: { x: existing.target.x, z: existing.target.z },
        startedAt: existing.startedAt ? Date.parse(existing.startedAt) : Date.now(),
        travelled: existing.travelled ?? 0,
        trail: Array.isArray(existing.trail) ? existing.trail : []
      }
    }
  } catch {
    // No previous run yet.
  }

  // While connected but idle, refresh the snapshot once a second so the page
  // stays live and shows the bot's real position.
  const heartbeat = setInterval(() => {
    if (run || !ctx.connected || !lastExpedition) return
    const bot = ctx.bot
    if (!bot?.entity) return
    const position = bot.entity.position
    writePayload(buildProgress({
      corner: lastExpedition.corner,
      target: lastExpedition.target,
      username: bot.username,
      server: `${ctx.config.host}:${ctx.config.port}`,
      position: { x: position.x, y: position.y, z: position.z },
      travelled: lastExpedition.travelled,
      speed: 0,
      health: bot.health,
      food: bot.food,
      sprinting: false,
      eating: false,
      status: 'idle',
      startedAt: lastExpedition.startedAt,
      trail: lastExpedition.trail
    }, Date.now()))
  }, 1000)
  heartbeat.unref?.()

  ctx.registerCommand('border-walk', {
    usage: '.border-walk [ne|nw|se|sw|x,z]',
    description: 'Walk (and sprint) to a world-border corner, eating on the way',
    aliases: ['walk-border'],
    run: args => { void start(args[0]) }
  })

  ctx.registerCommand('border-stop', {
    usage: '.border-stop',
    description: 'Stop the border walk',
    run: () => {
      if (!run) return ctx.log('border-walker: not walking')
      finish('stopped')
    }
  })

  ctx.registerCommand('diag', {
    usage: '.diag',
    description: 'Report blocks around the walker',
    run: () => {
      const bot = ctx.bot
      if (!bot?.entity) return ctx.log('diag: not connected')
      const p = bot.entity.position
      const yaw = bot.entity.yaw
      const fx = -Math.sin(yaw)
      const fz = -Math.cos(yaw)
      const at = (dx, dy, dz) => {
        const block = bot.blockAt(p.offset(dx, dy, dz))
        return block ? `${block.name}${block.boundingBox === 'block' ? '' : '(open)'}` : 'unloaded'
      }
      ctx.log(`diag: pos ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} onGround=${bot.entity.onGround} water=${bot.entity.isInWater} lava=${bot.entity.isInLava} yaw=${yaw.toFixed(2)} yawDeg=${(yaw*180/Math.PI).toFixed(0)}`)
      ctx.log(`diag: feet=${at(0,0,0)} head=${at(0,1,0)} below=${at(0,-1,0)} ahead1=${at(fx,0,fz)} ahead1up=${at(fx,1,fz)} ahead1down=${at(fx,-1,fz)} ahead2=${at(fx*2,0,fz*2)} ahead2down=${at(fx*2,-1,fz*2)}`)
      ctx.log(`diag: controls fwd=${bot.getControlState?.('forward')} jump=${bot.getControlState?.('jump')} sneak=${bot.getControlState?.('sneak')} sprint=${bot.getControlState?.('sprint')}`)
      const tools = (bot.inventory?.items?.() ?? []).filter(i => /pickaxe/.test(i.name)).map(i => `${i.name} x${i.count}`)
      ctx.log(`diag: held=${bot.heldItem?.name ?? 'none'} pickaxes=${tools.join(', ') || 'none'}`)
      ctx.log(`diag: physics=${bot.physicsEnabled} state=${bot._client.state} entity=${bot.entity ? 'yes' : 'no'} shouldUsePhysics=${bot.physics?.shouldUsePhysics}`)
      const path0 = run?.path?.[0]
      ctx.log(`diag: walk=${run ? run.status : 'idle'} path=${run?.path?.length ?? 0} wp=${path0 ? `${path0.x},${path0.y},${path0.z}` : '-'} heading=${run?.heading?.toFixed?.(2) ?? '-'} yaw=${bot.entity.yaw.toFixed(2)}`)
      ctx.log(`diag: game=${bot.game?.gameMode} vehicle=${bot.vehicle ? bot.vehicle.name : 'none'} passenger=${bot.entity.passenger ?? false} sleeping=${bot.isSleeping} health=${bot.health} food=${bot.food} window=${bot.currentWindow ? bot.currentWindow.type : 'none'}`)
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

  function writePayload (payload) {
    try {
      fs.mkdirSync(path.dirname(progressFile), { recursive: true })
      const tmp = `${progressFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
      fs.renameSync(tmp, progressFile)
    } catch (err) {
      ctx.debug(`border-walker: cannot write progress: ${err.message}`)
    }
  }

  function writeProgress () {
    if (!run) return
    writePayload(snapshot())
  }

  function finish (status) {
    if (!run) return
    run.status = status
    writeProgress()
    if (run.restoreSneak) {
      try {
        ctx.runtime?.session?.sneak?.setEnabled(true)
      } catch {
        // Session already gone.
      }
    }
    try {
      ctx.actions.stop()
      ctx.bot.setControlState('sprint', false)
    } catch {
      // Disconnected.
    }
    lastExpedition = {
      corner: run.corner,
      target: { x: run.target.x, z: run.target.z },
      startedAt: run.startedAt,
      travelled: run.travelled,
      trail: run.trail.slice(-200)
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
      lastProgressAt: Date.now(),
      bestDistance: Math.hypot(target.x - position.x, target.z - position.z),
      stuckReported: false,
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
      lastTrailAt: 0,
      path: [],
      lastPlanAt: 0,
      detour: null,
      detourFlip: -1,
      tickPos: position.clone(),
      blockedTicks: 0,
      strafe: 1,
      lastJumpAt: 0
    }

    const hasPickaxe = (bot.inventory?.items?.() ?? []).some(item => /pickaxe/.test(item.name))
    run.hasPickaxe = hasPickaxe
    if (!hasPickaxe) {
      ctx.log('border-walker: no pickaxe in inventory — stone steps can only be routed around')
    }

    // Held sneak caps movement and blocks step-ups; release it for the walk.
    const sneak = ctx.runtime?.session?.sneak
    if (sneak?.enabled) {
      try {
        sneak.setEnabled(false)
        run.restoreSneak = true
        ctx.log('border-walker: released held sneak for walking')
      } catch {
        // Feature unavailable.
      }
    }
    try { bot.setControlState('sneak', false) } catch {}

    ctx.log(`border-walker: walking to the ${target.corner} corner (${target.x}, ${target.z})`)
    writeProgress()

    try {
      while (run) {
        if (!ctx.connected) {
          finish('disconnected')
          break
        }

        // Keep the bot still while a container/menu is open, otherwise it walks
        // away from the container and the server closes the window.
        if (bot.currentWindow) {
          try {
            bot.setControlState('forward', false)
            bot.setControlState('sprint', false)
            bot.setControlState('jump', false)
          } catch {}
          await sleep(250)
          continue
        }

        const current = bot.entity.position
        const dx = run.target.x - current.x
        const dz = run.target.z - current.z
        const distance = Math.hypot(dx, dz)
        if (distance < (run.bestDistance ?? Infinity) - 1) {
          run.bestDistance = distance
          run.lastProgressAt = Date.now()
          if (run.stuckReported) {
            run.stuckReported = false
            if (run.status === 'stuck') run.status = 'walking'
            ctx.log('border-walker: making progress again')
          }
        }
        if (!run.stuckReported && Date.now() - (run.lastProgressAt ?? Date.now()) > 45000) {
          run.stuckReported = true
          run.status = 'stuck'
          writeProgress()
          ctx.log('border-walker: stuck — no net progress for 45s (needs a pickaxe or a clear route)')
        }
        if (distance <= 48) {
          finish('arrived')
          break
        }

        if (!run.eating && bot.food <= 17) {
          await maybeEat()
          if (!run) break
        }

        const targetYaw = Math.atan2(-dx, -dz)
        const nowMs = Date.now()
        let heading = targetYaw
        let stepUp = false
        const planEvery = run.path?.length ? 1500 : 600
        if (nowMs - run.lastPlanAt > planEvery) {
          const plan = planPath(bot, dx, dz)
          run.path = plan.path
          // A partial path that barely improves the heuristic is a dead end
          // (A* cannot reach its goal behind a mountain); treat it as no route.
          run.planUseful = plan.reached || plan.progress >= 2
          run.lastPlanAt = nowMs
        }
        if (run.planUseful && run.path?.length > 0) {
          run.detour = null
          const waypoint = run.path[0]
          const wdx = waypoint.x + 0.5 - current.x
          const wdz = waypoint.z + 0.5 - current.z
          if (Math.hypot(wdx, wdz) < 0.7) {
            run.path.shift()
          } else {
            heading = Math.atan2(-wdx, -wdz)
            stepUp = waypoint.y > current.y + 0.4
          }
        } else if (run.detour && nowMs < run.detour.until) {
          // Keep the committed detour: A* keeps finding short dead ends.
          heading = run.detour.heading
        } else {
          if (run.detour && run.detourStartPos &&
            current.distanceTo(run.detourStartPos) < 3) {
            run.detourFlip = -run.detourFlip
          }
          const side = targetYaw + run.detourFlip * (Math.PI / 2)
          const avoid = chooseHeading(bot, side, [0, 0.35, -0.35, 0.7, -0.7])
          run.detour = { heading: avoid, until: nowMs + 6000 }
          run.detourStartPos = current.clone()
          ctx.log(`border-walker: no useful route; detour ${(avoid * 180 / Math.PI).toFixed(0)}° for 6s`)
        }
        if (!run.planUseful && run.detour) heading = run.detour.heading
        run.heading = heading
        await bot.look(heading, 0, true)
        if (run.eating) {
          await sleep(150)
          continue
        }

        const fx = -Math.sin(heading)
        const fz = -Math.cos(heading)
        const feetAhead = solidAt(bot, fx, 0, fz)
        const headAhead = solidAt(bot, fx, 1, fz)
        const wallAhead = feetAhead
        try { if (bot.getControlState?.('sneak')) bot.setControlState('sneak', false) } catch {}
        const wantSprint = bot.food > 6 && distance > 64
        bot.setControlState('sprint', wantSprint)
        if (bot.entity.isInWater) {
          bot.setControlState('forward', true)
          bot.setControlState('jump', true)
        } else {
          try { bot.setControlState('jump', false) } catch {}
          if (wallAhead) {
            // Never shove a blocked step/wall: strict servers set the player
            // back on every blocked tick.
            bot.setControlState('forward', false)
            bot.setControlState('sprint', false)
            if (!headAhead) {
              // One-block step with headroom: jump first, then move forward.
              await hopStep(bot, heading)
            } else {
              // Two-block wall: carve it if we can, otherwise route around.
              const dug = await digStep(bot, ctx, heading)
              if (!dug) {
                run.path = []
                run.planUseful = false
                run.lastPlanAt = 0
                run.detour = null
              }
            }
          } else {
            bot.setControlState('forward', true)
            if ((stepUp || (feetAhead && !headAhead)) && bot.entity.onGround) {
              // Carve the step rather than relying on a jump.
              await digStep(bot, ctx, heading)
            }
          }
        }

        const tick = current.distanceTo(run.tickPos ?? current)
        run.tickPos = current.clone()
        const pressing = Boolean(bot.getControlState?.('forward'))
        if (pressing && tick < 0.02) run.blockedTicks = (run.blockedTicks ?? 0) + 1
        else if (tick > 0.05) run.blockedTicks = 0

        const moved = current.distanceTo(run.lastPos)
        if (moved > 0.8) {
          run.travelled += moved
          run.lastPos = current.clone()
          run.lastPosAt = Date.now()
          run.lastMoveAt = Date.now()
          run.sprinting = wantSprint
        }

        // Pressing into a wall makes strict servers set the player back; turn
        // to a clear heading instead of shoving the obstacle.
        if ((run.blockedTicks ?? 0) >= 3) {
          run.blockedTicks = 0
          run.path = []
          run.lastPlanAt = 0
          try { bot.setControlState('forward', false) } catch {}
          const avoid = chooseHeading(bot, run.detour ? run.detour.heading : targetYaw)
          run.heading = avoid
          await bot.look(avoid, 0, true)
          await clearAhead(bot, ctx, run)
        }

        if (Date.now() - run.lastMoveAt > 3500) {
          run.stuck = (run.stuck ?? 0) + 1
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          const mode = run.stuck % 3
          if (mode === 1) {
            // Jump and slide sideways along the obstacle.
            const key = run.strafe > 0 ? 'left' : 'right'
            bot.setControlState(key, true)
            await sleep(900)
            try {
              bot.setControlState(key, false)
            } catch {
              // Disconnected.
            }
            run.strafe = -run.strafe
          } else if (mode === 2) {
            // Back off, then take a new heading before pushing on.
            bot.setControlState('back', true)
            await sleep(600)
            try { bot.setControlState('back', false) } catch {}
            await bot.look(bot.entity.yaw + (run.strafe > 0 ? 0.8 : -0.8), 0, true)
            bot.setControlState('forward', true)
            await sleep(800)
            try {
              bot.setControlState('forward', false)
            } catch {}
            run.strafe = -run.strafe
          } else {
            // Last resort: punch the block in front (dirt, wood, leaves).
            try {
              const position = bot.entity.position
              const forwardX = -Math.sin(bot.entity.yaw)
              const forwardZ = -Math.cos(bot.entity.yaw)
              for (const height of [1, 0]) {
                const block = bot.blockAt(position.offset(forwardX * 1.2, height, forwardZ * 1.2))
                if (block && block.boundingBox === 'block' && !/bedrock|obsidian|water|lava/.test(block.name)) {
                  ctx.log(`border-walker: clearing ${block.name}`)
                  await bot.dig(block)
                  break
                }
              }
            } catch {
              // Not diggable; keep walking.
            }
          }
          ctx.log(`border-walker: unstick ${run.stuck} (${mode === 1 ? 'sidestep' : mode === 2 ? 'turn' : 'dig'})`)
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

        if (now - run.lastTrailAt >= 2000) {
          run.lastTrailAt = now
          run.trail.push({
            t: now,
            x: Math.round(bot.entity.position.x),
            z: Math.round(bot.entity.position.z)
          })
          if (run.trail.length > 720) run.trail.shift()
        }
        // Position/vitals update in near real time; only the trail is sampled.
        if (now - run.lastWriteAt >= 250) {
          run.lastWriteAt = now
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

function blockAt (bot, x, y, z) {
  const target = bot.entity.position.clone()
  target.set(x, y, z)
  return bot.blockAt(target)
}

/** Standing height for a column, or null when it cannot be stood on. */
function standHeight (bot, x, z, baseY) {
  let solidY = null
  for (let y = baseY + 2; y >= baseY - 4; y--) {
    const block = blockAt(bot, x, y, z)
    if (!block) return null
    if (block.boundingBox === 'block') {
      solidY = y
      break
    }
  }
  if (solidY == null) return null
  const feet = blockAt(bot, x, solidY + 1, z)
  const head = blockAt(bot, x, solidY + 2, z)
  if (!feet || !head) return null
  if (feet.boundingBox === 'block' || head.boundingBox === 'block') return null
  return {
    x,
    z,
    y: solidY + 1,
    water: feet.name === 'water' || head.name === 'water',
    slippery: /ice|snow_block|packed_ice|blue_ice/.test(blockAt(bot, x, solidY, z)?.name ?? '')
  }
}

/**
 * Small A* over a local height map. Returns waypoints toward the target
 * direction, stepping up one block, dropping up to three, avoiding walls.
 */
function planPath (bot, goalDx, goalDz, radius = 48, step = 2) {
  const position = bot.entity.position
  const bx = Math.floor(position.x)
  const bz = Math.floor(position.z)
  const baseY = Math.floor(position.y)
  const length = Math.hypot(goalDx, goalDz) || 1
  const dirX = goalDx / length
  const dirZ = goalDz / length

  const nodes = new Map()
  const key = (x, z) => `${x},${z}`
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const cell = standHeight(bot, bx + dx, bz + dz, baseY)
      if (cell) nodes.set(key(cell.x, cell.z), cell)
    }
  }

  const start = nodes.get(key(bx, bz)) ?? nodes.get(key(bx, bz + 1)) ?? nodes.get(key(bx, bz - 1))
  if (!start) return { path: [], reached: false, progress: 0 }

  const goalX = bx + Math.round(dirX * radius / step) * step
  const goalZ = bz + Math.round(dirZ * radius / step) * step
  const goalKey = key(goalX, goalZ)
  const heuristic = cell => Math.hypot(goalX - cell.x, goalZ - cell.z)
  // How far a reachable cell advances along the target direction. Used when the
  // direct goal is unreachable: pick the furthest reachable frontier, not the
  // cell closest to a goal hidden behind a mountain (which is the start).
  const projection = cell => (cell.x - start.x) * dirX + (cell.z - start.z) * dirZ

  const open = [{ ...start, g: 0, f: heuristic(start), parent: null }]
  const seen = new Map()
  let best = null

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f)
    const current = open.shift()
    const currentKey = key(current.x, current.z)
    if (seen.has(currentKey) && seen.get(currentKey) <= current.g) continue
    seen.set(currentKey, current.g)

    if (!best || projection(current) > projection(best) ||
      (projection(current) === projection(best) && current.g < best.g)) {
      best = current
    }
    if (currentKey === goalKey) { best = current; break }

    for (let dx = -step; dx <= step; dx += step) {
      for (let dz = -step; dz <= step; dz += step) {
        if (dx === 0 && dz === 0) continue
        const next = nodes.get(key(current.x + dx, current.z + dz))
        if (!next) continue
        if (next.y - current.y > 0) continue // no pickaxe: never climb
        if (current.y - next.y > 3) continue // too deep a fall
        if (dx !== 0 && dz !== 0) {
          // Never cut a corner: both orthogonal neighbours must be walkable at
          // the same height, and a diagonal never climbs.
          const sideA = nodes.get(key(current.x + dx, current.z))
          const sideB = nodes.get(key(current.x, current.z + dz))
          if (!sideA || !sideB) continue
          if (sideA.y !== current.y || sideB.y !== current.y) continue
          if (next.y !== current.y) continue
        }
        const climb = next.y - current.y
        const slopeCost = climb < -1 ? 4 : 0
        const cost = current.g + (dx !== 0 && dz !== 0 ? 1.414 : 1) * step +
          (next.water ? 3 : 0) + slopeCost + (next.slippery ? 20 : 0)
        const nextKey = key(next.x, next.z)
        if (seen.has(nextKey) && seen.get(nextKey) <= cost) continue
        open.push({ ...next, g: cost, f: cost + heuristic(next), parent: current })
      }
    }
  }

  if (!best) return { path: [], reached: false, progress: 0 }
  const reached = key(best.x, best.z) === goalKey
  const progress = projection(best)
  const path = []
  let cursor = best
  while (cursor && cursor.parent) {
    path.push({ x: cursor.x, z: cursor.z, y: cursor.y })
    cursor = cursor.parent
  }
  path.reverse()
  return { path: path.slice(0, 16), reached, progress }
}

function solidAt (bot, dx, dy, dz) {
  const position = bot.entity.position
  const block = bot.blockAt(position.offset(dx, dy, dz))
  return block ? block.boundingBox === 'block' : true
}

/**
 * Pick a heading close to the target while avoiding walls, drops and water.
 * Samples one and two blocks ahead for several candidate angles.
 */
function chooseHeading (bot, targetYaw, offsets = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6]) {
  let best = targetYaw
  let bestScore = Infinity
  for (const offset of offsets) {
    const yaw = targetYaw + offset
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    let score = Math.abs(offset) * 4

    const feet1 = solidAt(bot, fx, 0, fz)
    const head1 = solidAt(bot, fx, 1, fz)
    const below1 = solidAt(bot, fx, -1, fz)
    const feet2 = solidAt(bot, fx * 2, 0, fz * 2)
    const below2 = solidAt(bot, fx * 2, -1, fz * 2)

    if (head1) score += 30 // head-height obstacle (leaves, low ceiling)
    if (feet1 && !head1) score += 3 // step up, jumpable
    if (!feet1 && !below1) score += 25 // drop immediately ahead
    if (!feet2 && !below2) score += 10 // drop two ahead
    if (!feet1 && below1) {
      const block = bot.blockAt(bot.entity.position.offset(fx, -1, fz))
      if (block && /water|lava/.test(block.name)) score += block.name === 'water' ? 8 : 60
    }
    if (score < bestScore) {
      bestScore = score
      best = yaw
    }
  }
  return best
}

/** No route: clear the block in front so a new plan can find a way out. */
async function clearAhead (bot, logger, run) {
  const now = Date.now()
  if (now - (run.lastDigAt ?? 0) < 900) return
  run.lastDigAt = now
  const position = bot.entity.position
  const yaw = bot.entity.yaw
  let dug = false
  // Clear both the feet and head layers so the bot can step into the tunnel.
  for (const height of [0, 1]) {
    const block = bot.blockAt(position.offset(-Math.sin(yaw) * 1.3, height, -Math.cos(yaw) * 1.3))
    if (block && block.boundingBox === 'block' && !/bedrock|obsidian|water|lava/.test(block.name)) {
      logger.log(`border-walker: clearing ${block.name}`)
      try { await bot.dig(block); dug = true } catch (err) { logger.log(`border-walker: clear failed: ${err.message}`) }
    }
  }
  if (!dug) return
}

/** Carve the feet and head blocks of a step, then walk into the gap. */
const SOFT_BLOCK = /dirt|grass_block|sand|gravel|snow|leaves|log|wood|planks|clay|mud|podzol|mycelium|farmland|path|hay|moss|roots|vine|scaffolding|bamboo|cactus|melon|pumpkin|wheat|carrot|potato|beetroot|nether_wart|crimson|warped|shroomlight|froglight/i

async function digStep (bot, logger, heading) {
  const hasPickaxe = (bot.inventory?.items?.() ?? []).some(item => /pickaxe/.test(item.name))
  const position = bot.entity.position
  const fx = -Math.sin(heading)
  const fz = -Math.cos(heading)
  let dug = false
  for (const height of [0, 1]) {
    const block = bot.blockAt(position.offset(fx * 1.2, height, fz * 1.2))
    if (!block || block.boundingBox !== 'block') continue
    if (/bedrock|obsidian|water|lava/.test(block.name)) continue
    if (!hasPickaxe && !SOFT_BLOCK.test(block.name)) continue
    logger.log(`border-walker: step dig ${block.name}`)
    try { await bot.dig(block); dug = true } catch (err) { logger.log(`border-walker: step dig failed: ${err.message}`) }
  }
  return dug
}

/** Jump first, then press forward while airborne. */
async function hopStep (bot, heading) {
  try { bot.setControlState('forward', false) } catch { return }
  try { await bot.look(heading, 0, true) } catch {}
  bot.setControlState('jump', true)
  await sleep(60)
  try { bot.setControlState('jump', false) } catch {}
  await sleep(130)
  bot.setControlState('forward', true)
  await sleep(450)
  try { bot.setControlState('forward', false) } catch {}
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
