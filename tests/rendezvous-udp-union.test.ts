// The whole path, in one process: rendezvous, punch, Noise, identity, chat.
//
//   zro searches roshan
//     -> introduction request          (sealed; the service cannot read it)
//     -> roshan accepts                (and starts punching, without dialling)
//     -> both punch at once            (real UDP sockets)
//     -> PATH_ESTABLISHED
//     -> reliable channel
//     -> Noise_XX                      (the audited implementation, unchanged)
//     -> identity binding              (the same verifier TCP uses)
//     -> UNION
//     -> a chat message crosses it
//
// What is real here: both Nex applications, both transports, both UDP sockets,
// the sealing, the descriptors and their signatures, the handshake, the TOFU
// store. What is faked is the SERVICE — an in-process relay that stores what it
// is given and delivers frames to the right socket.
//
// That boundary is deliberate and it is also this test's limit. It proves the
// client half of the contract and the entire connection path; it cannot prove
// the Go service agrees, which is what rendezvous/testdata/vectors.json and
// tests/live-rendezvous-union.ts are for. Two implementations agreeing is not
// evidence when only one of them is in the room.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NexAppImpl } from "../src/core/app"
import type { ControlSocket } from "../src/core/rendezvous/client"
import { FileIdentityStore, generateIdentity, ensureNoiseStaticKey } from "../src/core/identity"
import {
  FileConversationStore,
  FilePeerRegistryStore,
  FileStaticKeyStore,
} from "../src/core/state/persistence"
import { EncryptedTcpTransport } from "../src/network/tcp/encrypted-tcp-transport"
import { TransportSelector } from "../src/network/transport-selector"
import { UdpTransport } from "../src/network/udp/udp-transport"

const BASE = "http://rendezvous.test"

// ---------- the fake service ----------

interface Registration {
  handle: string
  nodeId: string
  publicDescriptor: unknown
  socket: FakeControlSocket | null
}

class FakeControlSocket implements ControlSocket {
  private msgCb: ((data: string) => void) | undefined
  private closeCb: (() => void) | undefined
  closed = false

  send(): void {
    // Only pings go up this channel, and the fake service has nothing to say
    // back to them.
  }
  close(): void {
    this.closed = true
    this.closeCb?.()
  }
  onOpen(cb: () => void): void {
    // Open on the next turn, the way a real socket does — synchronous open
    // would let the client see a connected channel inside its own call stack.
    setTimeout(cb, 0)
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }
  onError(): void {}

  deliver(frame: unknown): void {
    if (!this.closed) this.msgCb?.(JSON.stringify(frame))
  }
}

/** Stores descriptors, relays frames, reads nothing it was not given in the clear. */
class FakeService {
  readonly byHandle = new Map<string, Registration>()
  /** Every introduction body the service saw, for asserting what it could NOT read. */
  readonly relayed: Array<Record<string, unknown>> = []

  register(body: Record<string, unknown>): Registration {
    const handle = String(body.handle)
    const reg: Registration = {
      handle,
      nodeId: String(body.nodeId),
      publicDescriptor: body.publicDescriptor,
      socket: this.byHandle.get(handle)?.socket ?? null,
    }
    this.byHandle.set(handle, reg)
    return reg
  }

  attach(nodeId: string, socket: FakeControlSocket): void {
    for (const reg of this.byHandle.values()) {
      if (reg.nodeId === nodeId) reg.socket = socket
    }
  }

  byNode(nodeId: string): Registration | undefined {
    for (const reg of this.byHandle.values()) if (reg.nodeId === nodeId) return reg
    return undefined
  }
}

function fakeFetch(service: FakeService): typeof fetch {
  const pendingRequests = new Map<string, { fromNodeId: string }>()
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url)
    const path = full.slice(full.indexOf("/v1")).split("?")[0]!
    const query = full.includes("?") ? new URLSearchParams(full.slice(full.indexOf("?") + 1)) : null
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

    if (path === "/v1/presence/register") {
      service.register(body!)
      return json(200, { leaseId: `lease-${body!.handle}`, handle: body!.handle, expiresAt: Date.now() + 90_000, refreshAfterMs: 30_000 })
    }
    if (path === "/v1/presence/refresh") {
      return json(200, { expiresAt: Date.now() + 90_000, refreshAfterMs: 30_000 })
    }
    if (path === "/v1/presence") return new Response(null, { status: 204 })

    if (path === "/v1/discovery/search") {
      const reg = service.byHandle.get(String(query?.get("handle")))
      return json(200, { result: reg?.publicDescriptor ?? null })
    }

    if (path === "/v1/introduction/request") {
      service.relayed.push(body!)
      const target = service.byHandle.get(String(body!.targetHandle))
      if (!target?.socket) return json(404, { error: { code: "not_found", message: "no such handle" } })
      pendingRequests.set(String(body!.requestId), { fromNodeId: String(body!.nodeId) })
      target.socket.deliver({
        type: "introduction.request",
        requestId: body!.requestId,
        fromHandle: body!.fromHandle,
        fromSignPub: body!.fromSignPub,
        // Relayed byte for byte. The service has no key that opens it.
        sealedContact: body!.sealedContact,
        expiresAt: body!.expiresAt,
      })
      return json(202, { requestId: body!.requestId, expiresAt: body!.expiresAt })
    }

    if (path === "/v1/introduction/respond") {
      service.relayed.push(body!)
      const pending = pendingRequests.get(String(body!.requestId))
      const requester = pending ? service.byNode(pending.fromNodeId) : undefined
      requester?.socket?.deliver({
        type: "introduction.response",
        requestId: body!.requestId,
        accept: body!.accept,
        sealedContact: body!.sealedContact,
      })
      return new Response(null, { status: 204 })
    }
    return json(404, { error: { code: "not_found", message: path } })
  }) as unknown as typeof fetch
}

// ---------- nodes ----------

const dirs: string[] = []
const nodes: NexAppImpl[] = []
const realFetch = globalThis.fetch

interface Node {
  app: NexAppImpl
  name: string
  udp: UdpTransport
  events: string[]
}

async function startNode(name: string, service: FakeService): Promise<Node> {
  const dir = await mkdtemp(join(tmpdir(), `nex-union-${name}-`))
  dirs.push(dir)
  const identityStore = new FileIdentityStore(join(dir, "identity.json"))
  const generated = generateIdentity()
  await identityStore.save({ ...generated.identity, name }, generated.secret)
  const identity = (await identityStore.load())!
  const secret = await ensureNoiseStaticKey(identityStore, identity, (await identityStore.loadSecret())!)

  const bindings = new FileStaticKeyStore(join(dir, "identities.json"))
  const events: string[] = []
  const log = (event: string) => events.push(event)
  const tcp = new EncryptedTcpTransport({ identityPrivHex: secret.identityPrivHex!, bindings })
  const udp = new UdpTransport({
    identityPrivHex: secret.identityPrivHex!,
    bindings,
    // No STUN in a unit test: it would reach the internet, and on a machine
    // that cannot, the whole suite would wait out three timeouts per node.
    stunServers: [],
    log,
  })
  const app = new NexAppImpl({
    identityStore,
    conversations: new FileConversationStore(join(dir, "conversations")),
    registry: new FilePeerRegistryStore(join(dir, "peers.json")),
    transport: new TransportSelector(tcp, udp, { log }),
    nat: udp,
    port: 0,
    openControlSocket: (_url, headers) => {
      const socket = new FakeControlSocket()
      service.attach(headers["X-Nex-Node"]!, socket)
      return socket
    },
  })
  await app.start()
  nodes.push(app)
  return { app, name, udp, events }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(40)
  }
  throw new Error("condition not met in time")
}

afterEach(async () => {
  for (const app of nodes.splice(0)) await app.shutdown().catch(() => {})
  globalThis.fetch = realFetch
})

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("rendezvous to UNION over UDP", () => {
  test("an accepted introduction ends in a direct authenticated link carrying chat", async () => {
    const service = new FakeService()
    globalThis.fetch = fakeFetch(service)

    const roshan = await startNode("roshan", service)
    const zro = await startNode("zro", service)

    await roshan.app.setRendezvous(true, { baseUrl: BASE, handle: "roshan" })
    await zro.app.setRendezvous(true, { baseUrl: BASE, handle: "zro" })
    // The control socket opens a turn after registering; the introduction has
    // nowhere to go until it does.
    await waitFor(() => service.byHandle.get("roshan")?.socket !== null)
    await waitFor(() => service.byHandle.get("zro")?.socket !== null)

    // Candidates: both nodes publish a punchable address on the socket that
    // will actually be punched.
    const roshanDescriptor = service.byHandle.get("roshan")!
    expect(roshanDescriptor).toBeTruthy()

    // --- zro asks for an introduction ---
    let inbound: { requestId: string; fromHandle: string } | null = null
    const messages: string[] = []
    roshan.app.emit((event) => {
      if (event.type === "introductionRequested") inbound = event.request
      if (event.type === "message") messages.push(event.message.content)
    })

    const found = await zro.app.searchHandle("roshan")
    expect(found?.nodeId).toBe(roshan.app.identity.nodeId)
    await zro.app.requestIntroduction("roshan")
    await waitFor(() => inbound !== null)
    expect(inbound!.fromHandle).toBe("zro")

    // --- roshan accepts: this is the "both punch now" moment ---
    await roshan.app.respondIntroduction(inbound!.requestId, true)

    // --- the union must form directly, over UDP ---
    await waitFor(async () => (await zro.app.listPeers()).some((p) => p.peerId === roshan.app.identity.nodeId && p.status === "connected"))
    await waitFor(async () => (await roshan.app.listPeers()).some((p) => p.peerId === zro.app.identity.nodeId && p.status === "connected"))

    const peer = (await zro.app.listPeers()).find((p) => p.peerId === roshan.app.identity.nodeId)!
    expect(peer.status).toBe("connected")
    // First meeting: reported honestly rather than as a verification that did
    // not happen.
    expect(peer.identityState).toBe("unknown")

    // --- and it carries chat ---
    await zro.app.sendMessage(roshan.app.identity.nodeId, "hello over the punched path")
    await waitFor(() => messages.some((m) => m.includes("hello over the punched path")))

    // The path really was the punched one, not a TCP fallback.
    expect(zro.events).toContain("union_formed")
    expect(zro.events).toContain("path_established")
    expect(roshan.events).toContain("union_formed")
  }, 40_000)

  test("the service never sees an address", async () => {
    const service = new FakeService()
    globalThis.fetch = fakeFetch(service)

    const roshan = await startNode("roshan", service)
    const zro = await startNode("zro", service)
    await roshan.app.setRendezvous(true, { baseUrl: BASE, handle: "roshan" })
    await zro.app.setRendezvous(true, { baseUrl: BASE, handle: "zro" })
    await waitFor(() => service.byHandle.get("roshan")?.socket !== null)
    await waitFor(() => service.byHandle.get("zro")?.socket !== null)

    let inbound: { requestId: string } | null = null
    roshan.app.emit((event) => {
      if (event.type === "introductionRequested") inbound = event.request
    })
    await zro.app.requestIntroduction("roshan")
    await waitFor(() => inbound !== null)
    await roshan.app.respondIntroduction(inbound!.requestId, true)

    // Everything the service was handed, as text. The UDP port each node is
    // punching on must not appear anywhere in it: the addresses travel sealed,
    // and a service that could read them could also hand them to someone else.
    const seen = JSON.stringify(service.relayed)
    expect(seen).not.toContain(String(zro.udp.port))
    expect(seen).not.toContain(String(roshan.udp.port))
    expect(seen).toContain("sealedContact")
  }, 40_000)
})
