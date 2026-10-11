import type { LeagueConfig } from '@shared/config/schema'
import type { SeasonInfo } from '@shared/league'
import { playedMode } from '@shared/played'
import type { PlayedPairs } from '@shared/season'
import { scheduleShape } from '@core/schedule'
import { jsonField, transaction, type Db } from './db'
import { appendEvent, currentSeason, listTeams, loadConfig } from './league'
import { refuse } from './rules'

/**
 * 2K 일정대로 (`season.schedule.build: 'played'`): a round robin played in
 * the order 2K's NBA-style days bring, with no rounds. A game is added when
 * it's played (any pair with a meeting left) into the open session, stored
 * as the games' round. 오늘 경기 끝 closes the session with a `round_closed`
 * event, and the next one opens; a closed session is a completed round for
 * everything rounds drive. The open session is one past the last closed one,
 * so it needs no column of its own and a backup restores it with the rest.
 *
 * This file imports nothing from season.ts or schedule.ts (both use it).
 */

/** The last session closed in a season (0 when none). */
export function lastClosedSession(db: Db, seasonId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(CAST(${jsonField('payload', '$.round')} AS INTEGER)), 0) AS r FROM events WHERE type = 'round_closed' AND season_id = ?`)
    .get(seasonId) as { r: number }
  return row.r
}

/** The session new games go into: one past the last closed. */
export const openSession = (db: Db, seasonId: number): number => lastClosedSession(db, seasonId) + 1

/**
 * Whether a season is played in sessions: the current season by today's
 * config, a past one by whether it closed any (the setting may have changed
 * since; it can only change between seasons once games are played).
 */
export function playedSeason(db: Db, seasonId: number, now?: { season: SeasonInfo; config: LeagueConfig }): boolean {
  const season = now?.season ?? currentSeason(db)
  if (season.id === seasonId) return playedMode(now?.config ?? loadConfig(db).config)
  return lastClosedSession(db, seasonId) > 0
}

interface Game {
  id: number
  round: number
  home: string
  away: string
  status: 'scheduled' | 'final'
}

const seasonGames = (db: Db, seasonId: number): Game[] =>
  (
    db.prepare("SELECT id, round, home_id, away_id, status FROM games WHERE season_id = ? AND stage = 'regular' ORDER BY round, id").all(seasonId) as {
      id: number
      round: number
      home_id: string
      away_id: string
      status: Game['status']
    }[]
  ).map((r) => ({ id: r.id, round: r.round, home: r.home_id, away: r.away_id, status: r.status }))

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** The current season in 2K 일정대로, during its regular season; refused otherwise. */
function context(db: Db) {
  const season = currentSeason(db)
  const { config } = loadConfig(db)
  if (!playedMode(config)) refuse('schedule-not-played')
  if (season.phase !== 'regular') refuse('wrong-phase', { phase: season.phase })
  const teams = listTeams(db)
  const shape = scheduleShape(config, teams.length)
  if (!shape) refuse('schedule-not-round-robin')
  return { season, config, teams, shape }
}

/** Who can still meet whom, and each school's games: what the picker shows. */
export function playedPairs(db: Db): PlayedPairs {
  const season = currentSeason(db)
  const { config } = loadConfig(db)
  if (!playedMode(config)) refuse('schedule-not-played')
  const teams = listTeams(db)
  const meetings = config.season.schedule.kind === 'round-robin' ? config.season.schedule.cycles : 0
  const games = seasonGames(db, season.id)
  const met = new Map<string, number>()
  const count = new Map(teams.map((t) => [t.id, { played: 0, scheduled: 0 }]))
  for (const g of games) {
    met.set(pairKey(g.home, g.away), (met.get(pairKey(g.home, g.away)) ?? 0) + 1)
    for (const id of [g.home, g.away]) {
      const c = count.get(id)
      if (c) c[g.status === 'final' ? 'played' : 'scheduled']++
    }
  }
  const perTeam = meetings * (teams.length - 1)
  const open: PlayedPairs['open'] = {}
  for (const t of teams) {
    open[t.id] = teams
      .filter((o) => o.id !== t.id)
      .map((o) => ({ teamId: o.id, left: meetings - (met.get(pairKey(t.id, o.id)) ?? 0) }))
      .filter((o) => o.left > 0)
  }
  return {
    session: openSession(db, season.id),
    meetings,
    teams: teams.map((t) => {
      const c = count.get(t.id)!
      return { teamId: t.id, played: c.played, scheduled: c.scheduled, left: Math.max(0, perTeam - c.played - c.scheduled) }
    }),
    open,
  }
}

/**
 * Adds a game just played in 2K to the open session: the first school picked
 * hosts. Any pair with a meeting left may meet, and a school may play more
 * than once in a session (a play session can cover several 2K days).
 */
export function addPlayedGame(db: Db, input: { home: string; away: string }): { gameId: number; round: number } {
  const { season, teams, shape } = context(db)
  const name = (id: string) => teams.find((t) => t.id === id)?.shortName ?? id
  for (const id of [input.home, input.away]) if (!teams.some((t) => t.id === id)) refuse('unknown-team', { team: id })
  if (input.home === input.away) refuse('schedule-same-team')
  return transaction(db, () => {
    const met = seasonGames(db, season.id).filter((g) => pairKey(g.home, g.away) === pairKey(input.home, input.away)).length
    if (met >= shape.meetings) refuse('schedule-already-met', { a: name(input.home), b: name(input.away) })
    const round = openSession(db, season.id)
    const gameId = Number(
      db
        .prepare("INSERT INTO games (season_id, stage, round, home_id, away_id, status) VALUES (?, 'regular', ?, ?, ?, 'scheduled')")
        .run(season.id, round, input.home, input.away).lastInsertRowid,
    )
    return { gameId, round }
  })
}

/**
 * 오늘 경기 끝: closes the open session, so it counts as a completed round
 * (round-ups, wiki edits, the lore sweep, trade windows and round polls all
 * follow from the `round_closed` event), and the next session opens. Refused
 * while a game in it is unplayed (they're named: play them or take them out)
 * or when it has no games.
 */
export function closeSession(db: Db): { round: number; next: number } {
  const { season, teams } = context(db)
  const name = (id: string) => teams.find((t) => t.id === id)?.shortName ?? id
  return transaction(db, () => {
    const round = openSession(db, season.id)
    const games = seasonGames(db, season.id).filter((g) => g.round === round)
    if (games.length === 0) refuse('session-empty', { round })
    const unplayed = games.filter((g) => g.status !== 'final')
    if (unplayed.length > 0) {
      refuse('session-unplayed', { round, count: unplayed.length, games: unplayed.map((g) => `${name(g.home)}–${name(g.away)}`).join(', ') })
    }
    appendEvent(db, 'round_closed', { round, games: games.length, by: 'button' }, season.id)
    return { round, next: round + 1 }
  })
}

/**
 * 플레이오프 시작 in 2K 일정대로: the last session, every game in it played
 * (the season is), closes with it, so its round-up and the rest still come.
 * Nothing happens when it has no games (오늘 경기 끝 was pressed already).
 * Runs inside the playoffs' own transaction.
 */
export function closeLastSession(db: Db, season: SeasonInfo, config: LeagueConfig): boolean {
  if (!playedMode(config)) return false
  const round = openSession(db, season.id)
  const games = seasonGames(db, season.id).filter((g) => g.round === round)
  if (games.length === 0 || games.some((g) => g.status !== 'final')) return false
  appendEvent(db, 'round_closed', { round, games: games.length, by: 'playoffs' }, season.id)
  return true
}

/**
 * A running regular season switched to 2K 일정대로 (리그 설정): the rounds
 * already played become sessions 1..N, all closed, and session N+1 opens.
 * (No built game waits unplayed: see the settings' switch rule.)
 */
export function closeSwitchedRounds(db: Db, seasonId: number): boolean {
  const last = (db.prepare("SELECT COALESCE(MAX(round), 0) AS r FROM games WHERE season_id = ? AND stage = 'regular'").get(seasonId) as { r: number }).r
  if (last <= lastClosedSession(db, seasonId)) return false
  const games = (db.prepare("SELECT COUNT(*) AS n FROM games WHERE season_id = ? AND stage = 'regular' AND round = ?").get(seasonId, last) as { n: number }).n
  appendEvent(db, 'round_closed', { round: last, games, by: 'switch' }, seasonId)
  return true
}

/** Built regular-season games still unplayed this season: switching to 2K 일정대로 mid-season waits for none. */
export function unplayedRegularGames(db: Db, seasonId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM games WHERE season_id = ? AND stage = 'regular' AND status <> 'final'").get(seasonId) as { n: number }).n
}
