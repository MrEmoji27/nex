// STUN client — RFC 5389 binding request.
//
// Answers one question: what does the rest of the internet see my address as?
// Behind a home router your machine holds a private address that nobody outside
// can dial. A STUN server looks at the packet you sent it and tells you the
// public address and port your router rewrote it to.
//
// That is worth doing on its own, before any hole punching exists: a node with a
// forwarded port or on a permissive NAT currently has to be told its public
// address by hand through NEX_PUBLIC_ADDRESS. This works it out.
//
// What this does NOT do is make an unreachable node reachable. It reports a
// fact; it does not change one. Nodes behind a symmetric NAT will learn an
// address that stops working the moment they talk to anyone else, which is
// exactly why the result is labelled with the NAT behaviour observed.

const MAGIC_COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const ATTR_MAPPED_ADDRESS = 0x0001
const ATTR_XOR_MAPPED_ADDRESS = 0x0020
const HEADER_BYTES = 20

/** Public servers that answer binding requests. Tried in order. */
export const DEFAULT_STUN_SERVERS: ReadonlyArray<{ host: string; port: number }> = [
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun1.l.google.com", port: 19302 },
  { host: "stun.cloudflare.com", port: 3478 },
]

export interface StunResult {
  /** Public address as seen from outside. */
  host: string
  port: number
  /** The local port the request went out from, for comparison. */
  localPort: number
  server: string
}

/**
 * Bun's UDP send takes an address literal, not a hostname — passing one throws
 * ERR_INVALID_ARG_TYPE. Resolve first.
 */
async function resolveV4(host: string): Promise<string | null> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
  try {
    const { lookup } = await import("node:dns/promises")
    const r = await lookup(host, { family: 4 })
    return r.address
  } catch {
    return null
  }
}

function buildRequest(): { packet: Uint8Array; txId: Uint8Array } {
  const packet = new Uint8Array(HEADER_BYTES)
  const view = new DataView(packet.buffer)
  view.setUint16(0, BINDING_REQUEST)
  view.setUint16(2, 0) // no attributes
  view.setUint32(4, MAGIC_COOKIE)
  const txId = new Uint8Array(12)
  crypto.getRandomValues(txId)
  packet.set(txId, 8)
  return { packet, txId }
}

function sameTx(packet: Uint8Array, txId: Uint8Array): boolean {
  for (let i = 0; i < 12; i++) if (packet[8 + i] !== txId[i]) return false
  return true
}

/**
 * Pull the mapped address out of a binding response.
 *
 * XOR-MAPPED-ADDRESS exists because some NATs rewrite anything that looks like
 * an IP address inside a packet body, corrupting the very answer being sent.
 * XORing it against the magic cookie hides it from that meddling.
 */
function parseResponse(packet: Uint8Array, txId: Uint8Array): { host: string; port: number } | null {
  if (packet.length < HEADER_BYTES) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  if (view.getUint16(0) !== BINDING_SUCCESS) return null
  if (view.getUint32(4) !== MAGIC_COOKIE) return null
  if (!sameTx(packet, txId)) return null

  const length = view.getUint16(2)
  let off = HEADER_BYTES
  const end = Math.min(packet.length, HEADER_BYTES + length)

  while (off + 4 <= end) {
    const type = view.getUint16(off)
    const len = view.getUint16(off + 2)
    const valueAt = off + 4
    if (valueAt + len > end) return null

    if (type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) {
      const family = view.getUint8(valueAt + 1)
      // IPv4 only. IPv6 mapping exists but a v6 host is directly reachable and
      // does not need this.
      if (family !== 0x01) return null
      const xor = type === ATTR_XOR_MAPPED_ADDRESS
      const rawPort = view.getUint16(valueAt + 2)
      const port = xor ? rawPort ^ (MAGIC_COOKIE >>> 16) : rawPort
      const octets: number[] = []
      for (let i = 0; i < 4; i++) {
        const b = view.getUint8(valueAt + 4 + i)
        // The cookie is big-endian; byte i is masked by the matching byte of it.
        octets.push(xor ? b ^ ((MAGIC_COOKIE >>> (24 - i * 8)) & 0xff) : b)
      }
      return { host: octets.join("."), port }
    }
    // Attributes are padded to a 4-byte boundary.
    off = valueAt + len + ((4 - (len % 4)) % 4)
  }
  return null
}

/** Ask one server. Resolves null on timeout rather than throwing. */
export async function stunQuery(
  server: { host: string; port: number },
  timeoutMs = 2500,
): Promise<StunResult | null> {
  const { packet, txId } = buildRequest()

  return new Promise<StunResult | null>((resolve) => {
    let settled = false
    let socket: { close(): void; send(d: Uint8Array, p: number, h: string): unknown } | null = null

    const finish = (value: StunResult | null) => {
      if (settled) return
      settled = true
      try {
        socket?.close()
      } catch {
        // already closed
      }
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    void resolveV4(server.host)
      .then(async (ip) => {
        if (!ip) {
          clearTimeout(timer)
          finish(null)
          return
        }
        return Bun.udpSocket({
      hostname: "0.0.0.0",
      port: 0,
          socket: {
            data: (_s: unknown, data: Uint8Array) => {
              const mapped = parseResponse(data, txId)
              if (!mapped) return
              clearTimeout(timer)
              finish({
                host: mapped.host,
                port: mapped.port,
                localPort: (socket as unknown as { port: number })?.port ?? 0,
                server: `${server.host}:${server.port}`,
              })
            },
          },
        }).then((s) => {
          socket = s as unknown as typeof socket
          s.send(packet, server.port, ip)
        })
      })
      .catch(() => {
        clearTimeout(timer)
        finish(null)
      })
  })
}

/** Try servers in order and return the first answer. */
export async function discoverPublicAddress(
  servers: ReadonlyArray<{ host: string; port: number }> = DEFAULT_STUN_SERVERS,
  timeoutMs = 2500,
): Promise<StunResult | null> {
  for (const server of servers) {
    const result = await stunQuery(server, timeoutMs)
    if (result) return result
  }
  return null
}

/**
 * What the NAT does to a single local port, which decides whether hole punching
 * can work at all.
 *
 * The test is to ask two different servers from the SAME socket. A cone NAT
 * maps a local port to one public port regardless of who you are talking to, so
 * a punched hole stays usable. A symmetric NAT picks a fresh public port per
 * destination, so the address a peer was told is stale the moment you contact
 * anyone else — no amount of punching fixes that, and such a pair needs a relay.
 */
export type NatBehaviour = "cone" | "symmetric" | "unknown"

export interface NatReport {
  behaviour: NatBehaviour
  /** Public address, when one could be determined. */
  address: { host: string; port: number } | null
  /** Plain-language reason, suitable to show a user. */
  detail: string
}

/**
 * Ask several servers from ONE socket and compare the mappings.
 *
 * Using a fresh socket per server proves nothing: different local ports get
 * different mappings on every NAT, cone or not. The whole test is holding the
 * local port constant and varying the destination.
 */
export async function detectNat(
  servers: ReadonlyArray<{ host: string; port: number }> = DEFAULT_STUN_SERVERS,
  timeoutMs = 2500,
): Promise<NatReport> {
  const { packet, txId } = buildRequest()
  const seen: Array<{ host: string; port: number }> = []

  const targets: Array<{ host: string; port: number; ip: string }> = []
  for (const s of servers.slice(0, 3)) {
    const ip = await resolveV4(s.host)
    if (ip) targets.push({ ...s, ip })
  }
  if (targets.length === 0) {
    return { behaviour: "unknown", address: null, detail: "No STUN server could be resolved." }
  }

  let socket: { close(): void; send(d: Uint8Array, p: number, h: string): unknown } | null = null
  try {
    socket = (await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: 0,
      socket: {
        data: (_s: unknown, data: Uint8Array) => {
          const mapped = parseResponse(data, txId)
          if (mapped) seen.push(mapped)
        },
      },
    })) as unknown as typeof socket
  } catch {
    return { behaviour: "unknown", address: null, detail: "Could not open a UDP socket." }
  }

  for (const t of targets) {
    try {
      socket!.send(packet, t.port, t.ip)
    } catch {
      // try the next server
    }
    await Bun.sleep(Math.min(timeoutMs, 1200))
  }
  try {
    socket!.close()
  } catch {
    // already closed
  }

  if (seen.length === 0) {
    return {
      behaviour: "unknown",
      address: null,
      detail: "No STUN server answered. The network may block UDP.",
    }
  }

  const address = seen[0]!
  if (seen.length === 1) {
    return {
      behaviour: "unknown",
      address,
      detail: "Only one server answered, so the mapping could not be compared.",
    }
  }

  const ports = new Set(seen.map((s) => s.port))
  const hosts = new Set(seen.map((s) => s.host))

  if (hosts.size > 1) {
    return {
      behaviour: "symmetric",
      address,
      detail: "Different servers saw different public addresses. A direct connection is unlikely.",
    }
  }
  if (ports.size === 1) {
    return {
      behaviour: "cone",
      address,
      detail: "Your router keeps one public port per local port, so a direct connection can be arranged.",
    }
  }
  return {
    behaviour: "symmetric",
    address,
    detail:
      "Your router assigns a new public port for every destination, so an address shared with a peer " +
      "stops working before they can use it. This connection needs a relay.",
  }
}
