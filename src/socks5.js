import net from 'node:net'

/**
 * Minimal SOCKS5 dialer for minecraft-protocol's `connect` option.
 *
 * minecraft-protocol lets a caller own the socket: `options.connect(client)` is
 * called instead of its built-in net.connect, and whatever socket we attach via
 * `client.setSocket()` is used for the protocol. We use it to send the whole
 * Minecraft connection through a SOCKS5 proxy (Tor), so testing never touches
 * the local network's public address.
 *
 * Unlike the built-in path we cannot rely on the socket's 'connect' event (it
 * fires when Tor's local port accepts, not when the tunnel is up), so the
 * client 'connect' event is emitted manually once the SOCKS reply succeeds —
 * the same shape minecraft-protocol uses for an injected stream.
 */
export function socks5Client (options, proxy) {
  return client => {
    const socket = net.connect(proxy.port, proxy.host)
    socket.setNoDelay(true)

    const host = String(options.host)
    const port = Number(options.port) || 25565
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)

    const fail = err => {
      buffer = Buffer.alloc(0)
      socket.destroy()
      client.emit('error', err)
    }

    const sendConnect = () => {
      const domain = Buffer.from(host, 'utf8')
      if (domain.length > 255) return fail(new Error('SOCKS5 host name too long'))
      const request = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
        domain,
        Buffer.from([(port >> 8) & 0xff, port & 0xff])
      ])
      stage = 'reply'
      socket.write(request)
    }

    socket.on('error', err => fail(err))
    socket.on('close', () => {
      if (stage !== 'ready') fail(new Error('SOCKS5 proxy closed the connection'))
    })

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) return fail(new Error(`SOCKS5 greeting rejected (${buffer[0]}, ${buffer[1]})`))
        buffer = buffer.subarray(2)
        sendConnect()
        return
      }

      if (stage === 'reply') {
        if (buffer.length < 5) return
        const reply = buffer[1]
        if (reply !== 0x00) {
          return fail(new Error(`SOCKS5 connect failed with code ${reply}`))
        }
        const atyp = buffer[3]
        const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : buffer[4]
        const total = atyp === 0x03 ? 5 + addressLength + 2 : 4 + addressLength + 2
        if (buffer.length < total) return // wait for the full reply

        stage = 'ready'
        socket.removeAllListeners('data')
        socket.removeAllListeners('close')
        socket.on('error', err => client.emit('error', err))
        client.setSocket(socket)
        client.emit('connect')
        return
      }
    })

    socket.write(Buffer.from([0x05, 0x01, 0x00]))
  }
}

/** Parse "127.0.0.1:9050" into { host, port }. */
export function parseProxy (value) {
  if (!value) return null
  const source = String(value).trim()
  const index = source.lastIndexOf(':')
  if (index === -1) return { host: source, port: 9050 }
  return {
    host: source.slice(0, index).replace(/^\[|\]$/g, ''),
    port: Number(source.slice(index + 1)) || 9050
  }
}
