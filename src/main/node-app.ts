import type { NexApp, StorageSecurity } from "../core/contract"
import { createNexApp } from "../core/app"
import {
  FileIdentityStore,
  generateIdentity,
  ensureNoiseStaticKey,
} from "../core/identity"
import {
  FileConversationStore,
  FilePeerRegistryStore,
  FileStaticKeyStore,
} from "../core/state/persistence"
import { FileSettingsStore } from "../core/state/settings"
import { FileRetentionStore } from "../core/state/retention"
import {
  VaultConversationStore,
  VaultIdentityStore,
  VaultPeerRegistryStore,
  VaultRetentionStore,
  VaultSettingsStore,
  VaultStaticKeyStore,
  migratePlaintextIntoVault,
} from "../core/state/encrypted-stores"
import { openVaultKey, PASSPHRASE_CREATED_WARNING, PASSPHRASE_BOOT_REMINDER } from "../core/state/vault"
import { EncryptedTcpTransport } from "../network/tcp/encrypted-tcp-transport"
import { UdpTransport } from "../network/udp/udp-transport"
import { TransportSelector } from "../network/transport-selector"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

export interface NodeOptions {
  /** Display name for this node; persisted when it differs from the stored identity. */
  name?: string
  /** Listen port override; transport falls back through its own defaults. */
  port?: number
  /** Root directory for identity, conversations, peer registry, and settings. */
  dataDir?: string
  /**
   * Protective tier: wrap the vault key with Argon2id(passphrase). Booting an
   * encrypted dir without it fails closed. Upgrades a standard (device-key)
   * or plaintext directory in place, carrying all data into the wrapped vault.
   */
  passphrase?: string
  /**
   * Explicit opt-OUT of local encryption entirely (--plaintext / NEX_PLAINTEXT).
   * Plaintext files on disk; the UI and logs will say NOT ENCRYPTED.
   */
  plaintext?: boolean
  /** Print the extensive first-create passphrase warning (default true when TTY-capable). */
  warnings?: boolean
}

export interface NodeAppResult {
  app: NexApp
  port: number | null
  storageSecurity: StorageSecurity
  /**
   * What the connection path is doing, for `/net` and for the acceptance test.
   *
   * A NAT failure and an application bug look identical from the outside — the
   * peer simply never connects — so the parts that can be observed are exposed
   * rather than guessed at from the outside.
   */
  net: NetDiagnostics
}

export interface NetDiagnostics {
  /** Local UDP port peers punch. */
  udpPort: number
  /** Public address of that port, once STUN has answered. */
  publicCandidate: { host: string; port: number } | null
  /** What the router does to it, in plain language. */
  natDetail: string
  /** Which transport currently carries a peer, or null when it carries none. */
  routeOf(peerId: string): "tcp" | "udp" | null
  /** Measure the public address now. */
  measure(): Promise<{ address: { host: string; port: number } | null; detail: string }>
}

/** Build a fully wired real node backed by disk state under dataDir. */
export async function createNodeApp(options: NodeOptions = {}): Promise<NodeAppResult> {
  const dataDir = options.dataDir ?? "data/local"
  const warn = options.warnings !== false

  // ---- storage tier selection ----
  let storageSecurity: StorageSecurity
  let identityStore: FileIdentityStore | VaultIdentityStore
  let conversations: FileConversationStore | VaultConversationStore
  let registry: FilePeerRegistryStore | VaultPeerRegistryStore
  let bindings: FileStaticKeyStore | VaultStaticKeyStore
  let settingsStore: FileSettingsStore | VaultSettingsStore
  let retentionStore: FileRetentionStore | VaultRetentionStore

  if (options.plaintext) {
    // Explicit opt-out: no local encryption at all.
    storageSecurity = "none"
    identityStore = new FileIdentityStore(join(dataDir, "identity.json"))
    conversations = new FileConversationStore(join(dataDir, "conversations"))
    registry = new FilePeerRegistryStore(join(dataDir, "peers.json"))
    bindings = new FileStaticKeyStore(join(dataDir, "identities.json"))
    settingsStore = new FileSettingsStore(join(dataDir, "settings.json"))
    retentionStore = new FileRetentionStore(join(dataDir, "agreements.json"))
    if (warn) {
      console.error("warning: storage NOT ENCRYPTED (plaintext by choice) — secrets are readable from disk")
    }
  } else {
    // Standard tier: device-key vault (no typing). Passphrase upgrades to the
    // protective tier. Either way, legacy plaintext state is carried in once.
    const { crypto: vault, created } = await openVaultKey(join(dataDir, "vault.key"), options.passphrase)
    storageSecurity = vault.secure ? "passphrase" : "device-key"
    if (vault.secure && created && warn) {
      console.error(PASSPHRASE_CREATED_WARNING)
    } else if (vault.secure && warn) {
      console.error(PASSPHRASE_BOOT_REMINDER)
    }

    const vaultIdentity = new VaultIdentityStore(vault, dataDir)
    const vaultConversations = new VaultConversationStore(vault, dataDir)
    const vaultRegistry = new VaultPeerRegistryStore(vault, dataDir)
    const vaultBindings = new VaultStaticKeyStore(vault, dataDir)
    settingsStore = new VaultSettingsStore(vault, dataDir)
    retentionStore = new VaultRetentionStore(vault, dataDir)
    await migratePlaintextIntoVault(
      vault,
      dataDir,
      {
        identity: vaultIdentity,
        conversations: vaultConversations,
        registry: vaultRegistry,
        bindings: vaultBindings,
      },
      {
        settings: join(dataDir, "settings.json"),
        agreements: join(dataDir, "agreements.json"),
        intoSettings: settingsStore,
        intoAgreements: retentionStore,
      },
    )
    identityStore = vaultIdentity
    conversations = vaultConversations
    registry = vaultRegistry
    bindings = vaultBindings
  }

  // Ensure identity + secrets exist BEFORE transport construction: the transport
  // needs both the seed (legacy verifier continuity) and the X25519 static key.
  let storedSecret = await identityStore.loadSecret()
  if (!storedSecret) {
    const generated = generateIdentity()
    await identityStore.save(generated.identity, generated.secret)
    storedSecret = generated.secret
  }
  const identity = await identityStore.load()
  if (!identity) throw new Error("identity missing after ensure")

  // v2: guarantee a long-term X25519 key exists for the encrypted transport.
  const secret = await ensureNoiseStaticKey(identityStore, identity, storedSecret)

  // Diagnostics for the connection path, off unless asked for. It goes to a
  // file rather than the console because the console belongs to the TUI: a
  // stray line there does not read as a log, it corrupts the screen.
  const diagnosticsFile = process.env.NEX_DEBUG_NET === "1" ? join(dataDir, "net-diagnostics.log") : null
  const log = diagnosticsFile
    ? (event: string, detail?: Record<string, unknown>) => {
        try {
          appendFileSync(diagnosticsFile, `${new Date().toISOString()} ${event} ${JSON.stringify(detail ?? {})}\n`)
        } catch {
          // Diagnostics must never be able to take the app down.
        }
      }
    : undefined

  const tcp = new EncryptedTcpTransport({
    identityPrivHex: secret.identityPrivHex!,
    bindings,
  })
  const udp = new UdpTransport({
    identityPrivHex: secret.identityPrivHex!,
    // The same TOFU store both transports use. Two stores would be two answers
    // to "who is this", and they would disagree the first time a peer switched
    // path — which is the ordinary case, not an exotic one.
    bindings,
    log,
  })
  const transport = new TransportSelector(tcp, udp, { log })

  const app = await createNexApp({
    nat: udp,
    identityStore,
    conversations,
    registry,
    settings: settingsStore,
    retentionStore,
    transport,
    port: options.port,
    storageSecurity,
  })
  if (options.name && app.identity.name !== options.name) {
    app.identity.name = options.name
    const fresh = await identityStore.loadSecret()
    if (fresh) await identityStore.save(app.identity, fresh)
  }
  return {
    app,
    port: transport.port,
    storageSecurity,
    net: {
      get udpPort() {
        return udp.port
      },
      get publicCandidate() {
        return udp.publicCandidate
      },
      get natDetail() {
        return udp.natDetailText
      },
      routeOf: (peerId: string) => transport.routeOf(peerId),
      measure: () => udp.discoverPublicCandidate(),
    },
  }
}


