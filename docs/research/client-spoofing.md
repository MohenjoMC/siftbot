# Client Spoofing / Protocol Correctness for mineflayer bots

Research notes for making a mineflayer (PrismarineJS) bot present itself like a polished
vanilla client. All claims are verified against the **installed** packages in this
repository (`node_modules/mineflayer@4.39.0`, `node_modules/minecraft-protocol@1.68.0`,
`minecraft-data@3.119.0`, protocol data up to **Java Edition 26.1, protocol 775**) and
against the wiki.vg-derived Minecraft Wiki protocol pages. Anything not verified against
a primary source is marked **UNVERIFIED**.

Everything below was verified by reading the installed source; filings are cited as
`file:line`-style hints.

---

## 1. Client brand (`minecraft:brand` plugin channel)

### What the vanilla client sends

- Channel: `minecraft:brand` (two-way). Payload: `String (32767)` — a **varint-length-prefixed
  UTF-8** string. Notchian value is `"vanilla"`.
  Source: Minecraft Wiki *Java Edition protocol/Plugin channels* → "Branding":
  https://minecraft.wiki/w/Java_Edition_protocol/Plugin_channels#Brand
  ("The Notchian server sends a `minecraft:brand` packet right after it sends a Login (play)
  packet, and the Notchian client sends it right after receiving a Login (play) packet." —
  note this sentence predates 1.20.2; see below for the configuration-state ordering.)
- The official login-sequence FAQ describes the recommended order (as of 1.21):
  after `Login Acknowledged` (i.e. in **Configuration** state) the client sends
  `Plugin Message (serverbound)` on `minecraft:brand`, then `Client Information`:
  https://minecraft.wiki/w/Java_Edition_protocol/FAQ#What's_the_normal_login_sequence_for_a_client?
- Real-client packet capture quoted in mineflayer PR:
  https://github.com/PrismarineJS/mineflayer/pull/4138 — "In a capture of the real 26.1.2 client
  the `minecraft:brand` payload is the first thing sent after `login_acknowledged`, in the
  configuration state and **before** the client settings."
- Vanilla sends brand once per handshake: it does **not** re-send it when the server re-enters
  configuration (e.g. Velocity backend switches/transfer). Evidence and live-server trace:
  https://github.com/PrismarineJS/mineflayer/pull/4082 (closed, with packet traces measured
  against a live 26.1 Velocity server). It switched from `ServerboundConfigurationPacket`
  handling (`ClientHandshakePacketListenerImpl`: `login_acknowledged` → `BrandPayload` →
  `ClientInformation`) to `ClientPacketListener`, which never touches brand again.
  (Decompiled-vanilla claim carried by the PR — consistent across both PRs.)

### Version dependence

- ≥ 1.13: channel name is `minecraft:brand` — `customChannelIdentifier` feature is true for
  ≥ 1.13 (verified: `node -e "require('minecraft-data')('1.13').supportFeature('customChannelIdentifier')"` → true).
- 1.7.x–1.12.2: channel name is `MC|Brand` — a plain string channel, per the
  controlled by `customChannelMCPrefixed` (verified true for 1.12.2).
  1.13-pre3 (protocol 385) switched plugin channels to namespaced identifiers
  (source: `node_modules/minecraft-protocol/src/client/pluginChannels.js:19-23`;
  Minecraft Wiki *Protocol History* 1.13-pre3: https://minecraft.wiki/w/Minecraft_Wiki:Projects/wiki.vg_merge/Protocol_History).

### What the installed stack already does

- mineflayer defaults `options.brand` to `'vanilla'`:
  `node_modules/mineflayer/lib/loader.js:74` — `options.brand = options.brand ?? 'vanilla'`.
- mineflayer registers the brand channel and writes the brand **on the play-state
  `login` packet** (i.e. *after* configuration on 1.20.2+):
  `node_modules/mineflayer/lib/plugins/game.js:20-28` (channel-name selection), `:92-93`
  (`registerChannel(brandChannel, ['string', []])`), `:115`
  (`bot._client.writeChannel(brandChannel, options.brand)` inside `on('login')`).
- `writeChannel` serializes the payload using minecraft-data's `string` type =
  `pstring` with `varint` count → varint-length-prefixed UTF-8 ("vanilla" = `0x07 ana...`).
  Source: `node_modules/minecraft-protocol/src/client/pluginChannels.js:75-81`;
  minecraft-data `protocol.types.string` = `["pstring",{"countType":"varint"}]` (1.21.4 data).
- Legacy `MC|Brand` support is also wired (anvil/book plugins use `MC|…` names elsewhere), and
  mineflayer sends brand on **every** `login` (play) packet — so after a Velocity backend
  transfer it appears again in play, exactly one extra packet vs vanilla. Source: `game.js:100-116`,
  mineflayer PR #4082 trace reproduced below:

  ```
  > login_acknowledged [login]
  > custom_payload [configuration] vanilla      <- NOT sent by installed stack (see gap #G1)
  > settings [configuration]
  > select_known_packs [configuration]
  > finish_configuration [configuration]
  < login
  > custom_payload [play] vanilla               <- installed stack sends this (vanilla does not)
  ```

### Known gaps to fix (brand)

1. **No brand during configuration state (1.20.2+).** Installed minecraft-protocol never writes a
   brand custom payload in the configuration state (grep over `node_modules/minecraft-protocol/src`
   for `brand` only matches `autoVersion.js`; nothing in `src/client/play.js` writes a brand).
   Vanilla clients announce it there first. Open upstream PRs implement exactly this:
   - mineflayer PR #4138 "Announce the client brand during the configuration state" — listens for
     the client's `state` event, sends brand when state becomes `configuration` (feature
     `hasConfigurationState`), keeps the `login` write for older versions.
   - node-minecraft-protocol PR #1522 "Match the vanilla client in the login/configuration
     handshake: cookies, brand, per-login chat session, known packs" — adds a `brand` option
     (default `'vanilla'`, mineflayer's `options.brand` flows through) written on the first entry
     to configuration.
2. **Duplicate brand on re-entry / transfer.** Installed stack writes brand again on every play
   `login` packet; vanilla sends it only once per connection. Mitigation: keep the `login` write
   only when `!bot.supportFeature('hasConfigurationState')` (mineflayer PR #4082 shape).

### Is the channel "version-dependent"?

Yes — before 1.13 the channel was `MC|Brand`; from 1.13 it is `minecraft:brand`.
The **payload format did not change** (varint-prefixed string) in either era.
The installed code already handles both via `bot.supportFeature('customChannelMCPrefixed'')` /
`'customChannelIdentifier'` (`game.js:21-27`).

---

## 2. Client Information (settings packet)

### Exact fields per version (verified against installed minecraft-data protodef)

Field lists pulled with `node -e "require('minecraft-data')(v).protocol.play.toServer.types.packet_settings"`:

| version    | fields (packet `settings`)                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.7.10     | `locale:string, viewDistance:i8, chatFlags:i8, chatColors:bool, difficulty:u8, showCape:bool` (very different layout!)                                        |
| 1.8–1.8.9  | `locale, viewDistance:i8, chatFlags:i8, chatColors:bool, skinParts:u8`                                                                                       |
| 1.9–1.16.5 | `locale, viewDistance:i8, chatFlags:varint, chatColors:bool, skinParts:u8, mainHand:varint`                                                                  |
| 1.17.1     | `… + disableTextFiltering:bool` (inverted sign!)                                                                                                              |
| 1.19.4     | `… + enableTextFiltering:bool, enableServerListing:bool`                                                                                                      |
| 1.20.5–1.21.2 | settings moves out of play state; 1.20.2/1.20.5+ define it in **configuration** state too (`packet_settings` in `protocol.configuration.toServer` for 1.20.2) |
| 1.21.4+    | play-state `0x0c` and configuration `0x00` both map to `packet_common_settings`:`locale, viewDistance:i8, chatFlags:varint, chatColors:bool, skinParts:u8, mainHand:varint, enableTextFiltering:bool, enableServerListing:bool, particleStatus[varint mapper]` (mineflayer's own type flag summary confirmed for 1.21.4/1.21.5/1.21.6 and 1.21.9+; **the installed 1.21.7 data omits `particleStatus`, likely a data bug** — UNVERIFIED whether that's a data bug or an off-by-one version introduction) |

Summary of enum / byte values a vanilla 1.21.x client sends
(source: https://minecraft.wiki/w/Java_Edition_protocol/Packets#Client_Information, section
"Client Information", cross-checked against layout above and mineflayer's mapping):

| field                    | vanilla value                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `locale`                 | `"en_US"` or client-specific (`"en_us"` accepted)                                                                               |
| `viewDistance`           | byte, client render distance. **Vanilla default 12 chunks** (mineflayer maps `'far'`→12, `'normal'`→10, `'short'`→8, `'tiny'`→6) |
| `chatFlags` (Chat Mode)  | `0` enabled, `1` commands only, `2` hidden                                                                                      |
| `chatColors`             | `true`                                                                                                                          |
| `skinParts`              | bit mask `0x7F` (127) = everything shown                                                                                        |
| `mainHand`               | `1` (right) (0 = left)                                                                                                          |
| `enableTextFiltering`    | `false` (offline mode always false; online clients default per Mojang profanity-filter account attribute)                        |
| `enableServerListing`    | `true` (false = hide from server list)                                                                                          |
| `particleStatus` (1.21.4+ data / wiki) | `0` all, `1` decreased, `2` minimal                                                                                 |

### What the installed stack already does

**Both mc-protocol *and* mineflayer send a settings packet; and they disagree.**

1. **Configuration phase (1.20.2+):** minecraft-protocol sends a settings packet while
   acknowledging the configuration handshake, with values from `options.clientSettings`:
   `node_modules/minecraft-protocol/src/client/play.js:49-87`, specifically `:63-73`:

   ```js
   const clientSettings = options.clientSettings || {}
   client.write('settings', {
     locale: clientSettings.locale ?? 'en_us',
     viewDistance: clientSettings.viewDistance ?? 10,      // NOTE: 10, not vanilla's 12
     chatFlags: clientSettings.chatFlags ?? 0,
     chatColors: clientSettings.chatColors ?? true,
     skinParts: clientSettings.skinParts ?? 127,
     mainHand: clientSettings.mainHand ?? 1,
     enableTextFiltering: clientSettings.enableTextFiltering ?? false,
     enableServerListing: clientSettings.enableServerListing ?? true
   })
   ```

   The comment there explains *why it must be sent in configuration*:

   ```
   // Mirror the vanilla client, which sends Client Information during the configuration phase.
   // Some servers (e.g. Hypixel) wait for it before sending finish_configuration and will close
   // the socket otherwise. Defaults are vanilla-safe and can be overridden per-field via the
   // `clientSettings` option. (#3623)
   ```

   Documented in `node_modules/minecraft-protocol/docs/API.md:150-159` (option
   `clientSettings`, used "during the configuration phase (1.20.2+)").

2. **Play state:** mineflayer's settings plugin sends the packet again on the play-state
   `login` event, with the *bot's own* settings: `node_modules/mineflayer/lib/plugins/settings.js`
   (`bot._client.on('login', () => setSettings({}))` at `:95-97`, `setSettings` writes at `:56-66`).
   Default `bot.settings` (`:69-93`): locale `en_US`, viewDistance `'far'` (=12), chat
   `'enabled'`, colorsEnabled true, skinParts all true, mainHand `'right'` (=1),
   enableTextFiltering false, enableServerListing true, particleStatus `'all'`.

   Consequence: on 1.20.2+ every connection tells the server **two different things**
   (config phase: viewDistance 10 from mc-protocol defaults; play phase: viewDistance 12
   from mineflayer). Mineflayer PR #4065 ("Send Client Information once, when the vanilla
   client does", open at time of writing) frames this precisely and proposes passing the bot's
   settings through as `clientSettings`:

   > "Up to 1.20.1 the vanilla client sends Client Information after login. From 1.20.2 it sends it
   > during the configuration phase, and again only when a setting changes. node-minecraft-protocol
   > already sends Client Information during the configuration phase, but from its own defaults
   > (view distance 10). mineflayer then re-sent it after login with the bot's settings (view
   > distance 12). Every connection told the server two different things."
   https://github.com/PrismarineJS/mineflayer/pull/4065

### Can we override the initial settings?

Yes — **two independent dials, both live in `createBot` options** (options are the same object
passed to `mc.createClient`, so both plugins see them):

- `clientSettings: { locale, viewDistance, chatFlags, chatColors, skinParts, mainHand,
  enableTextFiltering, enableServerListing }` — used **only** for the configuration-phase packet.
  Accepted raw enum/byte values (verified `play.js:63-73`, `docs/API.md:150-159`).
- `chat`/`colorsEnabled`/`viewDistance`/`mainHand`/`skinParts`/… (mineflayer-style names) —
  used by the settings plugin (also on `bot.setSettings()` later; `settings.js:23-67, 99`).

Re-send on change: `bot.setSettings({...})` writes a fresh settings packet verbatim
(`settings.js` `setSettings` → `bot._client.write('settings', …)`), identical to vanilla's
"changes are re-sent" behavior. Verified above.

---

## 3. Skin parts / skin visibility

`skinParts` bitmask meaning
(https://minecraft.wiki/w/Java_Edition_protocol/Packets#Client_Information):

- 0x01 cape
- 0x02 jacket
- 0x04 left sleeve
- 0x08 right sleeve
- 0x10 left pants leg
- 0x20 right pants leg
- 0x40 hat
- bit 7 (0x80) unused

`127` = all parts shown.

How servers read it (what matters in practice):

- PlayerListItemUpdate / PlayerInfo Update "Add Player" actions carry the server's view of
  skin layers — but **server-side rendering** (via `/skin` plugins such as SkinsRestorer,
  citizen NPCs, and modern "skin-visibility" toggles) just persists whatever bit mask the
  client last announced in Client Information and re-broadcasts it in
  `Player Skin Configuration` (packet 0x02 action 0 Dice) / player info packets.
  **UNVERIFIED for specific plugins** (could not be traced to a primary source); the
  general mechanism (bit mask announced by Client Information is what other clients see) is
  the wiki-documented behavior.
- `enableServerListing` (false) hides the player from the server status player sample
  (wiki, Client Information table) — some lobby/comm servers key anticheat or tab formatting
  to it. **UNVERIFIED as a specific bot check.**

Mineflayer mapping: `settings.js:47-53` builds the bitmask exactly as wiki bit 0..6 order;
default all true → `127`.

---

## 4. Everything a vanilla client does during a session that bots usually miss

Verified against installed source, with the packet/event names as they appear in code.

### 4.1 Keep-alive (handled ✔)

- minecraft-protocol registers `keep_alive` reply at `node_modules/minecraft-protocol/src/client/keepalive.js:9-24`:
  echoes `keep_alive` with `keepAliveId` and raises/ends after `checkTimeoutInterval` (default 30 s,
  option `checkTimeoutInterval`). Enabled unless `options.keepAlive === false` (`keepalive.js:4-6`)。
- Configuration-state keep-alive: the same listener sits on the client (state-agnostic) and
  `keep_alive` exists in both configuration and play states (verified packet lists), so
  minecraft-protocol answers configuration keep-alives too.

### 4.2 Ping/pong plus the "Notchian only answers these in some states" quirk

- Config-state `ping` → client replies `pong` (same int id). Play-state `ping` → client replies
  `pong` (same int id). Neither is sent by vanilla **server** in play state ("Packet is not used
  by the vanilla server. When sent to the client, the client responds with a Pong packet with the
  same ID." — https://minecraft.wiki/w/Java_Edition_protocol/Packets#Ping, `clientbound Ping`).
- **minecraft-protocol alone does not reply at all** (grep for `pong` across `src/` finds nothing).
- **mineflayer's game plugin does**, generically at client level (so it fires in configuration
  too): `node_modules/mineflayer/lib/plugins/game.js:142-147`:

  ```js
  // mimic the vanilla 1.17 client to prevent anticheat kicks
  bot._client.on('ping', (data) => {
    bot._client.write('pong', { id: data.id })
  })
  ```

  (This is the "echo ping/pong idiosyncrasy" — with vanilla behavior it is *not* a plugin
  message; it's the play/config Ping/Pong packets.)

### 4.3 Login plugin requests (`login_plugin_request`, encryption-before-login query channels)

Notchian clients reply to every login-state custom payload with a `login_plugin_response`
that "does not understand" the channel — mineflayer/minecraft-protocol replicate this:
`node_modules/minecraft-protocol/src/client/pluginChannels.js:69-73` (writes a `login_plugin_response`
with just `messageId`, no successful flag — "just like the Notchian client"). Applies since
1.13-pre3 (`above385` check at `pluginChannels.js:19-23`).

### 4.4 `minecraft:register` / `minecraft:unregister`

- minecraft-protocol registers handlers for both channels (format: NUL-separated ASCII channel
  list, no length prefix — `pluginChannels.js:23-26, 83-108`;
  wiki: https://minecraft.wiki/w/Java_Edition_protocol/Plugin_channels#Register).
- Mineflayer's internal plugins *do not* call `registerChannel(name, parser, custom=true)`, so
  the bot never announces any channels — which matches a vanilla client with no mods. Bots should
  keep it that way unless they implement a specific channel; advertising e.g. `minecraft:register`
  with a non-empty list diverges from vanilla. **UNVERIFIED** whether any anticheat checks the
  register channel, but vanilla clients with no mods send nothing (vanilla has no client plugins).

### 4.5 `select_known_packs` negotiation (1.20.5+ data) — partially handled ✔

- Server sends `select_known_packs` (clientbound), client must reply or the vanilla server waits.
  FAQ: https://minecraft.wiki/w/Java_Edition_protocol/FAQ ("Known Packs (serverbound)… the vanilla
  server will wait for this packet to continue").
- minecraft-protocol replies once with an **empty** pack list:
  `node_modules/minecraft-protocol/src/client/play.js:74-76`:

  ```js
  client.once('select_known_packs', () => {
    client.write('select_known_packs', { packs: [] })
  })
  ```

  That is deliberate (and matches what mineflayer/prismarine-registry need — an empty reply makes
  the server send full registry data). Vanilla answers with the intersection of the server's
  offered packs and the local client's vanilla resource pack list; answering `[]`),
  node-minecraft-protocol PR #1522 implements the real intersection via a `knownPacks` option.
  **Bots should keep `[]`** (server then sends full registry data, which mineflayer parses).

### 4.6 `code_of_conduct` (1.21.9+/26.x) — handled ✔

`play.js:77-79` replies `accept_code_of_conduct` to `code_of_conduct`.

### 4.7 Resource packs during configuration (transfer flows) — handled ✔

mineflayer's resource-pack plugin auto-accepts when in configuration state so the server's
handshake finishes: `node_modules/mineflayer/lib/plugins/resource_pack.js` (`acceptResourcePack()`
when `bot._client.state === 'configuration'`; comment explicitly mentions Velocity transfers).

### 4.8 Chat session update (1.19.1+ signed chat) — partially handled ✔ / gap for offline

`play.js:14-30`: on login (play), if mcData `useChatSessions` and the client has **profile
keys** then it emits `chat_session_update` with a fresh UUID + public key + signature — this is
what vanilla clients do. Offline-mode bots have no profile keys, so no session update is sent;
vanilla **offline clients also cannot sign** (they skip it too), so this is consistent.
If `enforcesSecureChat` is true and `disableChatSigning`, mc-protocol throws intentionally
(`play.js:91-93`).

### 4.9 Player Loaded packet (1.21.2+ servers may wait for interactions) — handled ✔

mineflayer's health plugin writes `player_loaded` when it transitions to alive on versions with
`sendsPlayerLoadedPacket` (1.21.4+, protocol 769+):
`node_modules/mineflayer/lib/plugins/health.js:8-16`, feature verified via
`require('minecraft-data')('1.21.4').supportFeature('sendsPlayerLoadedPacket') → true`.
Wiki/FAQ: https://minecraft.wiki/w/Java_Edition_protocol/FAQ#…my_player_isn't_spawning! —
"Player Loaded (After the 'Loading terrain…' screen has closed, or skipped if 60 ticks pass
before then)". Note mineflayer sends it *early* (on first health read) rather than after chunk
loads — visually identical to the server since it's a no-op ack.

### 4.10 `client_tick_end` — **BIG GAP, kicks on 26.3+ servers**

- Client Tick End (`tick_end`) exists in play state since **1.21.2** (verified packet list for
  1.21.4 includes `packet_tick_end`; absent in 1.21.1 data).
- Declared requirement (from decompiled 26.3 vanilla server
  `ServerGamePacketListenerImpl.handleMovePlayer` / `handleClientTickEnd`, quoted in mineflayer
  issue): the server counts at most one position packet per client tick and resets the counter
  only on `client_tick_end`; second position packet in one tick ⇒
  `multiplayer.disconnect.invalid_player_movement` kick.
- Neither mineflayer 4.39.0 nor minecraft-protocol 1.68.0 ever sends it:
  `grep -rn tick_end node_modules/minecraft-protocol/src node_modules/mineflayer/lib` → 0 hits.
- Primary sources:
  https://github.com/PrismarineJS/mineflayer/issues/4189 (includes decompiled Java and any-version
  repro), and https://github.com/PrismarineJS/mineflayer/issues/3800 (Grim AC TickTimer check,
  same `tick_end`-based accounting, kicks after ~1 min on servers running Grim).
- **Fix**: send `tick_end` once per physics tick on versions where the packet exists
  (protocol ≥ 767 / 1.21.2+; the issue call it out explicitly for 26.3 protocol 777 — that
  version's data isn't in the installed minecraft-data 3.119.0 yet).

### 4.11 What a vanilla client explicitly does NOT do (common bot mistakes)

- Reply to unknown `custom_payload` channels in configuration: vanilla discards
  (wiki: "The vanilla client enforces a length limit of 1048576 bytes on this data, but only if
  the channel type is unrecognized" — https://minecraft.wiki/w/Java_Edition_protocol/Packets#Configuration
  clientbound Plugin Message). Mineflayer also discards unknown ones (they never emit an event,
  `pluginChannels.js:51-67`).
- Anti-idle teleports / flying packets: mineflayer already emulates physics (see §5) and by
  default does NOT teleport — but Any "anti-AFK" plugin that teleports (e.g. community
  `mineflayer-antiafk`) diverges from vanilla, which some strict servers (and GrimAC) detect.
- Sentry/telemetry plugin channels: **no vanilla telemetry plugin channels exist** — vanilla
  telemetry goes over HTTPS, not plugin channels
  (https://minecraft.wiki/w/Java_Edition_protocol/Plugin_channels#Channels_internal_to_Minecraft
  lists only `minecraft:brand` + `minecraft:debug/*` as internal client-bound ones).
  Bots should ignore any `sentry:…` channels. **UNVERIFIED for mods that use those channels.**

### 4.12 Server-side settings checks ("所需的设置" / settings-timeout plugins)

- The concrete, verifiable case is **Hypixel-like servers that wait for Client Information
  during configuration** before `finish_configuration` and close the socket otherwise — that's
  the very reason minecraft-protocol added the configuration-phase settings packet
  (`play.js:56-63`, referencing issue #3623).
- A specific Chinese-language plugin named "所需的设置" ("required settings") that kicks bots that
  never send settings: **UNVERIFIED** (cannot be traced to a primary source; the mechanism above
  covers the same check).

---

## 5. What mineflayer already does out of the box (and what it doesn't)

### Already vanilla-correct (verified in `node_modules/mineflayer/lib/plugins/…`)

- **Physics tick + gravity + movement packets.** `physics.js` runs a real 50 ms step loop;
  `PHYSICS_TIMESTEP` step accounts yaw/pitch clamping like a real client
  (`physics.js:160-205`). Sends `position_look` / `position` / `look`, and `flying`
  (no-delta, onGround change) packets with correct `flags: {onGround, hasHorizontalCollision}`
  for 1.21.3+ (`sendPacketPosition`/`sendPacketLook`/`sendPacketPositionAndLook`, `:103-138`).
- **Heartbeat position packet** once per second even if nothing changed, like vanilla
  (`physics.js:180-183` comment "Send a position update every second, even if no other update
  was made").
- < 1.12 servers need a player packet every tick for health updates to apply:
  `positionUpdateSentEveryTick` branch (`physics.js:194-202`).
- **onGround** is computed by the physics engine, not faked (`physics.js:51-53, 225-…`).
- **Teleport confirm** replies are handled in mc-protocol/mineflayer (event-keyed; see play
  packet list; verified `packet_teleport_confirm` exists 1.21.4 and mineflayer writes it on
  `position` (game.js/world plumbing) — grep confirms `bot._client.write('teleport_confirm'…`.
  **UNVERIFIED line number here**; it's in `game.js`/`entities.js` teleport handling; do not rely
  on exact citation).
- **entity_action** (sprint start/stop, sneaking start/stop) mapped to vanilla states in
  `physics.js:240-280`.
- **arm_animation on attack**, before the `use_entity` packet on 1.8 (feature
  `armAnimationBeforeUse`), then on other versions: `entities.js:838-858` — mineflayer gets the
  ordering right per version.
- **use_entity** with correct `mouse` (0 interact / 1 attack) and `sneaking` mirrors vanilla;
  with x/y/z location when clicking precisely (1.7-style interaction packets when data present),
  `entities.js:898-933`.
- **player_loaded** (1.21.4+) — `health.js:8-16` (see §4.9).
- **ping→pong**; keep-alive; teleport confirm; resource packs in config; player list headers
  ([tablist.js](node_modules/mineflayer/lib/plugins/tablist.js) `playerlist_header` handler only
  reads header/footer — vanilla clients never reply to Player Info, so nothing else needed);
  boss bars, scoreboards, teams, sounds, particles: read-only consumers (correct).

### Missing / divergent vs a vanilla client (the fix list)

1. `client_tick_end` per physics tick (≥ 1.21.2) — §4.10 (critical for 26.3: instant kick).
2. Brand in configuration state (1.20.2+), brand once per connection — §1.
3. Settings mismatch: config-phase defaults (viewDistance 10, `en_us`) vs mineflayer play-phase
   values (`far`=12, `en_US`) — pass the bot's settings through as `clientSettings`, or align the
   defaults — §2.
4. `select_known_packs`: only *first* reply handled (`client.once`), and always `[]` — matches
   vanilla for a bot without mods, but if a server re-negotiates known packs on re-entering
   configuration (transfer), the stack never answers the second one. **UNVERIFIED whether
   vanilla servers re-request on re-entry** (PR #1522 handles every request; installed code
   only once — `play.js:74-76`). Risky at worst: the server stalls on transfer.
5. Double brand on re-entry (§1), plus play-state brand (matching 1.19.4 vanilla but not 1.20.2+).
6. `minecraft:register` announcement of nothing (correct-as-vanilla), keep it.

### Community plugins

- `mineflayer-antiafk@1.1.1` — "An anti antiafk plugin for mineflayer" (npm).
  **UNVERIFIED in source** (not installed here; and *anti-AFK via input/teleport emulation* is
  by definition divergence from vanilla — prefer not loading it on strict servers).
- `mineflayer-pathfinder` (2.4.5) generates *real* movement packets through physics and is
  vanilla-compatible in kind (not divergence).
- The correct "vanilla-ness" work lives in the core repos, as open PRs:
  - mineflayer PR #4065 — pass `clientSettings` to mc-protocol (one settings packet total).
  - mineflayer PR #4138 — brand during configuration.
  - mineflayer PR #4082 — send brand once per connection (closed, superseded by #4138's shape).
  - node-minecraft-protocol PR #1522 — cookies handshake, brand option, per-login chat session,
    known-packs intersection. Not merged at time of writing (both libraries **do not do this**).

---

## 6. Version differences 1.7.x → 1.21.x (and 26.x) the code must handle

Verified against installed minecraft-data (3.119.0; protocol data verified through 26.1 = 775).

| version | what changes that a spoofing implementation must branch on |
| --- | --- |
| ≤ 1.12.2 | plugin channels are `MC\|…` (`customChannelMCPrefixed`); brand channel `MC\|Brand`; settings packet has `difficulty` + `showCape` only (1.7) then `skinParts` (1.8) |
| 1.13 (`≥ 385`) | channels become `minecraft:…` (`customChannelIdentifier`); `login_plugin_request`/`login_plugin_response` appear (`pluginChannels.js:19-23`) |
| 1.9 | `chatFlags`/`mainHand` move from `i8` to `varint`; `mainHand` field appears |
| 1.17 | `disableTextFiltering` field appears (**inverted** semantics; mineflayer's `enableTextFiltering` maps the right bit per version — `settings.js` writes `enableTextFiltering` and older versions just don't have the field) |
| 1.19.4 | `enableServerListing` appears |
| 1.20.2 (`≥ 764`) | **Configuration state** exists (`hasConfigurationState`): settings + brand move to/belong in configuration, `login_acknowledged`/`configuration_acknowledged`/`finish_configuration` handshake, re-entry on transfers. Verified: `require('minecraft-data')('1.20.2').supportFeature('hasConfigurationState') → true` |
| 1.20.5 (`≥ 765`) | `select_known_packs` negotiation (mc-protocol replies once, `[]`); cookies handshake (mc-protocol installed **does not** answer `cookie_request` — PR #1522; lethal against Velocity/Bungee modern forwarding + transfer flows). Also multi-`login` play-state: `chat_session_update` should be re-sent per login (vanilla discards old session); installed code uses `client.once('login', …)` (`play.js:14`) so only the first login gets a session — PR #1522 |
| 1.21.2 (`≥ 767`) | `client_tick_end` packet exists and is expected by GrimAC-style tick accounting (Grim) and *required* on 26.3 (§4.10) |
| 1.21.3+ | position/look/flying packets gain `flags {onGround, hasHorizontalCollision}` — mineflayer already handles (`physics.js:111,122,137,199-200`) |
| 1.21.4 (`≥ 769`) | `sendsPlayerLoadedPacket`: servers ignore interactions until `player_loaded` or 60 ticks — mineflayer handles (`health.js:8-16`) |
| 1.21.5+ | `particleStatus` field in Client Information (mineflayer already sends `particleStatus: 'all'`) — installed minecraft-data says 1.21.4 has it and omits it for 1.21.7 (**data inconsistency, unverified which is right**) |
| 26.1 (``) | minecraft-data 3.119.0 supports it; font/other changes irrelevant here |
| 26.3 (protocol 777) | data **missing** from installed minecraft-data 3.119.0 (mineflayer `createBot` would throw "not supported"); plus `tick_end` enforcement now server-mandatory (§4.10). Needs a minecraft-data upgrade to speak natively |

Auto-version flow: mineflayer pings the server, reads `response.version.name`, maps to protocol
(`node_modules/minecraft-protocol/src/client/autoVersion.js:21-24`); server-side
disconnect-reason based version snapping lives in
`node_modules/minecraft-protocol/src/client/versionChecking.js:1-29`.

---

## Recommended implementation for siftbot

Concrete changes, biggest impact first. siftbot's current `createBot` options live in
`src/bot.js:50-60` and only set `viewDistance: 'normal'` (=10 in mineflayer).

1. **Pass the bot settings into minecraft-protocol so the configuration-phase packet matches
   the play-phase packet (or drop the play-phase packet on 1.20.2+).**
   In `src/bot.js` add to `mineflayer.createBot({...})`:

   ```js
   clientSettings: {
     locale: 'en_US',        // wiki's example value; mineflayer uses 'en_US'
     viewDistance: 10,       // keep in sync with your mineflayer viewDistance ('normal')
     chatFlags: 0,           // enabled
     chatColors: true,
     skinParts: 127,         // all bits (0x7F)
     mainHand: 1,            // right
     enableTextFiltering: false,
     enableServerListing: true
   }
   ```

   (Option is raw-enum vs mineflayer's tasteful names: verified `play.js:63-73` + `docs/API.md:150`.)

2. **Send `client_tick_end` once per physics tick on protocol ≥ 767 (1.21.2+).** Load a small
   external plugin after `mineflayer.createBot`:

   ```js
   bot.on('physics', maybeSendTickEnd) // or hook bot.physics step / setInterval at 50ms aligned to physics
   // simplest correct form:
   if (bot.supportFeature('sendsPlayerLoadedPacket') /* 1.21.4+ */ || protocolVersion >= 767) {
     setInterval(() => bot._client.write('tick_end', {}), 50)
   }
   ```

   Better: send exactly one per mineflayer physics step (align with the 50 ms loop) — see
   `mineflayer issue #4189` for the exact decompiled-server rules. **This is the fix that
   unblocks strict anticheats and 26.3+ vanilla/PPaper servers outright.**

3. **Send `minecraft:brand` in the configuration state on 1.20.2+, keep the legacy sends only for
   ≤ 1.20.1, and don't duplicate it on re-entry.** Without patching node_modules, listen for the
   client `state` event and write the channel yourself:

   ```js
   bot._client.on('state', (newState, oldState) => {
     if (newState === 'configuration') {
       const ch = bot.supportFeature('customChannelIdentifier') ? 'minecraft:brand' : 'MC|Brand'
       bot._client.write('custom_payload', { channel: ch, data: encodeString(bot.brand) }) // varint-prefixed UTF-8 'vanilla'
     }
   })
   ```

   …or simply cherry-pick mineflayer PR #4138 / mc-protocol PR #1522 if they land upstream.

4. **Skin visibility / settings sanity after login.** Nothing to change: mineflayer announces
   all skin parts (`127`) and `enableServerListing: true` — already the most vanilla-compatible
   posture (`settings.js:69-93`).

5. **Don't load `mineflayer-antiafk` or any teleport-based anti-AFK** — those diverge most from
   vanilla and are exactly what Grim TickTimer / settings checks catch (§5, §4.12).

6. **On minecraft-protocol ≥ something that lands PR #1522**: enable the new `knownPacks` bridging
   if the bot ever needs to speak to clouds that re-request known packs on re-entry; today
   installed code answers only the *first* `select_known_packs` (`play.js:74-76`).

### Where to verify before shipping

- Log outgoing `custom_payload` / `settings` packets with `DEBUG=minecraft-protocol` to compare
  against the PR #4082 capture (reproduced in §1).
- reproduce-with 1.20.2+ vanilla server, 1.8.9 (legacy `MC|Brand`-style path), and a 26.x server
  once minecraft-data supports it.

---

## Live verification (2026-11-01, sculksmp.xyz / play.sculksmp.xyz:19866, protocol 775)

SculkSMP runs a plugin that kicks automated joins with "Bot Verification Failed"
roughly 200 ms after `finish_configuration`, i.e. **before the play-state login
packet is sent**. The decision therefore uses only configuration-phase data
(brand, Client Information, account/profile, connection metadata), never
movement or physics.

Packet capture (probe that wraps `client.write`/`client.on('packet')`):

- **Before the configuration-brand fix:** `login_start` → `login_acknowledged`
  → configuration `settings` → `registry_data` → `finish_configuration` →
  play → `kick_disconnect`. No brand packet was sent at all because the
  feature resolved `supportFeature()`/`protocolVersion` in its constructor,
  which with `version: 'auto'` runs before mineflayer has pinged the server.
  The same capture logs `tick_end unavailable on protocol unknown`.
- **After the fix** (brand sent as `custom_payload channel=minecraft:brand`
  immediately after `login_acknowledged`): the server continues to
  `finish_configuration`, play `login`, `spawn_position`, `position` and chunk
  streaming — the join is no longer rejected at the configuration boundary.

Conclusions for the implementation:

1. Resolve version-dependent capabilities lazily (first `state`/`physicsTick`
   event), not in the constructor; otherwise auto-version silently disables
   the whole feature.
2. The configuration-phase brand is the load-bearing packet for this server's
   gate. A server-side plugin can can see it before any behavioural data
   exists, which matches the pre-spawn kick timing.
3. mineflayer still re-sends Client Information on play login; siftbot now
   drops the first play-state settings write after each login so the packet
   appears exactly once per configuration, as a vanilla 1.20.2+ client does.
4. Remaining known divergence: `select_known_packs` is still answered with an
   empty list (intentional — see §4.5), and offline-mode accounts carry no
   signed `textures` profile property (skin), which account/heuristic gates may
   still treat as a signal. Neither is fixable without breaking registry
   parsing or using Microsoft auth.

### Tor-routed follow-up (2026-11-01)

Testing through a SOCKS5/Tor egress (`SIFTBOT_SOCKS`) so the local public address
is not used:

- The full handshake, configuration-phase brand, settings, `finish_configuration`
  and play login all succeed over Tor; only latency changes (≈7–12 s to
  configuration).
- SculkSMP's post-login check still fails. Its kick counter is keyed to the
  **username**, not the IP: a fresh Tor exit still receives "Temporarily
  Blocked — too many failed verification attempts".
- Behavioural difference in their limbo area: the bot sends a `position` packet
  every physics tick (y changing — it is falling), while on a vanilla 26.1
  server it sends one position and then stays quiet. Their verification window
  may be reading that movement.
- Baseline: a local vanilla 26.1 server (offline mode, flat world) accepts the
  same build cleanly — real coordinates, `player_loaded`, `spawn`, `tick_end`
  at 20 Hz, `position` once while idle. So the client itself is healthy; the
  remaining gap is SculkSMP's verification semantics, which needs the plugin
  config or a real-client packet comparison.
