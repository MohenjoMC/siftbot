import readline from 'node:readline'
import { BotCommands } from './commands.js'

export class LiveConsole {
  constructor ({ runtime, config, logger, stdin = process.stdin, stdout = process.stdout, onQuit = null }) {
    this.runtime = runtime
    this.config = config
    this.logger = logger
    this.stdin = stdin
    this.stdout = stdout
    this.onQuit = onQuit
    this.rl = null
    this.started = false
    this.closing = false
    this.queue = Promise.resolve()
    this.print = (text = '') => this.stdout.write(text + '\n')
    this.service = new BotCommands({
      runtime,
      config,
      logger,
      print: text => this.print(text),
      onQuit: () => this.quit()
    })
  }

  start () {
    if (this.started || !this.config.console.enabled) return
    this.started = true

    this.logger.raw('siftbot console — .help for commands, /cmd for server commands, text for chat')

    this.rl = readline.createInterface({
      input: this.stdin,
      output: this.stdout,
      terminal: Boolean(this.stdout.isTTY),
      prompt: `${this.config.username}> `,
      completer: line => this.complete(line)
    })

    // Serialize command handling so pasted lines cannot race each other
    // (for example .quit overtaking an in-flight .eat).
    this.queue = Promise.resolve()
    this.rl.on('line', line => {
      this.queue = this.queue
        .then(() => this.handleLine(line))
        .catch(err => this.logger.error(err?.message ?? String(err)))
    })

    this.rl.on('SIGINT', () => {
      this.print('')
      void this.quit()
    })

    this.rl.on('close', () => {
      if (!this.closing) this.closing = true
    })

    this.prompt()
  }

  stop () {
    this.closing = true
    if (this.rl) {
      this.rl.removeAllListeners()
      this.rl.close()
      this.rl = null
    }
    this.started = false
  }

  prompt () {
    if (!this.rl || !this.stdout.isTTY) return
    this.rl.prompt()
  }

  async handleLine (line) {
    try {
      await this.service.handleInput(line)
    } finally {
      if (!this.closing) this.prompt()
    }
  }

  complete (line) {
    return this.service.complete(line)
  }

  async quit () {
    if (this.closing) return
    this.closing = true
    this.print('shutting down…')
    if (this.onQuit) {
      await this.onQuit()
    } else {
      await this.runtime.stop('console quit')
    }
  }
}
