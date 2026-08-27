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
import { COMMANDS, usage } from "../src/ui/commands"
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

  test("/rendezvous on needs both parts", async () => {
    const h = harness()
    await runCommand("/rendezvous on https://example.com", h.ctx)
    expect(h.said()).toContain("usage:")
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
