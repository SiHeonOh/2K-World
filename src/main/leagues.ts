import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CreateLeagueInput, CreateLeagueResult } from '@shared/api'
import {
  isValidSlug,
  slugKey,
  type FolderInspection,
  type LeagueListing,
  type LeagueSnapshot,
} from '@shared/league'
import { checkSetup } from '@shared/setup'
import { TEMPLATE_FORMAT, TEMPLATE_FORMAT_VERSION, type TemplateFile } from '@shared/template'
import type { RestoreResult, SchoolFolderMove } from '@shared/backups'
import { openDb, type Db } from '@data/db'
import { currentSeason, factsStamp, listPlayers, listSeasons, listTeams, loadConfig, peekLeague, seedLeague } from '@data/league'
import { MIGRATIONS } from '@data/migrations'
import { refuse } from '@data/rules'
import { AppError } from './errors'
import type { ImportService } from './importer'
import type { SettingsStore } from './settings'
import type { TemplateService } from './templates'
import { backupLeague, backupPath, peekBackup, replaceDatabase } from './backup'
import { followSchoolNames, formerSchoolNames } from './leagueSettings'
import { snapshotLore } from './loreSnapshots'

const DB_FILE = 'league.sqlite'

/** Deleted leagues are moved here, inside the data folder. Its leading _ keeps it off the league list. */
export const DELETED_DIR = '_deleted'

/** A pause for a retry, in a step that must stay synchronous (it runs inside one IPC call). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** This PC's time as a folder-safe stamp: 2026-10-11_231502. */
function localStamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

/** Steps that also snapshot the lore folder (the first open of a day does too). */
const LORE_POINTS = new Set(['manual', 'season-start'])

/** Removes files Windows may briefly lock (antivirus, indexer). Never throws. */
function removeQuietly(path: string, recursive = false): void {
  try {
    rmSync(path, { force: true, recursive, maxRetries: 5, retryDelay: 100 })
  } catch (e) {
    console.warn(`[leagues] could not remove ${path}`, e)
  }
}

/**
 * League folders in the data folder. Only the league being viewed keeps an
 * open database handle; listing peeks through short-lived read-only handles.
 */
export class LeagueService {
  private active: { key: string; slug: string; db: Db } | null = null
  private backedUp = new Set<string>()
  private hooks: LeagueHooks = {}

  constructor(
    private readonly dataDir: string,
    private readonly appVersion: string,
    private readonly settings: SettingsStore,
    private readonly templates: TemplateService,
    private readonly importer: ImportService,
  ) {}

  list(): LeagueListing[] {
    if (!existsSync(this.dataDir)) return []
    const out: LeagueListing[] = []
    for (const slug of readdirSync(this.dataDir).sort()) {
      if (!isValidSlug(slug)) continue
      const folder = join(this.dataDir, slug)
      try {
        if (!statSync(folder).isDirectory()) continue
      } catch {
        continue
      }
      const file = join(folder, DB_FILE)
      const hasDb = existsSync(file)
      const hasLore = existsSync(join(folder, 'lore'))
      if (!hasDb && !hasLore) continue
      const listing: LeagueListing = { slug, name: null, hasDb, hasLore, teams: 0, players: 0, season: null }
      if (hasDb) {
        try {
          const peek = this.isActive(slug) ? this.peekActive() : peekLeague(file)
          Object.assign(listing, { name: peek.name, teams: peek.teams, players: peek.players, season: peek.season })
        } catch (e) {
          listing.error = (e as Error).message
        }
      }
      out.push(listing)
    }
    return out
  }

  inspect(slug: string): FolderInspection {
    const folder = this.folder(slug)
    const exists = existsSync(folder)
    const teamsDir = join(folder, 'lore', 'teams')
    let loreTeams: string[] = []
    try {
      loreTeams = existsSync(teamsDir)
        ? readdirSync(teamsDir).filter((n) => !n.startsWith('_') && statSync(join(teamsDir, n)).isDirectory())
        : []
    } catch {
      loreTeams = []
    }
    return { slug, exists, hasDb: existsSync(join(folder, DB_FILE)), loreTeams }
  }

  create(input: CreateLeagueInput): CreateLeagueResult {
    const folder = this.folder(input.slug)
    const file = join(folder, DB_FILE)
    if (existsSync(file)) throw new AppError('league-exists', `${input.slug} already has a league`)
    const checked = checkSetup(input.setup)
    if (!checked.ok) throw new AppError('invalid-setup', 'setup has errors', { issues: checked.issues })

    const createdFolder = !existsSync(folder)
    mkdirSync(folder, { recursive: true })
    let db: Db | null = null
    try {
      db = openDb(file)
      seedLeague(db, checked.setup)
    } catch (e) {
      // Clean up, but never let a cleanup failure hide the real error.
      try {
        db?.close()
      } catch {
        // already closed
      }
      for (const suffix of ['', '-wal', '-shm', '-journal']) removeQuietly(file + suffix)
      if (createdFolder) removeQuietly(folder, true)
      throw e
    }
    this.setActive(input.slug, db)

    // The league exists now. What follows is best effort: a failure here must
    // not make the user retry (which would hit league-exists).
    let templatePath: string | null = null
    if (input.saveTemplate) {
      try {
        templatePath = this.exportTemplate(input.slug, input.saveTemplate).path
      } catch (e) {
        console.warn('[leagues] template save failed', e)
      }
    }
    try {
      if (input.importMapping) this.importer.remember(input.importMapping)
      this.settings.update((s) => {
        s.lastLeague = input.slug
      })
    } catch (e) {
      console.warn('[leagues] settings update failed', e)
    }
    return { slug: input.slug, warnings: checked.issues, templatePath }
  }

  snapshot(slug: string): LeagueSnapshot {
    const db = this.db(slug)
    const { config, version } = loadConfig(db)
    return {
      slug: this.active!.slug,
      config,
      configVersion: version,
      season: currentSeason(db),
      seasons: listSeasons(db),
      teams: listTeams(db),
      players: listPlayers(db),
      stamp: factsStamp(db),
    }
  }

  exportTemplate(slug: string, options: { name: string; includePlayers: boolean }): { path: string } {
    const snap = this.snapshot(slug)
    const template: TemplateFile = {
      format: TEMPLATE_FORMAT,
      formatVersion: TEMPLATE_FORMAT_VERSION,
      meta: { name: options.name, description: '', exportedAt: new Date().toISOString(), appVersion: this.appVersion },
      config: snap.config,
      teams: snap.teams,
      ...(options.includePlayers ? { players: snap.players.map(({ heightCm: _, ...p }) => p) } : {}),
    }
    return { path: this.templates.saveUser(template, snap.slug) }
  }

  /** Called when a league's database opens, and just before it closes (e.g. to start and stop its job queue). */
  onLifecycle(hooks: LeagueHooks): void {
    this.hooks = hooks
  }

  /** The open database of a league (opening it, with a first-open backup, if needed). */
  dbFor(slug: string): Db {
    return this.db(slug)
  }

  folderOf(slug: string): string {
    return this.folder(this.isActive(slug) ? this.active!.slug : slug)
  }

  /**
   * A backup before a step; null when nothing changed since the last one for
   * the same step (unless `fresh`: see backupLeague). Your own backups and a
   * season's start snapshot the lore folder too (a failed snapshot fails
   * only your own backup).
   */
  backup(slug: string, reason: string, options: { fresh?: boolean } = {}): string | null {
    const file = backupLeague(this.db(slug), this.folderOf(slug), reason, Date.now(), options)
    if (LORE_POINTS.has(reason)) {
      try {
        snapshotLore(this.folderOf(slug), reason)
      } catch (e) {
        if (reason === 'manual') throw e
        console.warn('[leagues] lore snapshot failed', e)
      }
    }
    return file
  }

  /**
   * Puts a database backup in place of the league's database. What's there
   * now is backed up first ('before-restore', with a lore snapshot), then the
   * league closes as it does when you switch leagues: its AI queue stops (a
   * running Claude call is ended and its answer dropped; the 'before-restore'
   * copy holds that job as a crash would, so it runs again if that copy is
   * restored) and the handle closes. It opens again from the backup, upgraded
   * if it's older (after an 'upgrade' copy), and the jobs waiting in it carry
   * on. The lore folder is left alone, apart from player files following the
   * restored rosters as on any open, and the folders of schools renamed since
   * the backup going back to the names it has (see followSchoolNames).
   *
   * If the backup won't open, the league goes back to what it was.
   */
  restore(slug: string, id: string): RestoreResult {
    const db = this.db(slug)
    const onDisk = this.active!.slug
    const folder = this.folder(onDisk)
    const file = join(folder, DB_FILE)
    const source = backupPath(folder, id)
    // Staged first: the safety copy below may prune the very backup being restored (the oldest of its kind).
    const staged = `${file}.incoming-${process.pid}-${Date.now()}`
    try {
      copyFileSync(source, staged)
      const peek = peekBackup(staged)
      if (peek.version !== null && peek.version > MIGRATIONS.length) refuse('backup-too-new')
      if (!peek.restorable) refuse('backup-unreadable')
      // Never replaced without a copy of what it replaces.
      const safety = backupLeague(db, folder, 'before-restore')
      if (safety === null || !existsSync(safety)) throw new AppError('backup-failed', 'the before-restore copy is missing')
      const namesBefore = new Map(listTeams(db).map((t) => [t.id, t.shortName]))
      try {
        snapshotLore(folder, 'before-restore')
      } catch (e) {
        console.warn('[leagues] lore snapshot before a restore failed', e)
      }
      // Reopening isn't a first open: the restored state already is a backup.
      this.backedUp.add(slugKey(onDisk))
      this.closeAll()
      try {
        replaceDatabase(file, staged)
        // It must read as a league, not just open.
        const restored = this.db(onDisk)
        loadConfig(restored)
        currentSeason(restored)
      } catch (e) {
        console.error('[leagues] restore failed; putting the league back', e)
        try {
          this.closeAll()
          replaceDatabase(file, safety)
          this.db(onDisk)
        } catch (e2) {
          console.error('[leagues] putting the league back failed', e2)
        }
        refuse('restore-failed', { message: (e as Error).message.slice(0, 200) })
      }
      // Schools renamed since the backup: their lore follows the names it has, where those are free.
      let schools: SchoolFolderMove[] = []
      try {
        const restored = this.db(onDisk)
        const former = formerSchoolNames(restored)
        for (const [teamId, name] of namesBefore) former.set(teamId, [name, ...(former.get(teamId) ?? [])])
        schools = followSchoolNames(restored, folder, former)
      } catch (e) {
        console.warn('[leagues] moving school lore folders after a restore failed', e)
      }
      return { safety: basename(safety), upgraded: peek.version! < MIGRATIONS.length, schools }
    } finally {
      removeQuietly(staged)
    }
  }

  /**
   * Deletes a league by moving its whole folder (database, lore, backups,
   * screenshots, exports) to `_deleted/<time>-<folder>` in the data folder,
   * so it can be put back by moving it out again. An open league closes first,
   * as on a league switch (its AI queue stops). A folder another program holds
   * a file of (Obsidian, Explorer, Excel) is refused and left as it was.
   */
  remove(slug: string): { movedTo: string } {
    const onDisk = existsSync(this.dataDir) ? (readdirSync(this.dataDir).find((n) => slugKey(n) === slugKey(slug)) ?? null) : null
    if (onDisk === null) throw new AppError('not-found', `${slug} has no league folder`)
    const folder = this.folder(onDisk)
    if (!statSync(folder).isDirectory()) throw new AppError('not-found', `${slug} is not a folder`)
    if (this.isActive(onDisk)) this.closeAll()
    const trash = join(this.dataDir, DELETED_DIR)
    mkdirSync(trash, { recursive: true })
    let name = `${localStamp()}-${onDisk}`
    for (let n = 2; existsSync(join(trash, name)); n++) name = `${localStamp()}-${onDisk}-${n}`
    // Windows can hold a just-closed file for a moment (antivirus, the indexer): a few tries before giving up.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(folder, join(trash, name))
        break
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if ((code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && attempt < 5) {
          pause(200)
          continue
        }
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new AppError('league-busy', `${onDisk} is in use: ${(e as Error).message}`)
        throw e
      }
    }
    this.backedUp.delete(slugKey(onDisk))
    try {
      this.settings.update((s) => {
        if (s.lastLeague !== null && slugKey(s.lastLeague) === slugKey(onDisk)) s.lastLeague = null
      })
    } catch (e) {
      console.warn('[leagues] settings update after a delete failed', e)
    }
    return { movedTo: `${DELETED_DIR}/${name}` }
  }

  closeAll(): void {
    if (this.active) this.close(this.active)
    this.active = null
  }

  private close(entry: { slug: string; db: Db }): void {
    try {
      this.hooks.close?.(entry.slug, entry.db)
    } catch (e) {
      console.warn('[leagues] close hook failed', e)
    }
    entry.db.close()
  }

  private isActive(slug: string): boolean {
    return this.active?.key === slugKey(slug)
  }

  private peekActive() {
    const db = this.active!.db
    const { config } = loadConfig(db)
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return { name: config.league.name, teams: count('teams'), players: count('players'), season: currentSeason(db).label }
  }

  private setActive(slug: string, db: Db): void {
    if (this.active && this.active.db !== db) this.close(this.active)
    this.active = { key: slugKey(slug), slug, db }
  }

  private db(slug: string): Db {
    if (this.isActive(slug)) return this.active!.db
    const folder = this.folder(slug)
    const file = join(folder, DB_FILE)
    if (!existsSync(file)) throw new AppError('not-found', `${slug} has no league`)
    // Use the folder's on-disk spelling, so 'Inter' and 'inter' are one league.
    const onDisk = readdirSync(this.dataDir).find((n) => slugKey(n) === slugKey(slug)) ?? slug
    const leagueFolder = join(this.dataDir, onDisk)
    // A database from an older app is copied as it is before it's upgraded: with no copy, it isn't upgraded (or opened).
    const beforeMigrate = (d: Db, from: number) => {
      const copy = backupLeague(d, leagueFolder, `upgrade-v${from}`)
      if (copy === null || !existsSync(copy)) throw new AppError('backup-failed', 'the copy before the upgrade is missing')
    }
    this.setActive(onDisk, openDb(file, { beforeMigrate }))
    // One backup each time a league is opened in a session, and a lore snapshot the first time in a day.
    if (!this.backedUp.has(slugKey(onDisk))) {
      this.backedUp.add(slugKey(onDisk))
      try {
        backupLeague(this.active!.db, leagueFolder, 'open')
      } catch (e) {
        console.warn('[leagues] backup on open failed', e)
      }
      try {
        snapshotLore(leagueFolder, 'open')
      } catch (e) {
        console.warn('[leagues] lore snapshot on open failed', e)
      }
    }
    try {
      this.hooks.open?.(onDisk, this.active!.db, join(this.dataDir, onDisk))
    } catch (e) {
      console.warn('[leagues] open hook failed', e)
    }
    return this.active!.db
  }

  private folder(slug: string): string {
    if (!isValidSlug(slug)) throw new AppError('invalid-input', `bad league folder name: ${slug}`)
    return join(this.dataDir, slug)
  }
}

export interface LeagueHooks {
  open?: (slug: string, db: Db, folder: string) => void
  close?: (slug: string, db: Db) => void
}

export { isValidSlug }
