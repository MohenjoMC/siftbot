# siftbot

An AFK Minecraft bot built on [mineflayer](https://github.com/PrismarineJS/mineflayer), with auto-eat, a held sneak key, anti-AFK activity, a live console, and an [OpenTUI](https://opentui.com) control room for running many bots at once.

- **Multi-bot control room** — add any number of bots with different names, servers and accounts, start and stop them independently, and follow a separate live console for each one.
- **Auto-eat** keeps hunger topped up so natural regeneration keeps running. It picks the smallest meal that fills the gap instead of wasting steak at 19/20 hunger, and it never burns golden apples or risky foods.
- **Held shift** keeps sneak pressed for the whole session, re-applies it on respawn, and has a watchdog for anything that resets client input.
- **AFK activity** looks around, swings, and jumps on a randomized timer. Optional small steps and chat lines are available.
- **Vanilla client presentation** announces the bot the way the official client does — a vanilla brand in the configuration phase, identical settings packets in both phases, answers to every known-packs negotiation, and `client_tick_end` every physics tick on 1.21.2+, which strict anticheats and 26.x servers expect.
- **Passes Sonar verification** — the popular anti-bot plugin's default checks (vanilla physics, protocol probes, boat/minecart packets, proxy transfer) are matched client-side, so the bot gets through on servers where automation is allowed.
- **Plugins with hot reload** — drop an ES module into `plugins/` and give every bot new behaviour: move, look, equip, read chests, add console commands, react to chat and events. Save the file and running bots rebind without a restart.
- **Live console** shows chat, whispers, system messages, and lets you type commands or chat in real time.
- **Automatic reconnect** with exponential backoff, plus optional startup commands for `/login` or `/register`.
- **Password manager** — saved passwords (JSON, mode 0600, hand-editable) are remembered from `/register` or `/login` commands the bot sends, and the bot answers the server's login prompt automatically on every reconnect.
- **Mod-ready API** — authenticated HTTP(S) endpoints for instances, console input and logs, Server-Sent Events for live updates, and signed outbound webhooks.
- **Sanitized logs** strip terminal escape sequences from player chat.

## Requirements

- Node.js **20.11 or newer** for the single-bot CLI.
- [Bun](https://bun.sh) **1.3.14 or newer** for the OpenTUI control room. OpenTUI is a native Zig renderer; this project does not require Node 26's experimental FFI because the UI runs on Bun.
- A Minecraft server. Supported Java Edition versions follow mineflayer: 1.8.8 through 26.1 with this dependency set, and newer versions as mineflayer adds them.

## Quick start

### One bot, terminal console

```bash
npm install
cp config.example.json config.json
# edit config.json — at minimum set host, port and username
npm start
```

Or skip the file and pass flags:

```bash
node src/index.js --host play.example.com --port 25565 --username siftbot
```

Run `npm start -- --help` for every option. The bot reads `./config.json` automatically when it exists. CLI flags override environment variables, which override the file.

### Many bots, OpenTUI control room

```bash
npm install
npm link          # installs the `siftbot` and `siftbot-ui` commands
siftbot-ui
```

`siftbot-ui` is the control room; `siftbot` is the single-bot CLI. Both run from any directory. The UI stores its bots in `instances.json`. On first launch it adopts an existing `config.json` as the first bot, otherwise it starts empty — press `a` to add one.

- `↑` / `↓` selects a bot.
- `s` starts or stops it; `r` reconnects.
- `i` focuses its console. Type chat, `/server-command`, or the same `.commands` as the CLI.
- `a`, `e`, `d` add, edit and delete bots.
- `?` shows help, `q` quits.

In-game menus (chests, shops, RTP) render as a **popup grid** automatically. `u` right-clicks
the held item to open a server menu, `g` reopens the popup, arrows move, `Enter` clicks a
slot, `Esc` closes the window.

### Run the TUI at boot

A terminal UI needs a TTY, so the shipped unit starts it inside a named tmux
session (`deploy/systemd/siftbot-ui.service`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/siftbot-ui.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now siftbot-ui.service
loginctl enable-linger "$USER"      # start at boot without an interactive login
tmux attach -t siftbot-ui           # open the control room from any shell
```

Stop with `systemctl --user stop siftbot-ui`. The unit assumes `siftbot-ui` and
`tmux` are in `~/.local/bin` and the instances file is `~/silfmc-live/instances.json`;
adjust the paths for your layout. Never run the API daemon and the TUI service
against the same instances file — both own the bot sessions.

Each bot has its own username, host, port, auth mode, version, password, auto-eat threshold and feature toggles. Bots run in the same process but have separate sessions and log buffers, so stopping or restarting one does not affect the others. Every bot is a full Minecraft client, so a handful per process is comfortable; dozens will use a lot of RAM.

The add/edit form covers the common settings. Advanced options (startup commands, AFK chat, reconnect tuning, food exclusions) are preserved from the copied config and can be edited directly in `instances.json`. Each entry stores a `label` and a complete config object.

`instances.json` is written with mode `0600` because it can contain login passwords. It is gitignored. Set `SIFT_UI_FILE=/path/to/file.json` to use a different location. OpenTUI inputs do not support password masking, so the password field is visible while the form is open.

> `config.json` and `instances.json` are both ignored by git. Keep them private.

### Mod / HTTP API daemon

The API is what a Minecraft mod, web dashboard or script should talk to. It runs headless and shares the same `instances.json`:

```bash
npm run api
cat api-token
```

Defaults: `http://127.0.0.1:8787`, token generated once in `./api-token` with mode `0600`, webhooks in `./webhooks.json`. Add `--start-all` to launch every configured bot with the daemon.

It includes:

- REST instance CRUD, start/stop/restart/reconnect, console input, and log backlog.
- `GET /api/v1/events` and `GET /api/v1/instances/{id}/events` SSE streams with snapshot/replay support via `Last-Event-ID`.
- Signed webhook subscriptions with per-event and per-instance filters.
- HTTPS when given `--tls-cert` and `--tls-key`; `npm run cert` creates a local self-signed pair.

Full contract: **[docs/API.md](docs/API.md)** · OpenAPI: **[docs/openapi.yaml](docs/openapi.yaml)**.

```bash
TOKEN=$(cat api-token)
curl -s http://127.0.0.1:8787/api/v1/instances \
  -H "Authorization: Bearer $TOKEN"
```

The token is full admin. Keep the daemon on loopback, use TLS if it leaves the machine, and never commit `api-token`, `webhooks.json`, or the certs.

> Run **one supervisor** per `instances.json`. The TUI and the API daemon each own their own bot sessions and both write the instance file, so do not run `npm run ui` and `npm run api` against the same file at the same time. Use the API for the mod and the TUI for terminal work, or point them at separate instance files.

## Configuration

`config.example.json` is the full reference. The defaults are:

```json
{
  "host": "localhost",
  "port": 25565,
  "username": "siftbot",
  "version": false,
  "auth": "offline",
  "password": "",
  "logLevel": "info",
  "startupCommands": [],
  "client": {
    "enabled": true,
    "brand": "vanilla",
    "viewDistance": "normal",
    "locale": "en_US"
  },
  "plugins": {
    "enabled": true,
    "dir": "plugins",
    "hotReload": true
  },
  "autoEat": {
    "enabled": true,
    "eatAtFood": 17,
    "eatAtHealth": 14,
    "cooldownMs": 1500,
    "restoreHeldItem": true,
    "exclude": []
  },
  "sneak": {
    "enabled": true,
    "watchdogMs": 3000
  },
  "afk": {
    "enabled": true,
    "minIntervalMs": 20000,
    "maxIntervalMs": 45000,
    "look": true,
    "swing": true,
    "jump": true,
    "move": false,
    "chat": [],
    "chatIntervalMs": 300000
  },
  "reconnect": {
    "enabled": true,
    "baseDelayMs": 3000,
    "maxDelayMs": 60000,
    "onKick": true,
    "stopOnBan": true,
    "stopOnVerification": true
  },
  "console": {
    "enabled": true,
    "chatPassthrough": true
  }
}
```

### Server and login

| Key | Meaning |
| --- | --- |
| `host`, `port` | Server address. |
| `username` | Bot name. For `offline` auth it must be 1–16 letters, numbers or `_`. |
| `version` | `false` for automatic detection, or a version string such as `"1.21.4"`. |
| `auth` | `"offline"` for cracked/offline-mode servers, `"microsoft"` for a real account. |
| `password` | Used only by `${password}` in `startupCommands`. Never sent automatically. |
| `logLevel` | `debug`, `info`, `warn` or `error`. |
| `startupCommands` | Commands to send after spawning. Strings, or objects with `command` and `delayMs`. |

### Client presentation

How the bot registers itself with the server, matching what a real vanilla client sends.

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch for the client presentation feature. |
| `brand` | Value announced on the `minecraft:brand` plugin channel. `"vanilla"` is what the official client sends; modded clients put their name here instead. |
| `viewDistance` | Render distance reported in the settings packet: `tiny`, `short`, `normal`, `far`, or a chunk count of 2-32. |
| `locale` | Locale reported in the settings packet (default `en_US`). |

The same values are sent in the configuration-phase and play-phase Client Information packets, all skin layers are shown, the right hand is active, and chat is enabled — the defaults a real client uses. On 1.21.2+ the bot also closes every client tick with `client_tick_end`, which strict tick-accounting anticheats (Grim) and 26.x vanilla servers treat as required, and it answers repeated `minecraft:select_known_packs` requests so proxy transfers do not stall. Evidence and citations: `docs/research/client-spoofing.md`.

### Auto-eat

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch. `.autoeat off` toggles it at runtime. |
| `eatAtFood` | Eat when hunger is at or below this value (default 17, inside the regeneration range). |
| `eatAtHealth` | Also eat when health is at or below this value and hunger is not full. |
| `cooldownMs` | Minimum gap between eating attempts. |
| `restoreHeldItem` | Re-equip the item the bot was holding before it ate. |
| `exclude` | Extra food names to never eat, on top of the built-in safe list. |

The safe list excludes golden apples, enchanted golden apples, pufferfish, rotten flesh, spider eyes, poisonous potatoes, raw chicken, suspicious stew, chorus fruit, and ominous bottles. Food is chosen in this order: the smallest food that fills the missing hunger points, then the highest quality, so a 1-point gap uses dried kelp rather than steak.

### Sneak

| Key | Meaning |
| --- | --- |
| `enabled` | Hold sneak for the session. |
| `watchdogMs` | How often to check that sneak is still held and re-send it if not. |

Sneak is re-applied on every spawn, including after death and respawn. The console `.stop` command releases movement keys only and leaves sneak held.

### AFK activity

| Key | Meaning |
| --- | --- |
| `enabled` | Master switch. |
| `minIntervalMs`, `maxIntervalMs` | Random gap between actions. |
| `look` | Turn the view by a small random amount. |
| `swing` | Swing the arm. |
| `jump` | Jump when on the ground, not in liquid, not riding, and not eating. |
| `move` | Optional short forward steps. Off by default because cliffs and lava are unforgiving. |
| `chat` | Optional chat lines, sent no more often than `chatIntervalMs`. |
| `chatIntervalMs` | Minimum gap between chat lines. |

Chat lines support `${username}`, `${health}`, `${food}`, `${x}`, `${y}` and `${z}` placeholders.

### Reconnect

| Key | Meaning |
| --- | --- |
| `enabled` | Reconnect after disconnects. |
| `baseDelayMs`, `maxDelayMs` | Exponential backoff bounds, with jitter. The backoff resets after a connection stays up for 60 seconds. |
| `onKick` | Reconnect after a normal kick. |
| `stopOnBan` | Do not reconnect when the kick reason looks like a ban, blacklist or whitelist rejection. |
| `stopOnVerification` | Do not reconnect when the server requires human/bot verification (default true). Verify manually, then reconnect. |

### Console

| Key | Meaning |
| --- | --- |
| `enabled` | Start the interactive console. Logs still stream with `--no-console`. |
| `chatPassthrough` | Treat plain console lines as chat. Set to `false` to require `.say`. |

### Login, register and the password store

Many servers need `/login` after joining. siftbot keeps a small password store
so the bot can answer by itself:

- `credentials.json` (next to `instances.json`, or `./credentials.json` for the
  CLI; override with `SIFTBOT_CREDENTIALS` / `--credentials`) holds
  `username@host -> password` entries. It is created with mode `0600` and is
  gitignored.
- Whenever the bot sends `/register <password> [again]` or `/login <password>` —
  from `startupCommands`, the console, or a manual command — the password is
  saved automatically. Passwords are never printed in logs.
- When the server shows its login prompt (`/login <password>`), the bot runs
  `/login` with the saved password automatically. If the prompt asks for
  registration and a password is known, it registers and then logs in.
- Manual edit: add or change entries in `credentials.json` and restart. The file
  is plain JSON and is reloaded on start:

  ```json
  {
    "version": 1,
    "credentials": {
      "farmer@mc.example.com": {
        "username": "farmer",
        "host": "mc.example.com",
        "password": "your-password"
      }
    }
  }
  ```

- `config.password` still works as a fallback (and is saved into the store the
  first time it is used). `.credentials` shows whether a password is stored;
  `.login` triggers the login immediately.

The first join can still be driven by explicit commands:

```json
{
  "password": "your-password",
  "startupCommands": [
    { "command": "/register ${password} ${password}", "delayMs": 1000 },
    { "command": "/login ${password}", "delayMs": 2500 }
  ]
}
```

Most servers ignore whichever command does not apply, and the password from the
commands is remembered for later reconnects.

Passwords are redacted in logs, `--print-config`, and API responses.

### Microsoft accounts

Set `"auth": "microsoft"` and choose any username; the account comes from the device-code flow. On first run the bot prints a URL and code — open the URL and approve it. The token is cached by minecraft-protocol for later runs.

## Plugins

Every bot can be extended with a small ES module in `plugins/`:

```js
export default function create (ctx) {
  ctx.on('spawn', () => ctx.log(`spawned on ${ctx.config.host}`))

  ctx.registerCommand('chest', {
    usage: '.chest [radius]',
    description: 'Read the nearest chest',
    run: async (args, c) => {
      const found = await c.containers.nearest(Number(args[0]) || 16)
      for (const item of found?.items ?? []) c.log(`${item.name} x${item.count}`)
    }
  })

  ctx.actions.move('forward', 500)   // drive the player
}
```

A plugin gets the bot, its config, movement/look/jump/equip/drop actions,
inventory and container reads, event/timer helpers with automatic cleanup, and
console command registration. `create(ctx)` runs once per connected bot, so
multi-bot and reconnects bind cleanly.

**Hot reload:** the plugin directory is watched — save the file and every active
bot rebinds to the new code. If a save has a syntax error, the last working
version keeps running and the error is logged.

Full API and lifecycle: **[docs/PLUGINS.md](docs/PLUGINS.md)**. Two plugins ship
with the project: `example.js` (`.where`, `.chest`, `.step`) and
`tree-to-table.js` (`.rtp-tree` — RTP, walk to the nearest tree, craft planks and
a crafting table). Plugins are trusted code executed in-process: only install
ones you have read.

## Anti-bot compatibility (Sonar)

siftbot speaks the vanilla client's full handshake and session cadence, which is enough to pass the standard verification used by [Sonar](https://github.com/jonesdevelopment/sonar) — the anti-bot plugin found on many public servers. Tested against **Sonar 2.1.53** on Paper 26.1.2 with its default configuration:

- configuration-phase brand (`minecraft:brand`) and vanilla Client Information, sent once and identically in both phases;
- gravity and collision checks: the exact vanilla fall curve and landing height on the invisible platform;
- protocol probes: invalid held-item slot ignored, valid slot echoed, transaction accepted, swing-arm echoed (on <26.3);
- the falling boat and minecart packet cadence (`vehicle_move`, `steer_boat`, rotation) the vehicle check expects;
- `transfer` packet handling when a proxy moves the client to the backend, and automatic reconnect;
- `client_tick_end` on 1.21.2+, so per-tick packet accounting matches.

This is client-fidelity work, not a captcha solver: Sonar's map/challenge captchas and any deliberate human verification still apply, and its checks can change between releases or server configs. Use siftbot only on servers where automation is permitted (see the AFK policy note at the end).

## Live console

Type `.help` in the running bot for the current list.

| Command | Action |
| --- | --- |
| `.help [command]` | Show all commands or one command. |
| `.status` | Connection, health, hunger, position, held item, features, uptime. |
| `.say <text>` | Send chat. |
| `.msg <player> <text>` | Whisper a player. |
| `.players` | List online players and ping. |
| `.inventory [filter]` | List carried items. |
| `.eat [food]` | Eat now, optionally a specific food. |
| `.autoeat [on\|off\|status]` | Control automatic eating. |
| `.hold <item>` | Equip an item. |
| `.drop <item> [count]` | Drop an item. |
| `.sneak [on\|off\|status\|toggle]` | Control held shift. |
| `.afk [on\|off\|status\|now]` | Control anti-AFK activity, or trigger it now. |
| `.look <yaw°> <pitch°>` | Turn the bot. |
| `.look at <player>` | Look at a player. |
| `.move <forward\|back\|left\|right\|jump> [ms]` | Hold a movement key. |
| `.stop` | Release movement keys. |
| `.jump` | Jump once. |
| `.respawn` | Request respawn. |
| `.reconnect` | Reconnect immediately. |
| `.credentials` | Show whether a password is stored for this account. |
| `.login` | Run `/login` now with the saved password. |
| `.log <level>` | Change log verbosity. |
| `.quit` | Disconnect this bot (and exit in the CLI). |

Input handling:

- Lines starting with `.` or `!` are local commands.
- Lines starting with `/` are sent to the server, so `/list` or `/tp` work.
- Anything else is sent as chat while `console.chatPassthrough` is on.
- Chat, whispers, and system messages appear in the same terminal.

## CLI and environment

```bash
node src/index.js \
  --host 127.0.0.1 --port 25565 --username siftbot \
  --auth offline --mc-version auto \
  --no-afk --no-sneak --no-autoeat \
  --no-console --no-reconnect \
  --log-level debug
```

`--print-config` prints the fully resolved config with secrets redacted. Shortcuts are `-c` for config, `-u` for username, `-h` for help, and `-v` for the siftbot version.

Environment variables: `SIFTBOT_CONFIG`, `SIFTBOT_CREDENTIALS`, `SIFTBOT_HOST`, `SIFTBOT_PORT`, `SIFTBOT_USERNAME`, `SIFTBOT_MC_VERSION`, `SIFTBOT_AUTH`, `SIFTBOT_PASSWORD`, `SIFTBOT_LOG_LEVEL`, and `SIFTBOT_AUTOEAT`, `SIFTBOT_SNEAK`, `SIFTBOT_AFK`, `SIFTBOT_CLIENT`, `SIFTBOT_PLUGINS`, `SIFTBOT_CONSOLE`, `SIFTBOT_RECONNECT`.

Set `SIFTBOT_SOCKS=127.0.0.1:9050` to send the Minecraft connection through a SOCKS5 proxy instead of the local network — useful for testing against a server without using its usual public address. When proxying, point `host`/`port` at the SRV target explicitly (for example `play.example.com` and `19866`): the SRV lookup itself is a local DNS query.

## How it works

| Path | Responsibility |
| --- | --- |
| `src/index.js` | CLI entry, startup banner, signal handling, shutdown. |
| `src/config.js` | Defaults, JSON/env/CLI merge, validation, secret redaction. |
| `src/bot.js` | mineflayer connection, sessions, features, reconnect and backoff. |
| `src/features/client-identity.js` | Vanilla handshake: configuration-phase brand, deduplicated brand, `client_tick_end` per tick, known-packs replies. |
| `src/credentials.js` | Password store (`credentials.json`, mode 0600): parsing, lookup, atomic save. |
| `src/features/auth.js` | Captures register/login passwords and answers the server's login prompt. |
| `src/plugins/manager.js` | Plugin discovery, per-session binding, hot reload and cleanup. |
| `src/plugins/context.js` | The plugin API: actions, inventory, containers, commands, events/timers. |
| `src/socks5.js` | Optional SOCKS5 egress (`SIFTBOT_SOCKS`) for testing without the local address. |
| `src/features/auto-eat.js` | Hunger checks, food choice, equip/consume, held-item restore. |
| `src/features/sneak.js` | Held shift, spawn re-application, watchdog. |
| `src/features/afk.js` | Randomized look/swing/jump/step/chat activity. |
| `src/foods.js` | Pure food selection rules. |
| `src/commands.js` | One command service per bot: help, status, eat, sneak, AFK, inventory, movement, reconnect. |
| `src/console.js` | Thin readline frontend used by the single-bot CLI. |
| `src/instances.js` | Multi-bot manager: persistence, start/stop, per-bot records, independent runtimes. |
| `src/daemon.js` | Headless API daemon, token/TLS setup, optional start-all. |
| `src/api/server.js` | Authenticated REST + SSE server with versioned routes and request IDs. |
| `src/api/events.js` | Monotonic event ring, replay cursors and live status diffing. |
| `src/api/webhooks.js` | Persistent webhook subscriptions, HMAC signing, filters, retries and delivery queue. |
| `src/api/serialize.js` | Instance/status/record serializers and secret redaction. |
| `src/tui.tsx` | OpenTUI/Bun entry point for the control room. |
| `src/tui-app.tsx` | React control room: bot list, details, consoles, add/edit forms. |
| `src/parse-input.js` | Pure console input tokenizer and classifier. |
| `src/logger.js` | Leveled, timestamped, colorized and sanitized logging. With a sink, it feeds a per-bot TUI buffer instead. |

All timers belong to a session and are cleared on disconnect, so reconnects do not leak listeners or double-eat. The TUI manager gives every bot its own logger, runtime, command service and ring buffer, which is what keeps consoles isolated.

## Tests

```bash
npm test          # core, config, commands, manager and logger tests
npm run test:tui  # OpenTUI headless render/interaction tests (Bun)
npm run test:all  # both
```

The unit tests cover food selection, config precedence and validation, console parsing, structured logging, instance persistence, and the auto-eat/sneak/AFK features against a fake bot. The UI tests mount the control room in OpenTUI's headless renderer and exercise selection, add/edit forms, help, delete confirmation and console focus. API tests cover auth, CRUD, redaction, partial patching, log cursors, SSE snapshots/replay, HMAC webhook delivery, daemon startup/shutdown, and HTTPS with a generated certificate.

Live tests were also run against a Minecraft 26.1 server: login, held sneak verified through a second observer client's entity metadata, auto-eat under a hunger effect, console commands, clean quit, manual reconnect, recovery after a server kill, two bots online at once with isolated consoles, chat crossing between them, and stopping/restarting one bot without touching the other. The API daemon was tested live too: start a bot, receive its online status over SSE, send `.status`, read the streamed record, fetch the log backlog, and stop the bot.

## Building from schematics (not implemented)

Short answer: yes, it is doable, and there are usable building blocks.

- `.schem` (Sponge) and `.schematic` (MCEdit) can be read with [`prismarine-schematic`](https://github.com/PrismarineJS/prismarine-schematic). It exposes a palette and a block iterator.
- `.litematic` is NBT with per-region palettes and bit-packed block states. [`litematic-parser`](https://www.npmjs.com/package/litematic-parser), [`minecraft-block-reader`](https://www.npmjs.com/package/minecraft-block-reader) or [`nucleation`](https://www.npmjs.com/package/nucleation) can parse it; a small custom parser on `prismarine-nbt` is also viable.
- Placement needs more than a parser: pathfinding to the build front (`mineflayer-pathfinder`), reach checks, rotating/mirroring, block-state matching, scaffolding, breaking wrong blocks, and material restocking. In creative with `/setblock` it is trivial; in survival it is a real builder engine.
- Litematics add multi-region offsets, negative region sizes and block entities. Large builds also need chunk-batched progress and a dry-run/material report.

A sensible first version would support `siftbot build <file> [--rotate] [--mirror] [--dry-run]`, parse into world coordinates, diff against the existing world, print a material list, then place bottom-up with reach checks and a progress bar in the UI. That is a follow-up feature, not part of this release.

## Notes and troubleshooting

- **It never eats.** Check that auto-eat is on, hunger is at or below `eatAtFood`, and there is safe food in the inventory. Golden apples and risky foods are excluded unless you change `exclude`; `.inventory` shows what the bot actually has.
- **It is not sneaking.** `.sneak status` shows both the feature and the live key state. Servers can reset input on teleport or respawn; the watchdog re-sends it within `watchdogMs`.
- **It cannot eat or equip.** Close any open chest or container first; the console refuses to click items in an open window.
- **Console is disabled.** Logs still print, but there is no prompt. The prompt is hidden when stdin is not a TTY, although piped lines still execute.
- **It keeps reconnecting to a whitelist server.** `reconnect.stopOnBan` defaults to true and stops on ban/whitelist style kicks. Set it to false only if you are sure the rejection is temporary.
- **"Bot Verification Failed" or a verification/captcha kick.** The server has an anti-bot gate and is deliberately rejecting an automated client. `reconnect.stopOnVerification` defaults to true, so the bot logs the real reason and stops instead of hammering. Complete the server's verification with a normal client (the kick usually names its Discord or website) or ask staff to allow the bot; there is no client-side switch that legitimately passes this check. The same applies to its escalation — "Temporarily Blocked / too many failed verification attempts" — the bot stops and waits for you rather than retrying through the server's cooldown window.
- **The server complains about the client brand.** The name announced on `minecraft:brand` is configurable as `client.brand`. Keep `"vanilla"` unless the server is set up to accept a different client; changing it to claim another modded client you do not actually run will not pass a real check.
- **Kicked on a 1.21.2+ server for invalid movement or a tick timeout.** The bot sends `client_tick_end` at the end of every physics tick on those versions. If you disabled it with `--no-client` or `client.enabled: false`, re-enable it.
- **The server is offline-mode.** Use `"auth": "offline"`. On an online-mode server use `"auth": "microsoft"`; offline mode will be rejected.
- **`bun` is missing or OpenTUI fails to load.** The UI needs Bun 1.3.14+. Run `bun --version`; if it is missing, install it and reopen the shell. `npm start` still works on Node 20 without Bun.
- **`npm install` warns about `@opentui/core` and Node 26.** OpenTUI declares Node 26.4+ for its experimental-FFI path. This project runs the UI on Bun instead, so the warning is safe; the CLI does not import OpenTUI.
- **The UI says the instances file is invalid.** `instances.json` must contain `{ "instances": [ ... ] }`. Fix the JSON or move the file aside; the app refuses to overwrite a file it cannot parse.
- **"Stop the bot before editing it".** The add/edit form changes the connection and feature settings for the next session, so the bot must be stopped first.
- **The hostname has no A record but the server works in-game.** Many servers publish an SRV record such as `_minecraft._tcp.example.com -> play.example.com:19866`. mineflayer follows SRV, but other tools may need the target host and port explicitly. Check with `dig +short SRV _minecraft._tcp.example.com`.
- **Two bots fight over one username.** Servers only allow one connection per username. Give each instance on the same server a distinct username.
- **Where does the UI store data?** `./instances.json` by default, or `SIFT_UI_FILE`. It is separate from the CLI's `config.json`; the UI imports an existing `config.json` on first run.
- **API returns 401.** Send `Authorization: Bearer $(cat api-token)`. The token may also be passed as `X-Siftbot-Token`; `?token=` is only accepted on SSE routes. Restart the daemon after replacing `api-token`.
- **Webhook is rejected.** URLs must be HTTPS. Plain HTTP is allowed only for loopback when the daemon runs with `--insecure-webhooks`. Check the `events` filter and use `POST /api/v1/webhooks/{id}/test` to diagnose delivery; verify `sha256=HMAC(secret, timestamp + "." + rawBody)`.
- **Browser dashboard cannot call the API.** The daemon intentionally sends no CORS headers; use a native mod or a small local proxy. Do not add a wildcard CORS policy to an admin token.
- **AFK policies.** Many servers forbid automation or have inactivity rules. Use the bot on servers where you have permission, and do not use it to evade bans or AFK checks.
