# Plugins

siftbot can load user plugins from a directory. A plugin is a small ES module
that receives a per-bot API and can drive the bot, read containers, listen to
events, run timers, and add console commands. Plugins are hot-reloaded: save the
file and running bots rebind to it without restarting.

> Plugins are trusted code executed in the siftbot process. Only install plugins
> you have read. Do not point the plugin directory at an untrusted location.

## Where plugins live

- CLI: `plugins/` next to the config (override with `--plugins-dir <dir>` or
  `plugins.dir`).
- TUI: `plugins/` next to `instances.json` (override with `SIFT_UI_PLUGINS`).
- API daemon: `plugins/` next to `instances.json` (override with `--plugins <dir>`
  or `SIFT_API_PLUGINS`).
- Anywhere: `plugins.dir` in the config; `plugins.enabled: false` or
  `--no-plugins` disables the system.

Files ending in `.js` or `.mjs` are loaded; `.`, `_` prefixes are ignored.

## Plugin contract

```js
export const name = 'chest-logger'   // optional, defaults to the file name
export const version = '1.0.0'       // optional

export default function create (ctx) {
  ctx.on('spawn', () => ctx.log(`spawned on ${ctx.config.host}`))

  ctx.registerCommand('chest', {
    usage: '.chest [radius]',
    description: 'Read the nearest chest',
    run: async (args, context) => {
      const contents = await context.containers.nearest(Number(args[0]) || 16)
      if (!contents) return context.log('no chest nearby')
      for (const item of contents.items) {
        context.log(`${item.name} x${item.count} (slot ${item.slot})`)
      }
    }
  })

  // Optional teardown; listeners/timers/commands are removed automatically.
  return { unload () {} }
}
```

`create(ctx)` is called once **per connected bot session** (so multi-bot setups
and reconnects rebind cleanly). Throwing during creation is logged and only that
plugin is skipped for that bot.

## The context (`ctx`)

| Member | Description |
| --- | --- |
| `bot` | The mineflayer bot for this session. |
| `config` | This bot's resolved config (host, username, …). |
| `connected` | `true` while the bot has an entity. |
| `log/debug/warn(...)` | Log through siftbot's logger (tagged per plugin). |
| `chat(text)` / `command('/say hi')` | Send chat or a server command. |
| `on(event, fn)` | `bot.on` with automatic removal on unload. |
| `every(ms, fn)` / `after(ms, fn)` | Timers with automatic cleanup. |
| `registerCommand(name, { usage, description, aliases, run })` | Add a console command (`.name`), removed on unload. |
| `actions.move(dir, ms)` | Hold `forward`/`back`/`left`/`right`/`jump`/`sprint`/`sneak`. |
| `actions.stop()` | Release movement keys. |
| `actions.jump()` | Jump once (requires ground). |
| `actions.look(yaw°, pitch°)` | Turn the bot. |
| `actions.lookAtPlayer(name)` | Look at another player. |
| `actions.equip(name)` / `actions.drop(name, count)` | Inventory actions. |
| `inventory.items()` / `inventory.count(name)` / `inventory.held()` | Inventory reads. |
| `containers.nearest(maxDistance?)` | Open and read the closest chest/barrel/shulker; returns `{ block, items }`. |
| `containers.read(x, y, z)` | Read a container at a block position. |

Container reads return `{ block: { name, x, y, z }, items: [{ slot, name, count }] }`
(or `null` when nothing is found) and close the window afterwards.

## Hot reload

The plugin directory is watched (`plugins.hotReload`, default true). On save:

1. every plugin instance is unloaded (`unload()` if returned, then listeners,
   timers and console commands are removed);
2. modules are re-imported with a cache-busting query;
3. every active bot rebinds to the new plugin code.

If a module fails to compile or throws on import, the last working version is
kept and the error is logged — a broken save cannot take the bots down.

## Examples

`plugins/example.js` ships with the project and adds `.where`, `.chest [radius]`,
and `.walk <direction> [ms]`. Copy it as a starting point.
