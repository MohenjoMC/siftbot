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

  return {
    unload () {
      ctx.debug('[example] unloaded')
    }
  }
}
