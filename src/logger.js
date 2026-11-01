import util from 'node:util'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  chat: '\x1b[37m',
  whisper: '\x1b[35m',
  system: '\x1b[34m',
  output: '\x1b[37m',
  dim: '\x1b[90m',
  reset: '\x1b[0m'
}
const TAGS = {
  chat: 'CHAT ',
  whisper: 'WSPR ',
  system: 'SYS  ',
  output: '     '
}

function supportsColor (stream) {
  if (Object.hasOwn(process.env, 'NO_COLOR')) return false
  if (process.env.FORCE_COLOR === '1') return true
  return Boolean(stream && stream.isTTY)
}

function timestamp (time = Date.now()) {
  const date = new Date(time)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

/** Strip terminal escapes and control characters from untrusted text. */
function sanitizeLine (value) {
  return String(value)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function levelColor (level) {
  return COLORS[level] ?? COLORS.info
}

/**
 * Leveled logger. With a sink, records are handed to the sink instead of the
 * terminal, which is how the TUI attaches a separate buffer to each bot.
 */
export class Logger {
  constructor ({ level = 'info', stream = process.stdout, color, sink = null } = {}) {
    this.stream = stream
    this.useColor = color ?? supportsColor(stream)
    this.sink = typeof sink === 'function' ? sink : null
    this.setLevel(level)
  }

  setLevel (level) {
    const normalized = String(level).toLowerCase()
    if (!(normalized in LEVELS)) throw new Error(`Unknown log level: ${level}`)
    this.level = normalized
  }

  setColor (enabled) {
    this.useColor = Boolean(enabled)
  }

  #paint (color, text) {
    return this.useColor ? `${COLORS[color] ?? ''}${text}${COLORS.reset}` : text
  }

  #format (record) {
    const color = record.kind === 'log' ? levelColor(record.level) : record.kind
    const tag = TAGS[record.kind] ?? record.level.toUpperCase().padEnd(5)
    return (
      `${this.#paint('dim', timestamp(record.time))} ` +
      `${this.#paint(color, tag)} ${record.text}`
    )
  }

  #emit (level, kind, text) {
    if (LEVELS[level] < LEVELS[this.level]) return
    const time = Date.now()
    for (const rawLine of String(text).split(/\r?\n/)) {
      const record = { time, level, kind, text: sanitizeLine(rawLine) }
      if (this.sink) {
        this.sink(record)
      } else {
        this.stream.write(this.#format(record) + '\n')
      }
    }
  }

  debug (...args) { this.#emit('debug', 'log', util.format(...args)) }
  info (...args) { this.#emit('info', 'log', util.format(...args)) }
  warn (...args) { this.#emit('warn', 'log', util.format(...args)) }
  error (...args) { this.#emit('error', 'log', util.format(...args)) }

  system (...args) {
    this.#emit('info', 'system', util.format(...args))
  }

  chat (username, message) {
    this.#emit('info', 'chat', `<${sanitizeLine(username)}> ${sanitizeLine(message)}`)
  }

  whisper (username, message) {
    this.#emit('info', 'whisper', `<${sanitizeLine(username)}> ${sanitizeLine(message)}`)
  }

  ownChat (message) {
    this.#emit('info', 'chat', `<me> ${sanitizeLine(message)}`)
  }

  /** Print unformatted text. In sink mode this becomes an output record. */
  raw (text = '') {
    if (!this.sink) {
      this.stream.write(text + '\n')
      return
    }
    for (const line of String(text).split(/\r?\n/)) {
      this.sink({ time: Date.now(), level: 'info', kind: 'output', text: sanitizeLine(line) })
    }
  }
}
