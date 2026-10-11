import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { createNegotiation, insertWindow, updateNegotiation, windowAfterRound } from '@data/gm'
import { currentSeason, listEvents, listPlayers, loadConfig, seedLeague, updateConfig } from '@data/league'
import { listChecklist, listTrades } from '@data/moves'
import { listGames, recordScore, setPhase, startSeason } from '@data/season'
import { describeEvent, readLeague } from '@story/context'
import { storyDemo, storyKinds } from '@story/jobs'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { gmDemo, gmKinds, resolvePlayer, type GmHooks } from '@sim/gm'
import { AiService } from './ai'
import { GmService } from './gm'
import { syncLoreFolder } from './lore'
import { StoryService } from './story'

const SECRET = '사실은 이 학교를 떠날 생각이다'

let dir: string
let db: Db
let ai: AiService
let gm: GmService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-gm-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  // One GM with a persona and a secret no job may see.
  mkdirSync(join(dir, 'lore', 'teams', '가람고'), { recursive: true })
  writeFileSync(
    join(dir, 'lore', 'teams', '가람고', '가람고 단장.md'),
    `---\nid: 가람고 단장\nname: 김단장\nteam: 가람고\nphilosophy: win-now\ntraits: { star_chasing: 5, risk: 5 }\nnegotiation: hardball\n---\n\n## 공개\n말이 짧다.\n\n## 비밀\n${SECRET}\n`,
  )
  ai = new AiService()
  const hooks = (slug: string, d: Db, f: string): GmHooks => ({
    queue: (kind, input, priority) => void ai.queueFor(slug, d, f).enqueue(kind, input, priority),
    changed: () => {
      syncLoreFolder(d, f)
      story.afterChange(slug, d, f)
    },
  })
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f, slug) => gmKinds(d, f, hooks(slug, d, f)), gmDemo)
  await ai.refresh()
  gm = new GmService(ai, hooks)
  story = new StoryService(ai, { onRound: (slug, d, f, season, round) => gm.onRound(slug, d, f, season, round) })
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = async () => {
  for (let i = 0; i < 5; i++) {
    await ai.queueFor('test', db, dir).kick()
    await new Promise((r) => setImmediate(r))
  }
}
const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]
const setGm = (change: Partial<ReturnType<typeof loadConfig>['config']['gm']>) => {
  const { config } = loadConfig(db)
  updateConfig(db, { ...config, gm: { ...config.gm, ...change } })
}

describe('a trade window (demo GMs)', () => {
  it('motivated GMs offer, receivers answer, and deals go through the League engine', async () => {
    const opened = gm.openWindow('test', db, dir, 'manual', null)
    expect(opened.gms).toBeGreaterThan(0)
    expect(gm.status('test', db, dir).open?.id).toBe(opened.windowId)
    for (const j of jobs('gm_intent')) {
      expect(j.input).not.toContain(SECRET)
      // The GM with a lore file gets its persona (공개), never its 비밀.
      if (j.input.includes('김단장')) expect(j.input).toContain('말이 짧다')
    }
    await drain()
    const [w] = gm.windows(db)
    expect(w!.status).toBe('closed')
    const accepted = w!.negotiations.filter((n) => n.status === 'accepted')
    expect(accepted.length).toBeGreaterThan(0)
    for (const n of w!.negotiations) {
      expect(n.steps[0]!.action).toBe('offer')
      expect(n.steps[0]!.note).not.toBe('')
    }
    for (const j of jobs('gm_respond')) expect(j.input).not.toContain(SECRET)
    // The trades are the League engine's: on the 2K checklist, vetoable, with their thread queued.
    const trades = listTrades(db, currentSeason(db).id)
    expect(trades.filter((t) => t.source === 'gm')).toHaveLength(accepted.length)
    expect(listChecklist(db).length).toBe(accepted.length)
    expect(accepted.every((n) => n.vetoable)).toBe(true)
    expect(listEvents(db, 'trade_window_closed')).toHaveLength(1)
    expect(jobs('event_thread').length).toBeGreaterThan(0)
    // No team ends up in two deals in one window.
    const teams = accepted.flatMap((n) => [n.fromTeam, n.toTeam])
    expect(new Set(teams).size).toBe(teams.length)
    expect(gm.status('test', db, dir).open).toBeNull()
  })

  it('with autonomy set to propose, agreed deals wait for you', async () => {
    setGm({ autonomy: 'propose' })
    gm.openWindow('test', db, dir, 'manual', null)
    await drain()
    const agreed = gm.windows(db)[0]!.negotiations.filter((n) => n.status === 'agreed')
    expect(agreed.length).toBeGreaterThan(0)
    expect(listTrades(db, currentSeason(db).id)).toHaveLength(0)
    expect(gm.status('test', db, dir).agreed).toBe(agreed.length)
    expect(gm.approve('test', db, dir, agreed[0]!.id)).toEqual({ status: 'accepted' })
    expect(listTrades(db, currentSeason(db).id)).toHaveLength(1)
    if (agreed[1]) {
      gm.decline(db, agreed[1].id)
      expect(gm.windows(db)[0]!.negotiations.find((n) => n.id === agreed[1]!.id)!.status).toBe('declined')
    }
  })

  it('opens a window after every N completed rounds', async () => {
    setGm({ tradeWindowEveryRounds: 1 })
    startSeason(db)
    story.afterChange('test', db, dir)
    for (const g of listGames(db, currentSeason(db).id).filter((x) => x.stage === 'regular' && x.round === 1)) {
      const lines = listPlayers(db)
        .filter((p) => p.teamId === g.home || p.teamId === g.away)
        .map((p) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 10 } }))
      recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
    }
    story.afterChange('test', db, dir)
    expect(windowAfterRound(db, currentSeason(db).id, 1)).toBe(true)
    expect(jobs('gm_intent').length).toBeGreaterThan(0)
  })

  it('drops a window’s work when trades close, and the window closes', async () => {
    gm.openWindow('test', db, dir, 'manual', null)
    // Trades are only allowed in preseason and regular season here.
    setPhase(db, currentSeason(db), 'offseason')
    await drain()
    expect(jobs('gm_intent').every((j) => j.status === 'cancelled')).toBe(true)
    expect(gm.status('test', db, dir).open).toBeNull()
    expect(() => gm.openWindow('test', db, dir, 'manual', null)).toThrow()
  })

  it('never opens a window in the playoffs, even when the league ticked them as a trade phase', () => {
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, trades: { ...config.trades, phases: ['preseason', 'regular', 'playoffs'] } })
    setPhase(db, currentSeason(db), 'playoffs')
    expect(gm.status('test', db, dir).blocked).toBe('phase')
    expect(() => gm.openWindow('test', db, dir, 'manual', null)).toThrow()
  })

  it('tells the forum a GM deal was lopsided, and leaked talks are rumors', () => {
    const league = readLeague(db, dir)
    const players = listPlayers(db)
    const trade = describeEvent(league, {
      id: 1,
      type: 'trade_applied',
      seasonId: 1,
      createdAt: '',
      payload: { tradeId: 1, teams: ['t1', 't2'], players: [players[0]!.id], cards: [], negotiationId: 3, valueGap: 22, lopsided: true },
    } as never)
    expect(trade?.text).toContain('사기 트레이드')
    const talks = describeEvent(league, { id: 2, type: 'trade_talks', seasonId: 1, createdAt: '', payload: { negotiationId: 3, teams: ['t1', 't2'], players: [] } } as never)
    expect(talks?.text).toContain('찌라시')
    const quiet = describeEvent(league, { id: 3, type: 'trade_window_closed', seasonId: 1, createdAt: '', payload: { windowId: 1, trades: 0, agreed: 0, talks: 0 } } as never)
    expect(quiet).toBeNull()
    const waiting = describeEvent(league, { id: 4, type: 'trade_window_closed', seasonId: 1, createdAt: '', payload: { windowId: 1, trades: 1, agreed: 2, talks: 3 } } as never)
    expect(waiting?.text).toContain('승인 대기 2건')
    expect(waiting?.text).not.toContain('결렬')
  })
})

describe('what the review found', () => {
  it('opens no window at all when no GM has anything worth offering', () => {
    // One AI team left: it has nobody to trade with.
    db.prepare("UPDATE teams SET control = 'user' WHERE id <> 't1'").run()
    expect(gm.openWindow('test', db, dir, 'manual', null)).toEqual({ windowId: null, gms: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM trade_windows').get()).toEqual({ n: 0 })
    expect(listEvents(db, 'trade_window_opened')).toHaveLength(0)
  })

  it('a window stuck open doesn’t swallow the next scheduled one', () => {
    setGm({ tradeWindowEveryRounds: 1 })
    insertWindow(db, currentSeason(db).id, currentSeason(db).phase, null, 'manual', Date.now())
    expect(gm.onRound('test', db, dir, currentSeason(db).id, 1)).toBe(true)
    const windows = db.prepare('SELECT status, round FROM trade_windows ORDER BY id').all()
    expect(windows).toEqual([
      { status: 'closed', round: null },
      { status: 'open', round: 1 },
    ])
  })

  it('a stuck window closed by a round’s last game still gets its rumors posted', async () => {
    setGm({ tradeWindowEveryRounds: 1 })
    startSeason(db)
    story.afterChange('test', db, dir)
    const season = currentSeason(db)
    const stuck = insertWindow(db, season.id, season.phase, null, 'manual', Date.now())
    const n = createNegotiation(db, stuck, { a: 't1', b: 't2', aGives: ['p1'], bGives: ['p7'], aCards: [], bCards: [] }, Date.now())
    updateNegotiation(db, n, { status: 'rejected' })
    for (const g of listGames(db, season.id).filter((x) => x.stage === 'regular' && x.round === 1)) {
      const lines = listPlayers(db)
        .filter((p) => p.teamId === g.home || p.teamId === g.away)
        .map((p) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 10 } }))
      recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
    }
    story.afterChange('test', db, dir)
    await drain()
    expect(listEvents(db, 'trade_talks')).toHaveLength(1)
    expect(jobs('event_thread').some((j) => j.input.includes('찌라시'))).toBe(true)
  })

  it('reads a player the way GMs see him named', () => {
    const league = readLeague(db, dir)
    const p = listPlayers(db)[1]!
    expect(resolvePlayer(league, `${p.name}(가람고 SG · OVR 71)`)).toBe(p.id)
    expect(resolvePlayer(league, p.name)).toBe(p.id)
    expect(resolvePlayer(league, '없는선수')).toBeNull()
  })
})
