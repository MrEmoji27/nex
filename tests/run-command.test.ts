// Slash commands, driven without a terminal.
//
// Until the dispatch moved out of the interface component this was the one part
// of the app nothing could test, and it is the part a person touches first. The
// bug that prompted the move was not a wrong answer — it was NO answer: results
// went to a four-second truncated footer line, so working commands were
// indistinguishable from broken ones.
//
// Hence the shape of these tests: almost every one asserts that something was
// SAID. A command that runs silently has failed even when it worked.
import { describe, expect, test } from "bun:test"
import type { NexApp } from "../src/core/contract"
import { COMMANDS, DEFAULT_RENDEZVOUS_URL, usage } from "../src/ui/commands"
import { runCommand, type CommandContext } from "../src/ui/run-command"

function harness(overrides: Partial<CommandContext> = {}, appOverrides: Partial<NexApp> = {}) {
  const lines: Array<{ text: string; tone: string }> = []
  const modals: string[] = []
  const dialled: string[] = []

  const app = {
    identity: { nodeId: "A".repeat(64), name: "zemo", createdAt: 0 },
    getRendezvousState: () => ({ enabled: false, connected: false, connectable: false, handle: null, expiresAt: null }),
    setRendezvous: async () => {},
    searchHandle: async () => null,
    requestIntroduction: async () => ({ requestId: "r1", expiresAt: 0 }),
    listIntroductionRequests: () => [],
    respondIntroduction: async () => {},
    createInvite: async () => "nex://code",
    setDisplayName: async () => {},
    renameContact: async () => {},
    setVerified: async () => {},
    disconnect: async () => {},
    pingPeer: async () => 12,
    setRetention: async () => {},
    createRoom: async (name: string) => ({ roomId: "r00m", name, members: [], voice: { participants: [] } }),
    joinRoom: async () => ({ roomId: "r00m", name: "lounge" }),
    leaveRoom: async () => {},
    closeRoom: async () => {},
    sendRoomMessage: async () => {},
    ...appOverrides,
  } as unknown as NexApp

  const ctx: CommandContext = {
    app,
    selectedPeerId: null,
    peers: [],
    rooms: [],
    invitations: [],
    activeRoom: null,
    log: (text, tone = "ok") => lines.push({ text, tone }),
    openModal: (kind) => modals.push(kind),
    connectTo: (address) => dialled.push(address),
    applyTheme: () => true,
    toggleVoice: () => {},
    toggleMute: () => {},
    ...overrides,
  }
  return { ctx, lines, modals, dialled, said: () => lines.map((l) => l.text).join("\n") }
}

describe("every command answers", () => {
  test("no command runs silently", async () => {
    // The failure this whole module exists to prevent. Commands that open a
    // modal or delegate to the caller are the two legitimate exceptions.
    const delegating = new Set(["verify", "themes", "theme", "voice", "mute", "say"])
    for (const spec of COMMANDS) {
      if (delegating.has(spec.name)) continue
      const h = harness()
      await runCommand(`/${spec.name}`, h.ctx)
      expect({ command: spec.name, said: h.lines.length > 0 }).toEqual({ command: spec.name, said: true })
    }
  })

  test("a command that throws still reports", async () => {
    const h = harness({}, {
      searchHandle: async () => {
        throw new Error("rendezvous is off")
      },
    } as Partial<NexApp>)
    await runCommand("/find roshan", h.ctx)
    expect(h.said()).toContain("rendezvous is off")
    expect(h.lines.some((l) => l.tone === "bad")).toBe(true)
  })
})

describe("unrecognised input", () => {
  test("a near miss is corrected, not just refused", async () => {
    const h = harness()
    await runCommand("/fnd roshan", h.ctx)
    expect(h.said()).toContain("did you mean /find")
  })

  test("something unrelated points at help", async () => {
    const h = harness()
    await runCommand("/wizard", h.ctx)
    expect(h.said()).toContain("/help")
    expect(h.lines[0]!.tone).toBe("bad")
  })

  test("a bare slash explains itself", async () => {
    const h = harness()
    await runCommand("/", h.ctx)
    expect(h.said()).toContain("/help")
  })
})

describe("finding people", () => {
  test("/find reports a miss as a miss", async () => {
    const h = harness()
    await runCommand("/find nobody", h.ctx)
    expect(h.said()).toContain('nobody is registered as "nobody"')
  })

  test("/find on a hit says what to do next", async () => {
    const h = harness({}, {
      searchHandle: async () => ({
        handle: "roshan",
        nodeId: "B".repeat(64),
        capabilities: [],
        connectable: true,
        expiresAt: 0,
      }),
    } as Partial<NexApp>)
    await runCommand("/find roshan", h.ctx)
    expect(h.said()).toContain("roshan is here")
    expect(h.said()).toContain("/ask roshan")
  })

  test("/accept with nothing waiting says so rather than failing quietly", async () => {
    const h = harness()
    await runCommand("/accept", h.ctx)
    expect(h.said()).toContain("no introductions waiting")
  })

  test("/accept takes the short id the notice shows", async () => {
    const seen: string[] = []
    const h = harness({}, {
      listIntroductionRequests: () => [
        { requestId: "abcd1234-5678", fromHandle: "roshan", fromNodeId: "B".repeat(64), receivedAt: 0, expiresAt: 0 },
      ],
      respondIntroduction: async (id: string) => {
        seen.push(id)
      },
    } as unknown as Partial<NexApp>)
    await runCommand("/accept abcd1234", h.ctx)
    expect(seen).toEqual(["abcd1234-5678"])
    expect(h.said()).toContain("accepted roshan")
  })

  test("/rendezvous with no arguments reports rather than changing anything", async () => {
    const calls: number[] = []
    const h = harness({}, {
      setRendezvous: async () => {
        calls.push(1)
      },
    } as Partial<NexApp>)
    await runCommand("/rendezvous", h.ctx)
    expect(calls.length).toBe(0)
    expect(h.said()).toContain("rendezvous is off")
  })

  test("/rendezvous on needs a handle", async () => {
    const h = harness()
    await runCommand("/rendezvous on", h.ctx)
    expect(h.said()).toContain("usage:")
  })

  test("a handle alone uses the default service", async () => {
    // Making someone retype a service address they have already used is how a
    // working command gets abandoned.
    const calls: Array<{ baseUrl?: string; handle?: string }> = []
    const h = harness({}, {
      setRendezvous: async (_on: boolean, cfg?: { baseUrl?: string; handle?: string }) => {
        calls.push(cfg ?? {})
      },
    } as unknown as Partial<NexApp>)
    await runCommand("/rendezvous on zemo", h.ctx)
    expect(calls[0]!.handle).toBe("zemo")
    expect(calls[0]!.baseUrl).toBe(DEFAULT_RENDEZVOUS_URL)
  })

  test("a service this node already used beats the default", async () => {
    const calls: Array<{ baseUrl?: string }> = []
    const h = harness(
      { rendezvousUrl: "https://mine.example" },
      {
        setRendezvous: async (_on: boolean, cfg?: { baseUrl?: string }) => {
          calls.push(cfg ?? {})
        },
      } as unknown as Partial<NexApp>,
    )
    await runCommand("/rendezvous on zemo", h.ctx)
    expect(calls[0]!.baseUrl).toBe("https://mine.example")
  })

  test("an explicit URL beats both, in either order", async () => {
    const calls: Array<{ baseUrl?: string; handle?: string }> = []
    const app = {
      setRendezvous: async (_on: boolean, cfg?: { baseUrl?: string; handle?: string }) => {
        calls.push(cfg ?? {})
      },
    } as unknown as Partial<NexApp>
    const first = harness({ rendezvousUrl: "https://mine.example" }, app)
    await runCommand("/rendezvous on zemo https://other.example", first.ctx)
    const second = harness({ rendezvousUrl: "https://mine.example" }, app)
    await runCommand("/rendezvous on https://other.example zemo", second.ctx)
    expect(calls.map((c) => c.baseUrl)).toEqual(["https://other.example", "https://other.example"])
    expect(calls.map((c) => c.handle)).toEqual(["zemo", "zemo"])
  })
})

describe("calling someone", () => {
  // A call used to cost /room name:peer, then an 8-char hex id read off an
  // expiring notice, then /join, then /voice — with an invisible notion of
  // which room was "active". The point of /call is that none of that is the
  // user's problem.
  const peer = { peerId: "B".repeat(64), name: "roshan", status: "connected" as const }

  test("/call <who> creates the room, invites them and opens voice", async () => {
    const created: Array<{ name: string; invited: string[] }> = []
    const voiced: Array<{ roomId: string; active: boolean }> = []
    const h = harness({ peers: [peer] }, {
      createRoom: async (name: string, invited: string[]) => {
        created.push({ name, invited })
        return { roomId: "r00m", name, members: [], voice: { participants: [] } }
      },
      setVoiceActive: async (roomId: string, active: boolean) => {
        voiced.push({ roomId, active })
      },
    } as unknown as Partial<NexApp>)

    await runCommand("/call roshan", h.ctx)
    expect(created).toHaveLength(1)
    expect(created[0]!.invited).toEqual([peer.peerId])
    expect(voiced).toEqual([{ roomId: "r00m", active: true }])
    expect(h.said()).toContain("calling roshan")
  })

  test("/call names the room after the people in it, not a hex id", async () => {
    const names: string[] = []
    const h = harness({ peers: [peer] }, {
      createRoom: async (name: string) => {
        names.push(name)
        return { roomId: "r00m", name, members: [], voice: { participants: [] } }
      },
      setVoiceActive: async () => {},
    } as unknown as Partial<NexApp>)
    await runCommand("/call roshan", h.ctx)
    expect(names[0]).toBe("zemo & roshan")
  })

  test("/call with no argument answers an invitation", async () => {
    const joined: string[] = []
    const h = harness(
      { invitations: [{ roomId: "r00m", roomName: "call", hostPeerId: "B".repeat(64), hostName: "roshan" }] },
      {
        joinRoom: async (id: string) => {
          joined.push(id)
          return { roomId: id, name: "call" }
        },
        setVoiceActive: async () => {},
      } as unknown as Partial<NexApp>,
    )
    await runCommand("/call", h.ctx)
    expect(joined).toEqual(["r00m"])
    expect(h.said()).toContain("joined roshan")
  })

  test("calling someone who is not connected says so, rather than making a room nobody joins", async () => {
    const h = harness({ peers: [{ ...peer, status: "offline" as const }] })
    await runCommand("/call roshan", h.ctx)
    expect(h.said()).toContain("offline")
  })

  test("calling a name that is not here does not silently do nothing", async () => {
    const h = harness()
    await runCommand("/call nobody", h.ctx)
    expect(h.said()).toContain("/peers")
  })

  test("/join with no argument takes the only invitation", async () => {
    const joined: string[] = []
    const h = harness(
      { invitations: [{ roomId: "only", roomName: "lounge", hostPeerId: "B".repeat(64), hostName: "roshan" }] },
      {
        joinRoom: async (id: string) => {
          joined.push(id)
          return { roomId: id, name: "lounge" }
        },
      } as unknown as Partial<NexApp>,
    )
    await runCommand("/join", h.ctx)
    expect(joined).toEqual(["only"])
  })
})

describe("commands that need something selected", () => {
  test("/rename says which rename this is", async () => {
    // /rename renames a contact and /name renames you. Confusing the two is
    // easy, so the error names the difference instead of just refusing.
    const h = harness()
    await runCommand("/rename bob", h.ctx)
    expect(h.said()).toContain("/name renames you")
  })

  test("/ping with nobody selected explains what to do", async () => {
    const h = harness()
    await runCommand("/ping", h.ctx)
    expect(h.said()).toContain("no one selected")
  })
})

describe("your node", () => {
  test("/name with no argument reports the current one", async () => {
    const h = harness()
    await runCommand("/name", h.ctx)
    expect(h.said()).toContain("zemo")
  })

  test("/name sets it", async () => {
    const set: string[] = []
    const h = harness({}, { setDisplayName: async (n: string) => void set.push(n) } as Partial<NexApp>)
    await runCommand("/name zro", h.ctx)
    expect(set).toEqual(["zro"])
    expect(h.said()).toContain('you are now "zro"')
  })

  test("/net without the UDP transport says so instead of pretending", async () => {
    const h = harness()
    await runCommand("/net", h.ctx)
    expect(h.said()).toContain("no UDP transport")
  })

  test("/net reports the route each peer is using", async () => {
    const h = harness({
      net: {
        udpPort: 54096,
        publicCandidate: { host: "203.0.113.7", port: 64350 },
        natDetail: "one public port per local port",
        routeOf: () => "udp" as const,
        measure: async () => ({ address: null, detail: "" }),
      },
      peers: [{ peerId: "B".repeat(64), name: "roshan", status: "connected" }],
    })
    await runCommand("/net", h.ctx)
    expect(h.said()).toContain("203.0.113.7:64350")
    expect(h.said()).toContain("roshan over udp")
  })

  test("/help lists every command with its usage", async () => {
    const h = harness()
    await runCommand("/help", h.ctx)
    const said = h.said()
    for (const spec of COMMANDS) expect(said).toContain(usage(spec))
  })

  test("/help <command> explains just that one", async () => {
    const h = harness()
    await runCommand("/help find", h.ctx)
    expect(h.said()).toContain("/find <handle>")
    expect(h.lines.length).toBe(1)
  })
})
