// Serverless discovery — pure helpers + the LAN beacon engine.
//
// Three layers (alpha.7):
//   LAN    — UDP beacons: announce self, hear neighbors, age them out.
//   invite — nex:// codes; fingerprint baked in so first dial arrives pre-pinned.
//   intro  — a connected peer vouches for a third by relaying their beacon.
//
// The engine here is transport-agnostic over a tiny UdpPort interface so tests
// inject sockets; app.ts wires real Bun.udpSocket(). No server anywhere.
import type { DiscoveredPeer, DiscoveryBeacon } from "./contract"

/** Beacon multicast/broadcast port. Same on every node. */
export const DISCOVERY_PORT = 42110
export const BEACON_INTERVAL_MS = 4_000
/** A neighbor we haven't heard from in this long drops off the discovered list. */
export const DISCOVERY_TTL_MS = 15_000

/** Minimal UDP surface used by DiscoveryEngine (real: Bun.udpSocket). */
export interface UdpPort {
  send(data: Uint8Array, address: string, port: number): Promise<number> | number
  /** Subscribe to datagrams (payload, host, port). */
  onMessage(cb: (data: Uint8Array, host: string, port: number) => void): void
  close(): Promise<void> | void
}

/** Build one outbound beacon payload for this node. */
export function makeBeacon(self: { nodeId: string; name: string; port: number }, fp: string): string {
  const beacon: DiscoveryBeacon = { v: 1, nodeId: self.nodeId, name: self.name, port: self.port, fp, ts: Date.now() }
  return JSON.stringify(beacon)
}

/** Parse an inbound datagram into a beacon; null when not ours/malformed. */
export function parseBeacon(data: Uint8Array): DiscoveryBeacon | null {
  try {
    const text = new TextDecoder().decode(data)
    const raw = JSON.parse(text) as DiscoveryBeacon
    if (!raw || raw.v !== 1) return null
    if (typeof raw.nodeId !== "string" || raw.nodeId.length < 8) return null
    if (typeof raw.name !== "string" || !raw.name.trim()) return null
    if (!Number.isFinite(raw.port) || raw.port <= 0 || raw.port > 65535) return null
    if (typeof raw.fp !== "string" || raw.fp.length < 8) return null
    return { v: 1, nodeId: raw.nodeId, name: raw.name.slice(0, 32), port: raw.port, fp: raw.fp, ts: Date.now() }
  } catch {
    return null
  }
}

/** nex:// invite codec — the shareable "phone number" with built-in ID check. */
export interface InviteParts {
  name: string
  host: string
  port: number
  fp?: string
}

export function encodeInvite(p: InviteParts): string {
  const fpPart = p.fp ? `/fp=${p.fp}` : ""
  const namePart = p.name ? `${encodeURIComponent(p.name)}@` : ""
  // IPv6 literals need brackets; hosts from our flows are ipv4/hostnames today.
  return `nex://${namePart}${p.host}:${p.port}${fpPart}`
}

export function decodeInvite(code: string): InviteParts | null {
  const trimmed = code.trim()
  // Anchored at BOTH ends on purpose. Without the trailing $, a malformed code
  // parsed "successfully" while silently dropping whatever could not be read —
  // and the piece most likely to fall off the end is /fp=, the fingerprint the
  // entire pinning story rests on. A code we cannot read in full is refused.
  const m = /^nex:\/\/(?:([^@]+)@)?\[?([^\]\/:]+)\]?:(\d+)(?:\/fp=([A-Fa-f0-9]+))?$/.exec(trimmed)
  if (!m) return null
  const [, nameRaw, host, portRaw, fp] = m
  const port = Number(portRaw)
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null
  let name = ""
  try {
    name = decodeURIComponent(nameRaw ?? "")
  } catch {
    name = nameRaw ?? ""
  }
  return { name, host, port, fp: fp?.toUpperCase() }
}

/**
 * Pure discovery bookkeeping: merge one inbound beacon into the seen-map and
 * decide what changed. Kept separate from I/O so it is unit-testable.
 * Returns the new/refreshed entry, plus who aged out (callers emit events).
 */
export class SeenRegistry {
  private readonly seen = new Map<string, { peer: DiscoveredPeer; expiresAt: number }>()

  observe(entry: Omit<DiscoveredPeer, "seenAt">, now = Date.now()): { added: boolean; peer: DiscoveredPeer } {
    const existing = this.seen.get(entry.peerId)
    const peer: DiscoveredPeer = existing
      ? { ...existing.peer, ...entry, seenAt: now }
      : { ...entry, seenAt: now }
    this.seen.set(entry.peerId, { peer, expiresAt: now + DISCOVERY_TTL_MS })
    return { added: !existing, peer }
  }

  /** Remove + return every entry whose TTL lapsed at `now`. */
  sweepExpired(now = Date.now()): DiscoveredPeer[] {
    const gone: DiscoveredPeer[] = []
    for (const [peerId, item] of [...this.seen]) {
      if (item.expiresAt <= now) {
        this.seen.delete(peerId)
        gone.push(item.peer)
      }
    }
    return gone
  }

  list(): DiscoveredPeer[] {
    return [...this.seen.values()].map((s) => ({ ...s.peer })).sort((a, b) => b.seenAt - a.seenAt)
  }

  get(peerId: string): DiscoveredPeer | null {
    const hit = this.seen.get(peerId)
    return hit ? { ...hit.peer } : null
  }
}
