// Trust-on-first-use binding of a node id to a static key.
//
// This lives outside any transport on purpose. TCP and UDP are two ways to move
// bytes; who is at the other end must be decided the same way for both. A
// second copy of this logic is how the two drift, and a drift here is not a
// cosmetic bug — it is one transport accepting a peer the other would refuse.

export interface StaticKeyRecord {
  nodeId: string
  staticKey: string
  firstSeenAt: number
  lastSeenAt: number
}

export interface StaticKeyBindings {
  get(nodeId: string): Promise<StaticKeyRecord | null>
  put(record: StaticKeyRecord): Promise<void>
}

/**
 * - no record  -> remember it, report `unknown` (first meeting, nothing to compare)
 * - same key   -> `identified`
 * - other key  -> `mismatch`; the record is deliberately NOT overwritten, so an
 *                 impostor cannot replace the binding by showing up loudly
 * - store fails-> `mismatch`, because a check that could not run is not a pass
 */
export type IdentityState = "unknown" | "identified" | "mismatch"

export async function resolveIdentityBinding(
  nodeId: string,
  presentedStaticKey: string,
  bindings: StaticKeyBindings | undefined,
  now: number,
  onError?: (message: string) => void,
): Promise<IdentityState> {
  const presented = presentedStaticKey.toLowerCase()
  try {
    const record = (await bindings?.get(nodeId)) ?? null
    if (!record) {
      await bindings?.put({ nodeId, staticKey: presented, firstSeenAt: now, lastSeenAt: now })
      return "unknown"
    }
    return record.staticKey.toLowerCase() === presented ? "identified" : "mismatch"
  } catch (err) {
    onError?.(`binding store: ${err instanceof Error ? err.message : String(err)}`)
    // Failing closed matters here. Treating an unreadable store as "probably
    // fine" would turn a disk error into an accepted impostor.
    return "mismatch"
  }
}
