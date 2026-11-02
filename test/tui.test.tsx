import { test, expect } from 'bun:test'
import { act } from 'react'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testRender } from '@opentui/react/test-utils'
import { App } from '../src/tui-app.js'
import { InstanceManager } from '../src/instances.js'
import { defaultConfig } from '../src/config.js'

test('renders, opens the add form and handles the help overlay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-tui-'))
  const file = path.join(dir, 'instances.json')
  const manager = new InstanceManager({ file })
  manager.load()
  manager.add({
    label: 'alpha',
    config: { ...defaultConfig(), username: 'alpha', host: 'alpha.example.com' }
  })

  const setup = await testRender(
    <App manager={manager} dataFile="instances.json" />,
    { width: 110, height: 32 }
  )

  try {
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain('alpha')
    expect(frame).toContain('Bots (1)')
    expect(frame).toContain('offline')

    await act(async () => { setup.mockInput.pressKey('a') })
    frame = await setup.waitForFrame(current => current.includes('New bot'))
    expect(frame).toContain('Username')
    expect(frame).toContain('Ctrl+S save')

    await act(async () => {
      setup.mockInput.pressEscape()
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    frame = await setup.waitForFrame(current => current.includes('Bots (1)'))
    expect(frame).toContain('alpha')

    await act(async () => { setup.mockInput.pressKey('?') })
    frame = await setup.waitForFrame(current => current.includes('Help'))
    expect(frame).toContain('start / stop')
    expect(frame).toContain('.status')

    await act(async () => {
      setup.mockInput.pressEscape()
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    await setup.waitForFrame(current => current.includes('Bots (1)'))

    await act(async () => { setup.mockInput.pressKey('d') })
    frame = await setup.waitForFrame(current => current.includes('Delete bot'))
    expect(frame).toContain('Delete alpha?')

    await act(async () => { setup.mockInput.pressKey('n') })
    await setup.waitForFrame(current => current.includes('Bots (1)'))

    await act(async () => { setup.mockInput.pressKey('d') })
    await setup.waitForFrame(current => current.includes('Delete bot'))
    await act(async () => { setup.mockInput.pressKey('y') })
    const empty = await setup.waitForFrame(current => current.includes('Bots (0)'))
    expect(empty).toContain('No bots yet')
    expect(manager.list().length).toBe(0)
  } finally {
    await setup.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('creates a new bot from the form', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-tui-add-'))
  const file = path.join(dir, 'instances.json')
  const manager = new InstanceManager({ file })
  manager.load()
  manager.add({
    label: 'alpha',
    config: { ...defaultConfig(), username: 'alpha' }
  })

  const setup = await testRender(
    <App manager={manager} dataFile="instances.json" />,
    { width: 110, height: 32 }
  )

  try {
    await setup.renderOnce()
    await act(async () => { setup.mockInput.pressKey('a') })
    await setup.waitForFrame(current => current.includes('New bot'))

    for (let i = 0; i < 4; i++) {
      await act(async () => { setup.mockInput.pressArrow('down') })
      await setup.renderOnce()
    }
    await act(async () => { setup.mockInput.pressArrow('right') })
    await setup.renderOnce()
    await act(async () => { setup.mockInput.pressKey('s', { ctrl: true }) })

    const frame = await setup.waitForFrame(current => current.includes('Bots (2)'))
    expect(frame).toContain('bot2')
    expect(manager.list().length).toBe(2)

    const created = manager.list().find(instance => instance.config.username === 'bot2')
    expect(created).toBeTruthy()
    expect(created.config.auth).toBe('microsoft')
  } finally {
    await setup.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('focuses the console and reports an offline send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-tui-console-'))
  const file = path.join(dir, 'instances.json')
  const manager = new InstanceManager({ file })
  manager.load()
  manager.add({
    label: 'alpha',
    config: { ...defaultConfig(), username: 'alpha' }
  })

  const setup = await testRender(
    <App manager={manager} dataFile="instances.json" />,
    { width: 110, height: 32 }
  )

  try {
    await setup.renderOnce()
    await act(async () => { setup.mockInput.pressKey('i') })
    await setup.renderOnce()
    await act(async () => { await setup.mockInput.typeText('.help'); setup.mockInput.pressEnter() })

    const frame = await setup.waitForFrame(current => current.includes('Start this bot first'))
    expect(frame).toContain('Start this bot first')
  } finally {
    await setup.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('renders an in-game menu as a popup and clicks a slot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftbot-tui-menu-'))
  const file = path.join(dir, 'instances.json')
  const manager = new InstanceManager({ file })
  manager.load()
  const instance = manager.add({
    label: 'alpha',
    config: { ...defaultConfig(), username: 'alpha', host: 'alpha.example.com' }
  })

  const clicks = []
  const fakeWindow = {
    id: 1,
    type: 'minecraft:generic_9x3',
    title: 'Homes & Teleports',
    slots: [
      null,
      {
        name: 'ender_pearl',
        count: 1,
        customName: { type: 'compound', value: { text: { type: 'string', value: 'Random Teleport' } } }
      }
    ]
  }
  instance.runtime = {
    active: true,
    bot: {
      currentWindow: fakeWindow,
      clickWindow: (slot) => clicks.push(slot),
      closeWindow: () => {}
    },
    status: () => ({
      connected: true,
      gameMode: 'survival',
      version: '26.1',
      host: 'alpha.example.com',
      port: 25565,
      health: 20,
      food: 20,
      saturation: 5,
      position: null,
      heldItem: null,
      players: 1,
      ping: 30,
      sneak: false,
      autoEatEnabled: true,
      afkEnabled: true,
      nextAfkMs: null,
      eating: false,
      lastEaten: null,
      uptimeMs: 1000,
      reconnectInMs: null,
      reconnectAttempt: 0
    })
  }

  const setup = await testRender(
    <App manager={manager} dataFile="instances.json" />,
    { width: 110, height: 32 }
  )

  try {
    const frame = await setup.waitForFrame(current => current.includes('Homes & Teleports'))
    expect(frame).toContain('Random Teleport')
    expect(frame).toContain('Enter click')

    await act(async () => { setup.mockInput.pressEnter() })
    await setup.renderOnce()
    expect(clicks).toEqual([1])
  } finally {
    await setup.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
