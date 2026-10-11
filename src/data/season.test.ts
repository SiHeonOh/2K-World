import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import type { LeagueSetup } from '@shared/setup'
import { computeRows, rankTeams } from '@core/standings'
import { seasonTotals } from '@core/stats'
import { openDb, type Db } from './db'
import { currentSeason, listEvents, listSeasons, loadConfig, seasonFor, seedLeague, updateConfig } from './league'
import { startNextSeason } from './moves'
import { RuleError } from './rules'
import { scheduleInfo } from './schedule'
import {
  finishPlayoffs,
  listGames,
  playoffsView,
  recordScore,
  regularFinals,
  seasonBoxLines,
  standings,
  startPlayoffs,
  startSeason,
  teamRefs,
} from './season'

function league(change?: (s: LeagueSetup) => void): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  change?.(setup)
  seedLeague(db, setup)
  return db
}

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    throw e
  }
  return []
}

/** Lower team number always wins, by 10. */
function playAll(db: Db, stage: 'regular' | 'playoffs') {
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter(
      (g) => g.status === 'scheduled' && (stage === 'regular' ? g.stage === 'regular' : g.stage !== 'regular'),
    )
    if (open.length === 0) return
    for (const g of open) {
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
    if (stage === 'regular') return
  }
}

describe('a season', () => {
  it('starts with a full schedule and moves to the regular season', () => {
    const db = league()
    expect(startSeason(db)).toEqual({ games: 28 })
    expect(currentSeason(db).phase).toBe('regular')
    expect(refusal(() => startSeason(db))).toEqual(['wrong-phase'])
    expect(listEvents(db, 'season_started')).toHaveLength(1)
  })

  it('records scores and keeps standings', () => {
    const db = league()
    startSeason(db)
    const [g] = listGames(db, currentSeason(db).id)
    expect(refusal(() => recordScore(db, { gameId: g!.id, homeScore: 80, awayScore: 80, lines: null }))).toEqual(['tie-score'])
    recordScore(db, { gameId: g!.id, homeScore: 101, awayScore: 99, lines: null })
    const view = standings(db)
    expect(view.played).toBe(1)
    const home = view.overall.find((l) => l.teamId === g!.home)!
    expect([home.wins, home.losses, home.streak]).toEqual([1, 0, 'W1'])
    // A correction is its own event.
    recordScore(db, { gameId: g!.id, homeScore: 90, awayScore: 99, lines: null })
    expect(standings(db).overall.find((l) => l.teamId === g!.home)!.losses).toBe(1)
    expect(listEvents(db, 'game_corrected')).toHaveLength(1)
    // Saving it again unchanged isn't a correction.
    recordScore(db, { gameId: g!.id, homeScore: 90, awayScore: 99, lines: null })
    expect(listEvents(db, 'game_corrected')).toHaveLength(1)
  })

  it('stores box lines and reports self-check warnings', () => {
    const db = league()
    startSeason(db)
    const g = listGames(db, currentSeason(db).id).find((x) => x.home === 't1' || x.away === 't1')!
    const t1Player = g.home === 't1' ? 'p1' : 'p1'
    const { warnings } = recordScore(db, {
      gameId: g.id,
      homeScore: 100,
      awayScore: 90,
      lines: [{ playerId: t1Player, teamId: 't1', stats: { pts: 30, fgm: 10, fga: 20, '3pm': 2, '3pa': 5, ftm: 4, fta: 5 } }],
    })
    expect(warnings.map((w) => w.code)).toContain('line-points')
    expect(
      refusal(() =>
        recordScore(db, { gameId: g.id, homeScore: 100, awayScore: 90, lines: [{ playerId: 'p13', teamId: 't1', stats: {} }] }),
      ),
    ).toEqual(['line-wrong-team'])
  })

  it('runs the playoffs to a champion and closes the season', () => {
    const db = league()
    startSeason(db)
    expect(refusal(() => startPlayoffs(db))).toEqual(['games-left'])
    playAll(db, 'regular')
    startPlayoffs(db)
    expect(currentSeason(db).phase).toBe('playoffs')
    let view = playoffsView(db)
    // Two seeds per conference: east r1, west r1, the final.
    expect(view.series.map((s) => s.slot)).toEqual(['east:r1:0', 'west:r1:0', 'finals'])
    expect(view.series[0]).toMatchObject({ highSeed: 1, lowSeed: 2 })
    expect(refusal(() => finishPlayoffs(db))).toEqual(['series-left'])
    playAll(db, 'playoffs')
    view = playoffsView(db)
    expect(view.series.every((s) => s.winner !== null)).toBe(true)
    const final = view.series.find((s) => s.slot === 'finals')!
    expect(final.highWins).toBe(4)
    expect(final.winner).toBe('t1')
    finishPlayoffs(db)
    expect(currentSeason(db).phase).toBe('offseason')
    expect(listEvents(db, 'series_won')).toHaveLength(3)
  })

  it('hands out cards: guaranteed ones at the start, the rest by final rank', () => {
    const db = league((s) => {
      s.config.draft = {
        ...defaultCardSwap(8),
        allocation: [
          { fromRank: 1, toRank: 1, cards: 5 },
          { fromRank: 2, toRank: 4, cards: 4 },
          { fromRank: 5, toRank: 8, cards: 3 },
        ],
      }
      s.teams[7]!.control = 'frozen'
    })
    startSeason(db)
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM cards')).toBe(7 * 3)
    playAll(db, 'regular')
    startPlayoffs(db)
    playAll(db, 'playoffs')
    finishPlayoffs(db)
    expect(currentSeason(db).phase).toBe('draft')
    // t1 is ranked first (5 cards); t8 is frozen (none).
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE original_team_id = 't1'")).toBe(5)
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE original_team_id = 't8'")).toBe(0)
  })

  it('refuses a corrected playoff game once the next series has started', () => {
    const db = league()
    startSeason(db)
    playAll(db, 'regular')
    startPlayoffs(db)
    playAll(db, 'playoffs')
    const eastGame = listGames(db, currentSeason(db).id).find((g) => g.stage === 'playoffs' && g.status === 'final')!
    expect(refusal(() => recordScore(db, { gameId: eastGame.id, homeScore: 50, awayScore: 60, lines: null }))).toEqual([
      'series-already-continued',
    ])
  })
})

describe('corrections and traded players', () => {
  it('refuses a correction that would have ended a series early', () => {
    const db = league()
    startSeason(db)
    playAll(db, 'regular')
    startPlayoffs(db)
    const series = () => playoffsView(db).series.find((x) => x.slot === 'east:r1:0')!
    const high = series().high!
    // High seed wins games 1–3, loses 4–6, wins game 7: 4-3.
    for (const highWins of [true, true, true, false, false, false, true]) {
      const g = listGames(db, currentSeason(db).id).find((x) => x.seriesId === series().id && x.status === 'scheduled')!
      const homeIsHigh = g.home === high
      recordScore(db, { gameId: g.id, homeScore: highWins === homeIsHigh ? 100 : 90, awayScore: highWins === homeIsHigh ? 90 : 100, lines: null })
    }
    expect(series()).toMatchObject({ highWins: 4, lowWins: 3, winner: high })
    // Flipping game 4 would have made it 4-0 after four games, with three more played.
    const game4 = listGames(db, currentSeason(db).id).find((x) => x.seriesId === series().id && x.round === 4)!
    const homeIsHigh = game4.home === high
    expect(
      refusal(() =>
        recordScore(db, { gameId: game4.id, homeScore: homeIsHigh ? 100 : 90, awayScore: homeIsHigh ? 90 : 100, lines: null }),
      ),
    ).toEqual(['series-impossible'])
  })

  it('records a series_result_changed event when a correction undoes a series win', () => {
    const db = league()
    startSeason(db)
    playAll(db, 'regular')
    startPlayoffs(db)
    const series = () => playoffsView(db).series.find((x) => x.slot === 'east:r1:0')!
    const high = series().high!
    const play = (highWins: boolean, g = listGames(db, currentSeason(db).id).find((x) => x.seriesId === series().id && x.status === 'scheduled')!) =>
      recordScore(db, { gameId: g.id, homeScore: highWins === (g.home === high) ? 100 : 90, awayScore: highWins === (g.home === high) ? 90 : 100, lines: null })
    for (let i = 0; i < 4; i++) play(true)
    expect(series().winner).toBe(high)
    const game4 = listGames(db, currentSeason(db).id).find((x) => x.seriesId === series().id && x.round === 4)!
    play(false, game4)
    expect(series().winner).toBeNull()
    expect(listEvents(db, 'series_result_changed').map((e) => e.payload)).toEqual([
      { seriesId: series().id, slot: 'east:r1:0', before: high, after: null },
    ])
  })

  it('accepts a box line for a player under the team he played for before a trade (and remembers it after)', () => {
    const db = league()
    startSeason(db)
    const before = listGames(db, currentSeason(db).id).find((g) => g.home === 't1' || g.away === 't1')!
    db.prepare("INSERT INTO trades (season_id, phase, status, source, created_at) VALUES (?, 'regular', 'applied', 'user', 'now')").run(currentSeason(db).id)
    db.prepare("INSERT INTO trade_items (trade_id, kind, from_team_id, to_team_id, player_id) VALUES (1, 'player', 't1', 't2', 'p1')").run()
    db.prepare("UPDATE players SET team_id = 't2' WHERE id = 'p1'").run()
    const { warnings } = recordScore(db, {
      gameId: before.id,
      homeScore: 100,
      awayScore: 90,
      lines: [{ playerId: 'p1', teamId: 't1', stats: { pts: 10 } }],
    })
    expect(warnings).toBeDefined()
    // Past rosters aren't stored: the box lines say where he played that season.
    expect(seasonTotals(seasonBoxLines(db, currentSeason(db).id)).get('p1')!.teamId).toBe('t1')
  })

  it('takes a player’s team that season from the order it was played, not from game ids', () => {
    const db = league()
    startSeason(db)
    const season = currentSeason(db).id
    // A round-2 game, then a round-1 game built later (a higher id): he played round 1 for t1, round 2 for t2.
    const game = db.prepare(
      "INSERT INTO games (season_id, stage, round, home_id, away_id, home_score, away_score, status) VALUES (?, 'regular', ?, ?, 't3', 100, 90, 'final')",
    )
    const line = db.prepare('INSERT INTO box_lines (game_id, player_id, team_id, row_order, stats) VALUES (?, ?, ?, 0, ?)')
    const round2 = Number(game.run(season, 2, 't2').lastInsertRowid)
    const round1 = Number(game.run(season, 1, 't1').lastInsertRowid)
    line.run(round2, 'p1', 't2', '{"pts":10}')
    line.run(round1, 'p1', 't1', '{"pts":20}')
    expect(round1).toBeGreaterThan(round2)
    expect(seasonTotals(seasonBoxLines(db, season)).get('p1')).toMatchObject({ teamId: 't2', games: 2, totals: { pts: 30 } })
  })
})

describe('a past season', () => {
  /** Season 1 played through (lower team number always wins), then season 2 started with one game played. */
  function twoSeasons() {
    const db = league()
    startSeason(db)
    playAll(db, 'regular')
    startPlayoffs(db)
    playAll(db, 'playoffs')
    finishPlayoffs(db)
    const first = currentSeason(db)
    startNextSeason(db, '시즌 2')
    startSeason(db)
    const [g] = listGames(db, currentSeason(db).id)
    // The higher-numbered team wins this one, unlike every game last season.
    const homeWins = Number(g!.home.slice(1)) > Number(g!.away.slice(1))
    recordScore(db, { gameId: g!.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    return { db, first, second: currentSeason(db), game: g! }
  }

  it('lists the seasons and finds one by id, refusing an id the league lacks', () => {
    const { db, first, second } = twoSeasons()
    expect(listSeasons(db)).toEqual([
      { id: first.id, label: '시즌 1', current: false },
      { id: second.id, label: '시즌 2', current: true },
    ])
    expect(seasonFor(db, first.id)).toMatchObject({ id: first.id, label: '시즌 1', phase: 'offseason' })
    expect(seasonFor(db)).toEqual(second)
    expect(refusal(() => seasonFor(db, 999))).toEqual(['unknown-season'])
    expect(refusal(() => standings(db, 999))).toEqual(['unknown-season'])
  })

  it('keeps its own standings, apart from the current season', () => {
    const { db, first, game } = twoSeasons()
    const now = standings(db)
    expect([now.played, now.total]).toEqual([1, 28])
    const then = standings(db, first.id)
    // Over: its total is the games it had, all played.
    expect([then.played, then.scheduled, then.total]).toEqual([28, 0, 28])
    expect(then.overall.map((l) => l.teamId)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])
    expect(then.overall[0]).toMatchObject({ wins: 7, losses: 0, streak: 'W7' })
    expect(then.conferences.east!.map((l) => l.teamId)).toEqual(['t1', 't2', 't5', 't6'])
    // This season's game isn't in last season's table.
    const winner = Number(game.home.slice(1)) > Number(game.away.slice(1)) ? game.home : game.away
    expect(now.overall.find((l) => l.teamId === winner)!.wins).toBe(1)
    expect(then.overall.find((l) => l.teamId === winner)!.wins).toBe(7 - Number(winner.slice(1)) + 1)
    // Asking for the current season by id is the same as asking for the current season.
    expect(standings(db, currentSeason(db).id)).toEqual(now)
  })

  it('keeps the order it ended in, though the tiebreakers change later', () => {
    const db = league()
    startSeason(db)
    // Lower team number wins by 10, except t4 beats t1 by 50: t1 and t2 finish 6-1, t3 and t4 5-2.
    // Head-to-head puts t1 and t3 ahead; point difference would put t2 and t4 ahead.
    for (const g of listGames(db, currentSeason(db).id)) {
      const upset = [g.home, g.away].sort().join() === 't1,t4'
      const winner = upset ? 't4' : Number(g.home.slice(1)) < Number(g.away.slice(1)) ? g.home : g.away
      const loser = 100 - (upset ? 50 : 10)
      recordScore(db, { gameId: g.id, homeScore: g.home === winner ? 100 : loser, awayScore: g.home === winner ? loser : 100, lines: null })
    }
    startPlayoffs(db)
    playAll(db, 'playoffs')
    finishPlayoffs(db)
    const first = currentSeason(db).id
    startNextSeason(db, '시즌 2')
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, season: { ...config.season, standings: { tiebreakers: ['point-diff'] } } })

    const then = standings(db, first)
    expect(then.overall.map((l) => l.teamId)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])
    // Records and games behind are counted again.
    expect(then.overall.slice(0, 4).map((l) => [l.wins, l.losses, l.gamesBehind])).toEqual([
      [6, 1, 0],
      [6, 1, 0],
      [5, 2, 1],
      [5, 2, 1],
    ])
    // Each conference keeps its seeds first; the rest, and each division, are ranked within themselves.
    expect(then.conferences.east!.map((l) => l.teamId)).toEqual(['t1', 't2', 't5', 't6'])
    expect(then.conferences.west!.map((l) => l.teamId)).toEqual(['t3', 't4', 't7', 't8'])
    expect(then.divisions.n!.map((l) => l.teamId)).toEqual(['t1', 't5'])
    // Ranked again with today's tiebreaker, t2 and t4 would have gone ahead.
    const games = regularFinals(db, first)
    const rows = computeRows(teamRefs(db, loadConfig(db).config), games)
    expect(rankTeams(['t1', 't2', 't3', 't4'], rows, games, ['point-diff'], seasonFor(db, first).seed)).toEqual(['t2', 't1', 't4', 't3'])
  })

  it('keeps its bracket and its schedule, read only', () => {
    const { db, first } = twoSeasons()
    expect(playoffsView(db).series).toEqual([])
    const then = playoffsView(db, first.id)
    expect(then.series.map((s) => s.slot)).toEqual(['east:r1:0', 'west:r1:0', 'finals'])
    expect(then.series.find((s) => s.slot === 'finals')).toMatchObject({ winner: 't1', highWins: 4 })
    expect(then.seeds).toEqual({ east: ['t1', 't2'], west: ['t3', 't4'] })

    expect(scheduleInfo(db, first.id)).toMatchObject({ rounds: 7, total: 28, played: 28, editable: false })
    expect(scheduleInfo(db)).toMatchObject({ total: 28, played: 1, editable: true })
    expect(listGames(db, first.id).filter((g) => g.stage !== 'regular').every((g) => g.status === 'final')).toBe(true)
  })
})
