// Retention-agreement store: <dataDir>/agreements.json (--plaintext tier only).
// In encrypted tiers the vault-wrapped variant lives in encrypted-stores.ts.
import type { PeerRetentionState, RetentionStore } from "../contract.ts"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { writeLocked } from "./settings"

function empty(): Record<string, PeerRetentionState> {
  return {}
}

export class FileRetentionStore implements RetentionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Record<string, PeerRetentionState>> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, PeerRetentionState>
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty()
      return parsed
    } catch {
      return empty()
    }
  }

  async save(all: Record<string, PeerRetentionState>): Promise<void> {
    await writeLocked(this.filePath, async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(all, null, 2) + "\n", "utf8")
    })
  }
}
