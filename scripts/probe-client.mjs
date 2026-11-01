import mineflayer from 'mineflayer'
import { ClientIdentity } from '../src/features/client-identity.js'
import { parseProxy, socks5Client } from '../src/socks5.js'

// Wire probe: connects and logs the packet sequence so we can see exactly what
// the server observes. SIFT_HOST/SIFT_PORT set the target (use the SRV target
// explicitly when proxying). SIFT_SOCKS=127.0.0.1:9050 sends it all through a
// SOCKS5 proxy (Tor) instead of the local network.
const [username = 'NotKillerMC'] = process.argv.slice(2)
const host = process.env.SIFT_HOST || 'sculksmp.xyz'
const port = Number(process.env.SIFT_PORT || 25565)
const proxy = parseProxy(process.env.SIFT_SOCKS)

const logger = { debug: m => console.log('[identity]', m) }

const options = {
  host,
  port,
  username,
  auth: 'offline',
  version: false,
  respawn: false,
  hideErrors: false,
  logErrors: false,
  viewDistance: 'normal',
  locale: 'en_US',
  brand: 'vanilla',
  clientSettings: {
    locale: 'en_US',
    viewDistance: 10,
    chatFlags: 0,
    chatColors: true,
    skinParts: 127,
    mainHand: 1,
    enableTextFiltering: false,
    enableServerListing: true
  }
}
if (proxy) options.connect = socks5Client(options, proxy)

const bot = mineflayer.createBot(options)
const identity = new ClientIdentity(bot, { enabled: true, brand: 'vanilla' }, logger)

const t0 = Date.now()
const stamp = () => `+${String(Date.now() - t0).padStart(5)}ms`

const client = bot._client
const originalWrite = client.write.bind(client)
client.write = (name, params) => {
  let extra = ''
  if (name === 'custom_payload') extra = ` channel=${params.channel}`
  if (name === 'settings') extra = ` ${JSON.stringify(params)}`
  if (name === 'set_protocol') extra = ` protocol=${params.protocolVersion}`
  if (name === 'select_known_packs') extra = ` ${JSON.stringify(params)}`
  if (name === 'position' || name === 'position_look' || name === 'look') {
    const p = params.position || params
    extra = ` pos=(${Number(p.x).toFixed(2)},${Number(p.y).toFixed(2)},${Number(p.z).toFixed(2)})` +
      ` onGround=${params.onGround ?? params.flags?.onGround}`
  }
  console.log(stamp(), 'OUT', client.state, name, extra)
  return originalWrite(name, params)
}

client.on('packet', (data, meta) => {
  if (meta.state === 'configuration' && meta.name === 'registry_data') return
  let extra = ''
  if (meta.name === 'system_chat') {
    try { extra = ' ' + JSON.stringify(data).slice(0, 400) } catch {}
  }
  if (meta.name === 'position' || meta.name === 'spawn_position') {
    try { extra = ' ' + JSON.stringify(data).slice(0, 160) } catch {}
    if (meta.name === 'position') {
      setTimeout(() => {
        const e = bot.entity
        console.log(stamp(), 'ENTITY', e ? `pos=(${e.position?.x},${e.position?.y},${e.position?.z}) yaw=${e.yaw} pitch=${e.pitch}` : 'none')
      }, 5)
    }
  }
  console.log(stamp(), 'IN ', meta.state, meta.name, extra)
})
client.on('state', (next, prev) => console.log(stamp(), 'STATE', prev, '->', next))

let spawned = false
bot.on('login', () => console.log(stamp(), 'EVENT login, version', bot.version))
bot.on('spawn', () => {
  spawned = true
  console.log(stamp(), 'EVENT spawn at', JSON.stringify(bot.entity?.position), 'onGround', bot.entity?.onGround)
  setTimeout(() => {
    console.log(stamp(), 'STILL ALIVE 45s after spawn')
    identity.stop()
    bot.quit('probe done')
  }, 45000)
})
bot.on('kicked', reason => console.log(stamp(), 'EVENT kicked', JSON.stringify(reason)))
bot.on('end', reason => {
  console.log(stamp(), 'EVENT end', reason, spawned ? '(had spawned)' : '(never spawned)')
  process.exit(0)
})
bot.on('error', err => console.log(stamp(), 'EVENT error', err.message))

setTimeout(() => {
  console.log(stamp(), 'TIMEOUT')
  try { identity.stop(); bot.quit('probe timeout') } catch {}
  setTimeout(() => process.exit(0), 500)
}, 90000)
