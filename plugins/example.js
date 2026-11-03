export const name = 'example'
export const version = '1.0.0'

/**
 * Example siftbot plugin.
 *
 * Drop a file like this in the plugin directory and it is loaded for every bot.
 * It is hot-reloaded: save the file and the running bots rebind to it without
 * restarting. Commands are available in the console as `.where`, `.chest`, and
 * `.walk`.
 */
export default function create (ctx) {
  ctx.on('spawn', () => {
    ctx.log(`[example] ${ctx.bot.username} spawned on ${ctx.config.host}`)
  })

  ctx.registerCommand('where', {
    usage: '.where',
    description: 'Print the bot position (example plugin)',
    run: (args, c) => {
      const position = c.bot?.entity?.position
      if (!position) {
        c.log('not spawned yet')
        return
      }
      c.log(`position ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`)
    }
  })

  ctx.registerCommand('chest', {
    usage: '.chest [radius]',
    description: 'Read the nearest chest (example plugin)',
    run: async (args, c) => {
      const radius = Number(args[0]) || 16
      const contents = await c.containers.nearest(radius)
      if (!contents) {
        c.log(`no container within ${radius} blocks`)
        return
      }
      const { block, items } = contents
      c.log(`${block.name} at ${block.x}, ${block.y}, ${block.z}: ${items.length} stacks`)
      for (const item of items) c.log(`  slot ${item.slot}: ${item.name} x${item.count}`)
    }
  })

  ctx.registerCommand('step', {
    usage: '.step <forward|back|left|right|jump> [ms]',
    description: 'Move the bot for a moment (example plugin)',
    run: (args, c) => {
      const direction = (args[0] ?? 'forward').toLowerCase()
      if (direction === 'jump') {
        c.actions.jump()
        return
      }
      c.actions.move(direction, Number(args[1]) || 600)
    }
  })

  ctx.registerCommand('use', {
    usage: '.use',
    description: 'Right-click with the held item (open menus)',
    run: (args, c) => c.bot.activateItem()
  })

  ctx.registerCommand('open', {
    usage: '.open [radius]',
    description: 'Open the nearest container and leave it open',
    run: async (args, c) => {
      const bot = c.bot
      const names = ['chest', 'trapped_chest', 'barrel', 'ender_chest']
      const ids = names.map(name => bot.registry?.blocksByName?.[name]?.id).filter(id => id != null)
      const block = bot.findBlock({ matching: ids, maxDistance: Number(args[0]) || 8 })
      if (!block) return c.log('no container nearby')
      const window = await bot.openContainer(block)
      c.log(`opened ${block.name} (${window.slots.length} slots)`)
    }
  })

  ctx.registerCommand('click', {
    usage: '.click <slot>',
    description: 'Click a slot in the open menu',
    run: (args, c) => {
      const slot = Number(args[0])
      if (!Number.isInteger(slot)) throw new Error('Usage: .click <slot>')
      return c.bot.clickWindow(slot, 0, 0)
    }
  })

  ctx.registerCommand('window', {
    usage: '.window',
    description: 'List the open container/menu slots',
    run: (args, c) => {
      const window = c.bot.currentWindow
      if (!window) {
        c.log('no window is open')
        return
      }
      c.log(`window ${window.type} — ${window.slots.length} slots`)
      window.slots.forEach((item, slot) => {
        if (!item) return
        let label = ''
        if (item.customName) label = componentText(item.customName)
        c.log(`  ${slot}: ${item.name} x${item.count}${label ? ` — ${label}` : ''}`)
      })
    }
  })

  return {
    unload () {
      ctx.debug('[example] unloaded')
    }
  }
}

/** Flatten a 1.20.5+ NBT text component (type/value wrappers) to plain text. */
function componentText (node) {
  const out = []
  const visit = n => {
    if (n == null) return
    if (typeof n === 'string') { out.push(n); return }
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (typeof n !== 'object') return
    if (typeof n.text === 'string') out.push(n.text)
    else if (n.text && typeof n.text === 'object') visit(n.text)
    if (typeof n.value === 'string') out.push(n.value)
    else if (n.value && typeof n.value === 'object') visit(n.value)
    if (n.extra) visit(n.extra)
  }
  visit(node)
  return out.join('')
}
