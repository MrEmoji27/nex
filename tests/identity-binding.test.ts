// One identity model, shared by every transport.
import { describe, expect, test } from "bun:test"
import { resolveIdentityBinding, type StaticKeyBindings, type StaticKeyRecord } from "../src/core/session/identity-binding"

function store(initial: StaticKeyRecord[] = []) {
  const map = new Map(initial.map((r) => [r.nodeId, r]))
  return {
    map,
    api: {
      get: async (id: string) => map.get(id) ?? null,
      put: async (r: StaticKeyRecord) => void map.set(r.nodeId, r),
    } satisfies StaticKeyBindings,
  }
}

describe("identity binding", () => {
  test("first meeting is remembered and reported as unknown", async () => {
    const s = store()
    expect(await resolveIdentityBinding("NODE", "aabb", s.api, 1)).toBe("unknown")
    expect(s.map.get("NODE")?.staticKey).toBe("aabb")
  })

  test("the same key on a later meeting is identified", async () => {
    const s = store([{ nodeId: "NODE", staticKey: "aabb", firstSeenAt: 1, lastSeenAt: 1 }])
    expect(await resolveIdentityBinding("NODE", "AABB", s.api, 2)).toBe("identified")
  })

  test("a different key is a mismatch and does NOT overwrite the record", async () => {
    const s = store([{ nodeId: "NODE", staticKey: "aabb", firstSeenAt: 1, lastSeenAt: 1 }])
    expect(await resolveIdentityBinding("NODE", "ccdd", s.api, 2)).toBe("mismatch")
    // An impostor must not be able to replace a binding simply by connecting.
    expect(s.map.get("NODE")?.staticKey).toBe("aabb")
  })

  test("an unreadable store fails closed", async () => {
    const broken: StaticKeyBindings = {
      get: async () => {
        throw new Error("disk gone")
      },
      put: async () => {},
    }
    // A check that could not run is not a pass.
    expect(await resolveIdentityBinding("NODE", "aabb", broken, 1)).toBe("mismatch")
  })

  test("with no store at all, every meeting is a first meeting", async () => {
    expect(await resolveIdentityBinding("NODE", "aabb", undefined, 1)).toBe("unknown")
  })
})
