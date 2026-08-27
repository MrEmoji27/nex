# Changelog

> **Note:** `web/content/releases.ts` is generated from this file. When you change the changelog, regenerate the site copy so the two never disagree.

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.0.0-alpha.3] - 2026-08-27

### Summary

Nex can now attempt a direct connection between two people who are both behind
ordinary home routers, without either of them forwarding a port. That is what
this release is for, and it is the honest headline: the machinery is complete
and has not yet been proven across two real networks. Until it is, treat NAT
traversal as untested rather than working.

### Added

- **Direct connections through NAT.** Two routers will not let each other's
  packets in, because neither has been asked to. Nex now has both sides send at
  the same moment, so each one's outgoing packet props the door open for the
  other's — the technique is called hole punching. The moment both sides agree
  on is the rendezvous introduction, which they both receive.
- **Nex works out its own public address.** It asks a STUN server "what address
  do you see me at?" and publishes the answer as somewhere peers can reach it.
  The measurement is taken on the very socket peers will punch, because a public
  address belongs to one specific local port; measured anywhere else it would
  advertise a door that leads nowhere.
- **A second transport.** Direct TCP is still there and is still preferred when
  a peer can already be dialled — same Wi-Fi, or a forwarded port. UDP is used
  when neither side can be dialled, which is the ordinary case across the
  internet. Both end in the same place: the same encrypted handshake, the same
  identity check, the same rules about who you are talking to.
- **`/net` and `/stun` in headless mode** report which transport carries each
  peer, the public address, and what the router does to it. `NEX_DEBUG_NET=1`
  writes every step of a connection attempt to `net-diagnostics.log` under the
  data directory, so a failure names a layer instead of being silence.

### Fixed

- **Messages sent the instant a connection formed could be lost — and worse.**
  The handshake finishes immediately; deciding *who* the peer is takes a moment
  longer because it reads from disk. A peer cannot see that gap, so they send.
  Those messages were being discarded, and on the UDP transport discarding one
  permanently desynchronised the encryption counters: every later message failed
  to decrypt while the connection went on looking healthy. They are now held and
  delivered in order once the identity check finishes.
- **Two peers connecting at the same time could be confused for each other.**
  An acknowledgement carrying a token we never sent could complete the wrong
  peer's connection attempt, and an incoming probe was offered to every attempt
  in flight rather than the one it belonged to. Neither could happen while
  talking to a single peer; both are ordinary the moment there are two.

### Known limits

- **NAT traversal is unproven.** Everything so far has been tested on one
  machine, which has no router in front of it. A connection that forms over a
  private address crossed nothing.
- **A router that assigns a new public port for every destination (symmetric
  NAT) cannot be punched through.** Nex detects this and says so rather than
  retrying forever. There is no relay fallback, by decision.
- **One message must fit in one packet on the UDP path** — about 1180 bytes. A
  longer message fails with an error rather than being silently cut in half.

---

## [3.0.0-alpha.2] - 2026-08-27

### Summary

First public release. A Go rendezvous service for optional serverless discovery, cross-implementation conformance vectors that prove the Go and TypeScript rendezvous clients speak the same protocol, a native audio sidecar with real microphone capture and Opus encoding, and a license change to AGPL-3.0-or-later. This is an untested alpha.

### Fixed in alpha.2

- **The audio sidecar now ships with the installer.** `alpha.1` installed the app alone, so voice would have started and then silently done nothing — worse than voice being missing, because nothing tells you why. The build now refuses to produce an installer without it.

### Breaking Changes

**The Noise transport prologue moved from `nex-tcp-v2` to `nex-tcp-v3`.** Builds on opposite sides of this boundary cannot handshake. The mismatch fails immediately and legibly at connection time instead of as an opaque decryption error partway through a session.

### Added

- **Rendezvous discovery service (Go)** — An optional, off-by-default Go service that helps peers find each other without a central server. Runs locally or on a VPS; the app works fine without it.
- **Cross-implementation conformance vectors** — Frozen test vectors that both the Go and TypeScript rendezvous clients are verified against, so the two implementations stay in lockstep.
- **Native audio sidecar** — Real microphone capture at 48 kHz mono, 20 ms frames, Opus encoding with forward error correction. The sidecar runs as a separate process and talks to the main app over a local pipe, so a fault in an audio driver kills something restartable rather than the node holding your conversation.
- **Echo cancellation and noise suppression** — Voice no longer feeds your speaker back into your microphone. Measured at 13.9 dB echo reduction on a synthetic room, roughly fivefold. It is a least-mean-squares canceller written in Rust rather than the WebRTC processing module, which does not build on Windows; it handles the common case of speaker bleed on every platform, and will not match a dedicated conferencing app in a difficult room.
- **Relicensed from MIT to AGPL-3.0-or-later** — The license now requires that anyone distributing modified versions also share their changes.

### Fixed

- Noise_XX handshake now matches the specification it advertises (revision 34). Three symmetric deviations were corrected: a chaining key and cipher key that were collapsed into one HKDF output, DH tokens calling the PSK-only mixing function, and a skipped encrypt-and-hash on the first handshake payload. Verified byte-for-byte against the official cacophony test vector for `Noise_XX_25519_ChaChaPoly_SHA256`.
- Invite naming now runs after the fingerprint check, so an impostor answering at the invited address cannot be written into the peer registry under the inviter's name.
- A stripped fingerprint no longer silently disables pinning. The parser is anchored at both ends and an unpinned code is refused.
- `connectDiscovered` now checks the fingerprint, so a spoofed LAN beacon cannot point a trusted name at any address.

---

## [2.0.0-alpha.7] - 2026-08-26

### Summary

Three layers of serverless discovery, zero infrastructure, in the order a friendship network actually forms.

### Added

- **Local discovery** — Each app quietly announces itself and listens for others on the same network. Anyone who goes quiet drops off the list after fifteen seconds, and the whole thing can be switched off on a network you do not trust.
- **`nex://` invite codes** — Carry name, address, and fingerprint. The dial is fingerprint-pinned: if anyone but the expected identity answers, the link is refused loudly. First contact arrives pre-checked.
- **Introductions** — A connected peer can relay a third peer's beacon down an existing encrypted link, so the social graph bootstraps from first contact.

### Verified

- 123 unit tests green, typecheck clean, and a live three-node smoke test over real UDP and TCP covering discovery both ways, invite roundtrip, tampered-invite rejection, and introduction propagation.

---

## [2.0.0-alpha.6] - 2026-08-25

### Summary

Group spaces over the existing encrypted pairwise links. The creator's node anchors the room and relays through itself — still no server anywhere.

### Added

- **Rooms** — Union-merged membership snapshots with original authorship preserved through the relay, and per-sender sequence numbers to dedupe replays and reorders. Leaving, closing, and link loss all converge membership honestly on every side.
- **Voice channels** — Join, leave, mute, and speaking presence converge like membership. Audio rides fire-and-forget frames with an 80 ms jitter buffer, late-frame drop, and an echo guard. The codec is a swappable port; this release ships a silent mock.
- **Forward compatibility** — Older and newer versions can now talk. Anything an older app does not recognise is ignored instead of breaking the connection, so it keeps working when the other side is more up to date.

### Fixed

- Muting no longer evicts other participants from the local view.
- Member-side reconciliation now adopts speakers who joined the voice channel before you arrived, instead of only filtering departures.

---

## [2.0.0-alpha.5] - 2026-08-25

### Summary

Retention agreements over the secure channel, the authenticating lifecycle stage, and a transport fix for a latent frame-drop race.

### Added

- **Terminal-native motion layer** — Boot shimmer, settling spinner, connecting and reconnecting states in the people pane — all of it disabled by a single environment variable.

---

## [2.0.0-alpha.4] - 2026-08-24

### Summary

Encryption becomes the default, a passphrase becomes the protective tier, and plaintext becomes an explicit opt-out.

### Changed

- **Encrypted by default** — Every node now stores its data encrypted out of the box, with the key held on the device. That defeats partial file leaks and careless backups but not full-disk access, and it is reported in exactly those words rather than as a flat claim of encryption.
- **Protective tier** — Wraps the same vault key with Argon2id behind a passphrase. Losing the passphrase loses the data, and the interface says so before the vault is created, on every subsequent boot, and permanently in settings.
- **Plaintext opt-out** — Plaintext remains available as an explicit opt-out that warns on every boot.

---

## [2.0.0-alpha.3] - 2026-08-24

### Summary

Identity, secret keys, contacts, trust bindings, and conversation history stored as authenticated-encryption envelopes under an Argon2id-wrapped key.

### Added

- **Name-bound ciphertexts** — Each blob's associated data includes its logical file name, so swapping blobs between files fails authentication.
- **One-time migration** — From a previously plaintext directory, with verified read-back before the originals are deleted.
- **Honest storage state** — A wrong or missing passphrase fails closed before any network activity.

---

## [2.0.0-alpha.2] - 2026-08-24

### Summary

The NO ENCRYPTION strip finally flips.

### Breaking Changes

**Both peers must run this version or later.** Older plaintext peers are not interoperable.

### Added

- **Noise-based encrypted transport** — Every message crosses the wire as authenticated ciphertext with per-message nonces, and mutual authentication of long-term keys is baked into the handshake transcript.
- **Identity pinning** — Your app remembers who someone was the first time you met them. If that person later turns up with different credentials — whether an impostor or a genuine key change — the connection is refused rather than quietly accepted.
- **Replay and reorder resistance** — Strict nonce counters. Any authentication failure tears the link down rather than resyncing.
- **Session forward secrecy** — Traffic keys come from ephemeral key agreement mixed into the handshake, so later compromise of long-term keys does not decrypt past sessions.

### Security

- First-meeting interception remains outside the trust-on-first-use model. Compare fingerprints out of band before confirming verification.
- Sessions have no rekey; very long-lived links eventually exhaust nonces and reconnect instead. A documented limitation, not a silent one.

---

## [2.0.0-alpha.1] - 2026-08-24

### Summary

First v2 slice: the project rename, a social home screen, token-based themes, and local message retention.

### Breaking Changes

**The project was renamed and the handshake domain separator bumped, so both peers must run a v2 build.** Existing attestation records show a mismatch once and need re-verifying after the upgrade.

### Added

- **Home screen** — Carries identity, people online, recent conversations with unread badges, and pending verifications or mismatch warnings.
- **Token-based theme system** — Six built-in themes. The tokens in that system are the ones this website is built from.
- **Message retention** — Strictly local semantics: expiry removes your stored copy only, and says nothing about the peer's copy.

---

## [1.0.0] - 2026-08-24

### Summary

A three-pane keyboard-driven shell, cryptographic node identity, and contacts instead of addresses.

### Added

- **Cryptographic node identity** — Peers prove control of their claimed identity on every handshake.
- **Trust-on-first-use identity continuity** — Explicit states: unknown, identified, mismatch.
- **Contacts instead of addresses** — Local renames, and out-of-band fingerprint verification.
- **Honest security strip** — Plaintext transport was always labelled as carrying no encryption.

---

## [0.2.0] - 2026-08-24

### Summary

Measured latency, explicit trust decisions, and a reconnecting state in the contract.

---

## [0.1.0] - 2026-08-24

### Summary

Two nodes found each other over direct TCP, exchanged messages both ways, and kept their identity and history across restarts.