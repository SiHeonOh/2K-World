import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { importMappingSchema, type ImportMapping } from '@shared/import'

/** App-wide settings, kept in the data folder as settings.json. */
const settingsSchema = z.object({
  version: z.literal(1),
  lastLeague: z.string().nullable(),
  /** Most recent first; matched by header signature on the next import. */
  importMappings: z.array(importMappingSchema).max(20),
  /** Where 2K's screenshots land (e.g. Steam's screenshots folder for the game); game day takes the newest from here. */
  screenshotFolder: z.string().nullable().default(null),
})

export type Settings = z.infer<typeof settingsSchema>

const DEFAULTS: Settings = { version: 1, lastLeague: null, importMappings: [], screenshotFolder: null }

/** Antivirus and sync clients briefly lock files on Windows; try a few times. */
function retry<T>(fn: () => T, attempts = 10): T {
  for (let i = 1; ; i++) {
    try {
      return fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= attempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

export class SettingsStore {
  private cache: Settings | null = null

  constructor(private readonly dataDir: string) {}

  get file(): string {
    return join(this.dataDir, 'settings.json')
  }

  /** Never throws: an unreadable file is set aside and defaults are used. */
  read(): Settings {
    if (this.cache) return this.cache
    let settings = structuredClone(DEFAULTS)
    if (existsSync(this.file)) {
      let parsed: Settings | null = null
      try {
        const result = settingsSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
        if (result.success) parsed = result.data
      } catch {
        parsed = null
      }
      if (parsed) settings = parsed
      else {
        try {
          renameSync(this.file, `${this.file}.invalid-${Date.now()}`)
        } catch (e) {
          console.warn('[settings] could not set aside an unreadable settings.json', e)
        }
      }
    }
    this.cache = settings
    return settings
  }

  update(change: (s: Settings) => void): Settings {
    const next = structuredClone(this.read())
    change(next)
    const valid = settingsSchema.parse(next)
    // Write then rename, so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`
    try {
      retry(() => writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', 'utf8'))
      retry(() => renameSync(tmp, this.file))
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    this.cache = valid
    return valid
  }

  rememberMapping(mapping: ImportMapping, signature: (m: ImportMapping) => string): void {
    this.update((s) => {
      const key = signature(mapping)
      s.importMappings = [mapping, ...s.importMappings.filter((m) => signature(m) !== key)].slice(0, 20)
    })
  }
}
