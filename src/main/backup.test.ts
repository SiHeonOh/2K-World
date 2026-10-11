import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupKind } from '@shared/backups'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { seedLeague } from '@data/league'
import { MIGRATIONS } from '@data/migrations'
import { COALESCE_MS, KEEP_OTHER, backupLeague, keepFor, listBackups, pruneBackups, stampOf } from './backup'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-backup-'))
  db = openDb(join(dir, 'league.sqlite'))
  seedLeague(db, sampleSetup())
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const backups = () => readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.sqlite'))
const ofReason = (reason: string) => backups().filter((f) => f.includes(`-${reason}-e`))
/** Something happened in the league (a new event), so the next copy isn't the same state. */
const change = () => db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('news_posted', '{}', ?)").run(new Date().toISOString())
const T0 = Date.parse('2026-10-11T00:00:00.000Z')
const MIN = 60_000

describe('database backups', () => {
  it('makes a consistent copy that keeps the schema version', () => {
    const file = backupLeague(db, dir, 'manual', T0)!
    const copy = new DatabaseSync(file, { readOnly: true })
    expect((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length)
    expect((copy.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n).toBe(48)
    copy.close()
    expect(listBackups(dir)).toEqual([
      expect.objectContaining({ reason: 'manual', at: '2026-10-11T00:00:00.000Z', season: '시즌 1', version: MIGRATIONS.length, restorable: true, keep: null }),
    ])
  })

  it('skips a step’s copy when nothing changed, but always makes yours', () => {
    expect(backupLeague(db, dir, 'season-start', T0)).not.toBeNull()
    expect(backupLeague(db, dir, 'season-start', T0 + MIN)).toBeNull()
    expect(backupLeague(db, dir, 'manual', T0 + 2 * MIN)).not.toBeNull()
    expect(backupLeague(db, dir, 'manual', T0 + 2 * MIN)).not.toBeNull()
    expect(ofReason('manual')).toHaveLength(2)
  })

  it('makes one copy for a burst of draft swaps or settings saves', () => {
    expect(backupLeague(db, dir, 'draft-swap', T0)).not.toBeNull()
    change()
    // Two minutes later: the copy from before the first swap covers this one.
    expect(backupLeague(db, dir, 'draft-swap', T0 + 2 * MIN)).toBeNull()
    change()
    expect(backupLeague(db, dir, 'draft-swap', T0 + COALESCE_MS + MIN)).not.toBeNull()
    // Other steps aren't held back by it.
    expect(backupLeague(db, dir, 'veto', T0 + COALESCE_MS + MIN)).not.toBeNull()
    change()
    expect(backupLeague(db, dir, 'veto', T0 + COALESCE_MS + 2 * MIN)).not.toBeNull()
    expect(ofReason('draft-swap')).toHaveLength(2)
    expect(ofReason('veto')).toHaveLength(2)
  })

  it('never lets a long draft push out your backups or a season’s start', () => {
    backupLeague(db, dir, 'manual', T0)
    backupLeague(db, dir, 'season-start', T0 + MIN)
    for (let i = 0; i < 40; i++) {
      change()
      backupLeague(db, dir, 'draft-swap', T0 + (i + 1) * (COALESCE_MS + MIN))
    }
    expect(ofReason('manual')).toHaveLength(1)
    expect(ofReason('season-start')).toHaveLength(1)
    expect(ofReason('draft-swap')).toHaveLength(KEEP_OTHER)
    // The newest ones stay.
    expect(ofReason('draft-swap').at(-1)).toContain(stampOf(T0 + 40 * (COALESCE_MS + MIN)))
  })
})

describe('the pruning policy', () => {
  /** Empty files named as the app names backups. */
  function files(reason: string, n: number, startMs: number) {
    mkdirBackups()
    for (let i = 0; i < n; i++) closeSync(openSync(join(dir, 'backups', `${stampOf(startMs + i * MIN)}-${reason}-e${i}.sqlite`), 'w'))
  }
  const mkdirBackups = () => readdirSync(dir).includes('backups') || backupLeague(db, dir, 'manual', 0)

  it('keeps each kind apart: manual ones always, the rest by their own limits', () => {
    files('draft-swap', 40, T0)
    files('season-start', 25, T0)
    files('open', 12, T0)
    files('upgrade-v16', 1, T0)
    files('upgrade-v17', 11, T0 + 100 * MIN)
    files('config', 7, T0)
    files('something-new', 6, T0)
    files('manual', 30, T0)
    for (const kind of ['draft-swap', 'season-start', 'open', 'upgrade', 'config', 'something-new', 'manual']) pruneBackups(join(dir, 'backups'), kind)
    expect(ofReason('draft-swap')).toHaveLength(KEEP_OTHER)
    expect(ofReason('season-start')).toHaveLength(keepFor('season-start')!)
    expect(ofReason('open')).toHaveLength(10)
    // Upgrades count together, whichever version they came from: the oldest (v16) went.
    expect(backups().filter((f) => f.includes('-upgrade-v'))).toHaveLength(10)
    expect(ofReason('upgrade-v16')).toHaveLength(0)
    expect(ofReason('config')).toHaveLength(KEEP_OTHER)
    expect(ofReason('something-new')).toHaveLength(KEEP_OTHER)
    // 30 made here, plus the one that made the folder.
    expect(ofReason('manual')).toHaveLength(31)
    // The oldest go first.
    expect(ofReason('draft-swap')[0]).toContain(stampOf(T0 + 35 * MIN))
  })

  it('names kinds the way the list shows them', () => {
    expect(backupKind('upgrade-v17')).toBe('upgrade')
    expect(backupKind('season-start')).toBe('season-start')
    expect(keepFor('manual')).toBeNull()
    expect(keepFor('upgrade-v3')).toBe(10)
  })

  it('lists a file that isn’t a league as not restorable', () => {
    mkdirBackups()
    closeSync(openSync(join(dir, 'backups', `${stampOf(T0)}-open-e1.sqlite`), 'w'))
    const listed = listBackups(dir).find((b) => b.reason === 'open')!
    expect(listed.restorable).toBe(false)
  })

  it('never removes the copy just made, even when the clock is behind the older ones', () => {
    // Ten copies made while the PC's clock ran two months ahead; then it was put right.
    const ahead = Date.parse('2026-12-01T00:00:00Z')
    for (let i = 0; i < 10; i++) {
      change()
      backupLeague(db, dir, 'before-restore', ahead + i * 1000)
    }
    change()
    const made = backupLeague(db, dir, 'before-restore', T0)!
    expect(existsSync(made)).toBe(true)
    // It sorts oldest by its name, so the oldest of the others went in its place.
    expect(ofReason('before-restore')).toHaveLength(10)
    expect(ofReason('before-restore').some((f) => f.startsWith(stampOf(ahead)))).toBe(false)
  })

  it('prunes only the kind just written: what an older app kept stays until its own kind is written again', () => {
    // An older app's copies, beyond today's limits.
    files('draft-swap', 24, T0)
    files('veto', 6, T0)
    change()
    backupLeague(db, dir, 'open', T0 + 100 * MIN)
    expect(ofReason('draft-swap')).toHaveLength(24)
    expect(ofReason('veto')).toHaveLength(6)
    // Past the event ids the old copies' names carry, so this one isn't skipped as the same state.
    for (let i = 0; i < 30; i++) change()
    backupLeague(db, dir, 'draft-swap', T0 + 200 * MIN)
    expect(ofReason('draft-swap')).toHaveLength(KEEP_OTHER)
    expect(ofReason('veto')).toHaveLength(6)
  })

  it('leaves alone files whose names aren’t backups the app made', () => {
    mkdirBackups()
    const odd = ['2026-13-45T99-99-99-000Z-draft-swap-e1.sqlite', 'my-copy.sqlite', 'draft-swap-e1.sqlite']
    for (const name of odd) closeSync(openSync(join(dir, 'backups', name), 'w'))
    files('draft-swap', 8, T0)
    pruneBackups(join(dir, 'backups'), 'draft-swap')
    for (const name of odd) expect(existsSync(join(dir, 'backups', name)), name).toBe(true)
    expect(listBackups(dir).map((b) => b.id)).not.toContain(odd[0])
  })

  it('makes a fresh copy when asked, even within a burst', () => {
    expect(backupLeague(db, dir, 'settings', T0)).not.toBeNull()
    change()
    expect(backupLeague(db, dir, 'settings', T0 + MIN)).toBeNull()
    expect(backupLeague(db, dir, 'settings', T0 + 2 * MIN, { fresh: true })).not.toBeNull()
    // Even with nothing changed since.
    expect(backupLeague(db, dir, 'settings', T0 + 3 * MIN, { fresh: true })).not.toBeNull()
    expect(ofReason('settings')).toHaveLength(3)
  })
})
