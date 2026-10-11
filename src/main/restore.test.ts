import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { sampleSetup } from '@shared/testing/fixtures'
import { migrate, schemaVersion } from '@data/db'
import { currentSeason, seedLeague } from '@data/league'
import { MIGRATIONS } from '@data/migrations'
import { listGames } from '@data/season'
import { stampOf } from './backup'
import { createContext, type AppContext } from './context'
import { AppError } from './errors'
import { createHandlers, type HandlerDeps } from './handlers'

let root: string
let ctx: AppContext
let opened: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '2kw-restore-'))
  mkdirSync(join(root, 'defaults', 'templates'), { recursive: true })
  ctx = createContext(join(root, 'data'), join(root, 'defaults'), '0.0.0-test')
  opened = []
})
afterEach(() => {
  ctx.ai.closeAll()
  ctx.leagues.closeAll()
  rmSync(root, { recursive: true, force: true })
})

const deps = (): HandlerDeps => ({
  context: () => ctx,
  appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
  pickFile: async () => null,
  pickFolder: async () => null,
  openFolder: (path) => void opened.push(path),
  showItem: () => {},
  switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
})

const SLUG = 'rt'
const folder = () => join(ctx.dataDir, SLUG)
const backupNames = () => readdirSync(join(folder(), 'backups')).filter((f) => f.endsWith('.sqlite'))
const version = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return schemaVersion(db)
  } finally {
    db.close()
  }
}
const finalGames = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'final'").get() as { n: number }).n
  } finally {
    db.close()
  }
}
const ruleCode = async (p: () => unknown) => {
  try {
    await p()
  } catch (e) {
    return e instanceof AppError ? (e.toShape().rules?.[0]?.code ?? e.code) : String(e)
  }
  return 'no-error'
}

/** A league database as an older app left it: the schema of migration `v`, seeded then. */
function oldDatabase(file: string, v: number): void {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db, MIGRATIONS.slice(0, v))
  seedLeague(db, sampleSetup())
  db.close()
}

describe('an app update', () => {
  it('copies a database from an older app, as it was, before upgrading it', () => {
    mkdirSync(folder(), { recursive: true })
    oldDatabase(join(folder(), 'league.sqlite'), 17)
    ctx.leagues.dbFor(SLUG)
    const upgrade = backupNames().find((f) => f.includes('-upgrade-v17-'))!
    expect(upgrade).toBeDefined()
    expect(version(join(folder(), 'backups', upgrade))).toBe(17)
    expect(schemaVersion(ctx.leagues.dbFor(SLUG))).toBe(MIGRATIONS.length)
    // The first-open copy is in the new format.
    expect(version(join(folder(), 'backups', backupNames().find((f) => f.includes('-open-'))!))).toBe(MIGRATIONS.length)
  })

  it('keeps the older app’s copies, and its own copy even with the clock behind the earlier ones', () => {
    mkdirSync(join(folder(), 'backups'), { recursive: true })
    oldDatabase(join(folder(), 'league.sqlite'), 18)
    const proto = join(root, 'proto.sqlite')
    const src = new DatabaseSync(join(folder(), 'league.sqlite'))
    src.exec(`VACUUM INTO '${proto.replace(/'/g, "''")}'`)
    src.close()
    // What the older app left: a draft's worth of swap copies, a few vetoes, and upgrade copies made while the clock ran ahead.
    const t0 = Date.parse('2026-10-10T10:00:00Z')
    const ahead = Date.now() + 60 * 86_400_000
    for (let i = 0; i < 24; i++) copyFileSync(proto, join(folder(), 'backups', `${stampOf(t0 + i * 60_000)}-draft-swap-e${100 + i}.sqlite`))
    for (let i = 0; i < 6; i++) copyFileSync(proto, join(folder(), 'backups', `${stampOf(t0 + i * 60_000)}-veto-e${200 + i}.sqlite`))
    for (let i = 0; i < 10; i++) copyFileSync(proto, join(folder(), 'backups', `${stampOf(ahead + i * 1000)}-upgrade-v17-e${300 + i}.sqlite`))
    ctx.leagues.dbFor(SLUG)
    expect(backupNames().filter((f) => f.includes('-draft-swap-'))).toHaveLength(24)
    expect(backupNames().filter((f) => f.includes('-veto-'))).toHaveLength(6)
    const upgrade = backupNames().find((f) => f.includes('-upgrade-v18-'))!
    expect(version(join(folder(), 'backups', upgrade))).toBe(18)
    expect(backupNames().filter((f) => f.includes('-upgrade-'))).toHaveLength(10)
  })

  it('doesn’t upgrade (or open) a database it couldn’t copy first', () => {
    mkdirSync(folder(), { recursive: true })
    oldDatabase(join(folder(), 'league.sqlite'), 17)
    // A file where the backups folder should be: no copy can be made.
    writeFileSync(join(folder(), 'backups'), '')
    expect(() => ctx.leagues.dbFor(SLUG)).toThrow(AppError)
    expect(version(join(folder(), 'league.sqlite'))).toBe(17)
  })
})

describe('restoring a database backup', () => {
  const create = () => ctx.leagues.create({ slug: SLUG, setup: sampleSetup(), saveTemplate: null, importMapping: null })

  it('backs up what’s there, stops the AI queue, swaps the database and opens it again', async () => {
    create()
    mkdirSync(join(folder(), 'lore', 'world'), { recursive: true })
    writeFileSync(join(folder(), 'lore', 'world', '설정.md'), '그대로')
    const h = createHandlers(deps())
    await h['season.start'](SLUG)
    const { path } = await h['leagues.backup'](SLUG)
    // Afterwards: a game is recorded, and a job is running when the restore comes.
    const [game] = await h['season.games'](SLUG)
    await h['season.recordScore'](SLUG, { gameId: game!.id, homeScore: 81, awayScore: 80, lines: null })
    const db = ctx.leagues.dbFor(SLUG)
    const queue = ctx.ai.queueFor(SLUG, db, folder())
    // Its first look at the (empty) queue is over; from here on nothing awaits until the restore.
    await new Promise((r) => setTimeout(r, 0))
    queue.register({
      kind: 'test_wait',
      model: 'haiku',
      tools: [],
      output: z.object({}),
      systemPrompt: () => '',
      prompt: () => '',
      stdin: () => '',
    })
    const jobId = queue.enqueue('test_wait', {})
    expect((db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }).status).toBe('running')
    const closeQueue = vi.spyOn(ctx.ai, 'closeQueue')

    const result = await h['backups.restore'](SLUG, basename(path))

    expect(closeQueue).toHaveBeenCalledWith(SLUG)
    expect(result.upgraded).toBe(false)
    // The league is as it was at the backup: no game played.
    const now = ctx.leagues.dbFor(SLUG)
    expect(now === db).toBe(false)
    expect(listGames(now, currentSeason(now).id).filter((g) => g.status === 'final')).toHaveLength(0)
    expect((await h['season.standings'](SLUG)).played).toBe(0)
    // What it replaced is a backup of its own (taken before the queue stopped, so a failed copy stops nothing),
    // holding the job as a crash would leave it: running, which goes back to waiting when that copy opens.
    const safety = join(folder(), 'backups', result.safety)
    expect(result.safety).toContain('-before-restore-')
    expect(finalGames(safety)).toBe(1)
    const old = new DatabaseSync(safety, { readOnly: true })
    const held = old.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }
    old.close()
    expect(held.status).toBe('running')
    expect(now.prepare("SELECT 1 FROM jobs WHERE kind = 'test_wait'").get()).toBeUndefined()
    // The first run's answer arriving later touches nothing.
    await new Promise((r) => setTimeout(r, 20))
    expect(now.prepare("SELECT 1 FROM jobs WHERE kind = 'test_wait'").get()).toBeUndefined()
    // The lore folder wasn't touched, and was snapshotted first.
    expect(readFileSync(join(folder(), 'lore', 'world', '설정.md'), 'utf8')).toBe('그대로')
    expect((await h['backups.list'](SLUG)).lore.map((s) => s.reason)).toContain('before-restore')
    // And it can be undone the same way.
    await h['backups.restore'](SLUG, result.safety)
    expect((await h['season.standings'](SLUG)).played).toBe(1)
  })

  it('keeps its before-restore copy when the clock is behind the earlier ones, so it can still be undone', async () => {
    create()
    const h = createHandlers(deps())
    await h['season.start'](SLUG)
    const { path } = await h['leagues.backup'](SLUG)
    const [game] = await h['season.games'](SLUG)
    await h['season.recordScore'](SLUG, { gameId: game!.id, homeScore: 81, awayScore: 80, lines: null })
    // Ten restores' copies made while the clock ran two months ahead.
    const ahead = Date.now() + 60 * 86_400_000
    for (let i = 0; i < 10; i++) copyFileSync(path, join(folder(), 'backups', `${stampOf(ahead + i * 1000)}-before-restore-e${900 + i}.sqlite`))
    const result = await h['backups.restore'](SLUG, basename(path))
    expect(existsSync(join(folder(), 'backups', result.safety))).toBe(true)
    expect(finalGames(join(folder(), 'backups', result.safety))).toBe(1)
    expect(backupNames().filter((f) => f.includes('-before-restore-'))).toHaveLength(10)
    await h['backups.restore'](SLUG, result.safety)
    expect((await h['season.standings'](SLUG)).played).toBe(1)
  })

  it('upgrades a backup from an older app, after copying it as it was', async () => {
    create()
    const h = createHandlers(deps())
    const name = `${stampOf(Date.parse('2026-01-01T00:00:00Z'))}-manual-e0.sqlite`
    mkdirSync(join(folder(), 'backups'), { recursive: true })
    oldDatabase(join(root, 'old.sqlite'), 17)
    // A backup is a plain file (VACUUM INTO writes no WAL).
    const src = new DatabaseSync(join(root, 'old.sqlite'))
    src.exec(`VACUUM INTO '${join(folder(), 'backups', name).replace(/'/g, "''")}'`)
    src.close()
    const listed = (await h['backups.list'](SLUG)).db.find((b) => b.id === name)!
    expect(listed).toMatchObject({ version: 17, restorable: true, reason: 'manual', season: '시즌 1' })

    const result = await h['backups.restore'](SLUG, name)
    expect(result.upgraded).toBe(true)
    expect(schemaVersion(ctx.leagues.dbFor(SLUG))).toBe(MIGRATIONS.length)
    const upgrade = backupNames().find((f) => f.includes('-upgrade-v17-'))!
    expect(version(join(folder(), 'backups', upgrade))).toBe(17)
    expect(ctx.leagues.snapshot(SLUG).teams).toHaveLength(8)
  })

  it('refuses unknown, foreign and too-new backups, and puts the league back when one won’t open', async () => {
    create()
    const h = createHandlers(deps())
    await h['season.start'](SLUG)
    expect(await ruleCode(() => h['backups.restore'](SLUG, 'nope.sqlite'))).toBe('backup-unknown')
    expect(await ruleCode(() => h['backups.restore'](SLUG, '../league.sqlite'))).toBe('backup-unknown')

    const good = backupNames().find((f) => f.includes('-season-start-'))!
    const copy = (name: string, change: string) => {
      copyFileSync(join(folder(), 'backups', good), join(folder(), 'backups', name))
      const db = new DatabaseSync(join(folder(), 'backups', name))
      db.exec(change)
      db.close()
      return name
    }
    const newer = copy(`${stampOf(Date.now() + 1000)}-open-e999.sqlite`, `PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    expect(await ruleCode(() => h['backups.restore'](SLUG, newer))).toBe('backup-too-new')
    const broken = copy(`${stampOf(Date.now() + 2000)}-open-e998.sqlite`, "UPDATE league_config SET json = 'not json'")
    const before = backupNames().length
    expect(await ruleCode(() => h['backups.restore'](SLUG, broken))).toBe('restore-failed')
    // Back as it was, with its 'before-restore' copy kept.
    expect(ctx.leagues.snapshot(SLUG).season.phase).toBe('regular')
    expect(backupNames().length).toBe(before + 1)
    expect(existsSync(join(folder(), 'league.sqlite'))).toBe(true)
    expect(readdirSync(folder()).filter((f) => f.includes('.incoming-') || f.includes('.restoring-'))).toEqual([])
  })
})

describe('lore snapshots in the league', () => {
  const create = () => ctx.leagues.create({ slug: SLUG, setup: sampleSetup(), saveTemplate: null, importMapping: null })

  it('are taken with your backups and at the season start, and restored apart from the database', async () => {
    mkdirSync(join(folder(), 'lore', 'world'), { recursive: true })
    writeFileSync(join(folder(), 'lore', 'world', '설정.md'), '처음')
    create()
    const h = createHandlers(deps())
    await h['season.start'](SLUG)
    await h['leagues.backup'](SLUG)
    const list = await h['backups.list'](SLUG)
    expect(list.hasLore).toBe(true)
    expect(list.lore.map((s) => s.reason).sort()).toEqual(['manual', 'season-start'])
    const manual = list.lore.find((s) => s.reason === 'manual')!
    expect(manual).toMatchObject({ files: 1, keep: null })

    writeFileSync(join(folder(), 'lore', 'world', '설정.md'), '나중')
    const [game] = await h['season.games'](SLUG)
    await h['season.recordScore'](SLUG, { gameId: game!.id, homeScore: 81, awayScore: 80, lines: null })
    const result = await h['backups.restoreLore'](SLUG, manual.id)
    expect(readFileSync(join(folder(), 'lore', 'world', '설정.md'), 'utf8')).toBe('처음')
    expect(result.safety).not.toBeNull()
    // The database is untouched: the game stays recorded.
    expect((await h['season.standings'](SLUG)).played).toBe(1)

    await h['backups.openLore'](SLUG, manual.id)
    expect(opened.at(-1)).toBe(join(folder(), 'backups', 'lore-snapshots', manual.id, 'lore'))
    expect(await ruleCode(() => h['backups.openLore'](SLUG, '..'))).toBe('snapshot-unknown')
  })
})
