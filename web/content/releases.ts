/**
 * Release history, condensed from `CHANGELOG.md`.
 *
 * Summaries only — the repository changelog stays the source of truth, and
 * nothing here is invented to fill a gap. A release with a breaking wire change
 * says so, because a public page that softens that is worse than no page.
 */

export type ReleaseKind = "unreleased" | "release"

export type Release = {
  version: string
  kind: ReleaseKind
  date?: string
  title: string
  summary: string
  breaking?: string
  entries: readonly { label: "Added" | "Changed" | "Fixed" | "Security" | "Verified"; items: readonly string[] }[]
}

export const RELEASES: readonly Release[] = [
  {
    version: "3.0.0-alpha.1",
    kind: "release",
    date: "2026-08-27",
    title: "Rendezvous, conformance vectors, native audio, AGPL",
    summary:
      "First public release. A Go rendezvous service for optional serverless discovery, cross-implementation conformance vectors that prove the Go and TypeScript rendezvous clients speak the same protocol, a native audio sidecar with real microphone capture and Opus encoding, and a license change to AGPL-3.0-or-later. This is an untested alpha.",
    breaking:
      "The Noise transport prologue moved from nex-tcp-v2 to nex-tcp-v3. Builds on opposite sides of this boundary cannot handshake. The mismatch fails immediately and legibly at connection time instead of as an opaque decryption error partway through a session.",
    entries: [
      {
        label: "Added",
        items: [
          "Rendezvous discovery service (Go) — an optional, off-by-default Go service that helps peers find each other without a central server. Runs locally or on a VPS; the app works fine without it.",
          "Cross-implementation conformance vectors — frozen test vectors that both the Go and TypeScript rendezvous clients are verified against, so the two implementations stay in lockstep.",
          "Native audio sidecar — real microphone capture at 48 kHz mono, 20 ms frames, Opus encoding with forward error correction. The sidecar runs as a separate process and talks to the main app over a local pipe.",
          "Relicensed from MIT to AGPL-3.0-or-later — the license now requires that anyone distributing modified versions also share their changes.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Noise_XX handshake now matches the specification it advertises (revision 34). Three symmetric deviations were corrected: a chaining key and cipher key that were collapsed into one HKDF output, DH tokens calling the PSK-only mixing function, and a skipped encrypt-and-hash on the first handshake payload. Verified byte-for-byte against the official cacophony test vector for Noise_XX_25519_ChaChaPoly_SHA256.",
          "Invite naming now runs after the fingerprint check, so an impostor answering at the invited address cannot be written into the peer registry under the inviter's name.",
          "A stripped fingerprint no longer silently disables pinning. The parser is anchored at both ends and an unpinned code is refused.",
          "connectDiscovered now checks the fingerprint, so a spoofed LAN beacon cannot point a trusted name at any address.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.7",
    kind: "release",
    date: "2026-08-26",
    title: "Serverless discovery",
    summary:
      "Three layers, zero infrastructure, in the order a friendship network actually forms.",
    entries: [
      {
        label: "Added",
        items: [
          "Finding people on the same network, with no internet involved. Each app quietly announces itself and listens for others nearby. Anyone who goes quiet drops off the list after fifteen seconds, and the whole thing can be switched off on a network you do not trust.",
          "nex:// invite codes carrying name, address and fingerprint. The dial is fingerprint-pinned: if anyone but the expected identity answers, the link is refused loudly. First contact arrives pre-checked.",
          "Introductions. A connected peer can relay a third peer's beacon down an existing encrypted link, so the social graph bootstraps from first contact.",
        ],
      },
      {
        label: "Verified",
        items: [
          "123 unit tests green, typecheck clean, and a live three-node smoke test over real UDP and TCP covering discovery both ways, invite roundtrip, tampered-invite rejection and introduction propagation.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.6",
    kind: "release",
    date: "2026-08-25",
    title: "Rooms and voice channels",
    summary:
      "Group spaces over the existing encrypted pairwise links. The creator's node anchors the room and relays through itself — still no server anywhere.",
    entries: [
      {
        label: "Added",
        items: [
          "Rooms with union-merged membership snapshots, original authorship preserved through the relay, and per-sender sequence numbers to dedupe replays and reorders. Leaving, closing and link loss all converge membership honestly on every side.",
          "A voice channel per room: join, leave, mute and speaking presence converge like membership. Audio rides fire-and-forget frames with an 80 ms jitter buffer, late-frame drop and an echo guard. The codec is a swappable port, and this release ships a silent mock.",
          "Older and newer versions can now talk. Anything an older app does not recognise is ignored instead of breaking the connection, so it keeps working when the other side is more up to date.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Muting no longer evicts other participants from the local view.",
          "Member-side reconciliation now adopts speakers who joined the voice channel before you arrived, instead of only filtering departures.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.5",
    kind: "release",
    date: "2026-08-25",
    title: "Retention agreements and the motion layer",
    summary:
      "Retention agreements over the secure channel, the authenticating lifecycle stage, and a transport fix for a latent frame-drop race.",
    entries: [
      {
        label: "Added",
        items: [
          "A terminal-native motion layer — boot shimmer, settling spinner, connecting and reconnecting states in the people pane — all of it disabled by a single environment variable.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.4",
    kind: "release",
    date: "2026-08-24",
    title: "Storage tiers",
    summary:
      "Encryption becomes the default, a passphrase becomes the protective tier, and plaintext becomes an explicit opt-out.",
    entries: [
      {
        label: "Changed",
        items: [
          "Every node now stores its data encrypted out of the box, with the key held on the device. That defeats partial file leaks and careless backups but not full-disk access, and it is reported in exactly those words rather than as a flat claim of encryption.",
          "The protective tier wraps the same vault key with Argon2id behind a passphrase. Losing the passphrase loses the data, and the interface says so before the vault is created, on every subsequent boot, and permanently in settings.",
          "Plaintext remains available as an explicit opt-out that warns on every boot.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.3",
    kind: "release",
    date: "2026-08-24",
    title: "The encrypted local vault",
    summary:
      "Identity, secret keys, contacts, trust bindings and conversation history stored as authenticated-encryption envelopes under an Argon2id-wrapped key.",
    entries: [
      {
        label: "Added",
        items: [
          "Name-bound ciphertexts: each blob's associated data includes its logical file name, so swapping blobs between files fails authentication.",
          "A one-time migration from a previously plaintext directory, with verified read-back before the originals are deleted.",
          "Honest storage state throughout the interface. A wrong or missing passphrase fails closed before any network activity.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.2",
    kind: "release",
    date: "2026-08-24",
    title: "Encrypted transport",
    summary: "The NO ENCRYPTION strip finally flips.",
    breaking:
      "Both peers must run this version or later. Older plaintext peers are not interoperable.",
    entries: [
      {
        label: "Added",
        items: [
          "A Noise-based encrypted transport. Every message crosses the wire as authenticated ciphertext with per-message nonces, and mutual authentication of long-term keys is baked into the handshake transcript.",
          "Your app remembers who someone was the first time you met them. If that person later turns up with different credentials — whether an impostor or a genuine key change — the connection is refused rather than quietly accepted.",
          "Replay and reorder resistance with strict nonce counters. Any authentication failure tears the link down rather than resyncing.",
          "Session forward secrecy: traffic keys come from ephemeral key agreement mixed into the handshake, so later compromise of long-term keys does not decrypt past sessions.",
        ],
      },
      {
        label: "Security",
        items: [
          "First-meeting interception remains outside the trust-on-first-use model. Compare fingerprints out of band before confirming verification.",
          "Sessions have no rekey; very long-lived links eventually exhaust nonces and reconnect instead. A documented limitation, not a silent one.",
        ],
      },
    ],
  },
  {
    version: "2.0.0-alpha.1",
    kind: "release",
    date: "2026-08-24",
    title: "The rename, the home screen, themes and retention",
    summary:
      "First v2 slice: the project rename, a social home screen, token-based themes, and local message retention.",
    breaking:
      "The project was renamed and the handshake domain separator bumped, so both peers must run a v2 build. Existing attestation records show a mismatch once and need re-verifying after the upgrade.",
    entries: [
      {
        label: "Added",
        items: [
          "A home screen carrying identity, people online, recent conversations with unread badges, and pending verifications or mismatch warnings.",
          "A token-based theme system with six built-ins. The tokens in that system are the ones this website is built from.",
          "Message retention with strictly local semantics: expiry removes your stored copy only, and says nothing about the peer's copy.",
        ],
      },
    ],
  },
  {
    version: "1.0.0",
    kind: "release",
    date: "2026-08-24",
    title: "Identity, contacts and the social foundation",
    summary:
      "A three-pane keyboard-driven shell, cryptographic node identity, and contacts instead of addresses.",
    entries: [
      {
        label: "Added",
        items: [
          "Cryptographic node identity, with peers proving control of their claimed identity on every handshake.",
          "Trust-on-first-use identity continuity with explicit states: unknown, identified, mismatch.",
          "Contacts rather than addresses — local renames, and out-of-band fingerprint verification.",
          "An honest security strip: plaintext transport was always labelled as carrying no encryption.",
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    kind: "release",
    title: "Latency and explicit trust",
    summary: "Measured latency, explicit trust decisions, and a reconnecting state in the contract.",
    entries: [],
  },
  {
    version: "0.1.0",
    kind: "release",
    title: "First proof",
    summary:
      "Two nodes found each other over direct TCP, exchanged messages both ways, and kept their identity and history across restarts.",
    entries: [],
  },
]