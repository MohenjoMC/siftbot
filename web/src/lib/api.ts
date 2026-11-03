export type BotStatus = "offline" | "connecting" | "online" | "retrying" | "stopping" | "error"

export type Bot = {
  id: string
  label: string
  status: BotStatus
  fatal: string | null
  startedAt: string | null
  connection: {
    username: string
    host: string
    port: number
    auth: string
    version: string | number
  }
  features: Record<string, boolean>
  details?: Record<string, unknown>
  config?: Record<string, unknown>
}

export type LogRecord = {
  time: number
  level: "debug" | "info" | "warn" | "error"
  kind: string
  text: string
  seq?: number
}

async function request<T> (path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function listBots (): Promise<Bot[]> {
  const body = await request<{ instances: Bot[] }>("/instances")
  return body.instances
}

export async function getBot (id: string): Promise<Bot> {
  const body = await request<{ instance: Bot }>(`/instances/${id}`)
  return body.instance
}

export async function startBot (id: string) {
  return request(`/instances/${id}/start`, { method: "POST" })
}

export async function stopBot (id: string) {
  return request(`/instances/${id}/stop`, { method: "POST" })
}

export async function restartBot (id: string) {
  return request(`/instances/${id}/restart`, { method: "POST" })
}

export async function reconnectBot (id: string) {
  return request(`/instances/${id}/reconnect`, { method: "POST" })
}

export async function sendInput (id: string, line: string) {
  return request(`/instances/${id}/input`, {
    method: "POST",
    body: JSON.stringify({ line })
  })
}

export async function getLogs (id: string, since = 0, limit = 300): Promise<LogRecord[]> {
  const body = await request<{ records: LogRecord[] }>(`/instances/${id}/logs?since=${since}&limit=${limit}`)
  return body.records ?? []
}

export async function createBot (label: string, config: Record<string, unknown>): Promise<Bot> {
  const body = await request<{ instance: Bot }>("/instances", {
    method: "POST",
    body: JSON.stringify({ label, config })
  })
  return body.instance
}

export async function updateBot (id: string, label: string, config: Record<string, unknown>): Promise<Bot> {
  const body = await request<{ instance: Bot }>(`/instances/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ label, config })
  })
  return body.instance
}

export async function deleteBot (id: string) {
  return request(`/instances/${id}`, { method: "DELETE" })
}
