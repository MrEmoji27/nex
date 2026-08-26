// Retention-agreement state machine — pure functions, no I/O.
//
// Model (dream vision §4/§5 + honesty rule):
//   - Each node enforces ITS OWN policy on ITS OWN copies. Always. The
//     agreement never claims remote deletion.
//   - `theirs` is what the peer last announced; the shared promise both sides
//     can rely on is effective = min(mine, theirs).
//   - LOWERING your own policy needs nobody's permission (it only tightens the
//     promise). RAISING it proposes a wider shared window; the peer answers
//     ack/reject explicitly. Until acked, the promise stays where it was.
//   - Everything rides the encrypted channel as RetentionControl ops.
import type {
  PeerRetentionState,
  RetentionControl,
  RetentionPolicy,
} from "./contract"
import { effectiveRetention, retentionLooseness } from "./contract"

export interface MachineOutcome {
  /** State to persist for this peer after applying the outcome. */
  next: PeerRetentionState
  /** Control op to send, when the transition calls for one. */
  reply?: RetentionControl
  /** Human-readable summary for notices/UI. Factual, no overclaiming. */
  notice?: string
}

function retention(policy: RetentionPolicy, action: RetentionControl["action"]): RetentionControl {
  return { kind: "retention", action, policy }
}

/**
 * Local policy changed from `previous` to `current` while connected to this
 * peer. Tightening/equal → announce only. Raising → announce + propose.
 */
export function onLocalPolicyChange(
  state: PeerRetentionState | undefined,
  previous: RetentionPolicy,
  current: RetentionPolicy,
): MachineOutcome {
  const base: PeerRetentionState = { ...(state ?? {}) }
  const raised = retentionLooseness(current) > retentionLooseness(previous)
  if (!raised) {
    delete base.pendingOut
    return {
      next: base,
      reply: retention(current, "state"),
      notice: `you keep messages ${current} now`,
    }
  }
  base.pendingOut = current
  return {
    next: base,
    reply: retention(current, "propose"),
    notice: `proposed ${current} — waiting for their answer`,
  }
}

/** Peer announced (or re-announced on connect) its standing policy. */
export function onRemoteState(state: PeerRetentionState | undefined, policy: RetentionPolicy): MachineOutcome {
  const next: PeerRetentionState = { ...(state ?? {}), theirs: policy }
  // A pending raise that they now meet or exceed is satisfied by their announcement.
  if (next.pendingOut && retentionLooseness(next.pendingOut) <= retentionLooseness(policy)) {
    delete next.pendingOut
  }
  return { next }
}

/**
 * Peer proposed widening the shared window to `policy`.
 * Auto-acks when our own copies are already at least that loose.
 */
export function onRemotePropose(
  state: PeerRetentionState | undefined,
  mine: RetentionPolicy,
  policy: RetentionPolicy,
): MachineOutcome {
  const next: PeerRetentionState = { ...(state ?? {}) }
  if (retentionLooseness(policy) <= retentionLooseness(mine)) {
    next.theirs = policy
    next.agreedAt = Date.now()
    next.lastAction = "ack"
    return {
      next,
      reply: retention(policy, "ack"),
      notice: `${policy} agreed`,
    }
  }
  next.pendingIn = policy
  return { next, notice: `they propose keeping messages ${policy}` }
}

/** User accepted the pending inbound proposal. */
export function acceptRemoteProposal(
  state: PeerRetentionState | undefined,
): MachineOutcome {
  const next: PeerRetentionState = { ...(state ?? {}) }
  if (!next.pendingIn) return { next }
  const policy = next.pendingIn
  next.theirs = policy
  delete next.pendingIn
  next.agreedAt = Date.now()
  next.lastAction = "ack"
  return {
    next,
    reply: retention(policy, "ack"),
    notice: `shared keep window is now ${effectiveRetention(policy, policy)}`,
  }
}

/** User rejected the pending inbound proposal; disagreement stays visible. */
export function rejectRemoteProposal(state: PeerRetentionState | undefined): MachineOutcome {
  const next: PeerRetentionState = { ...(state ?? {}) }
  if (!next.pendingIn) return { next }
  const policy = next.pendingIn
  delete next.pendingIn
  next.lastAction = "reject"
  return {
    next,
    reply: retention(policy, "reject"),
    notice: "declined — the shared window stays as-is",
  }
}

/** Peer answered OUR pending raise. */
export function onRemoteAnswer(
  state: PeerRetentionState | undefined,
  action: "ack" | "reject",
  policy: RetentionPolicy,
): MachineOutcome {
  const next: PeerRetentionState = { ...(state ?? {}) }
  const proposed = next.pendingOut
  delete next.pendingOut
  if (action === "ack") {
    next.agreedAt = Date.now()
    next.lastAction = "ack"
    return { next, notice: `they accepted ${policy ?? proposed} — shared window widened` }
  }
  next.lastAction = "reject"
  return { next, notice: "they declined the wider keep window" }
}
