import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupKind, type BackupView } from '@shared/backups'
import type { Db } from '@data/db'
import { MIGRATIONS } from '@data/migrations'
import { refuse } from '@data/rules'
import { AppError } from './errors'

/**
 * How many copies of each kind are kept (null: the app never removes them).
 * Kinds are pruned apart, so a burst of draft swaps or settings saves can't
 * push out your own backups, a season's milestones, or the copy made before
 * an upgrade or a restore.
 */
export const KEEP: Readonly<Record<string, number | null>> = {
  manual: null,
  'season-start': 20,
  'next-season': 20,
  'playoffs-start': 10,
  'playoffs-end': 10,
  'protection-end': 10,
  'draft-end': 10,
  upgrade: 10,
  'before-restore': 10,
  open: 10,
}
/** Every other step (draft swaps, settings saves, roster edits, vetoes, a cleared round, steps added later), per step. */
export const KEEP_OTHER = 5

export const keepFor = (reason: string): number | null => {
  const kind = backupKind(reason)
  return kind in KEEP ? KEEP[kind]! : KEEP_OTHER
}

/** Steps that come in bursts get at most one copy in this long: the state from before the burst began. */
export const COALESCE_MS = 5 * 60_000
const COALESCED = new Set(['draft-swap', 'config', 'settings', 'roster-edit'])

/** Always a fresh copy, even when nothing changed: yours, and what an upgrade or a restore replaces. */
const ALWAYS = new Set(['manual', 'upgrade', 'before-restore'])

/** <time>-<reason>-e<newest event id>.sqlite; the time is UTC with : and . as -. */
const FILE_RE = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-([a-z0-9-]+?)-e(\d+)\.sqlite$/i

interface BackupFile {
  name: string
  at: string
  reason: string
  marker: number
}

export const stampOf = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-')
export const atOf = (stamp: string) => stamp.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, '$1:$2:$3.$4Z')

/** A backup the app made, from its file name; null for any other file (one whose time isn't a real time included). */
function parse(name: string): BackupFile | null {
  const m = FILE_RE.exec(name)
  if (!m || Number.isNaN(Date.parse(atOf(m[1]!)))) return null
  return { name, at: atOf(m[1]!), reason: m[2]!.toLowerCase(), marker: Number(m[3]) }
}

const backupDir = (leagueFolder: string) => join(leagueFolder, 'backups')

/** The backups in a folder that the app made, oldest first. */
function backupFiles(dir: string): BackupFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map(parse)
    .filter((f): f is BackupFile => f !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The newest event id: a backup is only worth making if the league changed since the last one. */
function marker(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get() as { m: number }).m
}

/**
 * Copies a league database into <league>/backups with `VACUUM INTO`, which
 * makes a consistent, compact copy even while the league is open (WAL
 * included). File names carry the reason and the league's latest event id,
 * so repeated attempts at a step that keeps being refused don't pile up
 * copies of the same state. Returns the file, or null when no copy was needed.
 * `fresh` always makes one, as for your own backups (a step that throws
 * something away, such as cards expiring, isn't covered by a burst's copy).
 */
export function backupLeague(db: Db, leagueFolder: string, reason: string, now = Date.now(), options: { fresh?: boolean } = {}): string | null {
  const dir = backupDir(leagueFolder)
  const safeReason = reason.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 30) || 'manual'
  const kind = backupKind(safeReason)
  let file: string
  try {
    const at = marker(db)
    mkdirSync(dir, { recursive: true })
    const mine = backupFiles(dir).filter((f) => f.reason === safeReason)
    if (!ALWAYS.has(kind) && !options.fresh) {
      if (mine.some((f) => f.marker === at)) return null
      if (COALESCED.has(kind) && mine.some((f) => Date.parse(f.at) <= now && now - Date.parse(f.at) < COALESCE_MS)) return null
    }
    let ms = now
    do file = join(dir, `${stampOf(ms++)}-${safeReason}-e${at}.sqlite`)
    while (existsSync(file))
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  } catch (e) {
    throw new AppError('backup-failed', `backup failed: ${(e as Error).message}`)
  }
  // The copy is made; a file that won't go (locked for a moment) goes next time.
  try {
    pruneBackups(dir, kind, basename(file))
  } catch (e) {
    console.warn('[backup] pruning failed', e)
  }
  return file
}

/**
 * Removes the oldest copies of one kind past its limit (manual ones never),
 * oldest by the time in their names. Each copy prunes only its own kind, so
 * what an older app kept (under its own limits) stays until that kind is
 * written again. `made` is the copy just made: never removed, even when the
 * PC's clock is behind the times in older names and it sorts oldest.
 */
export function pruneBackups(dir: string, kind: string, made?: string): string[] {
  const keep = keepFor(kind)
  if (keep === null) return []
  const files = backupFiles(dir).filter((f) => backupKind(f.reason) === kind)
  const removable = files.filter((f) => f.name !== made)
  const removed: string[] = []
  for (const old of removable.slice(0, Math.max(0, files.length - keep))) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(join(dir, old.name + suffix), { force: true })
    removed.push(old.name)
  }
  return removed
}

/** What a backup file holds, read through a short-lived read-only handle. */
export function peekBackup(file: string): { version: number | null; season: string | null; restorable: boolean } {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < 1 || version > MIGRATIONS.length) return { version, season: null, restorable: false }
    const config = db.prepare('SELECT COUNT(*) AS n FROM league_config').get() as { n: number }
    const season = db.prepare('SELECT label FROM seasons ORDER BY id DESC LIMIT 1').get() as { label: string } | undefined
    return { version, season: season?.label ?? null, restorable: config.n > 0 }
  } catch {
    return { version: null, season: null, restorable: false }
  } finally {
    try {
      db?.close()
    } catch {
      // never opened
    }
  }
}

/** Every backup of a league, newest first. */
export function listBackups(leagueFolder: string): BackupView[] {
  const dir = backupDir(leagueFolder)
  return backupFiles(dir)
    .reverse()
    .flatMap((f) => {
      let bytes: number
      try {
        bytes = statSync(join(dir, f.name)).size
      } catch {
        return []
      }
      return [{ id: f.name, at: f.at, reason: f.reason, bytes, ...peekBackup(join(dir, f.name)), keep: keepFor(f.reason) }]
    })
}

/** A backup's path from its id (a file name the app made, never a path). */
export function backupPath(leagueFolder: string, id: string): string {
  const file = join(backupDir(leagueFolder), id)
  if (parse(id) === null || !existsSync(file)) refuse('backup-unknown')
  return file
}

/** Waits a moment without returning to the event loop (a restore is one synchronous step). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Renames, trying again for a moment while Windows holds the file (antivirus, indexer). */
export function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      pause(100)
    }
  }
}

/**
 * Puts a copy of `source` in place of the database file. Its handle must be
 * closed. A WAL or journal left beside the old file goes first: it would be
 * read into the new one.
 */
export function replaceDatabase(dbFile: string, source: string): void {
  const temp = `${dbFile}.restoring-${process.pid}-${Date.now()}`
  copyFileSync(source, temp)
  try {
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(dbFile + suffix, { force: true })
    renameRetrying(temp, dbFile)
  } catch (e) {
    rmSync(temp, { force: true })
    throw e
  }
}
