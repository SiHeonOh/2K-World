import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'

/**
 * Where league data lives:
 * 1. TWOK_DATA_DIR, if set (tests, power users);
 * 2. a folder you picked in settings (remembered in Electron's userData);
 * 3. run from the source folder: <project>/league-data (kept off GitHub);
 * 4. installed: Documents/2K World.
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.TWOK_DATA_DIR
  if (fromEnv) return resolve(fromEnv)
  const picked = readPointer()
  if (picked) return picked
  if (!app.isPackaged) return join(app.getAppPath(), 'league-data')
  return join(app.getPath('documents'), '2K World')
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The app's icon, for the window and the taskbar (resources/ next to the source, or beside an installed app). */
export function iconPath(): string {
  return join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'icon.ico')
}

/** Built-in defaults (templates, later prompts and personas). */
export function defaultsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'defaults') : join(app.getAppPath(), 'defaults')
}

const pointerFile = () => join(app.getPath('userData'), 'data-folder.json')

function readPointer(): string | null {
  try {
    const raw = JSON.parse(readFileSync(pointerFile(), 'utf8')) as { dataDir?: unknown }
    return typeof raw.dataDir === 'string' && isAbsolute(raw.dataDir) && existsSync(raw.dataDir) ? raw.dataDir : null
  } catch {
    return null
  }
}

/** Remembers a picked data folder; null goes back to the default. */
export function setDataDirPointer(dir: string | null): void {
  if (dir === null) {
    rmSync(pointerFile(), { force: true })
    return
  }
  ensureDir(app.getPath('userData'))
  writeFileSync(pointerFile(), JSON.stringify({ dataDir: dir }) + '\n', 'utf8')
}
