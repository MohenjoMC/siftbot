/**
 * Tokenize a console line, honouring single and double quotes so that
 * `.say "hello there"` keeps its spaces.
 * @param {string} input
 * @returns {string[]}
 */
export function tokenize (input) {
  const tokens = []
  let current = ''
  let quote = null
  let escaped = false
  let hasToken = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      hasToken = true
      continue
    }
    if (quote && char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      hasToken = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }

  if (hasToken) tokens.push(current)
  return tokens
}

/**
 * Classify console input.
 *
 *   ".say hi"       -> { type: 'command', name: 'say', args: ['hi'] }
 *   "/login secret" -> { type: 'server', raw: '/login secret' }
 *   "hello"         -> { type: 'chat', text: 'hello' }
 *
 * @param {string} line
 */
export function parseInput (line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed === '') return null

  if (trimmed.startsWith('.') || trimmed.startsWith('!')) {
    const body = trimmed.slice(1).trim()
    if (body === '') return null
    const [name, ...args] = tokenize(body)
    if (!name) return null
    return { type: 'command', name: name.toLowerCase(), args, raw: trimmed }
  }

  if (trimmed.startsWith('/')) {
    return { type: 'server', raw: trimmed }
  }

  return { type: 'chat', text: trimmed }
}
