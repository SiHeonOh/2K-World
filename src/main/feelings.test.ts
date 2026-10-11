import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import type { DealView } from '@shared/gm'
import { openDb, type Db } from '@data/db'
import { addStep, createNegotiation, insertWindow, updateNegotiation } from '@data/gm'
import { appendEvent, currentSeason, listEvents, seedLeague } from '@data/league'
import { applyTrade, vetoTrade } from '@data/moves'
import { startSeason } from '@data/season'
import { listSuggestions } from '@data/suggestions'
import { maybeClose, readMarket } from '@sim/gm'
import { ensureCast, gameThreadInput, readLeague } from '@story/context'
import { leagueFeelings } from '@story/feelings'
import { lockerRoom, snapshotMoods, WANTING_OUT_LINE } from '@story/mood'
import { reactionPicks } from '@story/reactions'
import { AiService } from './ai'
import { LoreService } from './lore'
import { SuggestionService } from './suggestions'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-feel-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  mkdirSync(join(dir, 'lore', 'teams', '가람고'), { recursive: true })
  // 가나나 (p2) counts 가다다 (p3) as a close friend.
  writeFileSync(join(dir, 'lore', 'teams', '가람고', '가나나.md'), '---\nid: 가나나\nrelationships:\n  - { with: 가다다, type: friend, strength: 4, visibility: public }\n---\n\n## 공개\n식스맨.\n')
  startSeason(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const league = () => readLeague(db, dir)
const feel = (id: string) => leagueFeelings(league()).get(id)!
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
/** A finished game straight into the tables (and its event), without going through the schedule. */
function fakeGame(home: string, away: string, homeScore: number, awayScore: number): number {
  const season = currentSeason(db).id
  const id = Number(
    db
      .prepare("INSERT INTO games (season_id, stage, round, home_id, away_id, home_score, away_score, status, recorded_at) VALUES (?, 'regular', 99, ?, ?, ?, ?, 'final', ?)")
      .run(season, home, away, homeScore, awayScore, iso()).lastInsertRowid,
  )
  appendEvent(db, 'game_recorded', { gameId: id, stage: 'regular', home, away, homeScore, awayScore }, season)
  return id
}
const tradeP3 = () =>
  applyTrade(db, [
    { kind: 'player', playerId: 'p3', from: 't1', to: 't2' },
    { kind: 'player', playerId: 'p9', from: 't2', to: 't1' },
  ])
const deal = (a: string, b: string, aGives: string[], bGives: string[]): DealView => ({ a, b, aGives, bGives, aCards: [], bCards: [] })
const step = (negotiationId: number, round: number, teamId: string, action: 'offer' | 'counter' | 'reject', d: DealView | null = null) =>
  addStep(db, { negotiationId, round, teamId, action, deal: d, message: '', note: '', report: null, trust: 0, jobId: null }, Date.now())
/** Talks that broke down, step by step as the GMs record them: the offer, the receiver's counter (still from the proposer's side) if any, and a no. */
function brokeDown(windowId: number, offer: DealView, counter?: DealView): number {
  const id = createNegotiation(db, windowId, offer, Date.now())
  step(id, 1, offer.a, 'offer', offer)
  if (counter) {
    step(id, 1, offer.b, 'counter', counter)
    updateNegotiation(db, id, { deal: counter })
    step(id, 2, offer.a, 'reject')
  } else step(id, 1, offer.b, 'reject')
  updateNegotiation(db, id, { status: 'rejected' })
  return id
}
const openWindow = () => insertWindow(db, currentSeason(db).id, currentSeason(db).phase, null, 'manual', Date.now())
/** Closes a window the way the GMs do: talks that broke down leak. */
const closeWindow = (windowId: number) => maybeClose({ db, folder: dir, hooks: { queue: () => {}, changed: () => {} } }, windowId, null, Date.now())

describe('lasting feelings, replayed from the league', () => {
  it('a friend traded away hurts the one left behind; the one sent away holds a grudge; a veto takes it all back', () => {
    const tradeId = tradeP3()
    expect(feel('p2').trust).toBe(-20)
    expect(feel('p2').why.trust[0]).toEqual({ key: 'friend_left', name: '가다다', value: -20 })
    expect(feel('p3').trust).toBe(0)
    expect(feel('p3').grudges).toEqual([expect.objectContaining({ target: { kind: 'team', id: 't1' }, why: 'sent_away' })])
    vetoTrade(db, tradeId)
    expect(feel('p2').trust).toBe(0)
    expect(feel('p3').grudges).toEqual([])
  })

  it('results count as they stand now: a corrected score changes the feelings', () => {
    fakeGame('t1', 't2', 80, 70)
    fakeGame('t1', 't3', 80, 70)
    const last = fakeGame('t1', 't4', 80, 70)
    const won = feel('p1')
    expect(won.trust).toBeGreaterThan(0)
    expect(won.attachment).toBeGreaterThan(40)
    db.prepare('UPDATE games SET home_score = 60 WHERE id = ?').run(last)
    appendEvent(db, 'game_corrected', { gameId: last, before: { homeScore: 80, awayScore: 70 }, after: { homeScore: 60, awayScore: 70 } }, currentSeason(db).id)
    const lost = feel('p1')
    expect(lost.trust).toBeLessThan(won.trust)
    expect(lost.attachment).toBeLessThan(won.attachment)
  })

  it('a trade request that outlives a window wears trust down', () => {
    db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, 'p1', 't1', 'none', '', 'private_request', '', ?)").run(
      currentSeason(db).id,
      iso(-2000),
    )
    const windowId = Number(
      db.prepare("INSERT INTO trade_windows (season_id, round, phase, status, reason, opened_at, closed_at) VALUES (?, NULL, 'regular', 'closed', 'manual', ?, ?)").run(currentSeason(db).id, iso(-1000), iso())
        .lastInsertRowid,
    )
    appendEvent(db, 'trade_window_closed', { windowId, trades: 0, talks: 0 }, currentSeason(db).id)
    expect(feel('p1').trust).toBe(-15)
    expect(feel('p1').why.trust[0]!.key).toBe('ignored_private')
  })

  it("a happy player's request was dropped: the window ignored nothing", () => {
    db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, 'p1', 't1', 'none', '', 'private_request', '', ?)").run(
      currentSeason(db).id,
      iso(-5000),
    )
    // He was happy again by the time a window opened: nothing was ignored.
    db.prepare("INSERT INTO player_mood (season_id, player_id, overall, band, parts, created_at) VALUES (?, 'p1', 50, 'happy', '{}', ?)").run(currentSeason(db).id, iso(-4000))
    const windowId = Number(
      db.prepare("INSERT INTO trade_windows (season_id, round, phase, status, reason, opened_at, closed_at) VALUES (?, NULL, 'regular', 'closed', 'manual', ?, ?)").run(currentSeason(db).id, iso(-3000), iso(-2000))
        .lastInsertRowid,
    )
    appendEvent(db, 'trade_window_closed', { windowId, trades: 0, talks: 0 }, currentSeason(db).id)
    expect(feel('p1').why.trust.map((r) => r.key)).not.toContain('ignored_private')
  })

  it("in a new season, last season's request has lapsed, and this season's counts", () => {
    const say = (season: number, at: string) =>
      db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, 'p1', 't1', 'none', '', 'private_request', '', ?)").run(season, at)
    const closeWindow = (season: number, opened: string, closed: string) => {
      const windowId = Number(
        db.prepare("INSERT INTO trade_windows (season_id, round, phase, status, reason, opened_at, closed_at) VALUES (?, NULL, 'regular', 'closed', 'manual', ?, ?)").run(season, opened, closed).lastInsertRowid,
      )
      appendEvent(db, 'trade_window_closed', { windowId, trades: 0, talks: 0 }, season)
    }
    const one = currentSeason(db).id
    say(one, iso(-9000))
    const two = Number(db.prepare("INSERT INTO seasons (label, phase, started_at, seed) VALUES ('시즌 2', 'regular', ?, 2)").run(iso(-8000)).lastInsertRowid)
    appendEvent(db, 'season_created', { label: '시즌 2' }, two)
    closeWindow(two, iso(-7000), iso(-6000))
    expect(feel('p1').why.trust.map((r) => r.key)).not.toContain('ignored_private')
    // After the new season began (its event is stamped now): asked, then a window came and went.
    say(two, iso(1000))
    closeWindow(two, iso(2000), iso(3000))
    expect(feel('p1').why.trust.map((r) => r.key)).toContain('ignored_private')
  })

  it('a series handed back by corrections counts once', () => {
    const series = Number(
      db
        .prepare("INSERT INTO series (season_id, stage, round, slot, a_ref, b_ref, best_of, winner_id) VALUES (?, 'playoffs', 1, 'A', 'x', 'y', 7, 't1')")
        .run(currentSeason(db).id).lastInsertRowid,
    )
    const before = feel('p1').attachment
    const won = () => appendEvent(db, 'series_won', { seriesId: series, slot: 'A', winner: 't1', loser: 't2', wins: 4, losses: 2 }, currentSeason(db).id)
    won()
    const once = feel('p1').attachment
    won()
    expect(once).toBe(before + 5)
    expect(feel('p1').attachment).toBe(once)
  })

  it('long unhappiness makes him want out: news once, a reason to speak, and his GM keener to move him', () => {
    const season = currentSeason(db).id
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO player_mood (season_id, player_id, overall, band, parts, created_at) VALUES (?, 'p1', -60, 'boiling', '{}', ?)").run(season, iso(-60_000 + i * 1000))
    }
    // Snapshots from before feelings were kept (null): the first look after can't tell a crossing.
    snapshotMoods(league(), 't1', Date.now() - 30_000)
    expect(listEvents(db, 'wanting_out')).toHaveLength(0)
    // Back under the line, then over it: news.
    db.prepare("UPDATE player_mood SET feelings = '{\"trust\":0,\"attachment\":40,\"wantingOut\":10}' WHERE id = (SELECT MAX(id) FROM player_mood WHERE player_id = 'p1')").run()
    snapshotMoods(league(), 't1', Date.now())
    const news = listEvents(db, 'wanting_out')
    expect(news).toHaveLength(1)
    expect(news[0]!.payload).toMatchObject({ playerId: 'p1', teamId: 't1' })
    expect((news[0]!.payload as { value: number }).value).toBeGreaterThanOrEqual(WANTING_OUT_LINE)
    // Already over the line: the next snapshot isn't news again; nor is dipping and crossing again this season.
    snapshotMoods(league(), 't1', Date.now() + 1000)
    db.prepare("UPDATE player_mood SET feelings = '{\"trust\":0,\"attachment\":40,\"wantingOut\":10}' WHERE id = (SELECT MAX(id) FROM player_mood WHERE player_id = 'p1')").run()
    snapshotMoods(league(), 't1', Date.now() + 2000)
    expect(listEvents(db, 'wanting_out')).toHaveLength(1)
    const pick = reactionPicks(league(), news).find((p) => p.playerId === 'p1')
    expect(pick?.causes.join()).toContain('참다 참다')
    // His GM is keener to move him by as much as he wants out (a neutral teammate: not at all).
    const market = readMarket(league()).market.players
    expect(market.find((p) => p.id === 'p1')!.moveWish).toBe(feel('p1').wantingOut / 100)
    expect(market.find((p) => p.id === 'p1')!.moveWish).toBeGreaterThan(0.3)
    expect(market.find((p) => p.id === 'p2')!.moveWish).toBe(0)
    const room = lockerRoom(league(), 't1').players.find((p) => p.playerId === 'p1')!
    expect(room.feelings.wantingOut).toBe(feel('p1').wantingOut)
    expect(room.parts.belonging).toBe(feel('p1').belonging)
  })

  it("a grudge against a player that won't fade becomes a relationship card, once", () => {
    appendEvent(db, 'player_said', { quoteId: 1, playerId: 'p7', teamId: 't2', channel: 'interview', quote: '가가가는 과대평가됐어요', action: 'call_out_rival', targetId: 'p1' }, currentSeason(db).id)
    for (let i = 0; i < 20; i++) fakeGame('t1', 't3', 80, 70)
    const g = feel('p1').grudges[0]!
    expect(g).toMatchObject({ target: { kind: 'player', id: 'p7' }, why: 'called_out', games: 20 })
    const suggestions = new SuggestionService(new AiService(), new LoreService(join(process.cwd(), 'defaults')))
    expect(suggestions.grudgeCards(db, dir, currentSeason(db).id, 5)).toBe(1)
    const card = listSuggestions(db, 'pending').find((s) => s.kind === 'relationship')!
    expect(card.target).toEqual({ kind: 'player', playerId: 'p1' })
    expect(card.patch.relationships).toEqual([{ with: '나가나', type: 'dislikes', strength: 3, visibility: 'rumor' }])
    expect(suggestions.grudgeCards(db, dir, currentSeason(db).id, 6)).toBe(0)
  })

  it('leaked talks hurt a player his own school offered, in its offer or its counter, not one the other school only asked for', () => {
    const w = openWindow()
    // 가람고 offered p3 for p10, and 나람고 said no.
    brokeDown(w, deal('t1', 't2', ['p3'], ['p10']))
    // 다람고 offered p13 for p19; 라람고 countered, asking for p14 instead and offering p20; 다람고 said no.
    brokeDown(w, deal('t3', 't4', ['p13'], ['p19']), deal('t3', 't4', ['p14'], ['p20']))
    closeWindow(w)
    expect(listEvents(db, 'trade_talks')).toHaveLength(2)
    for (const id of ['p3', 'p20']) {
      expect(feel(id).trust).toBe(-10)
      expect(feel(id).attachment).toBe(35)
      expect(feel(id).why.trust[0]).toEqual({ key: 'shopped', value: -10 })
    }
    // Only asked for (p10, p14), or offered but left out of the deal that leaked (p13): nothing.
    for (const id of ['p10', 'p14', 'p13', 'p19']) expect(feel(id).why.trust.map((r) => r.key)).not.toContain('shopped')
  })

  it('a leak after he was traded away in the same window spares his new school; a veto brings it back to the old one', () => {
    const w = openWindow()
    // 가람고 offered p3 for p10 and 나람고 said no; later in the window 나람고 traded p9 for him after all.
    brokeDown(w, deal('t1', 't2', ['p3'], ['p10']))
    const tradeId = tradeP3()
    closeWindow(w)
    expect(listEvents(db, 'trade_talks')).toHaveLength(1)
    // At 나람고 when the talks leak: nothing against his new school, and no more against 가람고 than sending him away.
    expect(feel('p3').trust).toBe(0)
    expect(feel('p3').attachment).toBe(30)
    expect(feel('p3').grudges).toEqual([expect.objectContaining({ target: { kind: 'team', id: 't1' }, why: 'sent_away', value: -25 })])
    expect(feel('p10').why.trust.map((r) => r.key)).not.toContain('shopped')
    // Vetoed: he never left 가람고, the school that shopped him.
    vetoTrade(db, tradeId)
    expect(feel('p3').trust).toBe(-10)
    expect(feel('p3').why.trust[0]).toEqual({ key: 'shopped', value: -10 })
    expect(feel('p3').grudges).toEqual([])
  })

  it('facing the school that sent him away is a 복수전 for the forum', () => {
    tradeP3()
    const gameId = fakeGame('t1', 't2', 80, 75)
    ensureCast(league())
    const input = gameThreadInput(league(), gameId, 0)
    expect(input.context).toContain('복수전')
    expect(input.context).toContain('가다다(현 나람고)는 원치 않게 가람고를 떠났다')
  })
})
