# siftbot API v1

HTTP(S) JSON API for the Minecraft mod, a web dashboard, or any other client that wants to manage siftbot instances.

The API is a thin, authenticated layer over `InstanceManager`. It does not run a second copy of the bot logic.

```
Fabric mod / dashboard / script
        │  HTTPS or loopback HTTP + bearer token
        ▼
siftbot daemon (src/daemon.js)
  InstanceManager → mineflayer bots
        │
        └── SSE streams and signed webhooks
```

## Start the daemon

```bash
npm run api
```

Defaults:

| Setting | Value |
| --- | --- |
| Bind address | `127.0.0.1` |
| Port | `8787` |
| Instances | `./instances.json` |
| Webhooks | `./webhooks.json` |
| Token | generated in `./api-token` if no token is configured |

Read the generated token:

```bash
cat api-token
```

Useful options:

```bash
npm run api -- \
  --host 127.0.0.1 \
  --port 8787 \
  --instances instances.json \
  --webhooks webhooks.json \
  --start-all \
  --show-token
```

`--start-all` starts every configured bot after the API is listening. `--show-token` prints the token to the log; use it only on a trusted terminal.

Environment equivalents:

| Variable | Meaning |
| --- | --- |
| `SIFT_API_HOST`, `SIFT_API_PORT` | Bind address and port |
| `SIFT_API_TOKEN` | Bearer token (otherwise `api-token`) |
| `SIFT_API_INSTANCES`, `SIFT_API_WEBHOOKS` | Data files |
| `SIFT_API_TLS_CERT`, `SIFT_API_TLS_KEY` | Enable HTTPS |
| `SIFT_API_INSECURE_WEBHOOKS` | Allow loopback HTTP webhooks |
| `SIFT_API_START_ALL` | Start every bot at boot |
| `SIFT_API_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

The daemon is headless. The OpenTUI control room (`npm run ui`) is a separate frontend and does not start the API by default. Do not run both against the same `instances.json`: each process owns its own bot sessions and both write the file. For a mod plus a terminal UI, use the API as the single supervisor and connect the terminal to it, or use separate instance files.

### HTTPS

The API speaks HTTP on loopback and HTTPS when given a certificate and key:

```bash
npm run cert
npm run api -- --tls-cert certs/cert.pem --tls-key certs/key.pem
```

`npm run cert` writes a self-signed certificate for `localhost`, `127.0.0.1` and `::1` to `certs/`. The key and certificate are gitignored.

For a Java Fabric mod, either:

- use loopback HTTP for a daemon on the same machine, or
- trust the self-signed certificate in the mod's `SSLContext` / truststore:

```bash
keytool -importcert \
  -alias siftbot-local \
  -file certs/cert.pem \
  -keystore siftbot-truststore.p12 \
  -storetype PKCS12
```

Production deployments should terminate TLS at a reverse proxy or use a certificate from a real CA. Do not expose this API directly to the internet.

## Authentication

Every `/api/v1` request needs a bearer token:

```http
Authorization: Bearer <token>
```

Accepted alternatives:

- `X-Siftbot-Token: <token>`
- `?token=<token>` on SSE endpoints only, for clients that cannot set headers

`GET /healthz` is public and returns no bot data. Everything else returns `401` without a valid token.

```bash
TOKEN=$(cat api-token)

curl -s http://127.0.0.1:8787/api/v1 \
  -H "Authorization: Bearer $TOKEN"
```

Tokens are compared in constant time. The daemon generates a 64-character token when no `--token` or `SIFT_API_TOKEN` is present; the token file is written with mode `0600`.

## Conventions

- Base path: `/api/v1`. The API version is stable for the v1 contract.
- Request bodies must be `application/json`, at most 1 MiB.
- Responses are JSON and use `Cache-Control: no-store`.
- Every response includes `X-Request-Id` and `X-Siftbot-Version`.
- Errors have one shape:

```json
{
  "error": {
    "code": "instance_not_found",
    "message": "Unknown bot instance: 3b...",
    "requestId": "a3..."
  }
}
```

- No CORS headers are sent. The API is designed for native mods and local tools, not arbitrary browser origins.
- Dates are ISO-8601 strings unless noted. Minecraft record timestamps (`time`) are Unix milliseconds.

### Status codes

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `201` | Created |
| `202` | Accepted; an asynchronous action started |
| `204` | No body |
| `400` | Invalid JSON/body/config/webhook |
| `401` | Missing or invalid token |
| `404` | Unknown route, instance or webhook |
| `405` | Wrong method |
| `409` | Conflict, e.g. editing a running bot or sending input while offline |
| `413` | Body too large |
| `415` | Body is not `application/json` |
| `500` | Internal error |

## Health and discovery

### `GET /healthz`

Public. No token. Intended for the mod's daemon-discovery check.

```json
{
  "ok": true,
  "service": "siftbot",
  "version": "1.0.0",
  "time": "2026-10-31T12:00:00.000Z"
}
```

### `GET /api/v1`

Authenticated. Returns version, capabilities and canonical links.

```json
{
  "name": "siftbot",
  "version": "1.0.0",
  "apiVersion": "v1",
  "protocol": "http",
  "capabilities": {
    "sse": true,
    "webhooks": true,
    "tls": false
  },
  "links": {
    "instances": "/api/v1/instances",
    "events": "/api/v1/events",
    "webhooks": "/api/v1/webhooks",
    "docs": "docs/API.md"
  },
  "serverTime": "2026-10-31T12:00:00.000Z"
}
```

## Instances

### Instance summary

```json
{
  "id": "0b5f...",
  "label": "Farmer",
  "status": "online",
  "fatal": null,
  "startedAt": "2026-10-31T11:55:00.000Z",
  "connection": {
    "username": "farmer",
    "host": "mc.example.com",
    "port": 25565,
    "auth": "offline",
    "version": "1.21.4"
  },
  "features": {
    "autoEat": true,
    "sneak": true,
    "afk": true,
    "client": true
  },
  "hasPassword": false,
  "lastRecordSeq": 42
}
```

`status` is one of `offline`, `connecting`, `online`, `retrying`, `stopping`, `error`.

### Instance detail

The single-instance response adds:

- `config`: a copy of the instance config. Secrets are redacted by default (`password: "***"`, and `${password}` in startup commands is replaced when a password is set).
- `details`: live runtime state:

```json
{
  "connected": true,
  "username": "farmer",
  "host": "mc.example.com",
  "port": 25565,
  "version": "1.21.4",
  "gameMode": "survival",
  "dimension": "minecraft:overworld",
  "health": 20,
  "food": 18,
  "saturation": 3.4,
  "position": { "x": 12.5, "y": 64, "z": -7.5 },
  "ping": 42,
  "players": 3,
  "heldItem": "cooked_beef",
  "clientBrand": "vanilla",
  "clientTickEnd": true,
  "hasStoredPassword": true,
  "sneak": true,
  "autoEatEnabled": true,
  "afkEnabled": true,
  "nextAfkMs": 14320,
  "eating": false,
  "lastEaten": "cooked_beef",
  "uptimeMs": 600000,
  "reconnectInMs": null,
  "reconnectAttempt": 0
}
```

### `GET /api/v1/instances`

```json
{ "instances": [ { "id": "...", "label": "Farmer", "status": "online" } ] }
```

Client should treat unknown fields as additive.

### `POST /api/v1/instances`

Create an instance. `config` uses the same schema as `config.example.json`; omitted fields get defaults.

```http
POST /api/v1/instances
Content-Type: application/json

{
  "label": "Farmer",
  "config": {
    "username": "farmer",
    "host": "mc.example.com",
    "port": 25565,
    "auth": "offline",
    "autoEat": { "enabled": true, "eatAtFood": 17 },
    "sneak": { "enabled": true },
    "afk": { "enabled": true }
  }
}
```

Response `201`:

```json
{ "instance": { "id": "...", "label": "Farmer", "status": "offline", "config": { "...": "..." }, "details": { "...": "..." } } }
```

`Location` points at the new instance. The response config is redacted.

### `GET /api/v1/instances/{id}`

Returns instance detail. Add `?reveal=true` to include the real password and un-redacted startup commands. The token already grants full control, but avoid reveal in logs or shared clients.

### `PATCH /api/v1/instances/{id}`

Partial update. `config` is deep-merged over the existing config; arrays are replaced, omitted fields are preserved.

```json
{
  "label": "Farmer 2",
  "config": {
    "host": "new.example.com",
    "autoEat": { "eatAtFood": 15 }
  }
}
```

Rules:

- The bot must be stopped. Otherwise the response is `409 conflict`.
- `config.password` omitted or `null` preserves the current password.
- `config.password: ""` clears it.
- `config.password: "***"` is treated as “keep the current password” so a form can round-trip a redacted config.
- Redacted `startupCommands` cannot be safely round-tripped. Send only the config fields you actually change, or use `?reveal=true` before sending commands back.

### `DELETE /api/v1/instances/{id}`

Stops the bot if needed and deletes it. `204 No Content`.

### `POST /api/v1/instances/{id}/start`

Starts the bot. `202 Accepted`, returns the instance summary. Connection progress appears on the event stream.

### `POST /api/v1/instances/{id}/stop`

Stops the bot and waits for the session to close. `200 OK`.

### `POST /api/v1/instances/{id}/restart`

Stops then starts the bot. `202 Accepted`.

### `POST /api/v1/instances/{id}/reconnect`

Forces an immediate reconnect if active, otherwise starts the bot. `202 Accepted`.

### `POST /api/v1/instances/{id}/input`

Sends one line to the bot console. This is the same input as the CLI/TUI:

- plain text → chat
- `/command` → server command
- `.command` → siftbot console command (`.status`, `.eat`, `.sneak on`, …)

```json
{ "line": ".status" }
```

Rules: non-empty, at most 1000 characters, no newlines, bot must be started (`409 offline` otherwise). Returns `202 { "accepted": true }`.

### `GET /api/v1/instances/{id}/logs?since=0&limit=100`

Returns buffered console records. `limit` is 1–800 (default 100). `since` is the per-instance `seq` cursor:

```json
{
  "instanceId": "0b5f...",
  "records": [
    {
      "time": 1761912000000,
      "level": "info",
      "kind": "chat",
      "text": "<Alex> hello",
      "seq": 42
    }
  ],
  "lastSeq": 42
}
```

`kind` is `log`, `chat`, `whisper`, `system` or `output`; `level` is `debug`, `info`, `warn` or `error`.

### `DELETE /api/v1/instances/{id}/logs`

Clears the in-memory console buffer. `204 No Content`.

## Streaming (SSE)

Server-Sent Events are used instead of WebSockets because they are plain HTTP, work through HTTPS proxies, and are easy to consume from Java and scripts.

Two endpoints:

- `GET /api/v1/events` — all instances.
- `GET /api/v1/instances/{id}/events` — one instance.

Both require a token. For clients that cannot set an `Authorization` header, `?token=<token>` is accepted on these two routes only.

```bash
curl -N \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/api/v1/instances/0b5f/events
```

Response headers:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-store
Connection: keep-alive
X-Accel-Buffering: no
```

### Stream lifecycle

1. `retry: 3000`
2. If the client supplied a cursor, replayed events with a global event id greater than the cursor.
3. `event: snapshot` — current state, authoritative.
4. `event: cursor` with `id` set to the current global event id.
5. Live events.
6. `: ping <unix-ms>` comments every 15 seconds.

Example:

```
retry: 3000

event: snapshot
data: {"at":"2026-10-31T12:00:00.000Z","lastEventId":127,"instances":[...]}

id: 127
event: cursor
data: {"lastEventId":127}

id: 128
event: record
data: {"id":128,"type":"record","at":"2026-10-31T12:00:01.000Z","instanceId":"0b5f...","data":{"time":1761912001000,"level":"info","kind":"chat","text":"<Alex> hi","seq":42}}

: ping 1761912015000
```

### Resuming

Send the last event id the client processed:

```http
Last-Event-ID: 127
```

or:

```
GET /api/v1/instances/0b5f/events?after=127
```

The server keeps a 2000-event ring (last 500 replayed per connection). The snapshot is authoritative for state. Records are not part of the snapshot, so replay is how a reconnecting client catches up on chat. Deduplicate records by `data.seq`; event ids and record seq are different counters.

Omit `Last-Event-ID` for a fresh connection. Sending `after=0` explicitly replays the whole ring before the snapshot.

If a client reads too slowly and the socket buffer fills, the daemon skips live events and writes a `: dropped N` comment before the next event. A comment is not an event and does not carry an id. Reconnect with `Last-Event-ID` to replay the ring.

### Event types

| Event | `instanceId` | `data` |
| --- | --- | --- |
| `record` | instance | console record |
| `status` | instance | instance summary + live `details` |
| `instance.created` | instance | instance detail |
| `instance.updated` | instance | instance detail |
| `instance.deleted` | instance | `{ "id": "..." }` |
| `instance.started` | instance | instance summary |
| `instance.stopped` | instance | instance summary |
| `cursor` | — | `{ "lastEventId": 128 }` |
| `snapshot` | — | `{ at, lastEventId, instances: [...] }` |

`status` events are emitted when meaningful state changes (connection, health, hunger, position, players, held item, sneak, eating, AFK). Countdowns such as `nextAfkMs` and `uptimeMs` are included in the payload but do not trigger events by themselves.

## Webhooks

Webhooks push the same event stream to an HTTP(S) endpoint. They are useful when a mod or dashboard cannot keep a long-lived SSE connection open.

Manage them through the API; they are persisted in `webhooks.json` with mode `0600`.

### `POST /api/v1/webhooks`

```http
POST /api/v1/webhooks
Content-Type: application/json

{
  "url": "https://mod.example.com/siftbot/events",
  "description": "Fabric mod bridge",
  "events": ["record", "status", "instance.*"],
  "instanceId": null
}
```

- `url` must be `https://`.
- `http://` is allowed only for loopback targets when the daemon runs with `--insecure-webhooks` (or `SIFT_API_INSECURE_WEBHOOKS=true`). This is for local development.
- `events` is a list of patterns: exact (`record`), wildcard (`*`), prefix (`instance.*`), or `instance` for all lifecycle events. Default `["*"]`.
- `instanceId` limits delivery to one bot; `null` means all.
- `secret` is optional. If omitted, a 48-character secret is generated.
- The secret is returned **once** on creation. Later list/get responses only show `hasSecret: true`.

Response `201`:

```json
{
  "webhook": {
    "id": "wh_...",
    "url": "https://mod.example.com/siftbot/events",
    "description": "Fabric mod bridge",
    "events": ["record", "status", "instance.*"],
    "instanceId": null,
    "active": true,
    "createdAt": "2026-10-31T12:00:00.000Z",
    "hasSecret": true,
    "secret": "generated-secret"
  }
}
```

### Listing and managing

| Endpoint | Action |
| --- | --- |
| `GET /api/v1/webhooks` | List (secrets hidden) |
| `GET /api/v1/webhooks/{id}` | Get one (secrets hidden) |
| `PATCH /api/v1/webhooks/{id}` | Update `url`, `description`, `events`, `instanceId`, `active` |
| `DELETE /api/v1/webhooks/{id}` | Delete |
| `POST /api/v1/webhooks/{id}/test` | Send a one-off `test` event; returns the delivery result |

Secrets cannot be rotated in place. Delete and recreate the subscription, or update the secret in `webhooks.json` while the daemon is stopped.

### Delivery payload

```json
{
  "id": "delivery-uuid",
  "type": "record",
  "sequence": 128,
  "createdAt": "2026-10-31T12:00:01.000Z",
  "instanceId": "0b5f...",
  "data": {
    "time": 1761912001000,
    "level": "info",
    "kind": "chat",
    "text": "<Alex> hi",
    "seq": 42
  }
}
```

Headers:

| Header | Meaning |
| --- | --- |
| `X-Siftbot-Event` | Event type, e.g. `record` |
| `X-Siftbot-Delivery` | Delivery UUID |
| `X-Siftbot-Timestamp` | Unix seconds used in the signature |
| `X-Siftbot-Signature` | `sha256=<hex>` |
| `User-Agent` | `siftbot-webhook/1` |

### Signature verification

The signature is HMAC-SHA256 over:

```
<timestamp> + "." + <raw request body>
```

Do not verify a re-serialized JSON object; use the exact bytes.

Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, timestamp, rawBody, header) {
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  const received = String(header).replace(/^sha256=/, '')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}
```

Java:

```java
Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
String expected = HexFormat.of().formatHex(
    mac.doFinal((timestamp + "." + rawBody).getBytes(StandardCharsets.UTF_8))
);
boolean ok = MessageDigest.isEqual(
    expected.getBytes(StandardCharsets.UTF_8),
    signatureHeader.replace("sha256=", "").getBytes(StandardCharsets.UTF_8)
);
```

Reject timestamps older than a few minutes to limit replay. Deduplicate on `id`.

### Delivery behavior

- 5-second timeout per attempt.
- Up to 3 attempts total for network errors, `429`, and `5xx`: 500ms then 1000ms backoff.
- Other `4xx` responses are not retried.
- Redirects are not followed.
- Pending deliveries per subscription are capped at 100; excess events are dropped with a daemon warning.
- Delivery status is exposed in the webhook object (`lastDeliveryAt`, `lastStatus`, `lastError`, `failureCount`), but these metrics are not persisted across daemon restarts.

## Mod integration notes

- Cache the daemon URL and token in the mod config, never ship a token in the jar.
- Use `GET /healthz` to show “daemon offline” cleanly.
- Prefer the per-instance SSE stream; use `Last-Event-ID` when reconnecting.
- Treat `snapshot` as authoritative and deduplicate records by `data.seq`.
- Fetch `/instances/{id}/logs?since=lastSeq` on startup for backlog, then subscribe.
- Do HTTP and SSE work off the Minecraft render thread. Fabric's `HttpClient` callbacks run on another thread; marshal changes back with `client.execute(...)`.
- A self-signed HTTPS daemon needs a truststore or a custom `SSLContext` in the mod. Loopback HTTP is simpler for local use.
- For Java SSE, read the response `InputStream` line by line with `BufferedReader`; dispatch an event when a blank line arrives.

```java
HttpRequest request = HttpRequest.newBuilder(
        URI.create(daemonUrl + "/api/v1/instances/" + id + "/events"))
    .header("Authorization", "Bearer " + token)
    .header("Accept", "text/event-stream")
    .GET()
    .build();

HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
    String line;
    while ((line = reader.readLine()) != null) {
        // Parse retry/id/event/data lines and dispatch on an empty line.
    }
}
```

## Security checklist

- Bind to `127.0.0.1` unless a remote mod really needs network access.
- Use HTTPS and a trusted certificate when the daemon is not loopback.
- Keep `api-token`, `instances.json`, `webhooks.json` and TLS keys at mode `0600`.
- Do not put tokens in query strings except the documented SSE fallback; URLs end up in proxy logs.
- Require HTTPS webhooks. Only enable `--insecure-webhooks` for local testing.
- Verify the webhook HMAC and timestamp.
- Put a reverse proxy in front of the daemon if it must be reachable from the internet; do not expose Node directly.
- Rotate the API token if it leaks (stop the daemon, replace `api-token`, restart).
- The API has no per-user permissions: the token is full admin. That includes creating webhooks to internal HTTPS services, so restrict who receives the token or apply an egress policy.
- `?reveal=true` returns real secrets. Do not log or cache those responses in a mod.

## Machine-readable specification

See [`docs/openapi.yaml`](./openapi.yaml) for an OpenAPI 3.1 document covering these endpoints and schemas.
