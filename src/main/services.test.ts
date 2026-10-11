import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { sampleSetup } from '@shared/testing/fixtures'
import { TEMPLATE_FORMAT, TEMPLATE_FORMAT_VERSION, serializeTemplate } from '@shared/template'
import { makeRosterWorkbook } from '@ingest/testing/sheet'
import type { ConfirmView } from '@shared/gameday'
import { sqliteJobStore } from '@data/jobs'
import { currentSeason, listPlayers, listTeams } from '@data/league'
import { applyTrade, giveAward, listChecklist, markApplied, startNextSeason } from '@data/moves'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from '@data/season'
import { FAKE_OUTPUT_FILE } from './ai'
import { createContext, type AppContext } from './context'
import { AppError } from './errors'
import { createHandlers, openDroppedHandler, withStory, type HandlerDeps } from './handlers'
import { isValidSlug } from './leagues'

let root: string
let ctx: AppContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '2kw-main-'))
  mkdirSync(join(root, 'defaults', 'templates'), { recursive: true })
  ctx = createContext(join(root, 'data'), join(root, 'defaults'), '0.0.0-test')
})
afterEach(() => {
  ctx.leagues.closeAll()
  rmSync(root, { recursive: true, force: true })
})

const create = (slug = 'test-league', extra: Partial<Parameters<AppContext['leagues']['create']>[0]> = {}) =>
  ctx.leagues.create({ slug, setup: sampleSetup(), saveTemplate: null, importMapping: null, ...extra })

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof AppError ? e.code : `not-app-error: ${String(e)}`
  }
  return 'no-error'
}

describe('league folders', () => {
  it('accepts Korean and simple names, refuses path tricks', () => {
    for (const ok of ['summer-league', '여름리그', 'league_2']) expect(isValidSlug(ok)).toBe(true)
    for (const bad of ['', '..', 'a/b', 'a\\b', '.hidden', '_x', 'a b', 'templates', 'x'.repeat(61)]) {
      expect(isValidSlug(bad)).toBe(false)
    }
  })

  it('creates a league, lists it and reads it back', () => {
    const result = create()
    expect(result.slug).toBe('test-league')
    expect(existsSync(join(ctx.dataDir, 'test-league', 'league.sqlite'))).toBe(true)
    expect(ctx.leagues.list()).toEqual([
      { slug: 'test-league', name: '테스트 리그', hasDb: true, hasLore: false, teams: 8, players: 48, season: '시즌 1' },
    ])
    const snap = ctx.leagues.snapshot('test-league')
    expect(snap.teams).toHaveLength(8)
    expect(snap.season.phase).toBe('preseason')
    expect(ctx.settings.read().lastLeague).toBe('test-league')
  })

  it('lists lore-only folders and inspects their team folders', () => {
    mkdirSync(join(ctx.dataDir, 'lore-only', 'lore', 'teams', '가람고'), { recursive: true })
    mkdirSync(join(ctx.dataDir, 'lore-only', 'lore', 'teams', '_templates'), { recursive: true })
    mkdirSync(join(ctx.dataDir, 'not-a-league'), { recursive: true })
    expect(ctx.leagues.list().map((l) => [l.slug, l.hasDb, l.hasLore])).toEqual([['lore-only', false, true]])
    expect(ctx.leagues.inspect('lore-only')).toEqual({ slug: 'lore-only', exists: true, hasDb: false, loreTeams: ['가람고'] })
  })

  it('creates a league inside an existing lore folder without touching it', () => {
    const lore = join(ctx.dataDir, 'lore-only', 'lore')
    mkdirSync(lore, { recursive: true })
    writeFileSync(join(lore, 'note.md'), '그대로')
    create('lore-only')
    expect(readFileSync(join(lore, 'note.md'), 'utf8')).toBe('그대로')
  })

  it('refuses a second league in the same folder', () => {
    create()
    expect(code(() => create())).toBe('league-exists')
  })

  it('reports setup errors and leaves no files behind', () => {
    const setup = sampleSetup()
    setup.players.pop()
    let error: unknown
    try {
      ctx.leagues.create({ slug: 'broken', setup, saveTemplate: null, importMapping: null })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('invalid-setup')
    expect((error as AppError).extra.issues?.some((i) => i.code === 'roster-size')).toBe(true)
    expect(existsSync(join(ctx.dataDir, 'broken'))).toBe(false)
  })

  it('saves a template on request and lists it', () => {
    const result = create('test-league', { saveTemplate: { name: '내 템플릿', includePlayers: false } })
    expect(result.templatePath).toBe(join(ctx.dataDir, 'templates', 'test-league.template.json'))
    const listed = ctx.templates.list()
    expect(listed).toEqual([
      expect.objectContaining({ source: 'user', name: '내 템플릿', hasTeams: true, hasPlayers: false }),
    ])
    const loaded = ctx.templates.load(listed[0]!.id)
    expect(loaded.config.league.name).toBe('테스트 리그')
    expect(loaded.players).toBeUndefined()
  })

  it('exports with players and never overwrites an earlier export', () => {
    create()
    const a = ctx.leagues.exportTemplate('test-league', { name: 'A', includePlayers: true })
    const b = ctx.leagues.exportTemplate('test-league', { name: 'B', includePlayers: true })
    expect(a.path).not.toBe(b.path)
    const t = ctx.templates.loadFile(b.path)
    expect(t.players).toHaveLength(48)
    expect(t.players![0]).not.toHaveProperty('heightCm')
  })
})

describe('templates', () => {
  it('lists built-in templates and flags broken files', () => {
    const { config, teams } = sampleSetup()
    const dir = join(root, 'defaults', 'templates')
    writeFileSync(
      join(dir, 'example.template.json'),
      serializeTemplate({
        format: TEMPLATE_FORMAT,
        formatVersion: TEMPLATE_FORMAT_VERSION,
        meta: { name: '예시', description: '설명', exportedAt: '', appVersion: '' },
        config,
        teams,
      }),
    )
    writeFileSync(join(dir, 'broken.template.json'), '{')
    writeFileSync(join(dir, 'ignored.json'), '{}')
    const list = ctx.templates.list()
    expect(list.map((t) => [t.id, t.name, t.error?.code])).toEqual([
      ['builtin:broken.template.json', 'broken.template.json', 'not-json'],
      ['builtin:example.template.json', '예시', undefined],
    ])
    expect(code(() => ctx.templates.load('builtin:broken.template.json'))).toBe('bad-template')
    expect(code(() => ctx.templates.load('builtin:../../etc'))).toBe('not-found')
  })
})

describe('settings', () => {
  it('survives a corrupt settings file', () => {
    mkdirSync(ctx.dataDir, { recursive: true })
    writeFileSync(join(ctx.dataDir, 'settings.json'), 'garbage')
    const fresh = createContext(ctx.dataDir, join(root, 'defaults'), '0')
    expect(fresh.settings.read().lastLeague).toBeNull()
    expect(readdirSync(ctx.dataDir).some((f) => f.startsWith('settings.json.invalid-'))).toBe(true)
  })
})

describe('handlers', () => {
  const deps = (): HandlerDeps => ({
    context: () => ctx,
    appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
    pickFile: async () => join(root, 'roster.xlsx'),
    pickFolder: async () => null,
    openFolder: () => {},
      showItem: () => {},
    switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
  })

  it('rejects malformed input with invalid-input', async () => {
    const h = createHandlers(deps())
    await expect(Promise.resolve().then(() => h['leagues.snapshot'](42))).rejects.toMatchObject({ code: 'invalid-input' })
    const dropped = openDroppedHandler({ context: () => ctx })
    expect(code(() => dropped('C:/x/notes.txt'))).toBe('invalid-input')
    expect(code(() => dropped('\\server\share\roster.xlsx'))).toBe('invalid-input')
  })

  it('reads only files that were picked or dropped', async () => {
    writeFileSync(join(root, 'roster.xlsx'), makeRosterWorkbook())
    writeFileSync(join(root, 'other.xlsx'), makeRosterWorkbook())
    const h = createHandlers(deps())
    const base = { config: { ...sampleSetup().config, league: { name: '', shortName: '' } } }
    await expect(
      Promise.resolve().then(() => h['import.analyze']({ path: join(root, 'other.xlsx'), sheet: 'Roster', base })),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    const dropped = openDroppedHandler({ context: () => ctx })
    expect(dropped(join(root, 'other.xlsx')).sheets).toHaveLength(2)
    expect(await h['import.analyze']({ path: join(root, 'other.xlsx'), sheet: 'Roster', base })).toBeTruthy()
  })

  it('runs a spreadsheet through analyze and import', async () => {
    writeFileSync(join(root, 'roster.xlsx'), makeRosterWorkbook())
    const h = createHandlers(deps())
    const summary = await h['import.chooseFile']({ title: '', filterName: '' })
    expect(summary?.sheets.map((s) => s.name)).toEqual(['Roster', 'Other'])
    const base = { config: { ...sampleSetup().config, league: { name: '', shortName: '' } } }
    const analysis = await h['import.analyze']({ path: summary!.path, sheet: 'Roster', base })
    const result = await h['import.run']({ path: summary!.path, mapping: analysis.suggested, base })
    expect(result.summary.players).toBe(24)
  })
})

describe('season handlers', () => {
  const deps = (): HandlerDeps => ({
    context: () => ctx,
    appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
    pickFile: async () => null,
    pickFolder: async () => null,
    openFolder: () => {},
      showItem: () => {},
    switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
  })

  it('runs season steps, backs up first, explains refusals and exports', async () => {
    create()
    const h = createHandlers(deps())
    expect(await h['season.start']('test-league')).toEqual({ games: 28 })
    const backups = readdirSync(join(ctx.dataDir, 'test-league', 'backups'))
    expect(backups.some((f) => f.includes('season-start'))).toBe(true)

    const [game] = await h['season.games']('test-league')
    let refused: unknown
    try {
      await h['season.recordScore']('test-league', { gameId: game!.id, homeScore: 80, awayScore: 80, lines: null })
    } catch (e) {
      refused = e
    }
    expect(refused).toBeInstanceOf(AppError)
    expect((refused as AppError).toShape()).toMatchObject({ code: 'rule', rules: [{ code: 'tie-score' }] })

    await h['season.recordScore']('test-league', { gameId: game!.id, homeScore: 81, awayScore: 80, lines: null })
    const table = await h['season.standings']('test-league')
    expect(table.played).toBe(1)

    const { path } = await h['leagues.exportExcel']('test-league', { rosters: '로스터' })
    expect(existsSync(path)).toBe(true)
  })

  it('reads a past season on request, refuses a season the league lacks, and exports every season', async () => {
    create()
    const h = createHandlers(deps())
    const slug = 'test-league'
    const db = ctx.leagues.dbFor(slug)
    const play = (stage: 'regular' | 'playoffs') => {
      for (;;) {
        const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && (g.stage === 'regular') === (stage === 'regular'))
        if (open.length === 0) return
        for (const g of open) {
          const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
          recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
        }
      }
    }
    // Season 1: p1 scores for t1, then is traded to t2 and wins the MVP there; the season is played out.
    startSeason(db)
    const first = currentSeason(db).id
    const game = listGames(db, first).find((g) => g.home === 't1' || g.away === 't1')!
    recordScore(db, {
      gameId: game.id,
      homeScore: game.home === 't1' ? 100 : 90,
      awayScore: game.home === 't1' ? 90 : 100,
      lines: [{ playerId: 'p1', teamId: 't1', stats: { pts: 30, reb: 4 } }],
    })
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    markApplied(db, listChecklist(db)[0]!.id)
    giveAward(db, { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p1' })
    play('regular')
    startPlayoffs(db)
    play('playoffs')
    finishPlayoffs(db)
    startNextSeason(db, '시즌 2')
    // Season 2: one game so far.
    startSeason(db)
    const second = currentSeason(db).id
    const [next] = listGames(db, second)
    recordScore(db, { gameId: next!.id, homeScore: 101, awayScore: 99, lines: null })

    expect((await h['leagues.snapshot'](slug)).seasons).toEqual([
      { id: first, label: '시즌 1', current: false },
      { id: second, label: '시즌 2', current: true },
    ])
    // Without a season id, reads are about the current season, as before.
    expect((await h['season.standings'](slug)).played).toBe(1)
    expect(await h['season.games'](slug)).toHaveLength(28)
    expect(await h['trades.list'](slug)).toEqual([])
    expect(await h['awards.list'](slug)).toEqual([])
    expect((await h['season.playoffs'](slug)).series).toEqual([])
    expect(await h['season.leaders'](slug, 0)).toSatisfy((boards: { rows: unknown[] }[]) => boards.every((b) => b.rows.length === 0))

    // With one, the past season as it ended.
    const table = await h['season.standings'](slug, first)
    expect([table.played, table.total, table.overall[0]!.teamId]).toEqual([28, 28, 't1'])
    expect((await h['season.games'](slug, first)).length).toBeGreaterThan(28)
    expect((await h['season.playoffs'](slug, first)).series.find((s) => s.slot === 'finals')!.winner).toBe('t1')
    expect(await h['schedule.info'](slug, first)).toMatchObject({ total: 28, played: 28, editable: false })
    expect(await h['trades.list'](slug, first)).toHaveLength(1)
    expect(await h['cards.list'](slug, first)).toEqual([])
    // The MVP keeps the team he won it with (t2, after the trade); his points stay with the team he scored them for (t1).
    expect(await h['awards.list'](slug, first)).toEqual([expect.objectContaining({ playerId: 'p1', teamId: 't2' })])
    const points = (await h['season.leaders'](slug, 1, first)).find((b) => b.key === 'pts')!
    expect(points.rows[0]).toMatchObject({ playerId: 'p1', teamId: 't1', value: 30, games: 1 })

    // A season the league doesn't have is refused, with a code the screens translate; a malformed id is bad input.
    const reads: (() => unknown)[] = [
      () => h['season.games'](slug, 999),
      () => h['season.standings'](slug, 999),
      () => h['season.leaders'](slug, 1, 999),
      () => h['schedule.info'](slug, 999),
      () => h['season.playoffs'](slug, 999),
      () => h['trades.list'](slug, 999),
      () => h['cards.list'](slug, 999),
      () => h['draft.view'](slug, 999),
      () => h['awards.list'](slug, 999),
    ]
    for (const read of reads) {
      await expect(Promise.resolve().then(read)).rejects.toMatchObject({ code: 'rule', extra: { rules: [{ code: 'unknown-season' }] } })
    }
    await expect(Promise.resolve().then(() => h['season.standings'](slug, 'x'))).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(Promise.resolve().then(() => h['awards.list'](slug, 0))).rejects.toMatchObject({ code: 'invalid-input' })

    // Every season: a season column first on each season's sheet; rosters as they are now.
    const labels = {
      season: '시즌',
      rosters: '로스터',
      rostersNow: '로스터(현재)',
      results: '경기 결과',
      standings: '순위',
      playoffs: '플레이오프',
      stats: '선수 기록(경기당)',
      trades: '트레이드',
      awards: '시상',
      team: '팀',
      name: '이름',
    }
    const read = (path: string) => {
      const wb = XLSX.read(readFileSync(path), { type: 'buffer' })
      const sheet = (name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1 })
      return { names: wb.SheetNames, sheet }
    }
    const all = await h['leagues.exportExcel'](slug, labels, 'all')
    expect(all.path).toMatch(/test-league-all-/)
    const book = read(all.path)
    expect(book.names).toEqual(['로스터(현재)', '경기 결과', '순위', '플레이오프', '선수 기록(경기당)', '트레이드', '시상'])
    const results = book.sheet('경기 결과')
    expect(results[0]![0]).toBe('시즌')
    expect(new Set(results.slice(1).map((r) => r[0]))).toEqual(new Set(['시즌 1', '시즌 2']))
    expect(results.filter((r) => r[0] === '시즌 2')).toHaveLength(28)
    const standingsRows = book.sheet('순위')
    expect(standingsRows).toHaveLength(1 + 8 + 8)
    expect(standingsRows[1]!.slice(0, 5)).toEqual(['시즌 1', 1, '가람고', 7, 0])
    expect(book.sheet('플레이오프').slice(1).every((r) => r[0] === '시즌 1')).toBe(true)
    // His team in last season's stats is the one he played for then.
    expect(book.sheet('선수 기록(경기당)')[1]!.slice(0, 5)).toEqual(['시즌 1', '가람고', '가가가', 1, 30])
    expect(book.sheet('트레이드').slice(1).map((r) => r[0])).toEqual(['시즌 1', '시즌 1'])
    expect(book.sheet('시상')[1]).toEqual(['시즌 1', 'MVP', '', 1, '가가가', '나람고'])
    // The roster sheet has no season column: it's today's.
    expect(book.sheet('로스터(현재)')[0]![0]).toBe('팀')
    expect(book.sheet('로스터(현재)').find((r) => r[2] === '가가가')![0]).toBe('나람고')

    // The current season only (the default), as before: no season column.
    const now = read((await h['leagues.exportExcel'](slug, labels)).path)
    expect(now.names).toEqual(['로스터', '경기 결과', '순위', '트레이드', '시상'])
    expect(now.sheet('경기 결과')).toHaveLength(1 + 28)
    expect(now.sheet('경기 결과')[0]![0]).not.toBe('시즌')
    await expect(Promise.resolve().then(() => h['leagues.exportExcel'](slug, labels, 'some'))).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('moves lore files with traded players, back on a veto, and catches up when the league opens', async () => {
    create()
    const h = withStory(createHandlers(deps()), () => ctx)
    const db = ctx.leagues.dbFor('test-league')
    const short = new Map(listTeams(db).map((t) => [t.id, t.shortName]))
    const name = new Map(listPlayers(db).map((p) => [p.id, p.name]))
    const lore = join(ctx.dataDir, 'test-league', 'lore')
    const file = (team: string, player: string) => join(lore, 'teams', short.get(team)!, `${name.get(player)}.md`)
    for (const [team, player] of [['t1', 'p1'], ['t2', 'p7']] as const) {
      mkdirSync(join(lore, 'teams', short.get(team)!), { recursive: true })
      writeFileSync(file(team, player), `---\nid: ${name.get(player)}\n---\n## 공개\n${player}의 이야기.\n`)
    }

    await h['season.start']('test-league')
    const { tradeId } = await h['trades.apply'](
      'test-league',
      [
        { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
        { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
      ],
      '',
    )
    expect(existsSync(file('t2', 'p1')) && existsSync(file('t1', 'p7'))).toBe(true)
    expect(existsSync(file('t1', 'p1')) || existsSync(file('t2', 'p7'))).toBe(false)
    expect(readFileSync(file('t2', 'p1'), 'utf8')).toContain('p1의 이야기.')

    await h['trades.veto']('test-league', tradeId)
    expect(existsSync(file('t1', 'p1')) && existsSync(file('t2', 'p7'))).toBe(true)

    // Moved by hand into the wrong folder while the league was closed: opening it puts the file back.
    ctx.leagues.closeAll()
    renameSync(file('t1', 'p1'), file('t2', 'p1'))
    const index = await h['lore.index']('test-league')
    expect(existsSync(file('t1', 'p1'))).toBe(true)
    expect(index.misplaced).toEqual([])
    expect(index.files.find((f) => f.file.endsWith(`${name.get('p1')}.md`))?.linkedTo).toBe(name.get('p1'))
  })
})

describe('game day (demo reader)', () => {
  const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, n])
  const rejection = async (p: () => unknown) => {
    try {
      await Promise.resolve().then(p)
    } catch (e) {
      return e instanceof AppError ? e.toShape() : { code: `not-app-error: ${String(e)}` }
    }
    return { code: 'no-error' }
  }
  let fakeCtx: AppContext
  let h: ReturnType<typeof createHandlers>
  beforeEach(async () => {
    process.env.TWOK_FAKE_AI = '1'
    fakeCtx = createContext(join(root, 'data-gameday'), join(root, 'defaults'), '0')
    h = createHandlers({
      context: () => fakeCtx,
      appInfo: () => ({ version: '0', dataDir: fakeCtx.dataDir, isPackaged: false }),
      pickFile: async () => null,
      pickFolder: async () => null,
      openFolder: () => {},
      showItem: () => {},
      switchDataDir: () => ({ version: '0', dataDir: fakeCtx.dataDir, isPackaged: false }),
    })
    fakeCtx.leagues.create({ slug: 'gd', setup: sampleSetup(), saveTemplate: null, importMapping: null })
    await h['ai.recheck']()
    await h['season.start']('gd')
  })
  afterEach(() => {
    fakeCtx.ai.closeAll()
    fakeCtx.leagues.closeAll()
    delete process.env.TWOK_FAKE_AI
  })
  const waitDone = async (jobId: number) => {
    for (let i = 0; i < 100 && ['queued', 'running'].includes((await h['gameday.job']('gd', jobId)).status); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    return h['gameday.job']('gd', jobId)
  }
  /** Fills open rows the way the confirm screen would, by elimination. */
  const linesOf = (view: ConfirmView) =>
    [view.home, view.away].flatMap((t) => {
      const taken = new Set(t.rows.map((r) => r.playerId).filter(Boolean))
      return t.rows.map((r) => {
        const playerId = r.playerId ?? r.candidates.find((c) => !taken.has(c))!
        taken.add(playerId)
        return { row: r.row, source: r.source, playerId, teamId: t.teamId, stats: r.stats }
      })
    })

  it('saves screenshots, reads them, confirms and learns the names', async () => {
    const [game] = await h['season.games']('gd')
    const a = await h['gameday.saveImage']('gd', png(1))
    const b = await h['gameday.saveImage']('gd', png(2))
    // Not a PNG or JPEG (a WebP, say), or over 20 MB: each with its own message.
    expect(await rejection(() => h['gameday.saveImage']('gd', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])))).toMatchObject({ code: 'image-type' })
    expect(await rejection(() => h['gameday.saveImage']('gd', new Uint8Array(20 * 1024 * 1024 + 1)))).toMatchObject({ code: 'image-too-large' })
    const { jobId } = await h['gameday.read']('gd', game!.id, [a.token, b.token])
    expect((await waitDone(jobId)).status).toBe('done')
    expect(await h['gameday.jobs']('gd', game!.id)).toEqual([expect.objectContaining({ id: jobId, status: 'done', gameId: game!.id })])

    const view = await h['gameday.confirmView']('gd', jobId)
    expect(view.home.teamId).toBe(game!.home)
    expect(view.home.rows).toHaveLength(6)
    expect(view.problem).toBeNull()
    const lines = linesOf(view)
    const homeScore = view.home.score === view.away.score ? view.home.score + 1 : view.home.score
    const input = {
      jobId,
      gameId: game!.id,
      homeScore,
      awayScore: view.away.score,
      lines: lines.map(({ playerId, teamId, stats }) => ({ playerId, teamId, stats })),
      names: lines.map(({ teamId, source, playerId, row }) => ({ teamId, source, playerId, row })),
    }
    // Tied to a finished reading of this game.
    const { jobId: _omit, ...noJob } = input
    expect(await rejection(() => h['gameday.confirm']('gd', noJob))).toMatchObject({ code: 'invalid-input' })
    expect(await rejection(() => h['gameday.confirm']('gd', { ...input, jobId: 999 }))).toMatchObject({ code: 'not-found' })
    // Both teams need lines; names must be rows that were read.
    expect(
      await rejection(() => h['gameday.confirm']('gd', { ...input, lines: input.lines.filter((l) => l.teamId === game!.home) })),
    ).toMatchObject({ code: 'rule', rules: [{ code: 'empty-side', params: { teams: game!.away } }] })
    expect(
      await rejection(() => h['gameday.confirm']('gd', { ...input, names: [{ ...input.names[0]!, source: 'Z. Nobody' }] })),
    ).toMatchObject({ code: 'rule', rules: [{ code: 'name-not-read' }] })

    await h['gameday.confirm']('gd', input)
    const after = (await h['season.games']('gd')).find((g) => g.id === game!.id)!
    expect(after).toMatchObject({ status: 'final', hasBox: true })
    // Once only: a second confirm would overwrite the game as a correction.
    expect(await rejection(() => h['gameday.confirm']('gd', { ...input, homeScore: homeScore + 10 }))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'game-final' }],
    })
    expect((await h['season.games']('gd')).find((g) => g.id === game!.id)!.homeScore).toBe(homeScore)
    // A final game takes no more screenshots.
    const c = await h['gameday.saveImage']('gd', png(3))
    expect(await rejection(() => h['gameday.read']('gd', game!.id, [c.token]))).toMatchObject({ rules: [{ code: 'game-final' }] })
    // Next time the same names are known.
    const again = fakeCtx.gameday.confirmView(fakeCtx.leagues.dbFor('gd'), jobId)
    expect(again.home.rows.every((r) => r.how === 'learned')).toBe(true)
  })

  it('records the game and the names together, or neither', async () => {
    const [game] = await h['season.games']('gd')
    const a = await h['gameday.saveImage']('gd', png(1))
    const b = await h['gameday.saveImage']('gd', png(2))
    const { jobId } = await h['gameday.read']('gd', game!.id, [a.token, b.token])
    await waitDone(jobId)
    const view = await h['gameday.confirmView']('gd', jobId)
    const lines = linesOf(view)
    // Remembering the names fails after the score was written: the score goes too.
    fakeCtx.leagues.dbFor('gd').exec('DROP TABLE name_map')
    await expect(
      Promise.resolve().then(() =>
        h['gameday.confirm']('gd', {
          jobId,
          gameId: game!.id,
          homeScore: view.home.score + (view.home.score === view.away.score ? 1 : 0),
          awayScore: view.away.score,
          lines: lines.map(({ playerId, teamId, stats }) => ({ playerId, teamId, stats })),
          names: lines.map(({ teamId, source, playerId, row }) => ({ teamId, source, playerId, row })),
        }),
      ),
    ).rejects.toThrow(/name_map/)
    expect((await h['season.games']('gd')).find((g) => g.id === game!.id)).toMatchObject({ status: 'scheduled', hasBox: false })
  })

  it('refuses the same screenshot twice and cleans up the inbox', async () => {
    const [game] = await h['season.games']('gd')
    const inbox = join(fakeCtx.leagues.folderOf('gd'), 'screenshots', 'inbox')
    const a = await h['gameday.saveImage']('gd', png(1))
    const b = await h['gameday.saveImage']('gd', png(1))
    expect(await rejection(() => h['gameday.read']('gd', game!.id, [a.token, a.token]))).toMatchObject({ code: 'invalid-input' })
    expect(await rejection(() => h['gameday.read']('gd', game!.id, [a.token, b.token]))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'same-screenshot' }],
    })
    // Taken back: the file goes (twice is fine). Only real tokens are accepted.
    await h['gameday.discardImage']('gd', b.token)
    expect(readdirSync(inbox)).toEqual([a.token])
    await h['gameday.discardImage']('gd', b.token)
    for (const bad of ['../league.sqlite', 'x.png', `${a.token}/..`]) {
      expect(await rejection(() => h['gameday.discardImage']('gd', bad))).toMatchObject({ code: 'invalid-input' })
    }
    expect(existsSync(join(inbox, a.token))).toBe(true)
  })

  /** Reads two screenshots for a game and waits for the demo reader. */
  const readGame = async (gameId: number, a: number, b: number) => {
    const x = await h['gameday.saveImage']('gd', png(a))
    const y = await h['gameday.saveImage']('gd', png(b))
    const { jobId } = await h['gameday.read']('gd', gameId, [x.token, y.token])
    await waitDone(jobId)
    return jobId
  }
  const confirmOf = async (jobId: number) => {
    const view = await h['gameday.confirmView']('gd', jobId)
    const lines = linesOf(view)
    return {
      jobId,
      gameId: view.gameId,
      homeScore: view.home.score === view.away.score ? view.home.score + 1 : view.home.score,
      awayScore: view.away.score,
      lines: lines.map(({ playerId, teamId, stats }) => ({ playerId, teamId, stats })),
      names: lines.map(({ teamId, source, playerId, row }) => ({ teamId, source, playerId, row })),
    }
  }

  it('says a move still to make in 2K blocks the game before a read is spent', async () => {
    const db = fakeCtx.leagues.dbFor('gd')
    // A t1 game against neither school t1 trades with below.
    const game = (await h['season.games']('gd')).find((g) => [g.home, g.away].includes('t1') && ![g.home, g.away].some((t) => t === 't2' || t === 't3'))!
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    const a = await h['gameday.saveImage']('gd', png(1))
    expect(await rejection(() => h['gameday.read']('gd', game.id, [a.token]))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'pending-2k-moves', params: { teams: 't1' } }],
    })
    // Nothing was read or moved: the screenshot is still waiting in the inbox.
    expect(await h['gameday.jobs']('gd', game.id)).toEqual([])
    expect(readdirSync(join(fakeCtx.leagues.folderOf('gd'), 'screenshots', 'inbox'))).toEqual([a.token])
    markApplied(db, listChecklist(db)[0]!.id)
    const jobId = await readGame(game.id, 2, 3)
    expect((await h['gameday.confirmView']('gd', jobId)).waiting2k).toEqual([])
    // A move made after the read shows on the confirm screen (and saving is refused).
    applyTrade(db, [
      { kind: 'player', playerId: 'p2', from: 't1', to: 't3' },
      { kind: 'player', playerId: 'p13', from: 't3', to: 't1' },
    ])
    expect((await h['gameday.confirmView']('gd', jobId)).waiting2k).toEqual(['t1'])
  })

  it('shows the screenshots it read, and checks the numbers before saving', async () => {
    const [game] = await h['season.games']('gd')
    const jobId = await readGame(game!.id, 4, 5)
    const view = await h['gameday.confirmView']('gd', jobId)
    expect(view.images).toBe(2)
    expect(view.usedFor).toEqual([])
    // The demo reader shows no team totals; its lines add up.
    expect([view.home.shown, view.away.shown]).toEqual([null, null])
    expect(view.issues.filter((i) => i.code === 'line-points')).toEqual([])
    const { files } = await h['gameday.shots']('gd', jobId)
    expect(files.map((f) => [f.name, [...f.bytes]])).toEqual([
      ['1.png', [...png(4)]],
      ['2.png', [...png(5)]],
    ])
  })

  it('keeps one set of screenshots to one game; 기록 취소 frees them', async () => {
    const [first, second] = await h['season.games']('gd')
    const one = await readGame(first!.id, 6, 7)
    // Read for another game too, before the first is recorded: allowed, with a warning.
    const two = await readGame(second!.id, 6, 7)
    expect((await h['gameday.confirmView']('gd', two)).usedFor).toEqual([expect.objectContaining({ id: first!.id, status: 'scheduled' })])
    await h['gameday.confirm']('gd', await confirmOf(one))
    // Now they're the first game's box score: the second can't be saved from them, nor read from them again.
    expect((await h['gameday.confirmView']('gd', two)).usedFor).toEqual([expect.objectContaining({ id: first!.id, status: 'final' })])
    const second2 = await confirmOf(two)
    expect(await rejection(() => h['gameday.confirm']('gd', second2))).toMatchObject({ code: 'rule', rules: [{ code: 'screenshot-recorded' }] })
    const c = await h['gameday.saveImage']('gd', png(6))
    expect(await rejection(() => h['gameday.read']('gd', second!.id, [c.token]))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'screenshot-recorded', params: { stage: 'regular', round: first!.round, teams: `${first!.home}, ${first!.away}` } }],
    })
    // The first was recorded by mistake: taking it back frees them for the second.
    await h['season.unrecord']('gd', first!.id)
    await h['gameday.confirm']('gd', second2)
    expect((await h['season.games']('gd')).find((g) => g.id === second!.id)).toMatchObject({ status: 'final', hasBox: true })
  })

  it('does not attach a reading made for a different game under the same number', async () => {
    const [game] = await h['season.games']('gd')
    const db = fakeCtx.leagues.dbFor('gd')
    const store = sqliteJobStore(db)
    const stale = store.insert('read_box_score', { images: ['1.png'], teams: ['가', '나'], gameId: game!.id, gameKey: 'another game' }, 50, null)
    store.update(stale, { status: 'done', output: { teams: [{ team: 'A', players: [] }], notes: '' } })
    expect(await h['gameday.jobs']('gd', game!.id)).toEqual([])
    expect(await rejection(() => h['gameday.confirmView']('gd', stale))).toMatchObject({ code: 'rule', rules: [{ code: 'unknown-game' }] })
  })

  it('reads a failed job again from the same folder, and refuses a one-team read', async () => {
    const [first, game] = await h['season.games']('gd')
    const db = fakeCtx.leagues.dbFor('gd')
    const folder = join(fakeCtx.leagues.folderOf('gd'), 'screenshots', `game-${game!.id}-1`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '1.png'), png(1))
    const input = { images: ['1.png'], teams: ['가', '나'], gameId: game!.id }
    const store = sqliteJobStore(db)
    const failed = store.insert('read_box_score', input, 50, folder)
    store.update(failed, { status: 'failed', error: 'boom', errorKind: 'failed', attempts: 2, finishedAt: new Date().toISOString() })
    expect(await rejection(() => h['gameday.retry']('gd', 999))).toMatchObject({ code: 'not-found' })

    // The demo reader answers with only one team.
    const players = sampleSetup().players.filter((p) => p.teamId === game!.home)
    const line = { pts: 2, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, fgm: 1, fga: 1, tpm: 0, tpa: 0, ftm: 0, fta: 0 }
    const oneTeam = { teams: [{ team: 'X', players: players.map((p, i) => ({ ...line, name: `Q. Made${i}` })) }], notes: '' }
    writeFileSync(join(folder, FAKE_OUTPUT_FILE), JSON.stringify(oneTeam))
    const { jobId } = await h['gameday.retry']('gd', failed)
    expect(jobId).not.toBe(failed)
    expect(store.get(jobId)).toMatchObject({ folder, input: { ...input, manualRetryOf: failed } })
    // Read again once: a second press (here, or 최근 작업's 다시 시도) spends no second read.
    expect(await rejection(() => h['gameday.retry']('gd', failed))).toMatchObject({ code: 'rule', rules: [{ code: 'job-retried' }] })
    expect(await rejection(() => h['ai.retryJob']('gd', failed))).toMatchObject({ code: 'rule', rules: [{ code: 'job-retried' }] })
    expect((await waitDone(jobId)).status).toBe('done')
    expect((await h['ai.recentJobs']('gd')).find((j) => j.id === failed)).toMatchObject({ canRetry: false, retriedBy: jobId })
    expect(await rejection(() => h['gameday.retry']('gd', failed))).toMatchObject({ code: 'rule', rules: [{ code: 'job-retried' }] })
    expect((await h['gameday.jobs']('gd', game!.id)).map((j) => j.id)).toEqual([jobId, failed])
    expect(await rejection(() => h['gameday.retry']('gd', jobId))).toMatchObject({ code: 'invalid-input' })

    const view = await h['gameday.confirmView']('gd', jobId)
    expect(view.problem).toBe('one-team')
    const lines = linesOf(view)
    const confirm = { jobId, gameId: game!.id, homeScore: 12, awayScore: 10, lines: lines.map(({ playerId, teamId, stats }) => ({ playerId, teamId, stats })), names: [] }
    expect(await rejection(() => h['gameday.confirm']('gd', confirm))).toMatchObject({ code: 'rule', rules: [{ code: 'read-one-team' }] })
    expect((await h['season.games']('gd')).find((g) => g.id === game!.id)!.status).toBe('scheduled')
    // A reading of one game can't confirm another.
    expect(await rejection(() => h['gameday.confirm']('gd', { ...confirm, gameId: first!.id }))).toMatchObject({
      code: 'rule',
      rules: [{ code: 'read-other-game' }],
    })
  })
})
