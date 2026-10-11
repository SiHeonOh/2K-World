import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import type { LeagueSetup } from '@shared/setup'
import { openDb, type Db } from './db'
import { currentSeason, listEvents, seedLeague } from './league'
import { RuleError } from './rules'
import { listGames, recordScore, standings, startPlayoffs, startSeason } from './season'
import { addScheduledGame, clearRound, fillRound, flipScheduledGame, removeScheduledGame, roundComplete, scheduleInfo, scheduleOptions } from './schedule'

function league(change?: (s: LeagueSetup) => void): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  change?.(setup)
  seedLeague(db, setup)
  return db
}

/** The 8-team sample league, building its rounds by hand: 7 rounds of 4 games. */
const byHand = () => league((s) => void (s.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'manual' }))

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    throw e
  }
  return []
}

const games = (db: Db) => listGames(db, currentSeason(db).id).filter((g) => g.stage === 'regular')
const inRound = (db: Db, round: number) => games(db).filter((g) => g.round === round)
const play = (db: Db, gameId: number) => recordScore(db, { gameId, homeScore: 80, awayScore: 70, lines: null })

describe('rounds built by hand', () => {
  it('starts the season with no games, knowing the whole season', () => {
    const db = byHand()
    expect(refusal(() => addScheduledGame(db, { round: 1, home: 't1', away: 't2' }))).toEqual(['wrong-phase'])
    expect(startSeason(db)).toEqual({ games: 28 })
    expect(games(db)).toEqual([])
    expect(scheduleInfo(db)).toEqual({ build: 'manual', rounds: 7, perRound: 4, total: 28, played: 0, editable: true })
    expect(standings(db)).toMatchObject({ played: 0, scheduled: 0, total: 28 })
    expect(listEvents(db, 'season_started')[0]!.payload).toEqual({ games: 28 })
  })

  it('checks every game added: once a round, each pair once, and never a dead end', () => {
    const db = byHand()
    startSeason(db)
    addScheduledGame(db, { round: 1, home: 't1', away: 't2' })
    expect(refusal(() => addScheduledGame(db, { round: 1, home: 't1', away: 't3' }))).toEqual(['schedule-team-busy'])
    expect(refusal(() => addScheduledGame(db, { round: 2, home: 't2', away: 't1' }))).toEqual(['schedule-already-met'])
    expect(refusal(() => addScheduledGame(db, { round: 8, home: 't3', away: 't4' }))).toEqual(['schedule-bad-round'])
    expect(refusal(() => addScheduledGame(db, { round: 2, home: 't3', away: 't3' }))).toEqual(['schedule-same-team'])
    addScheduledGame(db, { round: 1, home: 't3', away: 't4' })
    addScheduledGame(db, { round: 1, home: 't5', away: 't6' })
    // Round 1 now needs t7–t8, so that pair can't go anywhere else.
    expect(refusal(() => addScheduledGame(db, { round: 2, home: 't7', away: 't8' }))).toEqual(['schedule-dead-end'])
    const options = scheduleOptions(db, 2, 't7')
    expect(options.options.find((o) => o.teamId === 't8')?.status).toBe('dead-end')
    expect(options.options.find((o) => o.teamId === 't1')?.status).toBe('ok')
    // In round 1 the others are taken; t7 and t8 have no games yet.
    const first = scheduleOptions(db, 1, 't7')
    expect(first.options.map((o) => o.status).sort()).toEqual(['ok', 'placed', 'placed', 'placed', 'placed', 'placed', 'placed'])
    expect(first.self).toEqual({ home: 0, away: 0 })
    expect(first.options.find((o) => o.teamId === 't1')).toMatchObject({ home: 1, away: 0 })
    expect(refusal(() => scheduleOptions(db, 1, 't1'))).toEqual(['schedule-team-busy'])
  })

  it('fills a round, flips and removes unplayed games, and never touches played ones', () => {
    const db = byHand()
    startSeason(db)
    addScheduledGame(db, { round: 1, home: 't1', away: 't2' })
    expect(fillRound(db, 1)).toEqual({ added: 3 })
    expect(fillRound(db, 1)).toEqual({ added: 0 })
    expect(inRound(db, 1)).toHaveLength(4)
    const [a, b, c] = inRound(db, 1)
    flipScheduledGame(db, a!.id)
    expect(inRound(db, 1).find((g) => g.id === a!.id)).toMatchObject({ home: a!.away, away: a!.home })
    play(db, b!.id)
    expect(refusal(() => removeScheduledGame(db, b!.id))).toEqual(['schedule-game-played'])
    expect(refusal(() => flipScheduledGame(db, b!.id))).toEqual(['schedule-game-played'])
    // A screenshot read still waiting on a game keeps it.
    db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('read_box_score', 'queued', ?, ?)").run(JSON.stringify({ gameId: c!.id }), new Date().toISOString())
    expect(refusal(() => removeScheduledGame(db, c!.id))).toEqual(['schedule-game-in-use'])
    // A reading never confirmed goes with its game: cancelled, and no longer pointing at the id a new game may reuse.
    const read = Number(
      db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('read_box_score', 'done', ?, ?)").run(JSON.stringify({ gameId: a!.id }), new Date().toISOString())
        .lastInsertRowid,
    )
    expect(clearRound(db, 1)).toEqual({ removed: 2, kept: 1 })
    expect(inRound(db, 1).map((g) => g.id).sort()).toEqual([b!.id, c!.id].sort())
    const job = db.prepare('SELECT status, input FROM jobs WHERE id = ?').get(read) as { status: string; input: string }
    expect([job.status, JSON.parse(job.input)]).toEqual(['cancelled', {}])
    // Whatever's left can still be completed.
    expect(fillRound(db, 1)).toEqual({ added: 2 })
  })

  it('completes a round only when it is full and played, and the season only when every game is', () => {
    const db = byHand()
    startSeason(db)
    addScheduledGame(db, { round: 1, home: 't1', away: 't2' })
    addScheduledGame(db, { round: 1, home: 't3', away: 't4' })
    for (const g of inRound(db, 1)) play(db, g.id)
    expect(roundComplete(db, currentSeason(db).id, 1)).toBe(false)
    fillRound(db, 1)
    for (const g of inRound(db, 1).filter((x) => x.status === 'scheduled')) play(db, g.id)
    expect(roundComplete(db, currentSeason(db).id, 1)).toBe(true)
    // No games left to play, but most of the season isn't built yet.
    expect(scheduleInfo(db)).toMatchObject({ played: 4, total: 28 })
    expect(refusal(() => startPlayoffs(db))).toEqual(['games-left'])
    for (let r = 2; r <= 7; r++) {
      fillRound(db, r)
      for (const g of inRound(db, r)) play(db, g.id)
    }
    expect(scheduleInfo(db)).toMatchObject({ played: 28, total: 28 })
    expect(standings(db)).toMatchObject({ played: 28, scheduled: 0, total: 28 })
    startPlayoffs(db)
    expect(currentSeason(db).phase).toBe('playoffs')
    expect(scheduleInfo(db).editable).toBe(false)
  })

  it('lets a drawn schedule be changed too, but not a custom game count', () => {
    const db = league()
    expect(startSeason(db)).toEqual({ games: 28 })
    expect(scheduleInfo(db)).toMatchObject({ build: 'auto', editable: true })
    expect(clearRound(db, 7)).toEqual({ removed: 4, kept: 0 })
    expect(fillRound(db, 7)).toEqual({ added: 4 })
    const custom = league((s) => void (s.config.season.schedule = { kind: 'custom', gamesPerTeam: 6 }))
    startSeason(custom)
    expect(scheduleInfo(custom)).toMatchObject({ build: null, rounds: 0, editable: false, total: 24 })
    expect(refusal(() => addScheduledGame(custom, { round: 1, home: 't1', away: 't2' }))).toEqual(['schedule-not-round-robin'])
  })
})
