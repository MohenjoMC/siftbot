import fs from 'node:fs'
import path from 'node:path'

export const name = 'gui-bridge'
export const version = '1.0.0'

/**
 * Exposes the bot's in-game windows to the dashboard and applies clicks coming
 * back from it.
 *
 *   SIFT_GUI_FILE     state file (default ./gui.json)
 *   SIFT_GUI_ACTIONS  inbox directory for actions (default ./gui-actions)
 *
 * Actions are one JSON file per request: {action:"click",slot}, {action:"use"},
 * {action:"close"}, {action:"command",command:"/shop"}.
 */
export default function create (ctx) {
  const guiFile = process.env.SIFT_GUI_FILE || path.join(process.cwd(), 'gui.json')
  const actionsDir = process.env.SIFT_GUI_ACTIONS || path.join(process.cwd(), 'gui-actions')
  let signature = ''
  let lastAction = null

  const bot = ctx.bot
  if (bot) {
    bot.on('windowOpen', () => {
      // A walking bot drifts away from the container and the menu closes.
      try {
        for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
          bot.setControlState(key, false)
        }
      } catch {}
    })
  }

  const timer = setInterval(() => {
    dump()
    void processActions()
  }, 400)
  timer.unref?.()
  ctx.on('end', () => clearInterval(timer))

  function windowState () {
    const window = ctx.bot?.currentWindow
    if (!window) return null
    return {
      id: window.id,
      title: componentText(window.title) || window.type || 'menu',
      type: window.type,
      size: window.slots?.length ?? 0,
      slots: (window.slots ?? []).map((item, slot) => item
        ? {
            slot,
            name: item.name,
            count: item.count,
            label: componentText(item.customName) || item.name
          }
        : null)
    }
  }

  function dump () {
    try {
      const state = {
        plugin: 'gui-bridge',
        username: ctx.bot?.username ?? null,
        server: `${ctx.config.host}:${ctx.config.port}`,
        online: Boolean(ctx.bot?.entity),
        updatedAt: new Date().toISOString(),
        lastAction,
        window: ctx.bot?.entity ? windowState() : null
      }
      const next = JSON.stringify(state.window) + String(state.online)
      if (next === signature) return
      signature = next
      fs.mkdirSync(path.dirname(guiFile), { recursive: true })
      const tmp = `${guiFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
      fs.renameSync(tmp, guiFile)
    } catch (err) {
      ctx.debug(`gui-bridge: cannot write ${guiFile}: ${err.message}`)
    }
  }

  async function processActions () {
    let files
    try {
      files = fs.readdirSync(actionsDir).filter(file => file.endsWith('.json')).sort()
    } catch {
      return
    }
    for (const file of files) {
      const full = path.join(actionsDir, file)
      let action
      try {
        action = JSON.parse(fs.readFileSync(full, 'utf8'))
      } catch {
        fs.rmSync(full, { force: true })
        continue
      }
      try {
        await apply(action)
        lastAction = { at: Date.now(), action, ok: true }
      } catch (err) {
        lastAction = { at: Date.now(), action, ok: false, error: err.message }
      }
      fs.rmSync(full, { force: true })
      dump()
    }
  }

  async function apply (action) {
    const bot = ctx.bot
    if (!bot?.entity) throw new Error('bot is not connected')
    switch (action.action) {
      case 'click': {
        if (!bot.currentWindow) throw new Error('no window is open')
        const slot = Number(action.slot)
        if (!Number.isInteger(slot) || slot < 0) throw new Error('invalid slot')
        await bot.clickWindow(slot, Number(action.button) || 0, Number(action.mode) || 0)
        return
      }
      case 'use':
        bot.activateItem()
        return
      case 'name': {
        if (!bot.currentWindow) throw new Error('no window is open')
        bot._client.write('name_item', { name: String(action.name ?? '') })
        return
      }
      case 'close':
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        return
      case 'command': {
        const text = String(action.command ?? '')
        if (!text.startsWith('/')) throw new Error('command must start with /')
        bot.chat(text)
        return
      }
      default:
        throw new Error(`unknown action: ${action.action}`)
    }
  }
}

function componentText (node) {
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
