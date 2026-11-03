import { useEffect, useRef, useState } from "react"

export type Point = { x: number; z: number }

export type TrailPoint = { t: number; x: number; z: number }

export type Progress = {
  plugin?: string
  username: string
  server: string
  corner: string
  target: Point
  position: { x: number; y: number; z: number }
  distance: number
  travelled: number
  speed: number
  etaSeconds: number | null
  health: number
  food: number
  sprinting: boolean
  eating: boolean
  status: string
  startedAt: string
  updatedAt: string
  trail: TrailPoint[]
}

export type LogEvent = { time: number; text: string }

const POLL_MS = 500

export function formatNumber (value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

export function formatCoordinate (value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—"
  const rounded = Math.round(value)
  const sign = rounded < 0 ? "\u2212" : "+"
  return `${sign}${formatNumber(Math.abs(rounded))}`
}

export function distanceTo (point: Point, target: Point) {
  return Math.hypot(target.x - point.x, target.z - point.z)
}

export function formatEta (seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—"
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
  return `${total}s`
}

export function formatClock (time: number | string) {
  const date = new Date(time)
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function formatAge (time: string | null | undefined) {
  if (!time) return "—"
  const seconds = Math.max(0, Math.round((Date.now() - new Date(time).getTime()) / 1000))
  if (seconds < 2) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

/** Distance covered fraction for the route rail, 0..1. */
export function routeFraction (progress: Progress | null) {
  if (!progress) return 0
  const first = progress.trail?.[0]
  const initial = first ? distanceTo(first, progress.target) : progress.travelled + progress.distance
  const total = initial > 0 ? initial : progress.travelled + progress.distance
  if (!total) return 0
  return Math.min(1, Math.max(0, 1 - progress.distance / total))
}

function describeChange (previous: Progress | null, next: Progress) {
  const events: string[] = []
  if (!previous) {
    events.push(`connected as ${next.username} on ${next.server}`)
  } else if (previous.status !== next.status) {
    events.push(next.status)
  }
  if (previous && !previous.eating && next.eating) {
    events.push(`eating — food ${next.food}/20`)
  }
  if (previous && previous.sprinting !== next.sprinting) {
    events.push(next.sprinting ? "sprinting" : "walking")
  }
  return events
}

export function useProgress (paused: boolean) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [events, setEvents] = useState<LogEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const previous = useRef<Progress | null>(null)

  useEffect(() => {
    if (paused) return
    let active = true

    const poll = async () => {
      try {
        const response = await fetch("/progress", { cache: "no-store" })
        if (response.status === 404) {
          if (active) {
            setProgress(null)
            setError(null)
          }
          return
        }
        if (!response.ok) throw new Error(`progress endpoint returned ${response.status}`)
        const next = (await response.json()) as Progress
        if (!active) return
        const messages = describeChange(previous.current, next)
        if (messages.length > 0) {
          setEvents(current => [
            ...messages.map(text => ({ time: Date.now(), text })),
            ...current
          ].slice(0, 40))
        }
        previous.current = next
        setProgress(next)
        setError(null)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
    }

    void poll()
    const timer = window.setInterval(poll, POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [paused])

  return { progress, events, error }
}
