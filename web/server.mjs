import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, "dist")
const progressFile = process.env.SIFT_PROGRESS_FILE || path.join(here, "..", "border-progress.json")
const guiFile = process.env.SIFT_GUI_FILE || path.join(here, "..", "gui.json")
const guiActions = process.env.SIFT_GUI_ACTIONS || path.join(here, "..", "gui-actions")
const port = Number(process.env.PORT) || 8790
const host = process.env.HOST || "127.0.0.1"

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8"
}

function readJson (request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on("data", chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { statusCode: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch {
        reject(Object.assign(new Error("invalid json"), { statusCode: 400 }))
      }
    })
    request.on("error", reject)
  })
}

function validateAction (body) {
  const allowed = new Set(["click", "use", "close", "command"])
  if (!body || typeof body !== "object" || !allowed.has(body.action)) {
    throw Object.assign(new Error("invalid action"), { statusCode: 400 })
  }
  if (body.action === "click" && (!Number.isInteger(body.slot) || body.slot < 0 || body.slot > 255)) {
    throw Object.assign(new Error("invalid slot"), { statusCode: 400 })
  }
  if (body.action === "command") {
    if (typeof body.command !== "string" || !body.command.startsWith("/") || body.command.length > 200) {
      throw Object.assign(new Error("invalid command"), { statusCode: 400 })
    }
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)

  if (url.pathname === "/progress") {
    try {
      const payload = fs.readFileSync(progressFile, "utf8")
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      })
      response.end(payload)
    } catch {
      response.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      })
      response.end(JSON.stringify({ error: "no progress file", file: progressFile }))
    }
    return
  }

  if (url.pathname === "/gui") {
    try {
      const payload = fs.readFileSync(guiFile, "utf8")
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      })
      response.end(payload)
    } catch {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      })
      response.end(JSON.stringify({ online: false, window: null, updatedAt: null }))
    }
    return
  }

  if (url.pathname === "/gui/action" && request.method === "POST") {
    readJson(request, 64 * 1024)
      .then(body => {
        validateAction(body)
        fs.mkdirSync(guiActions, { recursive: true })
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
        fs.writeFileSync(path.join(guiActions, name), JSON.stringify(body) + "\n")
        response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" })
        response.end(JSON.stringify({ queued: true, id: name }))
      })
      .catch(err => {
        response.writeHead(err.statusCode ?? 400, { "Content-Type": "application/json; charset=utf-8" })
        response.end(JSON.stringify({ error: err.message }))
      })
    return
  }

  let file = path.join(dist, decodeURIComponent(url.pathname))
  if (!file.startsWith(dist)) {
    response.writeHead(403).end()
    return
  }
  try {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dist, "index.html")
    }
  } catch {
    file = path.join(dist, "index.html")
  }

  if (!fs.existsSync(file)) {
    response.writeHead(404).end("build the dashboard first: bun run build")
    return
  }

  response.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store"
  })
  fs.createReadStream(file).pipe(response)
})

server.listen(port, host, () => {
  console.log(`siftbot dashboard on http://${host}:${port}`)
  console.log(`progress: ${progressFile}`)
})
