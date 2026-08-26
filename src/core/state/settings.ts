// Local preferences store: <dataDir>/settings.json (v2 — vision §12/§15/§16).
import type { Settings, SettingsStore } from "../contract.ts"
import { DEFAULT_SETTINGS } from "../contract"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** In-process serialization so concurrent saves never race the same file. */
const writeLocks = new Map<string, Promise<unknown>>()

export async function writeLocked(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = writeLocks.get(filePath) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(write)
  writeLocks.set(filePath, current)
  try {
    await current
  } finally {
    if (writeLocks.get(filePath) === current) writeLocks.delete(filePath)
  }
}

/**
 * JSON settings file with defaults merged on load. Unknown keys are preserved
 * so older/newer builds do not silently drop preferences they don't know.
 */
export class FileSettingsStore implements SettingsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Settings> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<Settings>
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ...DEFAULT_SETTINGS }
      }
      return { ...DEFAULT_SETTINGS, ...parsed }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  async save(settings: Settings): Promise<void> {
    await writeLocked(this.filePath, async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(settings, null, 2) + "\n", "utf8")
    })
  }
}
