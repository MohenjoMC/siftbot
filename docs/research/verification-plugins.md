# Minecraft anti-bot / verification plugins — how they work

Research notes for siftbot's client-presentation work. Two families were examined;
claims are tied to the plugin's own source (or decompiled/inspected release where
noted) and to a local reproduction.

## Sonar (jonesdevelopment/sonar) — the plugin on sculksmp.xyz

Evidence:

- Source: https://github.com/jonesdevelopment/sonar (GPL-3.0), cloned at the time
  of writing; paths below are from that tree.
- Release checked: Modrinth `Sonar-Paper.jar` 2.1.53
  (`https://modrinth.com/project/I2qO6xbc`), run on Paper 26.1.2 with Java 25.
- Local reproduction: probe client against a local Sonar instance reproduced the
  SculkSMP failure exactly, including its message family ("You have failed the bot
  verification", "Please wait a few seconds before trying to verify again").

### The flow

1. `GravityHandler` (`common/src/main/java/xyz/jonesdev/sonar/common/verification/GravityHandler.java`)
   sends JoinGame, a spawn position, empty chunks, an **invisible collision
   platform**, and two teleports (IDs `FIRST_TELEPORT_ID`, `SECOND_TELEPORT_ID`).
   It then shows the configured welcome message — Sonar's default is
   "You are being verified. Please do not move; this is an automatic …", which
   SculkSMP has reworded to "Verifying connection… Please stay still for a moment."
2. It validates movement tick by tick:
   - the first packet after the teleport must be **position + rotation**,
     `onGround=false`, at the exact spawn X/Z;
   - the next packet must have **zero Y delta and carry rotation**
     (`canFall` is only set in that branch);
   - after that every Y delta must equal `(prevDeltaY - 0.08) * 0.98` within
     **1e-7**, until the player lands exactly on `PLATFORM_Y_POSITION + blockHeight`
     (the collision check; a random block height is used each time);
   - on 1.21.2+ movement packets and `client_tick_end` must alternate.
3. `ProtocolHandler` then probes protocol fidelity:
   - sends an **invalid held-item slot** and expects the client to ignore it;
   - sends a valid `set_held_item` and expects the client to answer with
     `held_item_slot`;
   - sends a transaction/ping and expects an accepted response;
   - plays an arm animation for the player and expects a swing-arm echo
     (removed for 26.3+ clients).
4. `VehicleHandler` (default `timing: ALWAYS`) spawns a boat at
   `IN_AIR_Y_POSITION` (3000 + random up to 500), mounts the player, sends a
   keep-alive, and expects at least `minimum-packets` (default **2**) of each:
   boat paddle packets, `vehicle_move` packets obeying boat gravity
   (`prevMotion - 0.03999999910593033`, tolerance 1e-7), and rotation packets;
   then the same with a minecart one block below, followed by a falling
   movement packet. Only then does the player reach the real server.
5. `CaptchaHandler` is last; `map-captcha: NEVER` by default.

### What siftbot had wrong, and what was fixed

Reproduced locally against Sonar on Paper 26.1.2 (no SculkSMP involvement):

1. **Brand not sent (auto version).** Feature constructed before mineflayer
   resolves the version, so `supportFeature()`/`protocolVersion` were unresolved
   and every capability check disabled itself. Fixed with lazy resolution.
2. **Duplicate position after teleport.** mineflayer's
   `sendPacketPositionAndLook` does not update its heartbeat timestamp, so the
   next physics tick emits a redundant `position` (no rotation). Sonar rejects
   it as "illegal movement packet order". Fixed by promoting the duplicate to
   `position_look` (same coordinates/rotation).
3. **Invalid held-item slot crashes the client.** `simple_inventory.js` asserts
   `slot >= 0`; Sonar deliberately sends an out-of-range slot. Fixed by ignoring
   invalid slots like vanilla (patch installed on `inject_allowed`, because
   mineflayer defers plugin injection until after the version ping).
4. **No swing-arm echo.** Vanilla (<26.3) echoes an arm animation for its own
   player; mineflayer never does. Fixed with a version-gated echo.

Result against local Sonar: brand/settings/gravity/collision/protocol checks all
pass; the client now reaches `VehicleHandler` and idles there until the
verification timeout, because mineflayer has no boat physics.

### Remaining work: vehicle stage

To pass Sonar's default config the client must behave like a vanilla client in a
falling boat/minecart: send `vehicle_move` with the boat gravity constant,
`steer_boat`, and rotation packets each tick, then a falling movement packet
when detached. This is implementable in `src/features/client-identity.js` as a
"vehicle" step, but is a distinct, sizeable behaviour and was not part of this
pass.

## VoidCaptcha (Modrinth `tqGxO2pe`) — inspected release

Downloaded the 1.0.0 release jar and inventoried it: Paper/Spigot plugin
(`com/realnamanyt/voidcaptcha/…`) that puts new players in a **dedicated captcha
world** and shows a code on a rendered map (`captcha/MapCaptchaRenderer`), solved
by chat (`ChatListener`). Unlike Sonar it is not a physics check, so a bot must
read the map and type the code; there is no protocol-level path around it.
License: ARR (closed source), so this note rests on the released artifact only.

## Confirmation on SculkSMP (live)

With the fixes above plus Transfer-packet handling, siftbot passed the live
SculkSMP verification and reached the real server. The login sequence was:

1. `minecraft:brand` in configuration → settings → gravity/collision checks →
   protocol checks → boat/minecart vehicle checks;
2. server sent `transfer` (`packet_common_transfer`: host + varint port) — this
   was the step that previously ended the connection silently, since
   mineflayer does not implement it;
3. after handling transfer/reconnect, the bot landed on the backend and received
   the server's own `/login <password>` prompt (AuthMe-style offline-mode auth).

Note: `transfer` is only sent while the player is still unverified. Once the
username is in Sonar's verified cache the proxy routes the join straight to the
backend, so a later run shows no transfer at all.
