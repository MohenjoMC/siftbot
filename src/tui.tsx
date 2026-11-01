#!/usr/bin/env bun
import path from 'node:path'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { App } from './tui-app.js'
import { InstanceManager } from './instances.js'

const dataFile = process.env.SIFT_UI_FILE
  ? path.resolve(process.env.SIFT_UI_FILE)
  : path.join(process.cwd(), 'instances.json')

const manager = new InstanceManager({ file: dataFile })
try {
  manager.load()
} catch (err) {
  console.error(`siftbot ui: ${err.message}`)
  process.exit(1)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30
})
const root = createRoot(renderer)
root.render(<App manager={manager} dataFile={path.basename(dataFile)} />)

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await manager.stopAll()
  } finally {
    try {
      renderer.destroy()
    } catch {
      // Already destroyed.
    }
    process.exit(0)
  }
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('uncaughtException', err => {
  console.error(err)
  void shutdown()
})
process.on('unhandledRejection', err => {
  console.error(err)
})
