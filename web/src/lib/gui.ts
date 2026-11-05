import { useEffect, useRef, useState } from "react"

export type GuiSlot = {
  slot: number
  name: string
  count: number
  label: string
}

export type GuiWindow = {
  id: number
  title: string
  type: string
  size: number
  slots: Array<GuiSlot | null>
}

export type GuiAction =
  | { action: "click"; slot: number; button?: number }
  | { action: "use" }
  | { action: "close" }
  | { action: "name"; name: string }
  | { action: "command"; command: string }

export type GuiState = {
  online: boolean
  username?: string | null
  server?: string
  updatedAt: string | null
  window: GuiWindow | null
  lastAction?: {
    at: number
    action: GuiAction
    ok: boolean
    error?: string
  } | null
}

export function useGui (paused: boolean) {
  const [state, setState] = useState<GuiState | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    if (paused) return () => { alive.current = false }
    let timer

    const poll = async () => {
      try {
        const response = await fetch("/gui", { cache: "no-store" })
        if (response.ok) {
          const next = (await response.json()) as GuiState
          if (alive.current) setState(next)
        }
      } catch {
        // Keep the last window visible if the bridge restarts.
      }
    }

    void poll()
    timer = window.setInterval(poll, 1000)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [paused])

  return state
}

export async function sendGuiAction (action: GuiAction) {
  const response = await fetch("/gui/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action)
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error ?? `action failed (${response.status})`)
  }
  return response.json()
}

/** devault item icon, or null when the name has no texture. */
export function itemIcon (name: string | null | undefined) {
  if (!name) return null
  return `/items/${name}.png`
}
