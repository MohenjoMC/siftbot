import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, "dist")
const progressFile = process.env.SIFT_PROGRESS_FILE || path.join(here, "..", "border-progress.json")
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
