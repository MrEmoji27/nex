// How a punchable peer is written down.
//
// A TCP peer is one address, so a string like "192.168.1.9:42001" says
// everything. A UDP peer is not: it is a LIST of candidates, because which of a
// peer's addresses works is not knowable in advance, and it is a nodeId,
// because a candidate list without one would connect to whoever answers — which
// is exactly what the identity check exists to prevent.
//
//   nex-udp://<NODEID>@host:port[,host:port]*
//
// This lives in core rather than in the transport so the application can pass
// one around like any other address without importing a transport module.

export const UDP_SCHEME = "nex-udp://"

export interface UdpAddress {
  nodeId: string
  candidates: Array<{ host: string; port: number }>
}

/** Parse one, or null when the string is not a UDP address at all. */
export function parseUdpAddress(address: string): UdpAddress | null {
  if (!address.startsWith(UDP_SCHEME)) return null
  const rest = address.slice(UDP_SCHEME.length)
  const at = rest.indexOf("@")
  if (at <= 0) return null
  const nodeId = rest.slice(0, at).toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(nodeId)) return null
  const candidates: Array<{ host: string; port: number }> = []
  for (const part of rest.slice(at + 1).split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const idx = trimmed.lastIndexOf(":")
    if (idx <= 0) continue
    const host = trimmed.startsWith("[") ? trimmed.slice(1, trimmed.indexOf("]")) : trimmed.slice(0, idx)
    const port = Number(trimmed.slice(idx + 1))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue
    candidates.push({ host, port })
  }
  return candidates.length > 0 ? { nodeId, candidates } : null
}

/** The inverse. */
export function formatUdpAddress(
  nodeId: string,
  candidates: ReadonlyArray<{ host: string; port: number }>,
): string {
  const list = candidates.map((c) => (c.host.includes(":") ? `[${c.host}]:${c.port}` : `${c.host}:${c.port}`))
  return `${UDP_SCHEME}${nodeId.toUpperCase()}@${list.join(",")}`
}
