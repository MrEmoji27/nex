// RendezvousClient behaviour, with the network faked at both ends.
//
// No test here touches a real socket or a real service. The point is to pin the
// behaviours the wire contract makes load-bearing:
//
//   - CONNECTED and CONNECTABLE are independent facts (contract §7, V3 §7)
//   - the service is untrusted, so everything it returns is re-verified (§6)
//   - a lapsed lease is routine and recoverable, not an error (§9)
//   - stop() must not depend on reaching the service (V3 §6)
import { describe, expect, test } from "bun:test"
import {
  RendezvousClient,
  RendezvousError,
  type ControlSocket,
  type RendezvousClientOptions,
} from "../src/core/rendezvous/client"
import { deriveSigningKey } from "../src/core/rendezvous/framing"
import { seal } from "../src/core/rendezvous/seal"
import {
  signContactDescriptor,
  signPublicDescriptor,
  type ContactDescriptor,
  type PublicDescriptor,
} from "../src/core/rendezvous/descriptor"

const SELF_SEED = "aa".repeat(32)
const PEER_SEED = "bb".repeat(32)
const SELF_NODE = "A".repeat(64)
const PEER_NODE = "B".repeat(64)
const NOISE_PUB = "cc".repeat(32)

/** Our own signing key — frames arriving for us are sealed to this. */
const SELF_SIGN_PUB = deriveSigningKey(SELF_SEED).signPub

/** Seal a descriptor to us, the way a peer's client would before sending. */
function sealedTo(self: unknown): string {
  return seal(JSON.stringify(self), SELF_SIGN_PUB)
}

/** A fake WebSocket the test drives directly. */
class FakeSocket implements ControlSocket {
  sent: string[] = []
  closedWith: number | undefined
  private openCb: (() => void) | undefined
  private msgCb: ((d: string) => void) | undefined
  private closeCb: (() => void) | undefined

  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.closedWith = code
    this.closeCb?.()
  }
  onOpen(cb: () => void): void {
    this.openCb = cb
  }
  onMessage(cb: (d: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }
  onError(): void {}

  /** Drive the socket from the test's point of view. */
  open(): void {
    this.openCb?.()
  }
  deliver(frame: unknown): void {
    this.msgCb?.(JSON.stringify(frame))
  }
  deliverRaw(text: string): void {
    this.msgCb?.(text)
  }
  drop(): void {
    this.closeCb?.()
  }
}

interface Recorded {
  path: string
  method: string
  body: Record<string, unknown> | null
  headers: Record<string, string>
}

/** Fake fetch with a per-path script. Records every call for assertions. */
function fakeFetch(routes: Record<string, () => { status: number; body: unknown }>) {
  const calls: Recorded[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url)
    const path = full.slice(full.indexOf("/v1"))
    const key = path.split("?")[0] ?? path
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const route = routes[key]
    if (!route) return new Response("{}", { status: 404 })
    const { status, body } = route()
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function leaseOk(now: number) {
  return { status: 200, body: { leaseId: "lease-1", handle: "zro", expiresAt: now + 90_000, refreshAfterMs: 30_000 } }
}

/** Build descriptors as a REMOTE peer would sign them, for verification tests. */
function peerDescriptors(now: number): { pub: PublicDescriptor; contact: ContactDescriptor } {
  const key = deriveSigningKey(PEER_SEED)
  const common = {
    v: 1 as const,
    handle: "roshan",
    nodeId: PEER_NODE,
    signPub: key.signPub,
    capabilities: ["chat"],
    issuedAt: now,
    expiresAt: now + 90_000,
  }
  return {
    pub: signPublicDescriptor({ ...common, connectable: true }, key),
    contact: signContactDescriptor(
      { ...common, noisePub: NOISE_PUB, candidates: [{ kind: "direct-tcp", host: "203.0.113.9", port: 42001 }] },
      key,
    ),
  }
}

function makeClient(
  routes: Record<string, () => { status: number; body: unknown }>,
  opts: {
    events?: RendezvousClientOptions["events"]
    socket?: FakeSocket
    now?: () => number
    candidates?: Array<{ kind: string; host: string; port: number }>
  } = {},
) {
  const { impl, calls } = fakeFetch(routes)
  const client = new RendezvousClient({
    baseUrl: "http://rv.test",
    identity: { nodeId: SELF_NODE, seedHex: SELF_SEED, noisePub: NOISE_PUB },
    handle: "zro",
    capabilities: ["chat"],
    candidates: opts.candidates ?? [{ kind: "direct-tcp", host: "198.51.100.4", port: 42001 }],
    events: opts.events ?? {},
    fetchImpl: impl,
    now: opts.now,
    openSocket: opts.socket ? () => opts.socket as ControlSocket : undefined,
  })
  return { client, calls }
}

describe("presence lease", () => {
  test("register publishes both descriptors and stores the lease", async () => {
    const now = 1_000_000
    const { client, calls } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now },
    )
    await client.start()

    const register = calls.find((c) => c.path === "/v1/presence/register")
    expect(register?.method).toBe("POST")
    expect(register?.body?.publicDescriptor).toBeDefined()
    expect(register?.body?.contactDescriptor).toBeDefined()
    expect(client.state().connectable).toBe(true)
    expect(client.state().handle).toBe("zro")
    await client.stop()
  })

  test("the public descriptor carries no address, the contact one does", async () => {
    const now = 1_000_000
    const { client, calls } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now },
    )
    await client.start()

    const body = calls[0]?.body as { publicDescriptor: PublicDescriptor; contactDescriptor: ContactDescriptor }
    // This is the structural form of V3 §11: search results have nowhere to put
    // an address, so one cannot leak before the recipient has accepted.
    expect(Object.keys(body.publicDescriptor)).not.toContain("candidates")
    expect(body.contactDescriptor.candidates[0]?.host).toBe("198.51.100.4")
    await client.stop()
  })

  test("a node with no reachable candidate publishes connectable:false", async () => {
    const now = 1_000_000
    const { client, calls } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, candidates: [] },
    )
    await client.start()

    const body = calls[0]?.body as { publicDescriptor: PublicDescriptor }
    // Honest rather than optimistic: with no candidate there is no path to dial,
    // so advertising availability would be inventing presence.
    expect(body.publicDescriptor.connectable).toBe(false)
    await client.stop()
  })

  test("stop() unregisters and clears published state", async () => {
    const now = 1_000_000
    const { client, calls } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/presence": () => ({ status: 204, body: null }) },
      { now: () => now },
    )
    await client.start()
    await client.stop()

    expect(calls.some((c) => c.path === "/v1/presence" && c.method === "DELETE")).toBe(true)
    expect(client.state().connectable).toBe(false)
    expect(client.state().handle).toBe(null)
  })

  test("stop() succeeds even when the service is unreachable", async () => {
    const now = 1_000_000
    const { client } = makeClient(
      {
        "/v1/presence/register": () => leaseOk(now),
        "/v1/presence": () => {
          throw new Error("network down")
        },
      },
      { now: () => now },
    )
    await client.start()

    // V3 §6: the lease lapses on its own, so a clean logout is a courtesy and
    // never a requirement. Failing to reach the service must not throw here.
    await client.stop()
    expect(client.state().connectable).toBe(false)
  })

  test("a failed register leaves the node not connectable and reports the error", async () => {
    const errors: string[] = []
    const { client } = makeClient(
      {
        "/v1/presence/register": () => ({
          status: 409,
          body: { error: { code: "handle_taken", message: "handle in use" } },
        }),
      },
      { events: { error: (m) => errors.push(m) } },
    )
    await client.start()

    expect(client.state().connectable).toBe(false)
    expect(errors.join(" ")).toContain("handle in use")
    await client.stop()
  })
})

describe("CONNECTED vs CONNECTABLE", () => {
  test("a lease without a control channel is connectable but not connected", async () => {
    const now = 1_000_000
    const { client } = makeClient({ "/v1/presence/register": () => leaseOk(now) }, { now: () => now })
    await client.start()

    expect(client.state().connectable).toBe(true)
    expect(client.state().connected).toBe(false)
    await client.stop()
  })

  test("an attached control channel reports connected", async () => {
    const now = 1_000_000
    const socket = new FakeSocket()
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket },
    )
    await client.start()
    socket.open()

    expect(client.state().connected).toBe(true)
    expect(client.state().connectable).toBe(true)
    await client.stop()
  })

  test("losing the control channel does NOT make the node undiscoverable", async () => {
    const now = 1_000_000
    const socket = new FakeSocket()
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket },
    )
    await client.start()
    socket.open()
    socket.drop()

    // The distinction the contract insists on: presence is the lease, liveness
    // is the socket. Collapsing these would drop a reachable node off the map
    // every time a connection blipped.
    expect(client.state().connected).toBe(false)
    expect(client.state().connectable).toBe(true)
    await client.stop()
  })

  test("an expired lease is not connectable even while the socket is up", async () => {
    let now = 1_000_000
    const socket = new FakeSocket()
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket },
    )
    await client.start()
    socket.open()
    now += 200_000 // past expiry

    expect(client.state().connected).toBe(true)
    expect(client.state().connectable).toBe(false)
    await client.stop()
  })
})

describe("search", () => {
  const now = 1_000_000

  test("a hit is returned once its signature verifies", async () => {
    const { pub } = peerDescriptors(now)
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/discovery/search": () => ({ status: 200, body: { result: pub } }) },
      { now: () => now },
    )
    await client.start()

    const found = await client.search("roshan")
    expect(found?.nodeId).toBe(PEER_NODE)
    await client.stop()
  })

  test("a miss returns null rather than throwing", async () => {
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/discovery/search": () => ({ status: 200, body: { result: null } }) },
      { now: () => now },
    )
    await client.start()

    expect(await client.search("nobody")).toBe(null)
    await client.stop()
  })

  test("the _pad member is ignored on both hit and miss (contract §5.4)", async () => {
    // Every search response is padded to a fixed size so response LENGTH is not
    // an existence oracle. _pad is filler, is not signed, and a client that
    // reads it is reading noise — so the client must simply ignore it.
    const { pub } = peerDescriptors(now)
    const filler = "A".repeat(600)
    const { client } = makeClient(
      {
        "/v1/presence/register": () => leaseOk(now),
        "/v1/discovery/search": () => ({ status: 200, body: { result: pub, _pad: filler } }),
      },
      { now: () => now },
    )
    await client.start()
    expect((await client.search("roshan"))?.nodeId).toBe(PEER_NODE)
    await client.stop()

    const missing = makeClient(
      {
        "/v1/presence/register": () => leaseOk(now),
        "/v1/discovery/search": () => ({ status: 200, body: { result: null, _pad: filler } }),
      },
      { now: () => now },
    )
    await missing.client.start()
    expect(await missing.client.search("nobody")).toBe(null)
    await missing.client.stop()
  })

  test("search authenticates via headers, since GET has no body", async () => {
    const { pub } = peerDescriptors(now)
    const { client, calls } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/discovery/search": () => ({ status: 200, body: { result: pub } }) },
      { now: () => now },
    )
    await client.start()
    await client.search("roshan")

    const search = calls.find((c) => c.path.startsWith("/v1/discovery/search"))
    expect(search?.headers["X-Nex-Sig"]).toMatch(/^[0-9a-f]{128}$/)
    expect(search?.headers["X-Nex-Node"]).toBe(SELF_NODE)
    await client.stop()
  })

  test("a tampered descriptor is rejected, not shown to the user", async () => {
    const { pub } = peerDescriptors(now)
    const forged = { ...pub, nodeId: "F".repeat(64) } // service swapped the identity
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/discovery/search": () => ({ status: 200, body: { result: forged } }) },
      { now: () => now },
    )
    await client.start()

    // The service is untrusted (§6). A record it could not have produced
    // honestly must never reach the user as a person they can contact.
    await expect(client.search("roshan")).rejects.toThrow(/signature/i)
    await client.stop()
  })

  test("a result for a different handle than we asked for is rejected", async () => {
    const { pub } = peerDescriptors(now)
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/discovery/search": () => ({ status: 200, body: { result: pub } }) },
      { now: () => now },
    )
    await client.start()

    // Correctly signed, but an answer to a question we did not ask.
    await expect(client.search("someone-else")).rejects.toThrow(/asked for/i)
    await client.stop()
  })

  test("an expired descriptor is rejected", async () => {
    const { pub } = peerDescriptors(now)
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now), "/v1/discovery/search": () => ({ status: 200, body: { result: pub } }) },
      { now: () => now + 500_000 },
    )
    await client.start()
    await expect(client.search("roshan")).rejects.toThrow()
    await client.stop()
  })
})

describe("introductions over the control channel", () => {
  const now = 1_000_000

  test("a valid request reaches the user for a decision", async () => {
    const socket = new FakeSocket()
    const seen: Array<{ fromHandle: string }> = []
    const { contact } = peerDescriptors(now)
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket, events: { introductionRequest: (r) => seen.push(r) } },
    )
    await client.start()
    socket.open()
    socket.deliver({
      type: "introduction.request",
      requestId: "req-1",
      fromHandle: "roshan",
      fromSignPub: deriveSigningKey(PEER_SEED).signPub,
      sealedContact: sealedTo(contact),
      expiresAt: now + 120_000,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.fromHandle).toBe("roshan")
    await client.stop()
  })

  test("a request whose descriptor fails verification is dropped", async () => {
    const socket = new FakeSocket()
    const seen: unknown[] = []
    const errors: string[] = []
    const { contact } = peerDescriptors(now)
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      {
        now: () => now,
        socket,
        events: { introductionRequest: (r) => seen.push(r), error: (m) => errors.push(m) },
      },
    )
    await client.start()
    socket.open()
    socket.deliver({
      type: "introduction.request",
      requestId: "req-1",
      fromHandle: "roshan",
      fromSignPub: deriveSigningKey(PEER_SEED).signPub,
      sealedContact: sealedTo({ ...contact, candidates: [{ kind: "direct-tcp", host: "evil.test", port: 9 }] }),
      expiresAt: now + 120_000,
    })

    // Validate before showing a human a name — the lesson the invite path
    // learned the hard way.
    expect(seen).toHaveLength(0)
    expect(errors.join(" ")).toContain("invalid descriptor")
    await client.stop()
  })

  test("a request whose handle disagrees with its descriptor is dropped", async () => {
    const socket = new FakeSocket()
    const seen: unknown[] = []
    const { contact } = peerDescriptors(now)
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket, events: { introductionRequest: (r) => seen.push(r) } },
    )
    await client.start()
    socket.open()
    socket.deliver({
      type: "introduction.request",
      requestId: "req-1",
      fromHandle: "someone-else",
      fromSignPub: deriveSigningKey(PEER_SEED).signPub,
      sealedContact: sealedTo(contact),
      expiresAt: now + 120_000,
    })

    expect(seen).toHaveLength(0)
    await client.stop()
  })

  test("an acceptance without a descriptor is dropped", async () => {
    const socket = new FakeSocket()
    const seen: unknown[] = []
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket, events: { introductionResponse: (r) => seen.push(r) } },
    )
    await client.start()
    socket.open()
    socket.deliver({ type: "introduction.response", requestId: "req-1", accept: true })

    // "Accepted" with nothing to dial is either a broken service or an attempt
    // to make us act on nothing.
    expect(seen).toHaveLength(0)
    await client.stop()
  })

  test("a rejection is delivered and carries no descriptor", async () => {
    const socket = new FakeSocket()
    const seen: Array<{ accept: boolean; contactDescriptor?: unknown }> = []
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket, events: { introductionResponse: (r) => seen.push(r) } },
    )
    await client.start()
    socket.open()
    socket.deliver({ type: "introduction.response", requestId: "req-1", accept: false })

    expect(seen[0]?.accept).toBe(false)
    expect(seen[0]?.contactDescriptor).toBeUndefined()
    await client.stop()
  })

  test("malformed and unknown frames are ignored without throwing", async () => {
    const socket = new FakeSocket()
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket },
    )
    await client.start()
    socket.open()

    expect(() => socket.deliverRaw("{not json")).not.toThrow()
    expect(() => socket.deliver({ type: "something.new" })).not.toThrow()
    expect(() => socket.deliver({ nope: true })).not.toThrow()
    await client.stop()
  })

  test("the client only ever sends ping frames", async () => {
    const socket = new FakeSocket()
    const { client } = makeClient(
      { "/v1/presence/register": () => leaseOk(now) },
      { now: () => now, socket },
    )
    await client.start()
    socket.open()

    // Structural guarantee that rendezvous cannot become a message transport:
    // there is no client frame type that carries content.
    for (const frame of socket.sent) {
      expect(JSON.parse(frame).type).toBe("ping")
    }
    await client.stop()
  })
})

describe("outbound operations", () => {
  const now = 1_000_000

  test("an introduction request ships our address sealed, never in the clear", async () => {
    const { pub } = peerDescriptors(now)
    const { client, calls } = makeClient(
      {
        "/v1/presence/register": () => leaseOk(now),
        // The request now searches first: the address is sealed to the target,
        // so their key has to be fetched and re-verified before sending.
        "/v1/discovery/search": () => ({ status: 200, body: { result: pub } }),
        "/v1/introduction/request": () => ({ status: 202, body: { requestId: "req-1", expiresAt: now + 120_000 } }),
      },
      { now: () => now },
    )
    await client.start()
    await client.requestIntroduction("roshan")

    const req = calls.find((c) => c.path === "/v1/introduction/request")
    // To ask for an introduction is still to offer your own address — but the
    // service relays it without being able to read it.
    expect(req?.body?.sealedContact).toBeDefined()
    expect(req?.body?.fromContactDescriptor).toBeUndefined()
    expect(req?.body?.fromSignPub).toBe(deriveSigningKey(SELF_SEED).signPub)
    expect(req?.body?.targetHandle).toBe("roshan")

    // The address must not be recoverable from what crossed the wire.
    expect(JSON.stringify(req?.body)).not.toContain("198.51.100.4")
    await client.stop()
  })

  test("accepting releases a sealed address; ignoring releases nothing", async () => {
    const socket = new FakeSocket()
    const { contact } = peerDescriptors(now)
    const { client, calls } = makeClient(
      {
        "/v1/presence/register": () => leaseOk(now),
        "/v1/introduction/respond": () => ({ status: 200, body: { ok: true } }),
      },
      { now: () => now, socket },
    )
    await client.start()
    socket.open()

    // Accepting means sealing our address to whoever asked, so the request has
    // to have arrived first. The requester's key comes with it rather than
    // being looked up, so a service that lied about who asked cannot redirect
    // where the reply is readable.
    socket.deliver({
      type: "introduction.request",
      requestId: "req-1",
      fromHandle: "roshan",
      fromSignPub: deriveSigningKey(PEER_SEED).signPub,
      sealedContact: sealedTo(contact),
      expiresAt: now + 120_000,
    })

    await client.respondIntroduction("req-1", true)
    await client.respondIntroduction("req-2", false)

    const responds = calls.filter((c) => c.path === "/v1/introduction/respond")
    expect(responds[0]?.body?.sealedContact).toBeDefined()
    expect(responds[0]?.body?.contactDescriptor).toBeUndefined()
    expect(JSON.stringify(responds[0]?.body)).not.toContain("198.51.100.4")
    // A refusal carries nothing at all.
    expect(responds[1]?.body?.sealedContact).toBeUndefined()
    await client.stop()
  })

  test("operations before start() fail rather than silently doing nothing", async () => {
    const { client } = makeClient({
      "/v1/discovery/search": () => ({ status: 401, body: { error: { code: "invalid_signature", message: "no" } } }),
    })
    await expect(client.search("roshan")).rejects.toBeInstanceOf(RendezvousError)
  })

  test("every signed request carries a fresh nonce", async () => {
    const { client, calls } = makeClient(
      {
        "/v1/presence/register": () => leaseOk(now),
        "/v1/introduction/respond": () => ({ status: 200, body: { ok: true } }),
      },
      { now: () => now },
    )
    await client.start()
    await client.respondIntroduction("req-1", false)
    await client.respondIntroduction("req-2", false)

    const nonces = calls.map((c) => c.body?.nonce).filter(Boolean)
    expect(new Set(nonces).size).toBe(nonces.length)
    for (const n of nonces) expect(String(n)).toMatch(/^[0-9a-f]{32}$/)
    await client.stop()
  })
})
