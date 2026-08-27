// Every command the interface knows, in one place.
//
// This exists because the same list was previously implied in three places and
// written down in none: a chain of else-ifs that dispatched them, a footer hint
// that named a handful, and the release notes. Nothing could show the user what
// was available, and an unknown command could only be reported, never
// suggested.
//
// Ordered by what a new node needs first — finding someone, then talking to
// them — because that order is also the order the palette shows them in.

/**
 * The service `/rendezvous on <handle>` uses when no URL is given.
 *
 * Rendezvous is optional and the protocol is not tied to any host, so this is a
 * convenience and not a dependency: point it anywhere with the two-argument
 * form, and whatever was used last is preferred over this default.
 */
export const DEFAULT_RENDEZVOUS_URL = "https://nex-rendezvous.onrender.com"

export interface CommandSpec {
  name: string
  /** Arguments, as a person would type them. Empty when it takes none. */
  args?: string
  /** One line. Shown in the palette next to the name. */
  summary: string
  /** Grouping for the palette header. */
  group: "finding people" | "people" | "rooms & voice" | "your node"
}

export const COMMANDS: readonly CommandSpec[] = [
  // ---- finding people ----
  {
    name: "rendezvous",
    args: "on <handle> [url] | off",
    summary: "publish your name so people can find you across the internet",
    group: "finding people",
  },
  { name: "find", args: "<handle>", summary: "is anyone here by that name?", group: "finding people" },
  { name: "ask", args: "<handle>", summary: "ask them for an introduction", group: "finding people" },
  { name: "accept", args: "[id]", summary: "accept an introduction someone asked for", group: "finding people" },
  { name: "ignore", args: "[id]", summary: "decline one", group: "finding people" },
  { name: "invite", args: "[host]", summary: "print a code to paste to someone directly", group: "finding people" },
  { name: "connect", args: "<host:port>", summary: "dial an address you already know", group: "finding people" },

  // ---- people ----
  { name: "peers", summary: "who you are connected to", group: "people" },
  { name: "ping", summary: "round-trip time to the selected peer", group: "people" },
  { name: "verify", summary: "compare fingerprints with the selected peer", group: "people" },
  { name: "trust", args: "on|off", summary: "mark the selected peer verified, or not", group: "people" },
  { name: "rename", args: "<name>", summary: "rename the selected contact, in your copy only", group: "people" },
  { name: "disconnect", summary: "drop the selected peer", group: "people" },

  // ---- rooms & voice ----
  { name: "room", args: "<name>[:peer,peer]", summary: "host a room and invite people", group: "rooms & voice" },
  { name: "join", args: "<id>", summary: "accept a room invitation", group: "rooms & voice" },
  { name: "rooms", summary: "rooms you are in", group: "rooms & voice" },
  { name: "say", args: "<text>", summary: "send to the active room", group: "rooms & voice" },
  { name: "leave", args: "<id|name>", summary: "leave a room", group: "rooms & voice" },
  { name: "close", args: "<id|name>", summary: "close a room you host, for everyone", group: "rooms & voice" },
  { name: "voice", summary: "join or leave the room's voice channel", group: "rooms & voice" },
  { name: "mute", summary: "mute or unmute yourself", group: "rooms & voice" },

  // ---- your node ----
  { name: "name", args: "[you]", summary: "the name peers see when they meet you", group: "your node" },
  { name: "net", summary: "which route each connection is using", group: "your node" },
  { name: "stun", summary: "the address the internet sees you at", group: "your node" },
  { name: "retention", args: "24h|7d|forever", summary: "how long messages are kept", group: "your node" },
  { name: "theme", args: "[name]", summary: "change the colours", group: "your node" },
  { name: "themes", summary: "list the themes", group: "your node" },
  { name: "help", args: "[command]", summary: "this list", group: "your node" },
]

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]))

export function findCommand(name: string): CommandSpec | undefined {
  return BY_NAME.get(name)
}

/** Commands whose name starts with `prefix`, in registry order. */
export function matchCommands(prefix: string): CommandSpec[] {
  const needle = prefix.toLowerCase()
  if (!needle) return [...COMMANDS]
  return COMMANDS.filter((c) => c.name.startsWith(needle))
}

/** "/find <handle>" — how a person would type it. */
export function usage(spec: CommandSpec): string {
  return spec.args ? `/${spec.name} ${spec.args}` : `/${spec.name}`
}

/**
 * The closest command to something that was not recognised.
 *
 * Edit distance over a list this small is cheaper than the user retyping, and
 * "unknown command" alone is the least useful true statement an interface can
 * make.
 */
export function suggest(name: string): CommandSpec | undefined {
  const needle = name.toLowerCase()
  if (!needle) return undefined
  // A prefix is not a typo, it is an unfinished word, and edit distance scores
  // it badly: "na" is two edits from "name" and would be rejected as unrelated.
  const prefix = COMMANDS.find((c) => c.name.startsWith(needle))
  if (prefix) return prefix
  let best: CommandSpec | undefined
  let bestScore = Infinity
  for (const spec of COMMANDS) {
    const score = distance(needle, spec.name)
    if (score < bestScore) {
      bestScore = score
      best = spec
    }
  }
  // Beyond a third of the word being wrong it is a different word, not a typo.
  return bestScore <= Math.max(1, Math.floor(needle.length / 3)) ? best : undefined
}

function distance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let prev = Array.from({ length: cols }, (_, i) => i)
  for (let i = 1; i < rows; i++) {
    const row = [i, ...Array<number>(cols - 1).fill(0)]
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
    }
    prev = row
  }
  return prev[cols - 1]!
}
