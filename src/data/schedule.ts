import type { ScheduleInfo, ScheduleOption, ScheduleOptions } from '@shared/season'
import { canSwapInto, completeRoundRobin, gameKey, scheduleProblems, scheduleShape, type Completion, type RoundRobinShape, type ScheduledGame } from '@core/schedule'
import { jsonField, transaction, type Db } from './db'
import { currentSeason, listTeams, loadConfig, seasonFor } from './league'
import { lastClosedSession, openSession, playedSeason } from './played'
import { RuleError, refuse } from './rules'
import { dropGame } from './season'

/**
 * Rounds built by hand, and changes to unplayed games in any round robin.
 * Every change keeps the season completable (each team once per round, each
 * pair meeting exactly as often as the schedule says), checked by the
 * solver in core/schedule before anything is saved. Played games never change.
 */

interface RegularGame extends ScheduledGame {
  id: number
  status: 'scheduled' | 'final'
}

function regularGames(db: Db, seasonId: number): RegularGame[] {
  const rows = db
    .prepare("SELECT id, round, home_id, away_id, status FROM games WHERE season_id = ? AND stage = 'regular' ORDER BY round, id")
    .all(seasonId) as { id: number; round: number; home_id: string; away_id: string; status: 'scheduled' | 'final' }[]
  return rows.map((r) => ({ id: r.id, round: r.round, home: r.home_id, away: r.away_id, status: r.status }))
}

function scheduleContext(db: Db) {
  const season = currentSeason(db)
  const { config } = loadConfig(db)
  const teams = listTeams(db)
  return { season, config, teams, shape: scheduleShape(config, teams.length) }
}

/** Games in the whole regular season: a round robin's full count, or (a custom game count) the games drawn. */
export function regularSeasonTotal(db: Db): number {
  const { season, shape } = scheduleContext(db)
  if (shape) return shape.rounds * shape.perRound
  return (db.prepare("SELECT COUNT(*) AS n FROM games WHERE season_id = ? AND stage = 'regular'").get(season.id) as { n: number }).n
}

/**
 * What 일정 needs for a season, the current one by default. A past season
 * is over: its rounds and total are the ones it played (the schedule
 * settings may have changed since), and nothing in it can change.
 */
export function scheduleInfo(db: Db, seasonId?: number): ScheduleInfo {
  const { season: current, config, shape } = scheduleContext(db)
  const season = seasonId === undefined ? current : seasonFor(db, seasonId)
  const past = season.id !== current.id
  const { schedule } = config.season
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(status = 'final'), 0) AS played, COALESCE(MAX(round), 0) AS rounds
       FROM games WHERE season_id = ? AND stage = 'regular'`,
    )
    .get(season.id) as { n: number; played: number; rounds: number }
  const total = past ? count.n : regularSeasonTotal(db)
  const editable = !past && shape !== null && season.phase === 'regular'
  // 2K 일정대로: the sessions so far (the open one too, while the regular season runs), no fixed size.
  if (playedSeason(db, season.id, { season: current, config })) {
    const open = !past && season.phase === 'regular' ? openSession(db, season.id) : 0
    return { build: 'played', rounds: Math.max(count.rounds, open), perRound: 0, total, played: count.played, editable, session: openSession(db, season.id) }
  }
  return {
    build: schedule.kind === 'round-robin' ? schedule.build : null,
    rounds: past ? count.rounds : (shape?.rounds ?? 0),
    perRound: shape?.perRound ?? 0,
    total,
    played: count.played,
    editable,
  }
}

/**
 * A round is complete when it's full (every game of it exists, for a round
 * robin) and every game in it is played. Round-ups, wiki edits, the lore
 * sweep and trade windows wait for this. In 2K 일정대로 a session has no
 * fixed size: it's complete once 오늘 경기 끝 closed it, with its games played.
 */
export function roundComplete(db: Db, seasonId: number, round: number): boolean {
  const { season, config, shape } = scheduleContext(db)
  const r = db
    .prepare("SELECT COUNT(*) AS n, SUM(status <> 'final') AS open FROM games WHERE season_id = ? AND stage = 'regular' AND round = ?")
    .get(seasonId, round) as { n: number; open: number | null }
  if (r.n === 0 || (r.open ?? 0) > 0) return false
  if (playedSeason(db, seasonId, { season, config })) return round <= lastClosedSession(db, seasonId)
  return shape === null || r.n >= shape.perRound
}

/** Checks a round robin's games and that the season can still be completed; refuses with the reason. */
function mustComplete(teams: { id: string; shortName: string }[], shape: RoundRobinShape, games: ScheduledGame[], seed: string, budget?: number): Completion {
  const name = (id: string) => teams.find((t) => t.id === id)?.shortName ?? id
  const problem = scheduleProblems(
    teams.map((t) => t.id),
    shape,
    games,
  )[0]
  if (problem) {
    if (problem.code === 'round-out-of-range') refuse('schedule-bad-round', { round: problem.round, rounds: shape.rounds })
    if (problem.code === 'same-team') refuse('schedule-same-team')
    if (problem.code === 'unknown-team') refuse('unknown-team', { team: problem.team })
    if (problem.code === 'twice-in-round') refuse('schedule-team-busy', { team: name(problem.team), round: problem.round })
    refuse('schedule-already-met', { a: name(problem.a), b: name(problem.b) })
  }
  const done = completeRoundRobin(
    teams.map((t) => t.id),
    shape,
    games,
    seed,
    budget ? { budget } : {},
  )
  if (!done.ok) refuse(done.reason === 'impossible' ? 'schedule-dead-end' : 'schedule-too-hard')
  return done
}

/** The current season and its round robin, refusing when its unplayed games can't be changed now. */
function editable(db: Db) {
  const ctx = scheduleContext(db)
  if (!ctx.shape) refuse('schedule-not-round-robin')
  if (ctx.season.phase !== 'regular') refuse('wrong-phase', { phase: ctx.season.phase })
  return { ...ctx, shape: ctx.shape }
}

/** Building rounds: not in 2K 일정대로, which has none (its games go in with addPlayedGame). */
function buildable(db: Db) {
  const ctx = editable(db)
  if (playedSeason(db, ctx.season.id, ctx)) refuse('schedule-played')
  return ctx
}

/** An unplayed game no live thread or screenshot read is waiting on. */
function removable(db: Db, game: RegularGame): void {
  if (game.status !== 'scheduled') refuse('schedule-game-played')
  const thread = db.prepare('SELECT 1 FROM posts WHERE game_id = ? LIMIT 1').get(game.id)
  const reading = db.prepare(`SELECT 1 FROM jobs WHERE status IN ('queued', 'running') AND ${jsonField('input', '$.gameId')} = ? LIMIT 1`).get(game.id)
  if (thread || reading) refuse('schedule-game-in-use')
}

/**
 * Takes a game out. Its screenshot readings (never confirmed: a played game
 * can't be removed, and none is waiting: see removable) are cancelled and
 * lose their link to the game, as when a playoff game goes (dropGame).
 */
const deleteGame = (db: Db, gameId: number): void => dropGame(db, gameId, 'game removed from the schedule')

function gameOf(db: Db, seasonId: number, gameId: number): RegularGame {
  const game = regularGames(db, seasonId).find((g) => g.id === gameId)
  if (!game) refuse('unknown-game', { game: gameId })
  return game
}

const insertGame = (db: Db, seasonId: number, g: ScheduledGame) =>
  Number(
    db
      .prepare("INSERT INTO games (season_id, stage, round, home_id, away_id, status) VALUES (?, 'regular', ?, ?, ?, 'scheduled')")
      .run(seasonId, g.round, g.home, g.away).lastInsertRowid,
  )

/** Adds one game to a round: the first school hosts. */
export function addScheduledGame(db: Db, input: { round: number; home: string; away: string }): { gameId: number } {
  const { season, teams, shape } = buildable(db)
  const game = { round: input.round, home: input.home, away: input.away }
  return transaction(db, () => {
    mustComplete(teams, shape, [...regularGames(db, season.id), game], season.seed)
    return { gameId: insertGame(db, season.id, game) }
  })
}

/** Removes an unplayed game. The season stays completable: whatever completed it before still does. */
export function removeScheduledGame(db: Db, gameId: number): void {
  const { season } = editable(db)
  transaction(db, () => {
    removable(db, gameOf(db, season.id, gameId))
    deleteGame(db, gameId)
  })
}

/** Swaps home and away of an unplayed game. */
export function flipScheduledGame(db: Db, gameId: number): void {
  const { season } = editable(db)
  transaction(db, () => {
    const game = gameOf(db, season.id, gameId)
    if (game.status !== 'scheduled') refuse('schedule-game-played')
    db.prepare('UPDATE games SET home_id = ?, away_id = ? WHERE id = ?').run(game.away, game.home, gameId)
  })
}

/** Fills the rest of a round with games that keep the season completable (자동 채우기). */
export function fillRound(db: Db, round: number): { added: number } {
  const { season, teams, shape } = buildable(db)
  if (!Number.isInteger(round) || round < 1 || round > shape.rounds) refuse('schedule-bad-round', { round, rounds: shape.rounds })
  return transaction(db, () => {
    const done = mustComplete(teams, shape, regularGames(db, season.id), `${season.seed}:fill:${round}`)
    const games = done.ok ? done.games.filter((g) => g.round === round) : []
    for (const g of games) insertGame(db, season.id, g)
    return { added: games.length }
  })
}

/** Removes a round's unplayed games, keeping any a live thread or screenshot read is waiting on. */
export function clearRound(db: Db, round: number): { removed: number; kept: number } {
  const { season } = editable(db)
  return transaction(db, () => {
    let removed = 0
    let kept = 0
    for (const g of regularGames(db, season.id).filter((x) => x.round === round && x.status === 'scheduled')) {
      try {
        removable(db, g)
      } catch (e) {
        if (!(e instanceof RuleError)) throw e
        kept++
        continue
      }
      deleteGame(db, g.id)
      removed++
    }
    return { removed, kept }
  })
}

/**
 * Who a school could meet in a round, each checked against the rest of the
 * season. One search completes the season as it stands (tens of
 * milliseconds for 36 schools); an opponent it already pairs with the
 * school in this round is fine, and so is one whose game can be swapped
 * into this round from another without touching a game already set
 * (`canSwapInto`, microseconds). Only the rest get a search of their own;
 * one that runs out of nodes says 'unsure', and adding the game checks again.
 */
export function scheduleOptions(db: Db, round: number, teamId: string): ScheduleOptions {
  const { season, teams, shape } = buildable(db)
  if (!teams.some((t) => t.id === teamId)) refuse('unknown-team', { team: teamId })
  if (!Number.isInteger(round) || round < 1 || round > shape.rounds) refuse('schedule-bad-round', { round, rounds: shape.rounds })
  const games = regularGames(db, season.id)
  const venues = new Map(teams.map((t) => [t.id, { home: 0, away: 0 }]))
  for (const g of games) {
    venues.get(g.home)!.home++
    venues.get(g.away)!.away++
  }
  const busy = new Set(games.filter((g) => g.round === round).flatMap((g) => [g.home, g.away]))
  if (busy.has(teamId)) refuse('schedule-team-busy', { team: teams.find((t) => t.id === teamId)!.shortName, round })
  const met = (a: string, b: string) => games.filter((g) => (g.home === a && g.away === b) || (g.home === b && g.away === a)).length
  const ids = teams.map((x) => x.id)
  // The season completed as it stands, and the games already set (which no swap may move).
  const base = completeRoundRobin(ids, shape, games, season.seed)
  const plan = base.ok ? [...games, ...base.games] : null
  const fixed = new Set(games.map((g) => gameKey(g.round, g.home, g.away)))
  const swappable = (other: string) =>
    plan !== null &&
    plan.some(
      (g) =>
        ((g.home === teamId && g.away === other) || (g.home === other && g.away === teamId)) &&
        !fixed.has(gameKey(g.round, g.home, g.away)) &&
        canSwapInto(ids, plan, fixed, teamId, other, g.round, round),
    )
  const options: ScheduleOption[] = teams
    .filter((t) => t.id !== teamId)
    .map((t) => {
      const status: ScheduleOption['status'] = busy.has(t.id)
        ? 'placed'
        : met(teamId, t.id) >= shape.meetings
          ? 'met'
          : swappable(t.id)
            ? 'ok'
            : ((): ScheduleOption['status'] => {
                const done = completeRoundRobin(ids, shape, [...games, { round, home: teamId, away: t.id }], season.seed, { restarts: 1 })
                return done.ok ? 'ok' : done.reason === 'impossible' ? 'dead-end' : 'unsure'
              })()
      return { teamId: t.id, status, ...venues.get(t.id)! }
    })
  return { self: venues.get(teamId)!, options }
}
