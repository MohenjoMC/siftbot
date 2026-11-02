import React, { useEffect, useReducer, useRef, useState } from 'react'
import { TextAttributes } from '@opentui/core'
import type { InputRenderable } from '@opentui/core'
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import { defaultConfig } from './config.js'
import { formatCoords, formatDuration } from './util.js'
import { describeWindow } from './window.js'

const COLORS = {
  text: '#c0caf5',
  dim: '#7f849c',
  faint: '#565f89',
  border: '#3b4261',
  panel: '#16161e',
  header: '#1a1b26',
  selected: '#2a2e3f',
  green: '#9ece6a',
  yellow: '#e0af68',
  red: '#f7768e',
  cyan: '#7dcfff',
  magenta: '#bb9af7',
  blue: '#7aa2f7',
  white: '#ffffff'
}

const STATUS_COLORS = {
  online: COLORS.green,
  connecting: COLORS.yellow,
  retrying: COLORS.yellow,
  stopping: COLORS.yellow,
  error: COLORS.red,
  offline: COLORS.faint
}

function statusColor (status) {
  return STATUS_COLORS[status] ?? COLORS.faint
}

function recordColor (record) {
  if (record.kind === 'chat') return COLORS.cyan
  if (record.kind === 'whisper') return COLORS.magenta
  if (record.kind === 'system') return COLORS.blue
  if (record.kind === 'output') return COLORS.text
  if (record.level === 'error') return COLORS.red
  if (record.level === 'warn') return COLORS.yellow
  if (record.level === 'debug') return COLORS.faint
  return COLORS.text
}

function recordTag (record) {
  if (record.kind === 'chat') return 'CHAT'
  if (record.kind === 'whisper') return 'WSPR'
  if (record.kind === 'system') return 'SYS '
  if (record.kind === 'output') return '    '
  return record.level.toUpperCase().padEnd(4).slice(0, 4)
}

function clock (time) {
  const date = new Date(time)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

function numberOrDash (value) {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '—'
}

function dimensionName (dimension) {
  return dimension ? String(dimension).replace(/^minecraft:/, '') : 'unknown'
}

function detailsLines (instance, manager) {
  const status = manager.details(instance)
  const kind = manager.statusOf(instance)
  const lines = []

  if (instance.fatal) {
    lines.push(`error: ${instance.fatal}`)
    lines.push(`${instance.config.host}:${instance.config.port} · stopped`)
    return lines
  }

  if (!instance.runtime) {
    lines.push(`offline · ${instance.config.host}:${instance.config.port} · press s to start`)
    return lines
  }

  if (kind === 'connecting') {
    lines.push(`connecting to ${instance.config.host}:${instance.config.port}…`)
  } else if (kind === 'retrying') {
    lines.push(`reconnecting in ${formatDuration(status.reconnectInMs)} (attempt ${Math.max(1, status.reconnectAttempt)})`)
  } else if (kind === 'stopping') {
    lines.push('stopping…')
  } else if (kind === 'online') {
    lines.push(
      `${status.gameMode ?? '?'} · ${dimensionName(status.dimension)} · ${status.version} · ` +
      `ping ${Number.isFinite(status.ping) ? status.ping + 'ms' : '—'}`
    )
    lines.push(
      `health ${numberOrDash(status.health)}/20 · food ${numberOrDash(status.food)}/20 · ` +
      `pos ${formatCoords(status.position)}`
    )
    const features = [
      `autoeat ${status.autoEatEnabled ? 'on' : 'off'}`,
      `sneak ${status.sneak ? 'held' : 'off'}`,
      `afk ${status.afkEnabled ? 'on' : 'off'}`,
      `up ${formatDuration(status.uptimeMs)}`
    ]
    lines.push(features.join(' · '))
  } else {
    lines.push(`offline · ${instance.config.host}:${instance.config.port} · press s to start`)
  }

  return lines
}

function nextField (index, count) {
  return (index + 1) % count
}

function previousField (index, count) {
  return (index - 1 + count) % count
}

function FormView ({ manager, initial, onCancel, onSaved }) {
  const mode = initial.mode
  const config = initial.config ?? defaultConfig()
  const [focus, setFocus] = useState(0)
  const [auth, setAuth] = useState(config.auth ?? 'offline')
  const [toggles, setToggles] = useState({
    autoEat: config.autoEat?.enabled ?? true,
    sneak: config.sneak?.enabled ?? true,
    afk: config.afk?.enabled ?? true
  })
  const [error, setError] = useState(null)
  const refs = useRef({})
  const fields = ['label', 'username', 'host', 'port', 'auth', 'version', 'password', 'eatAtFood', 'autoEat', 'sneak', 'afk']
  const values = {
    label: initial.label ?? config.username ?? 'siftbot',
    username: config.username ?? 'siftbot',
    host: config.host ?? 'localhost',
    port: String(config.port ?? 25565),
    version: config.version || '',
    password: config.password ?? '',
    eatAtFood: String(config.autoEat?.eatAtFood ?? 17)
  }

  const read = name => {
    const value = refs.current[name]?.value
    return value === undefined ? (values[name] ?? '') : value
  }

  useEffect(() => {
    for (const input of Object.values(refs.current)) input?.blur?.()
    refs.current[fields[focus]]?.focus?.()
  }, [focus])

  const save = () => {
    try {
      const base = mode === 'edit'
        ? JSON.parse(JSON.stringify(manager.get(initial.id).config))
        : defaultConfig()

      base.username = String(read('username')).trim()
      base.host = String(read('host')).trim()
      base.port = Number(String(read('port')).trim())
      base.auth = auth
      base.version = String(read('version')).trim() || false
      base.password = String(read('password'))
      base.autoEat.enabled = toggles.autoEat
      base.autoEat.eatAtFood = Number(String(read('eatAtFood')).trim())
      base.sneak.enabled = toggles.sneak
      base.afk.enabled = toggles.afk

      if (mode === 'add') {
        const instance = manager.add({ label: String(read('label')).trim(), config: base })
        onSaved(instance.id, `Added ${instance.label}`)
      } else {
        const instance = manager.update(initial.id, { label: String(read('label')).trim(), config: base })
        onSaved(instance.id, `Saved ${instance.label}`)
      }
    } catch (err) {
      setError(err?.message ?? String(err))
    }
  }

  const move = delta => {
    setFocus(current => {
      const target = delta > 0 ? nextField(current, fields.length) : previousField(current, fields.length)
      return target
    })
  }

  useKeyboard(key => {
    if (key.name === 'escape') {
      onCancel()
      return
    }
    if (key.ctrl && key.name === 's') {
      save()
      return
    }
    if (key.name === 'tab') {
      move(key.shift ? -1 : 1)
      return
    }
    if (key.name === 'down') {
      move(1)
      return
    }
    if (key.name === 'up') {
      move(-1)
      return
    }

    const field = fields[focus]
    if (key.name === 'left' || key.name === 'right' || key.name === 'space') {
      if (field === 'auth') {
        setAuth(current => current === 'offline' ? 'microsoft' : 'offline')
        return
      }
      if (field === 'autoEat' || field === 'sneak' || field === 'afk') {
        setToggles(current => ({ ...current, [field]: !current[field] }))
      }
    }
  })

  const row = (label, index, content) => (
    <box flexDirection="row" height={1} key={label}>
      <text width={12} fg={focus === index ? COLORS.cyan : COLORS.dim}>
        {focus === index ? '› ' : '  '}{label}
      </text>
      {content}
    </box>
  )

  const input = (name, index, extra = {}) => (
    <input
      ref={el => { refs.current[name] = el }}
      width={44}
      value={values[name]}
      focused={focus === index}
      backgroundColor={focus === index ? COLORS.selected : undefined}
      focusedBackgroundColor={COLORS.selected}
      onSubmit={() => move(1)}
      {...extra}
    />
  )

  return (
    <box flexDirection="column" flexGrow={1} borderStyle="rounded" borderColor={COLORS.border} title={mode === 'add' ? ' New bot ' : ' Edit bot '}>
      <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
        {row('Label', 0, input('label', 0, { placeholder: 'shown in the sidebar' }))}
        {row('Username', 1, input('username', 1, { placeholder: 'bot username' }))}
        {row('Host', 2, input('host', 2, { placeholder: 'play.example.com' }))}
        {row('Port', 3, input('port', 3, { placeholder: '25565' }))}
        {row('Auth', 4, (
          <box flexDirection="row" width={44} backgroundColor={focus === 4 ? COLORS.selected : undefined} paddingLeft={1}>
            <text fg={COLORS.cyan}>{auth === 'offline' ? '‹ ' : '  '}</text>
            <text fg={COLORS.text}>{auth}</text>
            <text fg={COLORS.cyan}>{auth === 'microsoft' ? ' ›' : '  '}</text>
            <text fg={COLORS.faint}>  ←/→ change</text>
          </box>
        ))}
        {row('MC version', 5, input('version', 5, { placeholder: 'blank = auto' }))}
        {row('Password', 6, input('password', 6, { placeholder: 'for /login startup commands' }))}
        {row('Eat at', 7, input('eatAtFood', 7, { placeholder: '17' }))}
        {row('Auto-eat', 8, (
          <box width={44} backgroundColor={focus === 8 ? COLORS.selected : undefined} paddingLeft={1}>
            <text fg={toggles.autoEat ? COLORS.green : COLORS.faint}>{toggles.autoEat ? '[x]' : '[ ]'} enabled</text>
          </box>
        ))}
        {row('Sneak', 9, (
          <box width={44} backgroundColor={focus === 9 ? COLORS.selected : undefined} paddingLeft={1}>
            <text fg={toggles.sneak ? COLORS.green : COLORS.faint}>{toggles.sneak ? '[x]' : '[ ]'} hold shift</text>
          </box>
        ))}
        {row('AFK', 10, (
          <box width={44} backgroundColor={focus === 10 ? COLORS.selected : undefined} paddingLeft={1}>
            <text fg={toggles.afk ? COLORS.green : COLORS.faint}>{toggles.afk ? '[x]' : '[ ]'} anti-AFK actions</text>
          </box>
        ))}
      </scrollbox>
      <box height={1} paddingLeft={1}>
        <text fg={error ? COLORS.red : COLORS.faint} wrapMode="none">
          {error ?? 'Tab/↑↓ move · space/←→ toggle · Ctrl+S save · Esc cancel'}
        </text>
      </box>
    </box>
  )
}

function HelpView ({ onClose }) {
  useKeyboard(key => {
    if (key.name === 'escape' || key.name === '?') onClose()
  })

  const keys = [
    ['↑ / ↓', 'select a bot'],
    ['s', 'start / stop'],
    ['r', 'reconnect / restart'],
    ['i / Enter', 'focus the console input'],
    ['a', 'add a bot'],
    ['e', 'edit selected bot'],
    ['d', 'delete selected bot'],
    ['c', 'clear this console'],
    ['?', 'this help'],
    ['q', 'quit siftbot'],
    ['Esc', 'back to the bot list']
  ]
  const commands = [
    ['text', 'send chat'],
    ['/command', 'send a server command'],
    ['.help', 'all console commands'],
    ['.status', 'health, food, position'],
    ['.eat [food]', 'eat now'],
    ['.sneak on|off', 'held shift'],
    ['.afk now', 'trigger an AFK action'],
    ['.reconnect', 'reconnect this bot']
  ]

  return (
    <box flexDirection="column" flexGrow={1} borderStyle="rounded" borderColor={COLORS.border} title=" Help ">
      <scrollbox flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD}>Keys</text>
        {keys.map(([key, description]) => (
          <box key={key} flexDirection="row" height={1}>
            <text width={14} fg={COLORS.yellow}>{key}</text>
            <text fg={COLORS.text}>{description}</text>
          </box>
        ))}
        <box height={1} />
        <text fg={COLORS.cyan} attributes={TextAttributes.BOLD}>Console</text>
        {commands.map(([command, description]) => (
          <box key={command} flexDirection="row" height={1}>
            <text width={18} fg={COLORS.green}>{command}</text>
            <text fg={COLORS.text}>{description}</text>
          </box>
        ))}
        <box height={1} />
        <text fg={COLORS.faint}>Bots are saved to instances.json. Passwords are stored there, so keep the file private.</text>
      </scrollbox>
      <box height={1} paddingLeft={1}>
        <text fg={COLORS.faint}>Press Esc or ? to close</text>
      </box>
    </box>
  )
}

function ConfirmView ({ title, message, onYes, onNo }) {
  useKeyboard(key => {
    if (key.name === 'y') onYes()
    else if (key.name === 'escape' || key.name === 'n') onNo()
  })

  return (
    <box flexDirection="column" flexGrow={1} borderStyle="rounded" borderColor={COLORS.border} title={` ${title} `} alignItems="center" justifyContent="center">
      <text fg={COLORS.text}>{message}</text>
      <box height={1} />
      <text fg={COLORS.faint}>y confirm · n / Esc cancel</text>
    </box>
  )
}

export function App ({ manager, dataFile }) {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const [, force] = useReducer(value => value + 1, 0)
  const [selectedId, setSelectedId] = useState(manager.list()[0]?.id ?? null)
  const [focusConsole, setFocusConsole] = useState(false)
  const [modal, setModal] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuSnapshot, setMenuSnapshot] = useState(null)
  const [slotIndex, setSlotIndex] = useState(0)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const inputRef = useRef(null)
  const sendQueue = useRef(Promise.resolve())

  const selected = selectedId ? manager.get(selectedId) : null
  const instances = manager.list()
  const selectedStatus = selected ? manager.statusOf(selected) : 'offline'
  const windowData = selected ? describeWindow(selected.runtime?.bot?.currentWindow) : null
  const windowId = windowData?.id ?? null
  const activeWindow = windowData ?? menuSnapshot
  const menuRows = activeWindow ? Math.ceil(activeWindow.size / 9) : 0

  const notify = message => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => {
    let scheduled = false
    let timer = null
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      timer = setTimeout(() => {
        scheduled = false
        timer = null
        force()
      }, 40)
    }
    manager.on('change', schedule)
    manager.on('record', schedule)
    const tick = setInterval(force, 1000)
    return () => {
      manager.off('change', schedule)
      manager.off('record', schedule)
      clearInterval(tick)
      if (timer) clearTimeout(timer)
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [manager])

  useEffect(() => {
    if (selectedId && manager.get(selectedId)) return
    setSelectedId(manager.list()[0]?.id ?? null)
  })

  useEffect(() => {
    if (focusConsole) inputRef.current?.focus?.()
    else inputRef.current?.blur?.()
  }, [focusConsole, selectedId])

  // An in-game menu (chest, shop, RTP, ...) opens as a popup, with the first
  // non-empty slot selected so Enter is immediately useful.
  useEffect(() => {
    if (!windowData) return
    setMenuSnapshot(windowData)
    setFocusConsole(false)
    setMenuOpen(true)
    const first = windowData.slots.findIndex(Boolean)
    setSlotIndex(first >= 0 ? first : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId])

  const shutdown = async () => {
    try {
      await manager.stopAll()
    } finally {
      renderer.destroy()
      process.exit(0)
    }
  }

  const requestQuit = () => {
    const running = manager.list().filter(instance => {
      const status = manager.statusOf(instance)
      return status !== 'offline' && status !== 'error'
    })
    if (running.length === 0) {
      void shutdown()
    } else {
      setModal({ type: 'confirm', action: 'quit' })
    }
  }

  const moveSelection = delta => {
    if (instances.length === 0) return
    const found = instances.findIndex(instance => instance.id === selectedId)
    const index = found === -1 ? (delta > 0 ? -1 : 0) : found
    const next = (index + delta + instances.length) % instances.length
    setSelectedId(instances[next].id)
    setFocusConsole(false)
  }

  const run = fn => {
    void Promise.resolve().then(fn).catch(err => notify(err?.message ?? String(err)))
  }

  const clickSlot = slot => {
    if (!selected?.runtime?.bot || !windowData) return
    if (!windowData.slots[slot]) return
    setSlotIndex(slot)
    run(() => selected.runtime.bot.clickWindow(slot, 0, 0))
  }

  const closeMenuWindow = () => {
    const bot = selected?.runtime?.bot
    if (bot?.currentWindow) run(() => bot.closeWindow(bot.currentWindow))
    setMenuOpen(false)
    setMenuSnapshot(null)
  }

  const handleMenuKey = key => {
    const last = (activeWindow?.size ?? 1) - 1
    switch (key.name) {
      case 'escape':
        closeMenuWindow()
        break
      case 'g':
        setMenuOpen(false)
        break
      case 'left':
        setSlotIndex(index => Math.max(0, index - 1))
        break
      case 'right':
        setSlotIndex(index => Math.min(last, index + 1))
        break
      case 'up':
        setSlotIndex(index => Math.max(0, index - 9))
        break
      case 'down':
        setSlotIndex(index => Math.min(last, index + 9))
        break
      case 'return':
        clickSlot(slotIndex)
        break
      default:
        break
    }
  }

  const toggleBot = () => {
    if (!selected) return
    const status = manager.statusOf(selected)
    if (status === 'offline' || status === 'error') {
      run(() => {
        manager.start(selected.id)
        notify(`Starting ${selected.label}`)
      })
    } else {
      run(async () => {
        await manager.stop(selected.id)
        notify(`Stopped ${selected.label}`)
        force()
      })
    }
  }

  const reconnect = () => {
    if (!selected) return
    if (!selected.runtime?.active) {
      run(() => {
        manager.start(selected.id)
        notify(`Starting ${selected.label}`)
      })
      return
    }
    run(() => {
      selected.runtime.reconnectNow()
      notify(`Reconnecting ${selected.label}`)
    })
  }

  const openAdd = () => {
    setFocusConsole(false)
    const template = selected?.config ?? defaultConfig()
    const config = JSON.parse(JSON.stringify(template))
    config.username = `bot${instances.length + 1}`
    config.password = ''
    config.startupCommands = []
    setModal({
      type: 'form',
      mode: 'add',
      config,
      label: config.username
    })
  }

  const openEdit = () => {
    if (!selected) return
    const status = manager.statusOf(selected)
    if (status !== 'offline' && status !== 'error') {
      notify('Stop the bot before editing it')
      return
    }
    setFocusConsole(false)
    setModal({ type: 'form', mode: 'edit', id: selected.id, config: selected.config, label: selected.label })
  }

  const submitConsole = value => {
    if (!selected) return
    if (!String(value).trim()) return
    const line = String(value)
    sendQueue.current = sendQueue.current
      .then(() => manager.send(selected.id, line))
      .catch(err => notify(err?.message ?? String(err)))
    if (inputRef.current) inputRef.current.value = ''
  }

  useKeyboard(key => {
    if (key.ctrl && key.name === 'c') {
      requestQuit()
      return
    }
    if (modal) return
    if (key.eventType === 'release') return

    if (menuOpen && activeWindow) {
      handleMenuKey(key)
      return
    }

    if (focusConsole) {
      if (key.name === 'escape') {
        setFocusConsole(false)
        inputRef.current?.blur?.()
      }
      return
    }

    if (key.repeated && key.name !== 'up' && key.name !== 'down') return

    switch (key.name) {
      case 'up':
        moveSelection(-1)
        break
      case 'down':
        moveSelection(1)
        break
      case 'i':
      case 'return':
        if (selected) setFocusConsole(true)
        break
      case 's':
        toggleBot()
        break
      case 'r':
        reconnect()
        break
      case 'u':
        if (selected?.runtime?.bot) run(() => selected.runtime.bot.activateItem())
        break
      case 'g':
        if (activeWindow) setMenuOpen(true)
        else notify('No in-game menu is open')
        break
      case 'a':
        openAdd()
        break
      case 'e':
        openEdit()
        break
      case 'd':
        if (selected) setModal({ type: 'confirm', action: 'delete', id: selected.id })
        break
      case 'c':
        if (selected) manager.clearRecords(selected.id)
        break
      case '?':
        setModal({ type: 'help' })
        break
      case 'q':
        requestQuit()
        break
      default:
        break
    }
  })

  if (modal?.type === 'form') {
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={COLORS.header}>
        <Header manager={manager} dataFile={dataFile} />
        <FormView
          manager={manager}
          initial={modal}
          onCancel={() => setModal(null)}
          onSaved={(id, message) => {
            setSelectedId(id)
            setModal(null)
            notify(message)
            force()
          }}
        />
        <Footer text="add / edit bot" toast={toast} />
      </box>
    )
  }

  if (modal?.type === 'help') {
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={COLORS.header}>
        <Header manager={manager} dataFile={dataFile} />
        <HelpView onClose={() => setModal(null)} />
        <Footer text="help" />
      </box>
    )
  }

  if (modal?.type === 'confirm') {
    const quitting = modal.action === 'quit'
    const target = selected
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={COLORS.header}>
        <Header manager={manager} dataFile={dataFile} />
        <ConfirmView
          title={quitting ? 'Quit' : 'Delete bot'}
          message={quitting
            ? 'Quit siftbot and disconnect every running bot?'
            : `Delete ${target?.label ?? 'this bot'}? This cannot be undone.`}
          onYes={() => {
            if (quitting) {
              void shutdown()
              return
            }
            const id = modal.id
            setModal(null)
            run(async () => {
              await manager.remove(id)
              setSelectedId(manager.list()[0]?.id ?? null)
              notify('Bot deleted')
              force()
            })
          }}
          onNo={() => setModal(null)}
        />
        <Footer text="confirm" />
      </box>
    )
  }

  const details = selected ? detailsLines(selected, manager) : []
  const records = selected ? selected.records.slice(-400) : []

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={COLORS.header}>
      <Header manager={manager} dataFile={dataFile} />

      <box flexDirection="row" flexGrow={1} gap={0}>
        <box width={30} flexDirection="column" borderStyle="rounded" borderColor={COLORS.border} title={` Bots (${instances.length}) `} backgroundColor={COLORS.panel}>
          <scrollbox flexGrow={1} stickyScroll stickyStart="top">
            {instances.length === 0 && (
              <box flexDirection="column" paddingLeft={1} paddingTop={1}>
                <text fg={COLORS.dim}>No bots yet.</text>
                <text fg={COLORS.faint}>press a to add one</text>
              </box>
            )}
            {instances.map(instance => {
              const status = manager.statusOf(instance)
              const active = instance.id === selectedId
              return (
                <box
                  key={instance.id}
                  flexDirection="column"
                  height={2}
                  paddingLeft={1}
                  backgroundColor={active ? COLORS.selected : undefined}
                  onMouseDown={() => { setSelectedId(instance.id); setFocusConsole(false) }}
                >
                  <box flexDirection="row" height={1}>
                    <text fg={statusColor(status)}>● </text>
                    <text fg={active ? COLORS.white : COLORS.text}>{instance.label}</text>
                  </box>
                  <box flexDirection="row" height={1}>
                    <text fg={COLORS.faint}>
                      {'  '}{status === 'online' ? instance.config.username : status} · {instance.config.host}
                    </text>
                  </box>
                </box>
              )
            })}
          </scrollbox>
        </box>

        <box flexGrow={1} flexDirection="column" borderStyle="rounded" borderColor={COLORS.border} title={selected ? ` ${selected.label} ` : ' Console '}>
          {selected
            ? (
              <>
                <box flexDirection="column" height={details.length + 1} paddingLeft={1} paddingRight={1}>
                  {details.map((line, index) => (
                    <text key={index} fg={index === 0 ? statusColor(selectedStatus) : COLORS.dim} wrapMode="none">
                      {line}
                    </text>
                  ))}
                </box>
                <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" verticalScrollbarOptions={{ showArrows: false }}>
                  {records.length === 0 && (
                    <box paddingLeft={1}>
                      <text fg={COLORS.faint}>
                        {manager.statusOf(selected) === 'offline'
                          ? 'Press s to start this bot.'
                          : 'Waiting for output…'}
                      </text>
                    </box>
                  )}
                  {records.map((record, index) => (
                    record.kind === 'output'
                      ? (
                        <box key={index} paddingLeft={1}>
                          <text fg={COLORS.text} wrapMode="word">{record.text}</text>
                        </box>
                        )
                      : (
                        <box key={index} paddingLeft={1}>
                          <text wrapMode="word">
                            <span fg={COLORS.faint}>{clock(record.time)} {recordTag(record)} </span>
                            <span fg={recordColor(record)}>{record.text}</span>
                          </text>
                        </box>
                        )
                  ))}
                </scrollbox>
                <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
                  <text fg={focusConsole ? COLORS.cyan : COLORS.faint}>{focusConsole ? '› ' : '· '}</text>
                  <input
                    ref={inputRef}
                    width={Math.max(20, width - 36)}
                    focused={focusConsole}
                    placeholder={selected ? 'command, /server, or chat — press i to type' : 'select a bot'}
                    backgroundColor={COLORS.panel}
                    focusedBackgroundColor={COLORS.selected}
                    onSubmit={submitConsole}
                  />
                </box>
              </>
            )
            : (
              <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
                <text fg={COLORS.dim}>Select a bot from the list</text>
                <text fg={COLORS.faint}>or press a to add one</text>
              </box>
            )}
        </box>
      </box>

      {menuOpen && activeWindow && (
        <box
          position="absolute"
          top={2}
          left={2}
          zIndex={10}
          width={Math.min(Math.max(width - 4, 104), 108)}
          height={Math.min(menuRows * 4 + 5, 44)}
          flexDirection="column"
          borderStyle="double"
          borderColor={COLORS.cyan}
          backgroundColor={COLORS.header}
          title={` ${activeWindow.title.slice(0, 40)} `}
        >
          <MenuGrid
            data={activeWindow}
            index={slotIndex}
            live={Boolean(windowData)}
            onSelect={slot => setSlotIndex(slot)}
            onActivate={slot => clickSlot(slot)}
          />
          <box height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
            <text fg={COLORS.white}>{slotLabel(activeWindow, slotIndex)}</text>
            <text fg={windowData ? COLORS.green : COLORS.faint}>{windowData ? 'live' : 'closed'}</text>
          </box>
          <box height={1} paddingLeft={1}>
            <text fg={COLORS.faint}>←↑↓→ move · Enter click · Esc close · g hide</text>
          </box>
        </box>
      )}

      <Footer
        text={focusConsole
          ? 'Enter send · Esc back · .help lists commands'
          : '↑↓ select · s start/stop · r reconnect · a add · e edit · d delete\n' +
            'i console · u use item · g menu · c clear · ? help · q quit'}
        toast={toast}
      />
    </box>
  )
}

function menuLabelLines (label, width = 9) {
  const clean = String(label ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= width) return [clean]
  if (clean.length <= width * 2) {
    const cut = clean.lastIndexOf(' ', width)
    if (cut > 0) return [clean.slice(0, cut), clean.slice(cut + 1)]
    return [clean.slice(0, width), clean.slice(width)]
  }
  return [clean.slice(0, width), clean.slice(width, width * 2 - 1) + '…']
}

function slotLabel (data, index) {
  const item = data?.slots?.[index]
  if (!item) return 'empty slot'
  return `${item.label}${item.count > 1 ? ` ×${item.count}` : ''}`
}

function MenuGrid ({ data, index, live, onSelect, onActivate }) {
  const rows = []
  const rowCount = Math.ceil(data.size / 9)
  for (let row = 0; row < rowCount; row++) {
    const cells = []
    for (let column = 0; column < 9; column++) {
      const slot = row * 9 + column
      const item = data.slots[slot]
      const active = slot === index
      const lines = item ? menuLabelLines(item.label) : ['', '']
      cells.push(
        <box
          key={slot}
          width={11}
          height={4}
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          borderStyle="single"
          borderColor={active ? COLORS.cyan : COLORS.border}
          backgroundColor={active ? COLORS.selected : COLORS.panel}
          onMouseMove={() => onSelect(slot)}
          onMouseDown={() => {
            onSelect(slot)
            if (live && item) onActivate(slot)
          }}
        >
          <text fg={active ? COLORS.white : COLORS.text}>{lines[0] || ' '}</text>
          <text fg={COLORS.faint}>{lines[1] || ' '}</text>
        </box>
      )
    }
    rows.push(<box key={row} flexDirection="row">{cells}</box>)
  }
  return <box flexDirection="column" paddingLeft={1} paddingRight={1}>{rows}</box>
}

function Header ({ manager, dataFile }) {
  const instances = manager.list()
  const online = instances.filter(instance => manager.statusOf(instance) === 'online').length
  return (
    <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor={COLORS.header}>
      <text fg={COLORS.cyan} attributes={TextAttributes.BOLD}>SIFTBOT</text>
      <text fg={COLORS.faint}>
        {instances.length} bots · {online} online · {dataFile}
      </text>
    </box>
  )
}

function Footer ({ text, toast = null }) {
  return (
    <box flexDirection="column">
      {toast && (
        <box height={1} paddingLeft={1} backgroundColor={COLORS.header}>
          <text fg={COLORS.yellow}>{toast}</text>
        </box>
      )}
      <box flexDirection="column" paddingLeft={1} backgroundColor={COLORS.panel}>
        {String(text).split('\n').map((line, index) => (
          <text key={index} fg={COLORS.faint}>{line}</text>
        ))}
      </box>
    </box>
  )
}
