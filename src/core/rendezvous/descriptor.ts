// Handles and signed descriptors — wire contract §2 and §3.
//
// The split between the two descriptor types is the whole reason V3 §11 ("do not
// expose connection details before the recipient has responded") is enforceable
// rather than aspirational: a search result physically cannot carry an address,
// because the object returned by search has no field for one.
import { DOMAIN, SigningInput, sign, verify, type RendezvousSigningKey } from "./framing"

/** A way to reach a node. v1 speaks only direct TCP; unknown kinds are ignored, not rejected. */
export interface TransportCandidate {
  kind: string
  host: string
  port: number
}

/** What search returns: enough to decide whether to ask, never enough to dial. */
export interface PublicDescriptor {
  v: 1
  handle: string
  nodeId: string
  signPub: string
  capabilities: string[]
  connectable: boolean
  issuedAt: number
  expiresAt: number
  sig: string
}

/** Released only after the recipient accepts an introduction. Carries addresses. */
export interface ContactDescriptor {
  v: 1
  handle: string
  nodeId: string
  signPub: string
  noisePub: string
  capabilities: string[]
  candidates: TransportCandidate[]
  issuedAt: number
  expiresAt: number
  sig: string
}

export const MAX_CANDIDATES = 6
export const MAX_CAPABILITIES = 12
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/
const CAPABILITY_RE = /^[a-z0-9-]{1,32}$/

/**
 * Normalize a handle, or return null when it is not a legal one.
 *
 * Deliberately returns null instead of repairing: a handle the service quietly
 * rewrote is a handle the user did not choose, and silently mapping two distinct
 * inputs onto one namespace entry is how impersonation gets in.
 */
export function normalizeHandle(raw: string): string | null {
  // ASCII whitespace only, per contract §2 step 1. JS .trim() also strips
  // Unicode whitespace (U+00A0, U+2028, ...), which the Go service does not,
  // so " roshan" normalized here but was rejected there. A handle one
  // implementation accepts and the other refuses is exactly the class of
  // silent divergence the shared conformance vectors exist to prevent.
  const trimmed = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "")
  const normalized = trimmed.normalize("NFKC").toLowerCase()
  return HANDLE_RE.test(normalized) ? normalized : null
}

function validCandidate(c: TransportCandidate): boolean {
  return (
    typeof c?.kind === "string" &&
    c.kind.length > 0 &&
    c.kind.length <= 32 &&
    typeof c.host === "string" &&
    c.host.length > 0 &&
    new TextEncoder().encode(c.host).length <= 255 &&
    Number.isInteger(c.port) &&
    c.port >= 1 &&
    c.port <= 65535
  )
}

function validCapabilities(caps: readonly string[]): boolean {
  return (
    Array.isArray(caps) && caps.length <= MAX_CAPABILITIES && caps.every((c) => CAPABILITY_RE.test(c))
  )
}

function publicInput(d: Omit<PublicDescriptor, "sig">): SigningInput {
  return new SigningInput(DOMAIN.publicDescriptor)
    .str(String(d.v))
    .str(d.handle)
    .str(d.nodeId)
    .str(d.signPub)
    .arr(d.capabilities)
    .int(d.issuedAt)
    .int(d.expiresAt)
    .bool(d.connectable)
}

function contactInput(d: Omit<ContactDescriptor, "sig">): SigningInput {
  return new SigningInput(DOMAIN.contactDescriptor)
    .str(String(d.v))
    .str(d.handle)
    .str(d.nodeId)
    .str(d.signPub)
    .str(d.noisePub)
    .arr(d.capabilities)
    .candidates(d.candidates)
    .int(d.issuedAt)
    .int(d.expiresAt)
}

export function signPublicDescriptor(
  d: Omit<PublicDescriptor, "sig">,
  key: RendezvousSigningKey,
): PublicDescriptor {
  return { ...d, sig: sign(publicInput(d), key) }
}

export function signContactDescriptor(
  d: Omit<ContactDescriptor, "sig">,
  key: RendezvousSigningKey,
): ContactDescriptor {
  return { ...d, sig: sign(contactInput(d), key) }
}

/**
 * Structural + signature validation of a descriptor received from the service.
 *
 * A valid signature here proves only that the record was not forged or mutated
 * in transit. It does NOT prove that signPub belongs to nodeId — nothing in this
 * protocol does (wire contract §6). That binding is established later, by the
 * Noise handshake, when the dialing peer pins nodeId.
 */
export function verifyPublicDescriptor(d: PublicDescriptor, now = Date.now()): boolean {
  if (!d || d.v !== 1) return false
  if (normalizeHandle(d.handle) !== d.handle) return false
  if (!/^[0-9A-F]{64}$/.test(d.nodeId)) return false
  if (typeof d.connectable !== "boolean") return false
  if (!validCapabilities(d.capabilities)) return false
  if (!Number.isInteger(d.issuedAt) || !Number.isInteger(d.expiresAt)) return false
  if (d.expiresAt <= now) return false
  return verify(publicInput(d), d.sig, d.signPub)
}

export function verifyContactDescriptor(d: ContactDescriptor, now = Date.now()): boolean {
  if (!d || d.v !== 1) return false
  if (normalizeHandle(d.handle) !== d.handle) return false
  if (!/^[0-9A-F]{64}$/.test(d.nodeId)) return false
  if (!/^[0-9a-f]{64}$/.test(d.noisePub)) return false
  if (!validCapabilities(d.capabilities)) return false
  if (!Array.isArray(d.candidates) || d.candidates.length > MAX_CANDIDATES) return false
  if (!d.candidates.every(validCandidate)) return false
  if (!Number.isInteger(d.issuedAt) || !Number.isInteger(d.expiresAt)) return false
  if (d.expiresAt <= now) return false
  return verify(contactInput(d), d.sig, d.signPub)
}

/** Dialable "host:port" strings, in candidate order. Unknown kinds are skipped. */
export function dialAddresses(d: ContactDescriptor): string[] {
  return d.candidates
    .filter((c) => c.kind === "direct-tcp")
    .map((c) => (c.host.includes(":") ? `[${c.host}]:${c.port}` : `${c.host}:${c.port}`))
}

/**
 * Punchable candidates, in published order.
 *
 * The wire contract leaves candidate kinds open and says unknown ones are
 * ignored rather than rejected, which is what lets a v1 service carry these
 * unchanged — to the service they are opaque strings inside a sealed blob it
 * cannot read anyway.
 */
export function udpCandidates(d: ContactDescriptor): Array<{ host: string; port: number }> {
  return d.candidates.filter((c) => c.kind === "udp").map((c) => ({ host: c.host, port: c.port }))
}
