import { isLoginPrompt, isRegisterPrompt, parsePasswordCommand } from '../credentials.js'

/**
 * Remembers account passwords and answers the server's auth prompt.
 *
 * Servers running AuthMe-style auth ask for `/login <password>` (or
 * `/register <password> <password>` on first join). This feature:
 *
 * - captures passwords from register/login commands the bot itself sends,
 *   whether from startupCommands, the console, or a manual `/register`, and
 *   stores them in the credential store (a JSON file, mode 0600, editable by
 *   hand);
 * - when the server asks to log in, runs `/login <password>` automatically
 *   with the stored password (falling back to `config.password`).
 *
 * Passwords are never written to the log. Auto-responses are rate-limited so a
 * repeating prompt cannot turn into an attempt loop.
 */
export class AutoLogin {
  constructor (bot, config, logger, { credentials = null } = {}) {
    this.bot = bot
    this.config = config
    this.logger = logger
    this.credentials = credentials
    this.stopped = false
    this.actions = 0
    this.lastActionAt = 0

    // Capture passwords from commands the bot sends (console, startup, manual).
    // With `version: 'auto'` mineflayer injects its plugins (including chat)
    // only after the version ping, so the wrapper is installed then as well.
    this.chatPatched = false
    this.originalChat = null
    this.patchChat()
    this.onInjectAllowed = () => this.patchChat()
    bot.once?.('inject_allowed', this.onInjectAllowed)

    this.onMessage = message => this.handleMessage(message)
    bot.on('message', this.onMessage)
  }

  patchChat () {
    if (this.chatPatched || typeof this.bot.chat !== 'function') return
    const original = this.bot.chat.bind(this.bot)
    this.originalChat = original
    this.bot.chat = text => {
      this.capturePassword(text)
      return original(text)
    }
    this.chatPatched = true
  }

  /** Password from the store, falling back to the configured one. */
  storedPassword () {
    return this.credentials?.get(this.config.host, this.config.username) ??
      (this.config.password || null)
  }

  capturePassword (text) {
    if (this.stopped || !this.credentials) return
    const parsed = parsePasswordCommand(text)
    if (!parsed) return
    if (this.credentials.set(this.config.host, this.config.username, parsed.password)) {
      this.logger.info(`auth: saved ${parsed.type} password for ${this.config.username}@${this.config.host}`)
    }
  }

  handleMessage (message) {
    if (this.stopped) return
    let text = ''
    try {
      text = message?.toString?.() ?? String(message)
    } catch {
      return
    }
    if (!text) return

    const password = this.storedPassword()
    // Never react to our own command being echoed back.
    if (password && text.includes(password)) return

    if (isRegisterPrompt(text)) return this.respond('register')
    if (isLoginPrompt(text)) return this.respond('login')
  }

  respond (kind) {
    const password = this.storedPassword()
    if (!password) {
      if (this.actions === 0) {
        this.logger.debug('auth: server requested a login but no password is stored')
      }
      return
    }

    const now = Date.now()
    if (this.actions >= 3 || now - this.lastActionAt < 5000) return
    this.actions += 1
    this.lastActionAt = now

    if (kind === 'register') {
      this.logger.info('auth: registering the account with the saved password')
      this.send(`/register ${password} ${password}`)
      const timer = setTimeout(() => {
        if (!this.stopped) this.send(`/login ${password}`)
      }, 1500)
      timer.unref?.()
      return
    }

    this.logger.info('auth: logging in with the saved password')
    this.send(`/login ${password}`)
  }

  send (command) {
    try {
      const chat = this.originalChat ??
        (typeof this.bot.chat === 'function' ? this.bot.chat.bind(this.bot) : null)
      if (!chat) throw new Error('chat is not available yet')
      chat(command)
    } catch (err) {
      this.logger.debug(`auth: command failed: ${err.message}`)
    }
  }

  stop () {
    if (this.stopped) return
    this.stopped = true
    this.bot.removeListener('message', this.onMessage)
    if (this.onInjectAllowed) this.bot.removeListener('inject_allowed', this.onInjectAllowed)
    try {
      if (this.chatPatched && this.originalChat) this.bot.chat = this.originalChat
    } catch {
      // Client already gone.
    }
  }
}
