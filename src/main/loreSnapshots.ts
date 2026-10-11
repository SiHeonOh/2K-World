import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LoreSnapshotView } from '@shared/backups'
import { refuse } from '@data/rules'
import { atOf, renameRetrying, stampOf } from './backup'
import { AppError } from './errors'

/**
 * Snapshots of the whole lore folder, beside the database backups: a plain
 * folder copy (no zip library ships with the app, and a copy can be opened
 * and picked from by hand). The lore editor's own per-file backups
 * (backups/lore/) cover its saves; these cover the folder as a whole: the
 * app's other writers (reveal and suggestion approvals, files following
 * trades) and anything done to it outside the app.
 *
 * Each snapshot is backups/lore-snapshots/<time>-<reason>/ holding `lore/`
 * (the copy) and `info.json`.
 */

/** How many of each kind are kept (null: never removed by the app). */
export const LORE_KEEP: Readonly<Record<string, number | null>> = {
  manual: null,
  'season-start': 20,
  open: 10,
  'before-restore': 10,
}
const LORE_KEEP_OTHER = 5
export const loreKeepFor = (reason: string): number | null => (reason in LORE_KEEP ? LORE_KEEP[reason]! : LORE_KEEP_OTHER)

/** Always a fresh snapshot, even when nothing changed. */
const ALWAYS = new Set(['manual', 'before-restore'])

const ID_RE = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-([a-z0-9-]+)$/i
const INFO = 'info.json'

interface Info {
  reason: string
  at: string
  files: number
  bytes: number
  /** Over every file's path and bytes: an unchanged folder isn't copied again. */
  hash: string
}

interface Snapshot extends Info {
  id: string
}

export const snapshotsDir = (leagueFolder: string) => join(leagueFolder, 'backups', 'lore-snapshots')

/**
 * The lore folder's files, by path. Names starting with `.` (an editor's temp
 * files, an Obsidian vault's settings) and links (which could lead outside the
 * folder) aren't lore and aren't copied.
 */
function loreFiles(root: string): { rel: string; full: string }[] {
  const out: { rel: string; full: string }[] = []
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, path)
      else if (entry.isFile()) out.push({ rel: path, full })
    }
  }
  walk(root, '')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

function readInfo(dir: string): Info | null {
  try {
    const info = JSON.parse(readFileSync(join(dir, INFO), 'utf8')) as Partial<Info>
    if (typeof info.hash !== 'string' || typeof info.files !== 'number' || typeof info.bytes !== 'number') return null
    return info as Info
  } catch {
    return null
  }
}

/** Finished snapshots, oldest first. */
function snapshots(leagueFolder: string): Snapshot[] {
  const dir = snapshotsDir(leagueFolder)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((id): Snapshot[] => {
      const m = ID_RE.exec(id)
      if (!m) return []
      const info = readInfo(join(dir, id))
      return info ? [{ ...info, id, at: atOf(m[1]!), reason: m[2]!.toLowerCase() }] : []
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const localDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Copies a folder's files (as `loreFiles` sees them), keeping their times. */
function copyFiles(files: { rel: string; full: string }[], to: string): { bytes: number; hash: string } {
  const hash = createHash('sha256')
  let bytes = 0
  mkdirSync(to, { recursive: true })
  for (const f of files) {
    const data = readFileSync(f.full)
    const st = statSync(f.full)
    const dest = join(to, ...f.rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, data)
    utimesSync(dest, st.atime, st.mtime)
    hash.update(`${f.rel}\0${data.length}\0`).update(data)
    bytes += data.length
  }
  return { bytes, hash: hash.digest('hex') }
}

function fingerprint(files: { rel: string; full: string }[]): string {
  const hash = createHash('sha256')
  for (const f of files) {
    const data = readFileSync(f.full)
    hash.update(`${f.rel}\0${data.length}\0`).update(data)
  }
  return hash.digest('hex')
}

/**
 * Snapshots <league>/lore. Returns the snapshot's id, or null when none was
 * needed: no lore folder; for automatic reasons, the newest snapshot of the
 * same reason already holds exactly these files; for 'open', one was already
 * made today (local time).
 */
export function snapshotLore(leagueFolder: string, reason: string, now = Date.now()): string | null {
  const lore = join(leagueFolder, 'lore')
  if (!existsSync(lore)) return null
  const safeReason = reason.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 30) || 'manual'
  const dir = snapshotsDir(leagueFolder)
  let id: string
  let partial: string | null = null
  try {
    const files = loreFiles(lore)
    if (!ALWAYS.has(safeReason)) {
      const mine = snapshots(leagueFolder).filter((s) => s.reason === safeReason)
      if (safeReason === 'open' && mine.some((s) => localDay(Date.parse(s.at)) === localDay(now))) return null
      if (mine.length > 0 && mine[mine.length - 1]!.hash === fingerprint(files)) return null
    }
    let ms = now
    do id = `${stampOf(ms++)}-${safeReason}`
    while (existsSync(join(dir, id)) || existsSync(join(dir, `${id}.partial`)))
    // Written under a .partial name and renamed when complete, so a half-made copy is never listed.
    partial = join(dir, `${id}.partial`)
    const { bytes, hash } = copyFiles(files, join(partial, 'lore'))
    const info: Info = { reason: safeReason, at: new Date(now).toISOString(), files: files.length, bytes, hash }
    writeFileSync(join(partial, INFO), JSON.stringify(info, null, 2), 'utf8')
    renameRetrying(partial, join(dir, id))
  } catch (e) {
    if (partial) rmSync(partial, { recursive: true, force: true })
    throw new AppError('backup-failed', `lore snapshot failed: ${(e as Error).message}`)
  }
  try {
    pruneLoreSnapshots(leagueFolder, safeReason, id)
  } catch (e) {
    console.warn('[backup] pruning lore snapshots failed', e)
  }
  return id
}

/**
 * Removes the oldest snapshots of one kind past its limit, and half-made
 * ones. `made` is the snapshot just made: never removed, even when the PC's
 * clock is behind the times in older names and it sorts oldest.
 */
export function pruneLoreSnapshots(leagueFolder: string, reason: string, made?: string): string[] {
  const dir = snapshotsDir(leagueFolder)
  if (!existsSync(dir)) return []
  // Snapshots are made in one synchronous step, so a .partial here is left from a crash.
  for (const name of readdirSync(dir)) if (name.endsWith('.partial')) rmSync(join(dir, name), { recursive: true, force: true })
  const keep = loreKeepFor(reason)
  if (keep === null) return []
  const list = snapshots(leagueFolder).filter((s) => s.reason === reason)
  const removable = list.filter((s) => s.id !== made)
  const removed: string[] = []
  for (const old of removable.slice(0, Math.max(0, list.length - keep))) {
    rmSync(join(dir, old.id), { recursive: true, force: true })
    removed.push(old.id)
  }
  return removed
}

export function listLoreSnapshots(leagueFolder: string): LoreSnapshotView[] {
  return snapshots(leagueFolder)
    .reverse()
    .map((s) => ({ id: s.id, at: s.at, reason: s.reason, files: s.files, bytes: s.bytes, keep: loreKeepFor(s.reason) }))
}

/** A snapshot's copy of the lore folder, from its id (never a path). */
export function loreSnapshotPath(leagueFolder: string, id: string): string {
  const dir = join(snapshotsDir(leagueFolder), id)
  if (!ID_RE.test(id) || readInfo(dir) === null || !existsSync(join(dir, 'lore'))) refuse('snapshot-unknown')
  return join(dir, 'lore')
}

/** Whether anything (a dangling link too) is at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Moves what snapshots don't copy (names starting with `.` and links, at any
 * depth; a folder of them goes whole) from the replaced lore folder to the
 * same place in the restored one, making its parent folders. Returns what
 * couldn't move: the name is taken there, or the move failed (a lock).
 */
function moveUncopied(from: string, to: string): string[] {
  const stuck: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(full, path)
        continue
      }
      if (entry.isFile() && !entry.name.startsWith('.')) continue
      const dest = join(to, ...path.split('/'))
      try {
        if (present(dest)) throw new Error('the name is taken in the restored folder')
        mkdirSync(dirname(dest), { recursive: true })
        renameRetrying(full, dest)
      } catch (e) {
        console.warn(`[backup] could not move ${path} into the restored lore folder`, e)
        stuck.push(path)
      }
    }
  }
  walk(from, '')
  return stuck
}

/**
 * Puts a snapshot in place of the lore folder. The folder as it is goes into
 * a 'before-restore' snapshot first (so this can be undone the same way;
 * without it nothing changes), and the swap is two folder renames: a file
 * held open elsewhere refuses it (`lore-busy`) and leaves everything as it
 * was. Entries snapshots don't copy (names starting with `.`, such as an
 * Obsidian vault's settings or a note kept out of sight, and links), at any
 * depth, move into the restored folder at the same place. The folder it
 * replaced is removed only when everything left in it is in the
 * 'before-restore' snapshot; otherwise it stays as `kept`
 * (lore.replaced-<tag> in the league folder) for you to sort out.
 * A lore folder that is itself a link (a junction to a vault kept elsewhere)
 * is refused (`lore-linked`): the swap would put a plain folder in its place.
 */
export function restoreLoreSnapshot(leagueFolder: string, id: string, now = Date.now()): { safety: string | null; kept: string | null } {
  const source = loreSnapshotPath(leagueFolder, id)
  const lore = join(leagueFolder, 'lore')
  const had = present(lore)
  if (had && lstatSync(lore).isSymbolicLink()) refuse('lore-linked')
  const safety = had ? snapshotLore(leagueFolder, 'before-restore', now) : null
  // Never replaced without a copy of what it replaces.
  const held = safety === null ? null : readInfo(join(snapshotsDir(leagueFolder), safety))
  if (had && (held === null || !existsSync(join(snapshotsDir(leagueFolder), safety!, 'lore')))) {
    throw new AppError('backup-failed', 'the before-restore snapshot is missing')
  }
  const tag = `${process.pid}-${now}`
  const incoming = join(leagueFolder, `lore.restoring-${tag}`)
  const replaced = join(leagueFolder, `lore.replaced-${tag}`)
  try {
    copyFiles(loreFiles(source), incoming)
  } catch (e) {
    rmSync(incoming, { recursive: true, force: true })
    throw new AppError('backup-failed', `could not copy the snapshot: ${(e as Error).message}`)
  }
  try {
    if (had) renameRetrying(lore, replaced)
  } catch {
    rmSync(incoming, { recursive: true, force: true })
    refuse('lore-busy')
  }
  try {
    renameRetrying(incoming, lore)
  } catch {
    try {
      if (had) renameRetrying(replaced, lore)
    } catch (e) {
      // Still whole in both places: the folder under its parked name, and the 'before-restore' snapshot.
      console.error(`[backup] the lore folder is parked at ${replaced}`, e)
    }
    rmSync(incoming, { recursive: true, force: true })
    refuse('lore-busy')
  }
  if (!had) return { safety, kept: null }
  // The restore has happened: from here on nothing throws, and anything that can't be settled stays where it is.
  let whole = false
  try {
    whole = moveUncopied(replaced, lore).length === 0 && fingerprint(loreFiles(replaced)) === held!.hash
  } catch (e) {
    console.warn(`[backup] could not look over ${replaced}`, e)
  }
  if (!whole) {
    console.warn(`[backup] the replaced lore folder is kept at ${replaced}: not everything in it is in the snapshot`)
    return { safety, kept: replaced }
  }
  try {
    rmSync(replaced, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (e) {
    // What's left of it is all in the 'before-restore' snapshot.
    console.warn(`[backup] could not remove ${replaced}`, e)
  }
  return { safety, kept: null }
}
