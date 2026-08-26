
// Regression: frames arriving during the TOFU binding window must be queued,
// never dropped. Before the fix the peer's first post-handshake frame was
// silently discarded, desyncing AEAD counters ("invalid tag" on next frame).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeIdentity } from "../src/core/contract.ts"
import {
  FileIdentityStore,
  generateIdentity,
  generateNoiseStaticKey,
  ensureNoiseStaticKey,
} from "../src/core/identity"
import { FileStaticKeyStore } from "../src/core/state/persistence"
import { EncryptedTcpTransport, TRANSPORT_PROLOGUE } from "../src/network/tcp/encrypted-tcp-transport"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
})

async function makeNode(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `nex-queue-${name}-`))
  dirs.push(dir)
  const store = new FileIdentityStore(join(dir, "identity.json"))
  const generated = generateIdentity()
  const identity: NodeIdentity = { ...generated.identity, name }
  await store.save(identity, generated.secret)
  const secret = await ensureNoiseStaticKey(store, identity, generated.secret)
  return { identity, privHex: secret.identityPrivHex!, dir }
}

test("message sent during peer binding window still arrives (counter sync)", async () => {
  const a = await makeNode("alpha")
  const b = await makeNode("bravo")

  // Responder whose binding lookup stalls: opens the vulnerable window.
  class SlowBindings extends FileStaticKeyStore {
    override async get(nodeId: string) {
      await Bun.sleep(120)
      return super.get(nodeId)
    }
    override async put(record: any) {
      await Bun.sleep(60)
      return super.put(record)
    }
  }

  const ta = new EncryptedTcpTransport({ identityPrivHex: a.privHex, bindings: new FileStaticKeyStore(join(a.dir, "k.json")) })
  const tb = new EncryptedTcpTransport({ identityPrivHex: b.privHex, bindings: new SlowBindings(join(b.dir, "k.json")) })

  const got: string[] = []
  tb.onMessage((_peerId, content) => got.push(content))

  const bPort = await tb.start({ port: 42971, identity: b.identity })
  expect(bPort).toBeGreaterThan(0)
  await ta.start({ port: 42972, identity: a.identity })

  // Dial resolves at handshake; fire the message IMMEDIATELY. The responder is
  // guaranteed to still be inside its delayed binding window.
  await ta.dial(`127.0.0.1:${bPort}`)
  await ta.send(b.identity.nodeId, "first frame wins")
  await Bun.sleep(400)

  expect(got).toEqual(["first frame wins"])

  await ta.stop()
  await tb.stop()
})
