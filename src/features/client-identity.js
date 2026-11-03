/**
 * Presents the bot to the server the way a real vanilla client does.
 *
 * mineflayer and minecraft-protocol miss three details of the vanilla handshake
 * and session cadence (verified against the installed 4.39.0 / 1.68.0 sources
 * and the Minecraft protocol wiki — see docs/research/client-spoofing.md):
 *
 * 1. From 1.20.2 the vanilla client announces its brand ("vanilla") on the
 *    `minecraft:brand` plugin channel in the CONFIGURATION state, once per
 *    connection. The stack only sends it later, in the play state, and re-sends
 *    it on every login — servers see the wrong shape and a duplicate packet.
 * 2. A vanilla 1.21.2+ client ends every client tick with a `client_tick_end`
 *    packet. Neither library sends it, and strict servers (Grim-based
 *    anticheats, 26.3+ vanilla hosts) count position packets per tick and kick
 *    without the reset.
 * 3. `select_known_packs` (1.20.5+) is answered only once by the stack; a
 *    server that re-negotiates packs on a transfer gets no reply and stalls.
 *
 * The client-settings packet sent during configuration is aligned with the
 * play-state one in `src/bot.js` via the `clientSettings` createBot option.
 */

const VIEW_DISTANCE_TO_CHUNKS = {
  tiny: 6,
  short: 8,
  normal: 10,
  far: 12
}

const BRAND_CHANNEL_LEGACY = 'MC|Brand' // ≤ 1.12.2
const BRAND_CHANNEL_NAMESPACED = 'minecraft:brand' // ≥ 1.13
const TICK_END_MIN_PROTOCOL = 767 // 1.21.2: client_tick_end exists and is expected

/** map a normalized config viewDistance (name or chunk count) to its chunk count */
export function viewDistanceChunks (viewDistance) {
  if (typeof viewDistance === 'number') return viewDistance
  return VIEW_DISTANCE_TO_CHUNKS[viewDistance] ?? VIEW_DISTANCE_TO_CHUNKS.normal
}

export class ClientIdentity {
  constructor (bot, options, logger) {
    this.bot = bot
    this.options = options
    this.logger = logger
    this.enabled = options.enabled !== false
    this.stopped = false

    this.brand = String(options.brand ?? 'vanilla')
    this.brandSent = false
    this.knownPacksAnswered = false
    this.configured = false

    // Debug switches for isolating anticheat interactions (see docs).
    this.setupBrand()
    if (process.env.SIFT_NO_SETTINGS_PATCH !== '1') this.setupSettings()
    if (process.env.SIFT_NO_MOVEMENT_PATCH !== '1') this.setupMovement()
    this.setupInventory()
    this.setupVehicles()
    this.setupTransfer()
    if (process.env.SIFT_NO_TICK_END !== '1') this.setupTickEnd()
    if (process.env.SIFT_NO_PLAYER_INPUT !== '1') this.setupPlayerInput()
    this.setupKnownPacks()
  }

  /**
   * With `version: 'auto'` mineflayer has not resolved the server version yet
   * when this feature is constructed, so every capability check is deferred to
   * the first event that actually needs it (by then the ping has finished).
   */
  resolveVersion () {
    const bot = this.bot
    const brandChannel = bot.supportFeature?.('customChannelIdentifier')
      ? BRAND_CHANNEL_NAMESPACED
      : BRAND_CHANNEL_LEGACY
    const usesConfigurationState = Boolean(bot.supportFeature?.('hasConfigurationState'))
    const hasTickEnd = typeof bot.protocolVersion === 'number' && bot.protocolVersion >= TICK_END_MIN_PROTOCOL
    const hasPlayerInput = Boolean(bot.supportFeature?.('newPlayerInputPacket'))

    const fingerprint = `${brandChannel}|${usesConfigurationState}|${hasTickEnd}|${hasPlayerInput}`
    if (fingerprint !== this.versionFingerprint) {
      this.versionFingerprint = fingerprint
      this.brandChannel = brandChannel
      this.usesConfigurationState = usesConfigurationState
      this.hasTickEnd = hasTickEnd
      this.hasPlayerInput = hasPlayerInput
      this.logger.debug(
        `client: ${brandChannel}, configuration state ${usesConfigurationState ? 'yes' : 'no'}, ` +
        `tick_end ${hasTickEnd ? 'on' : 'off'}, player_input ${hasPlayerInput ? 'on' : 'off'} ` +
        `(protocol ${bot.protocolVersion ?? 'unknown'})`
      )
    }

    this.configured = true
    return this.hasTickEnd
  }

  setupBrand () {
    const client = this.bot._client
    if (client == null) return

    // Announce the brand when entering configuration (1.20.2+), before the
    // stack's play-state write. Vanilla never touches brand again, so the
    // play-state write is suppressed once ours is out.
    this.onClientState = newState => {
      if (this.stopped || !this.enabled) return
      this.resolveVersion()
      if (!this.usesConfigurationState) return
      if (newState !== 'configuration') return
      this.sendBrand()
    }
    client.on('state', this.onClientState)

    if (typeof client.writeChannel === 'function') {
      const originalWriteChannel = client.writeChannel.bind(client)
      this.unpatchWriteChannel = () => { client.writeChannel = originalWriteChannel }
      client.writeChannel = (channel, data) => {
        if (!this.stopped && this.enabled && this.brandSent &&
          channel === (this.brandChannel ?? this.resolveBrandChannel())) {
          this.logger.debug(`client: suppressed duplicate ${channel} write`)
          return
        }
        return originalWriteChannel(channel, data)
      }
    }
  }

  resolveBrandChannel () {
    if (!this.configured) this.resolveVersion()
    return this.brandChannel
  }

  sendBrand () {
    if (this.brandSent || !this.enabled || this.stopped) return
    const client = this.bot._client
    if (client.state !== 'configuration') return
    try {
      const channel = this.brandChannel ?? this.resolveBrandChannel()
      client.writeChannel(channel, this.brand)
      this.brandSent = true
      this.logger.debug(`client: brand '${this.brand}' sent as ${channel}`)
    } catch (err) {
      this.logger.debug(`client: brand write failed: ${err.message}`)
    }
  }

  /**
   * Vanilla 1.20.2+ sends Client Information once, during configuration, and
   * afterwards only when the player changes a setting. mineflayer's settings
   * plugin re-sends it on every play-state login, so the first play-state
   * settings packet after each login is dropped. Later writes (bot.setSettings)
   * pass through untouched.
   */
  setupSettings () {
    const client = this.bot._client
    if (typeof client.write !== 'function') return
    this.dropNextPlaySettings = true

    this.onPlayLogin = () => { this.dropNextPlaySettings = true }
    client.on('login', this.onPlayLogin)

    const originalWrite = client.write.bind(client)
    this.unpatchWrite = () => { client.write = originalWrite }
    client.write = (name, params) => {
      if (name === 'settings' && client.state === 'play' &&
        this.dropNextPlaySettings && !this.stopped && this.enabled) {
        this.dropNextPlaySettings = false
        this.logger.debug('client: suppressed duplicate play-state settings')
        return
      }
      return originalWrite(name, params)
    }
  }

  /**
   * Vanilla acknowledges a teleport with a single position+rotation packet and
   * then falls. mineflayer's sendPacketPositionAndLook never updates its own
   * heartbeat timestamp, so the next physics tick believes a second has passed
   * and emits a redundant position-only packet. Sony/anti-bot physics checks
   * (e.g. Sonar) reject that as "illegal movement packet order", so the
   * duplicate is suppressed. Only an identical position within 500 ms of a
   * position+rotation acknowledgement is dropped; real movement always passes.
   */
  setupMovement () {
    const client = this.bot._client
    if (typeof client.write !== 'function') return

    this.lastTeleportAck = null
    this.lastMoveSample = null
    const originalWrite = client.write.bind(client)
    this.unpatchMovementWrite = () => { client.write = originalWrite }

    const control = key => {
      try {
        return Boolean(this.bot.getControlState?.(key))
      } catch {
        return false
      }
    }

    // 1.21.3+ servers use hasHorizontalCollision when the player pushes a
    // block; mineflayer always sends false, so a jump against a step looks
    // like unrequested motion and is set back.
    const applyMovementFlags = params => {
      const entity = this.bot.entity
      const position = entity?.position
      const previous = this.lastMoveSample
      const wantsMove = control('forward') || control('back') || control('left') || control('right')
      const moved = position && previous
        ? Math.hypot(position.x - previous.x, position.z - previous.z)
        : 0
      const collided = Boolean(wantsMove && previous && moved < 0.005)
      if (position) this.lastMoveSample = { x: position.x, z: position.z }
      const onGround = params.flags?.onGround ?? params.onGround ?? entity?.onGround ?? false
      return {
        ...params,
        flags: { ...(params.flags ?? {}), onGround, hasHorizontalCollision: collided }
      }
    }

    client.write = (name, params) => {
      if (this.stopped || !this.enabled) return originalWrite(name, params)

      // While the verification vehicle is being emulated, mineflayer's own
      // movement/look packets would desynchronise the packet accounting.
      if (this.vehicleEmulationActive && !this.vehicleBypass &&
        (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying')) {
        return
      }

      if (name === 'position_look') {
        this.lastTeleportAck = {
          at: Date.now(),
          x: params.x ?? params.position?.x,
          y: params.y ?? params.position?.y,
          z: params.z ?? params.position?.z,
          yaw: params.yaw,
          pitch: params.pitch,
          onGround: params.onGround ?? params.flags?.onGround
        }
        const lookParams = process.env.SIFT_NO_COLLISION_FLAG === '1' ? params : applyMovementFlags(params)
        return originalWrite(name, lookParams)
      }

      if (name === 'position' && this.lastTeleportAck) {
        const ack = this.lastTeleportAck
        const x = params.x ?? params.position?.x
        const y = params.y ?? params.position?.y
        const z = params.z ?? params.position?.z
        if (Date.now() - ack.at <= 500 && x === ack.x && y === ack.y && z === ack.z) {
          this.lastTeleportAck = null
          // A vanilla client's follow-up packet after the teleport ack carries the
          // same rotation, so keep it a position+rotation packet instead of a
          // redundant position-only one. Anti-bot physics checks (Sonar) require
          // the dy=0 packet to be rotated.
          this.logger.debug('client: promoted duplicate position after teleport to position_look')
          return originalWrite('position_look', {
            x,
            y,
            z,
            yaw: ack.yaw,
            pitch: ack.pitch,
            onGround: params.onGround ?? params.flags?.onGround,
            flags: {
              onGround: params.onGround ?? params.flags?.onGround,
              hasHorizontalCollision: undefined
            }
          })
        }
      }

      const outParams = process.env.SIFT_NO_COLLISION_FLAG === '1'
        ? params
        : (name === 'position' || name === 'position_look' || name === 'look')
          ? applyMovementFlags(params)
          : params
      return originalWrite(name, outParams)
    }
  }

  /**
   * Two vanilla behaviours mineflayer lacks, both probed by Sonar's protocol
   * handler:
   *
   * 1. An out-of-range held-item slot is ignored by a vanilla client;
   *    mineflayer asserts and throws, losing the connection mid-verification.
   * 2. A vanilla client (before 26.3) echoes a swing-arm animation when the
   *    server plays one for its own player; mineflayer never replies. 26.3+
   *    removed the echo, so it is version-gated.
   */
  setupInventory () {
    this.patchInventory()
    // With `version: 'auto'` mineflayer injects its plugins only after the
    // version ping (the inject_allowed event), so the patch is applied there
    // as well.
    this.onInjectAllowed = () => this.patchInventory()
    this.bot.once?.('inject_allowed', this.onInjectAllowed)

    const bot = this.bot
    this.onEntityAnimation = packet => {
      if (this.stopped || !this.enabled) return
      const entityId = packet.entityId ?? packet.entityID
      const animation = packet.animation
      if (entityId !== bot.entity?.id) return
      if (animation !== 0 && animation !== 'swing_main_arm') return
      // 26.3 (protocol 777) removed the client-side swing echo.
      if (typeof bot.protocolVersion === 'number' && bot.protocolVersion >= 777) return
      try {
        bot._client.write('arm_animation', { hand: 0 })
      } catch (err) {
        this.logger.debug(`client: arm_animation echo failed: ${err.message}`)
      }
    }
    bot._client?.on('animation', this.onEntityAnimation)
  }

  patchInventory () {
    if (this.stopped || this.unpatchQuickBar) return
    const bot = this.bot
    if (typeof bot.setQuickBarSlot !== 'function') return
    const original = bot.setQuickBarSlot.bind(bot)
    this.unpatchQuickBar = () => { bot.setQuickBarSlot = original }
    bot.setQuickBarSlot = slot => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
        this.logger.debug(`client: ignored invalid held item slot ${slot}`)
        return
      }
      return original(slot)
    }
  }

  /**
   * Sonar's vehicle check (and, before it, the player's own time in the air)
   * expects the client to behave like a vanilla client riding a falling boat or
   * minecart: one `vehicle_move` obeying boat gravity, one `steer_boat`, and one
   * rotation packet per tick. mineflayer has no vehicle physics at all, so this
   * stages the same packets itself.
   *
   * It is deliberately gated to high altitudes (verification limbo is at Y≈3000)
   * so it can never interfere with a real boat or minecart on a live server.
   */
  setupVehicles () {
    const bot = this.bot
    const client = bot._client
    if (client == null) return

    this.entitySpawns = new Map()
    this.vehicle = null
    this.vehicleStage = 'boat'
    this.vehicleEmulationActive = false
    this.vehicleBypass = false

    this.onSpawnEntity = packet => {
      if (this.stopped || !this.enabled) return
      if (typeof packet.entityId !== 'number') return
      this.entitySpawns.set(packet.entityId, { x: packet.x, y: packet.y, z: packet.z })
      if (this.entitySpawns.size > 64) {
        const oldest = this.entitySpawns.keys().next().value
        this.entitySpawns.delete(oldest)
      }
    }

    this.onSetPassengers = packet => {
      if (this.stopped || !this.enabled) return
      const selfId = bot.entity?.id
      if (selfId == null) return
      const passengers = Array.isArray(packet.passengers) ? packet.passengers : []

      if (passengers.includes(selfId)) {
        if (this.vehicle?.id === packet.entityId) return
        const spawn = this.entitySpawns.get(packet.entityId)
        const pos = spawn ?? bot.vehicle?.position
        // Only emulate verification vehicles (Y≈3000), never real ones.
        if (!pos || !(pos.y > 1000)) return
        this.entitySpawns.delete(packet.entityId)
        this.vehicle = {
          id: packet.entityId,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          motion: 0,
          stage: this.vehicleStage
        }
        this.logger.debug(`client: riding ${this.vehicle.stage} at y=${pos.y}`)
        this.startVehicleEmulation()
        return
      }

      if (this.vehicle && packet.entityId === this.vehicle.id) this.disembark()
    }

    this.onEntityDestroy = packet => {
      if (this.stopped || !this.enabled) return
      const ids = Array.isArray(packet.entityIds) ? packet.entityIds : []
      if (this.vehicle && ids.includes(this.vehicle.id)) this.disembark()
    }

    client.on('spawn_entity', this.onSpawnEntity)
    client.on('set_passengers', this.onSetPassengers)
    client.on('entity_destroy', this.onEntityDestroy)
  }

  startVehicleEmulation () {
    this.vehicleEmulationActive = true
    clearInterval(this.vehicleTimer)
    this.vehicleTimer = setInterval(() => this.vehicleTick(), 50)
  }

  vehicleTick () {
    if (this.stopped || !this.enabled) return
    const vehicle = this.vehicle
    if (!vehicle) return
    const client = this.bot._client
    if (!client || client.state !== 'play') return

    this.vehicleBypass = true
    try {
      if (vehicle.stage === 'boat') {
        // Vanilla boat gravity: motion = (motion - 0.04) with float precision.
        vehicle.motion -= 0.03999999910593033
        vehicle.y += vehicle.motion
        client.write('vehicle_move', {
          x: vehicle.x,
          y: vehicle.y,
          z: vehicle.z,
          yaw: 0,
          pitch: 0,
          onGround: false
        })
        client.write('steer_boat', { leftPaddle: false, rightPaddle: false })
      }
      // Rotation packet: counts as player input for 1.21.2+ vehicle checks.
      client.write('look', { yaw: 0, pitch: 0, flags: { onGround: false } })
    } catch (err) {
      this.logger.debug(`client: vehicle packet failed: ${err.message}`)
    } finally {
      this.vehicleBypass = false
    }
  }

  disembark () {
    const vehicle = this.vehicle
    if (!vehicle) return
    this.vehicle = null
    clearInterval(this.vehicleTimer)
    this.vehicleTimer = null
    this.vehicleStage = vehicle.stage === 'boat' ? 'minecart' : null

    const x = vehicle.x
    const y = vehicle.y - 0.5
    const z = vehicle.z

    // The server sends the vehicle removal and a keep-alive together and
    // ignores movement until the keep-alive is answered, so the falling packet
    // is sent a moment later.
    const timer = setTimeout(() => {
      if (this.stopped || !this.enabled) return
      this.vehicleBypass = true
      try {
        this.bot._client.write('position', { x, y, z, flags: { onGround: false } })
      } catch (err) {
        this.logger.debug(`client: falling packet failed: ${err.message}`)
      } finally {
        this.vehicleBypass = false
      }
      this.logger.debug(`client: vehicle stage ${vehicle.stage} complete`)

      if (this.vehicleStage == null) {
        // Verification should be over; hand movement back to mineflayer.
        const release = setTimeout(() => { this.vehicleEmulationActive = false }, 3000)
        release.unref?.()
      }
    }, 100)
    timer.unref?.()
  }

  /**
   * 1.20.5+ servers (and proxy setups such as Sonar on Velocity) can move a
   * client to another address with a Transfer packet instead of disconnecting
   * it. Vanilla reconnects to the given host/port; mineflayer does not implement
   * it. The target is recorded and the connection ended, so the runtime can
   * reconnect there.
   */
  setupTransfer () {
    const client = this.bot._client
    if (client == null) return
    this.transferTarget = null

    this.onTransfer = packet => {
      if (this.stopped || !this.enabled) return
      const host = packet?.host
      const port = Number(packet?.port)
      if (typeof host !== 'string' || !host || !Number.isInteger(port)) return
      this.transferTarget = { host, port }
      this.logger.info(`client: server transferred us to ${host}:${port}`)
      try {
        client.end('transfer')
      } catch (err) {
        this.logger.debug(`client: transfer end failed: ${err.message}`)
      }
    }
    client.on('transfer', this.onTransfer)
  }

  /**
   * 26.1+ servers use `player_input` (forward/backward/left/right/jump/shift/
   * sprint bitflags) for movement prediction. mineflayer only sends it for
   * sneak, so the server believes every jump/step-up is unrequested motion and
   * sets the player back. Send the full input state when it changes, before
   * mineflayer writes the position.
   */
  setupPlayerInput () {
    this.lastPlayerInput = null
    this.onPlayerInputTick = () => {
      if (this.stopped || !this.enabled) return
      if (!this.configured) this.resolveVersion()
      if (!this.hasPlayerInput) return
      const client = this.bot._client
      if (client.state !== 'play') return
      const control = key => {
        try {
          return Boolean(this.bot.getControlState?.(key))
        } catch {
          return false
        }
      }
      const inputs = {
        forward: control('forward'),
        backward: control('back'),
        left: control('left'),
        right: control('right'),
        jump: control('jump'),
        shift: control('sneak'),
        sprint: control('sprint')
      }
      const fingerprint = JSON.stringify(inputs)
      // Vanilla sends Player Input when the input state changes, not every
      // tick; repeating it every tick makes strict servers predict a new jump
      // each tick and set the player back.
      if (fingerprint === this.lastPlayerInput) return
      this.lastPlayerInput = fingerprint
      try {
        client.write('player_input', { inputs })
      } catch (err) {
        this.logger.debug(`client: player_input write failed: ${err.message}`)
      }
    }
    this.bot.on('physicsTick', this.onPlayerInputTick)
  }

  setupTickEnd () {
    // Vanilla ends each client tick with client_tick_end *after* that tick's
    // movement packet. mineflayer emits physicsTick before it simulates and
    // writes the position, so writing immediately sends tick_end first and
    // makes every movement packet look one tick late (Grim sets the player
    // back). Defer past the synchronous tick body so the order is
    // position/look, then tick_end.
    // Version support is resolved on the first tick, after auto-version has
    // settled.
    this.onPhysicsTick = () => {
      if (this.stopped || !this.enabled) return
      if (!this.configured) this.resolveVersion()
      if (!this.hasTickEnd) return
      const client = this.bot._client
      if (client.state !== 'play') return
      setImmediate(() => this.writeTickEnd(client))
    }
    this.bot.on('physicsTick', this.onPhysicsTick)
  }

  writeTickEnd (client = this.bot._client) {
    if (this.stopped || !this.enabled) return
    if (!client || client.state !== 'play') return
    try {
      client.write('tick_end', {})
    } catch (err) {
      this.logger.debug(`client: tick_end write failed: ${err.message}`)
    }
  }

  setupKnownPacks () {
    // minecraft-protocol answers the first request with an empty pack list
    // (which keeps full registry data flowing). Any later request — a proxy
    // re-entering configuration after a transfer — must still be answered.
    this.onKnownPacks = () => {
      if (this.stopped || !this.enabled) return
      if (this.knownPacksAnswered) {
        try {
          this.bot._client.write('select_known_packs', { packs: [] })
        } catch (err) {
          this.logger.debug(`client: select_known_packs write failed: ${err.message}`)
        }
        return
      }
      this.knownPacksAnswered = true
    }
    this.bot._client?.on('select_known_packs', this.onKnownPacks)
  }

  stop () {
    if (this.stopped) return
    this.stopped = true
    try {
      this.unpatchWriteChannel?.()
      this.unpatchWrite?.()
      this.unpatchMovementWrite?.()
      this.unpatchQuickBar?.()
    } catch {
      // The client is gone; nothing left to restore.
    }
    if (this.onClientState) this.bot._client?.removeListener('state', this.onClientState)
    if (this.onEntityAnimation) this.bot._client?.removeListener('animation', this.onEntityAnimation)
    if (this.onSpawnEntity) this.bot._client?.removeListener('spawn_entity', this.onSpawnEntity)
    if (this.onSetPassengers) this.bot._client?.removeListener('set_passengers', this.onSetPassengers)
    if (this.onEntityDestroy) this.bot._client?.removeListener('entity_destroy', this.onEntityDestroy)
    if (this.onTransfer) this.bot._client?.removeListener('transfer', this.onTransfer)
    if (this.onPlayLogin) this.bot._client?.removeListener('login', this.onPlayLogin)
    if (this.onPhysicsTick) this.bot.removeListener('physicsTick', this.onPhysicsTick)
    if (this.onPlayerInputTick) this.bot.removeListener('physicsTick', this.onPlayerInputTick)
    if (this.onKnownPacks) this.bot._client?.removeListener('select_known_packs', this.onKnownPacks)
    clearInterval(this.vehicleTimer)
    this.vehicleTimer = null
  }
}
