/**
 * Flatten a 1.20.5+ NBT text component (type/value wrappers) to plain text.
 */
export function componentText (node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)

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

/**
 * Turn a mineflayer window (chest/menu) into something the TUI can render:
 * a title plus one entry per slot, with display names from item components.
 */
export function describeWindow (window) {
  if (!window) return null
  const slots = Array.isArray(window.slots) ? window.slots : []
  return {
    id: window.id,
    type: typeof window.type === 'string' ? window.type : 'menu',
    title: componentText(window.title) || (typeof window.type === 'string' ? window.type : 'menu'),
    size: slots.length,
    slots: slots.map((item, slot) => item
      ? {
          slot,
          name: item.name,
          count: item.count,
          label: componentText(item.customName) || item.name
        }
      : null)
  }
}
