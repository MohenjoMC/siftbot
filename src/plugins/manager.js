import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PluginContext } from './context.js'

/**
 * Loads user plugins from a directory and binds them to every bot session.
 *
 * Plugin file contract (ESM):
 *
 *   export const name = 'chest-logger'      // optional, defaults to filename
 *   export const version = '1.0.0'          // optional
 *   export default function create (ctx) {  // required
 *     ctx.on('spawn', () => ctx.log('spawned'))
 *     ctx.registerCommand('chest', { run: async (args, context) => { ... } })
 *     return { unload () { ... } }          // optional
 *   }
 *
 * Plugins are instantiated once per connected bot session. Editing a file in
 * the plugin directory reloads every plugin and rebinds active sessions
 * without restarting the bots or the process.
 */
export class PluginManager {
  constructor ({ dir, logger, hotReload = true }) {
    this.dir = path.resolve(dir)
    this.logger = logger
    this.hotReload = hotReload
    this.plugins = []
    this.sessions = new Map()
    this.watcher = null
    this.watchTimer = null
    this.ready = Promise.resolve()
    this.stopped = false
  }

  start () {
    this.ready = this.loadModules().then(() => this.watch())
    return this.ready
  }

  pluginFiles () {
    let entries
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true })
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger.warn(`plugins: cannot read ${this.dir}: ${err.message}`)
      return []
    }
    return entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(name => /\.(?:js|mjs)$/i.test(name) && !name.startsWith('.') && !name.startsWith('_'))
      .sort()
      .map(name => path.join(this.dir, name))
  }

  async loadModules () {
    const previous = new Map(this.plugins.map(plugin => [plugin.file, plugin]))
    const loaded = []

    for (const file of this.pluginFiles()) {
      try {
        const cacheBust = `?v=${Date.now()}-${Math.random().toString(36).slice(2)}`
        const module = await import(pathToFileURL(file).href + cacheBust)
        const create = module.default ?? module.create
        if (typeof create !== 'function') {
          throw new Error('must export default function create (ctx)')
        }
        loaded.push({
          file,
          name: typeof module.name === 'string' && module.name ? module.name : path.basename(file).replace(/\.(?:js|mjs)$/i, ''),
          version: typeof module.version === 'string' ? module.version : null,
          create
        })
      } catch (err) {
        this.logger.error(`plugins: failed to load ${path.basename(file)}: ${err.message}`)
        const old = previous.get(file)
        if (old) loaded.push(old) // keep the last working version
      }
    }

    this.plugins = loaded
    if (loaded.length > 0) {
      this.logger.info(`plugins: loaded ${loaded.map(plugin => plugin.name).join(', ')} from ${this.dir}`)
    }
    return loaded
  }

  attachSession ({ id, runtime, commands = null, logger = null }) {
    this.detachSession(id)
    const session = {
      id,
      runtime,
      commands,
      logger: logger ?? this.logger,
      instances: [],
      onSession: () => this.bind(session),
      onDisconnect: () => this.cleanupSession(session)
    }
    this.sessions.set(id, session)
    runtime.on('session', session.onSession)
    runtime.on('disconnect', session.onDisconnect)
    this.ready.then(() => this.bind(session)).catch(err => {
      this.logger.error(`plugins: ${err.message}`)
    })
    return session
  }

  bind (session) {
    if (this.stopped) return
    const bot = session.runtime?.bot
    this.cleanupSession(session)
    if (!bot) return

    for (const plugin of this.plugins) {
      const context = new PluginContext({
        name: plugin.name,
        runtime: session.runtime,
        bot,
        commands: session.commands,
        logger: session.logger,
        config: session.runtime.config
      })
      try {
        const instance = plugin.create(context)
        session.instances.push({ plugin, context, instance })
        this.logger.debug(`plugins: ${plugin.name} bound to ${bot.username ?? 'bot'}`)
      } catch (err) {
        context.cleanup()
        this.logger.error(`plugins: ${plugin.name} failed to start: ${err.stack ?? err.message}`)
      }
    }
  }

  cleanupSession (session) {
    for (const { plugin, context, instance } of session.instances) {
      try {
        instance?.unload?.()
      } catch (err) {
        this.logger.debug(`plugins: ${plugin.name} unload failed: ${err.message}`)
      }
      context.cleanup()
    }
    session.instances = []
  }

  detachSession (id) {
    const session = this.sessions.get(id)
    if (!session) return
    this.cleanupSession(session)
    try {
      session.runtime.removeListener('session', session.onSession)
      session.runtime.removeListener('disconnect', session.onDisconnect)
    } catch {
      // Runtime already stopped.
    }
    this.sessions.delete(id)
  }

  async reload () {
    if (this.stopped) return
    this.logger.info('plugins: reloading…')
    for (const session of this.sessions.values()) this.cleanupSession(session)
    await this.loadModules()
    for (const session of this.sessions.values()) this.bind(session)
  }

  watch () {
    if (!this.hotReload || this.stopped) return
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => {
        clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => {
          this.reload().catch(err => this.logger.error(`plugins: reload failed: ${err.message}`))
        }, 250)
        this.watchTimer.unref?.()
      })
      this.watcher.on('error', err => this.logger.warn(`plugins: watcher: ${err.message}`))
      this.watcher.unref?.()
    } catch (err) {
      this.logger.warn(`plugins: hot reload unavailable: ${err.message}`)
    }
  }

  stop () {
    this.stopped = true
    clearTimeout(this.watchTimer)
    this.watchTimer = null
    try {
      this.watcher?.close()
    } catch {
      // Already closed.
    }
    this.watcher = null
    for (const id of [...this.sessions.keys()]) this.detachSession(id)
  }

  /** Sanitized plugin list for status output. */
  list () {
    return this.plugins.map(plugin => ({ name: plugin.name, version: plugin.version, file: path.basename(plugin.file) }))
  }
}
