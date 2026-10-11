import type { LeagueConfig, Phase } from '@shared/config/schema'
import type { SeasonInfo } from '@shared/league'
import type { GameRow, GameStage, PlayoffsView, SeriesRow, StandingLine, StandingsView } from '@shared/season'
import {
  effectiveSeeds,
  highSeedHosts,
  planBracket,
  resolveBracket,
  seedsNeeded,
  winsNeeded,
  type Participant,
  type SeriesPlan,
} from '@core/playoffs'
import { buildSchedule, scheduleShape } from '@core/schedule'
import { computeRows, gamesBehind, rankTeams, type FinalScore, type StandingRow, type TeamRef } from '@core/standings'
import { checkBoxScore, type BoxIssue, type BoxLine } from '@core/stats'
import { jsonField, transaction, type Db } from './db'
import { appendEvent, currentSeason, listTeams, loadConfig, seasonFor } from './league'
import { closeLastSession } from './played'
import { refuse } from './rules'

const now = () => new Date().toISOString()

export function setPhase(db: Db, season: SeasonInfo, to: Phase): void {
  db.prepare('UPDATE seasons SET phase = ? WHERE id = ?').run(to, season.id)
  appendEvent(db, 'phase_changed', { from: season.phase, to }, season.id)
}

export function teamRefs(db: Db, config: LeagueConfig): TeamRef[] {
  const conference = new Map(config.structure.divisions.map((d) => [d.id, d.conferenceId]))
  return listTeams(db).map((t) => ({ id: t.id, divisionId: t.divisionId, conferenceId: conference.get(t.divisionId) ?? null }))
}

// ── Games ────────────────────────────────────────────────────────────────

interface GameDbRow {
  id: number
  stage: GameStage
  round: number
  series_id: number | null
  home_id: string
  away_id: string
  home_score: number | null
  away_score: number | null
  status: 'scheduled' | 'final'
  recorded_at: string | null
  has_box: number
}

const GAME_SELECT = `SELECT g.id, g.stage, g.round, g.series_id, g.home_id, g.away_id, g.home_score, g.away_score, g.status,
  g.recorded_at, EXISTS (SELECT 1 FROM box_lines b WHERE b.game_id = g.id) AS has_box FROM games g`

const toGame = (r: GameDbRow): GameRow => ({
  id: r.id,
  stage: r.stage,
  round: r.round,
  seriesId: r.series_id,
  home: r.home_id,
  away: r.away_id,
  homeScore: r.home_score,
  awayScore: r.away_score,
  status: r.status,
  recordedAt: r.recorded_at,
  hasBox: r.has_box === 1,
})

/**
 * The order a season was played in: the regular season round by round, then
 * the playoffs. Game ids don't follow rounds built by hand, so they only
 * order games within a round. A player's team that season is the one on his
 * last box line in this order.
 */
const PLAYED_ORDER = "g.stage <> 'regular', g.round, g.id"

export function listGames(db: Db, seasonId: number): GameRow[] {
  return (db.prepare(`${GAME_SELECT} WHERE g.season_id = ? ORDER BY ${PLAYED_ORDER}`).all(seasonId) as unknown as GameDbRow[]).map(toGame)
}

export function getGame(db: Db, gameId: number): (GameRow & { seasonId: number }) | null {
  const row = db.prepare(`${GAME_SELECT.replace('SELECT g.id', 'SELECT g.season_id, g.id')} WHERE g.id = ?`).get(gameId) as
    | (GameDbRow & { season_id: number })
    | undefined
  return row ? { ...toGame(row), seasonId: row.season_id } : null
}

export function boxLines(db: Db, gameId: number): BoxLine[] {
  const rows = db
    .prepare('SELECT game_id, player_id, team_id, stats FROM box_lines WHERE game_id = ? ORDER BY team_id, row_order')
    .all(gameId) as { game_id: number; player_id: string; team_id: string; stats: string }[]
  return rows.map((r) => ({ gameId: r.game_id, playerId: r.player_id, teamId: r.team_id, stats: JSON.parse(r.stats) as Record<string, number> }))
}

/**
 * Every regular-season box line of a season, in the order it was played
 * (seasonTotals takes a player's team from his last line). Past rosters
 * aren't stored, so this is how a past season knows where he played.
 */
export function seasonBoxLines(db: Db, seasonId: number): BoxLine[] {
  const rows = db
    .prepare(
      `SELECT b.game_id, b.player_id, b.team_id, b.stats FROM box_lines b JOIN games g ON g.id = b.game_id
       WHERE g.season_id = ? AND g.stage = 'regular' ORDER BY ${PLAYED_ORDER}, b.team_id, b.row_order`,
    )
    .all(seasonId) as { game_id: number; player_id: string; team_id: string; stats: string }[]
  return rows.map((r) => ({ gameId: r.game_id, playerId: r.player_id, teamId: r.team_id, stats: JSON.parse(r.stats) as Record<string, number> }))
}

/**
 * Takes an unplayed game out for good. What points at it lets go first, so
 * nothing attaches to a game that's gone: a live thread on it stays up as a
 * plain post, and its screenshot readings are cancelled (a running one
 * finishes unattached) and forget the game. Box lines go with it (cascade).
 */
export function dropGame(db: Db, gameId: number, reason: string): void {
  db.prepare('UPDATE posts SET game_id = NULL WHERE game_id = ?').run(gameId)
  db.prepare(
    `UPDATE jobs SET status = CASE WHEN status IN ('queued', 'done', 'failed') THEN 'cancelled' ELSE status END,
       error = COALESCE(error, ?), input = json_remove(input, '$.gameId')
     WHERE kind = 'read_box_score' AND ${jsonField('input', '$.gameId')} = ?`,
  ).run(reason, gameId)
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId)
}

/** Teams with a move recorded in the app that hasn't been made in 2K yet. */
export function teamsWaitingOn2k(db: Db): Set<string> {
  const rows = db.prepare('SELECT team_ids FROM checklist WHERE applied_at IS NULL AND cancelled_at IS NULL').all() as { team_ids: string }[]
  return new Set(rows.flatMap((r) => JSON.parse(r.team_ids) as string[]))
}

// ── Starting a season ────────────────────────────────────────────────────

/** Lowest card count any rank gets: those cards exist (and can be traded) from day one. */
export function guaranteedCards(config: LeagueConfig, teamCount: number): number {
  if (config.draft.kind !== 'card-swap') return 0
  const counts = config.draft.allocation.filter((t) => t.fromRank <= teamCount).map((t) => t.cards)
  return counts.length > 0 ? Math.min(...counts) : 0
}

/**
 * preseason → regular: writes the schedule and the cards every team is sure
 * to get. A league that builds its rounds by hand (or adds its games as
 * they're played, 2K 일정대로) starts with no games; the event still names
 * the season's full game count.
 */
export function startSeason(db: Db): { games: number } {
  const season = currentSeason(db)
  if (season.phase !== 'preseason') refuse('wrong-phase', { phase: season.phase })
  const { config } = loadConfig(db)
  const teams = listTeams(db)
  const shape = scheduleShape(config, teams.length)
  const byHand = config.season.schedule.kind === 'round-robin' && config.season.schedule.build !== 'auto'
  const schedule = byHand ? [] : buildSchedule(config, teams.map((t) => t.id), season.seed)
  const games = byHand && shape ? shape.rounds * shape.perRound : schedule.length
  if (games === 0) refuse('no-schedule')
  return transaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO games (season_id, stage, round, home_id, away_id, status) VALUES (?, 'regular', ?, ?, ?, 'scheduled')",
    )
    for (const g of schedule) insert.run(season.id, g.round, g.home, g.away)
    const guaranteed = guaranteedCards(config, teams.length)
    if (guaranteed > 0) {
      const card = db.prepare(
        "INSERT INTO cards (season_id, issued_season_id, original_team_id, owner_team_id, number, status) VALUES (?, ?, ?, ?, ?, 'held')",
      )
      for (const t of teams) {
        if (t.control === 'frozen') continue
        for (let n = 1; n <= guaranteed; n++) card.run(season.id, season.id, t.id, t.id, n)
      }
    }
    setPhase(db, season, 'regular')
    appendEvent(db, 'season_started', { games }, season.id)
    return { games }
  })
}

// ── Recording results ────────────────────────────────────────────────────

export interface ScoreInput {
  gameId: number
  homeScore: number
  awayScore: number
  /** Box lines to store with the game; null leaves any existing ones as they are. */
  lines: { playerId: string; teamId: string; stats: Record<string, number> }[] | null
}

/**
 * Records (or corrects) a final score, optionally with box lines. Returns
 * box-score self-check warnings; the score is stored either way.
 */
export function recordScore(db: Db, input: ScoreInput): { warnings: BoxIssue[] } {
  const game = getGame(db, input.gameId)
  if (!game) refuse('unknown-game', { game: input.gameId })
  const season = currentSeason(db)
  if (game.seasonId !== season.id) refuse('past-season')
  for (const score of [input.homeScore, input.awayScore]) {
    if (!Number.isInteger(score) || score < 0 || score > 400) refuse('bad-score', { score })
  }
  if (input.homeScore === input.awayScore) refuse('tie-score')
  const correcting = game.status === 'final'
  if (game.stage === 'regular' && season.phase !== 'regular') refuse('wrong-phase', { phase: season.phase })
  if (game.stage !== 'regular' && season.phase !== 'playoffs') refuse('wrong-phase', { phase: season.phase })
  if (!correcting) {
    const waiting = teamsWaitingOn2k(db)
    const blocked = [game.home, game.away].filter((t) => waiting.has(t))
    if (blocked.length > 0) refuse('pending-2k-moves', { teams: blocked.join(', ') })
  }
  if (correcting && game.seriesId !== null && seriesHasPlayedDependents(db, game.seriesId)) {
    refuse('series-already-continued')
  }
  if (game.seriesId !== null && seriesWouldEndEarly(db, game.seriesId, game.id, input.homeScore, input.awayScore)) {
    refuse('series-impossible')
  }

  const { config } = loadConfig(db)
  const lines = input.lines === null ? null : checkLines(db, config, game, input.lines)
  const warn = () => {
    const stored = boxLines(db, game.id)
    return stored.length > 0 ? checkBoxScore(config, stored, new Map([[game.home, input.homeScore], [game.away, input.awayScore]])) : []
  }
  // Saving a played game again with nothing changed isn't a correction: no event, so no 점수 정정 notice.
  if (correcting && game.homeScore === input.homeScore && game.awayScore === input.awayScore) {
    const key = (ls: { playerId: string; teamId: string; stats: Record<string, number> }[]) =>
      JSON.stringify(ls.map((l) => [l.playerId, l.teamId, Object.entries(l.stats).sort(([a], [b]) => a.localeCompare(b))]).sort())
    if (lines === null || key(lines) === key(boxLines(db, game.id))) return { warnings: warn() }
  }

  return transaction(db, () => {
    db.prepare("UPDATE games SET home_score = ?, away_score = ?, status = 'final', source = 'manual', recorded_at = ? WHERE id = ?").run(
      input.homeScore,
      input.awayScore,
      now(),
      game.id,
    )
    if (lines !== null) {
      db.prepare('DELETE FROM box_lines WHERE game_id = ?').run(game.id)
      const insert = db.prepare('INSERT INTO box_lines (game_id, player_id, team_id, row_order, stats) VALUES (?, ?, ?, ?, ?)')
      lines.forEach((l, i) => insert.run(game.id, l.playerId, l.teamId, i, JSON.stringify(l.stats)))
    }
    if (correcting) {
      appendEvent(
        db,
        'game_corrected',
        {
          gameId: game.id,
          before: { homeScore: game.homeScore!, awayScore: game.awayScore! },
          after: { homeScore: input.homeScore, awayScore: input.awayScore },
        },
        season.id,
      )
    } else {
      appendEvent(
        db,
        'game_recorded',
        { gameId: game.id, stage: game.stage, home: game.home, away: game.away, homeScore: input.homeScore, awayScore: input.awayScore },
        season.id,
      )
    }
    if (game.seriesId !== null) syncPlayoffs(db, season)
    return { warnings: warn() }
  })
}

/**
 * 기록 취소: a played game goes back to unplayed, box lines and all, where
 * nothing has been built on it yet. A regular-season game while the regular
 * season is on (once the playoffs start, the final table and seeds stand).
 * A playoff game while the playoffs are on, if it's the last one played in
 * its series and no series it feeds has played: the series' next game, if
 * one was scheduled, goes (this one is next again), and the bracket syncs
 * (a series it decided is open again, with series_result_changed).
 * `game_unrecorded` carries what the game was, so the story engine can take
 * back its thread.
 */
export function unrecordGame(db: Db, gameId: number): void {
  const game = getGame(db, gameId)
  if (!game) refuse('unknown-game', { game: gameId })
  const season = currentSeason(db)
  if (game.seasonId !== season.id) refuse('past-season')
  if (game.status !== 'final') refuse('unrecord-not-played')
  if (game.stage === 'regular' && season.phase !== 'regular') refuse('unrecord-regular-closed')
  if (game.stage !== 'regular') {
    if (season.phase !== 'playoffs') refuse('unrecord-playoffs-closed')
    const later = game.seriesId !== null && db.prepare("SELECT 1 FROM games WHERE series_id = ? AND status = 'final' AND round > ?").get(game.seriesId, game.round)
    if (later) refuse('unrecord-not-last')
    if (game.seriesId !== null && seriesHasPlayedDependents(db, game.seriesId)) refuse('series-already-continued')
  }
  transaction(db, () => {
    if (game.seriesId !== null) {
      for (const g of db.prepare("SELECT id FROM games WHERE series_id = ? AND status = 'scheduled' AND id <> ?").all(game.seriesId, game.id) as { id: number }[]) {
        dropGame(db, g.id, 'an earlier game was unrecorded')
      }
    }
    db.prepare('DELETE FROM box_lines WHERE game_id = ?').run(game.id)
    db.prepare("UPDATE games SET home_score = NULL, away_score = NULL, status = 'scheduled', source = NULL, recorded_at = NULL WHERE id = ?").run(game.id)
    appendEvent(
      db,
      'game_unrecorded',
      { gameId: game.id, stage: game.stage, home: game.home, away: game.away, homeScore: game.homeScore!, awayScore: game.awayScore! },
      season.id,
    )
    if (game.seriesId !== null) syncPlayoffs(db, season)
  })
}

function checkLines(db: Db, config: LeagueConfig, game: GameRow & { seasonId: number }, lines: NonNullable<ScoreInput['lines']>) {
  const statIds = new Set(config.stats.columns.map((c) => c.id))
  const current = new Map(
    (db.prepare('SELECT id, team_id FROM players').all() as { id: string; team_id: string }[]).map((p) => [p.id, p.team_id]),
  )
  const before = new Map(boxLines(db, game.id).map((l) => [l.playerId, l.teamId]))
  // Teams a player was on this season: a game before a trade keeps his old team.
  const pastTeams = new Map<string, Set<string>>()
  for (const m of db
    .prepare(
      `SELECT i.player_id, i.from_team_id, i.to_team_id FROM trade_items i JOIN trades t ON t.id = i.trade_id
       WHERE t.season_id = ? AND t.status = 'applied' AND i.kind = 'player'`,
    )
    .all(game.seasonId) as { player_id: string; from_team_id: string; to_team_id: string }[]) {
    const set = pastTeams.get(m.player_id) ?? new Set<string>()
    set.add(m.from_team_id)
    set.add(m.to_team_id)
    pastTeams.set(m.player_id, set)
  }
  const seen = new Set<string>()
  for (const l of lines) {
    if (l.teamId !== game.home && l.teamId !== game.away) refuse('line-wrong-team', { player: l.playerId })
    if (seen.has(l.playerId)) refuse('line-duplicate', { player: l.playerId })
    seen.add(l.playerId)
    const team = current.get(l.playerId)
    if (team === undefined) refuse('unknown-player', { player: l.playerId })
    // A correction may keep a line for a player who has since been traded.
    if (team !== l.teamId && before.get(l.playerId) !== l.teamId && !pastTeams.get(l.playerId)?.has(l.teamId)) {
      refuse('line-wrong-team', { player: l.playerId })
    }
    for (const [k, v] of Object.entries(l.stats)) {
      if (!statIds.has(k)) refuse('unknown-stat', { stat: k })
      if (!Number.isInteger(v) || v < 0 || v > 999) refuse('bad-stat', { stat: k, value: v })
    }
  }
  return lines
}

// ── Standings ────────────────────────────────────────────────────────────

export function regularFinals(db: Db, seasonId: number): FinalScore[] {
  return (
    db
      .prepare(
        "SELECT id, round, home_id, away_id, home_score, away_score FROM games WHERE season_id = ? AND stage = 'regular' AND status = 'final'",
      )
      .all(seasonId) as { id: number; round: number; home_id: string; away_id: string; home_score: number; away_score: number }[]
  ).map((r) => ({ id: r.id, round: r.round, home: r.home_id, away: r.away_id, homeScore: r.home_score, awayScore: r.away_score }))
}

const rec = (r: { w: number; l: number }) => `${r.w}-${r.l}`

/**
 * A season's table, the current one by default. A past season's comes from
 * its own games and its own seed (so its coin flips land as they did), with
 * today's teams and structure. What was fixed when it ended stays: the
 * overall order (the final ranking) and each conference's playoff seeds, so
 * a tiebreaker changed since doesn't reorder them. The rest of a conference,
 * and each division, is ranked within itself as it was then (a tie inside a
 * group can break differently from the same teams' tie overall). Records and
 * games behind are counted again. It's over, so its total is the games it had.
 */
export function standings(db: Db, seasonId?: number): StandingsView {
  const current = currentSeason(db)
  const season = seasonId === undefined ? current : seasonFor(db, seasonId)
  const past = season.id !== current.id
  const { config } = loadConfig(db)
  const teams = teamRefs(db, config)
  const games = regularFinals(db, season.id)
  const rows = computeRows(teams, games)
  const tb = config.season.standings.tiebreakers
  const fixed = past ? endedOrder(db, season.id) : null
  const rank = (ids: string[], group?: string) => {
    const today = rankTeams(ids, rows, games, tb, season.seed)
    if (!fixed) return today
    const seeds = group === undefined ? [] : (fixed.seeds[group] ?? []).filter((id) => ids.includes(id))
    return [...seeds, ...today.filter((id) => !seeds.includes(id))]
  }
  /** The overall table: the final ranking as it was fixed (a team it lacks, none should, keeps today's place after the rest). */
  const rankOverall = (ids: string[]) => {
    const today = rankTeams(ids, rows, games, tb, season.seed)
    if (!fixed) return today
    const place = (id: string) => (fixed.ranking.includes(id) ? fixed.ranking.indexOf(id) : fixed.ranking.length + today.indexOf(id))
    return [...today].sort((a, b) => place(a) - place(b))
  }
  const lines = (ordered: string[]): StandingLine[] => {
    const gb = gamesBehind(ordered, rows)
    return ordered.map((id) => line(rows.get(id)!, gb.get(id) ?? 0))
  }
  const counts = db
    .prepare("SELECT status, COUNT(*) AS n FROM games WHERE season_id = ? AND stage = 'regular' GROUP BY status")
    .all(season.id) as { status: string; n: number }[]
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0
  // A round robin's total counts games not built yet (rounds built by hand).
  const shape = scheduleShape(config, teams.length)
  return {
    overall: lines(rankOverall(teams.map((t) => t.id))),
    conferences: Object.fromEntries(
      config.structure.conferences.map((c) => [c.id, lines(rank(teams.filter((t) => t.conferenceId === c.id).map((t) => t.id), c.id))]),
    ),
    divisions: Object.fromEntries(
      config.structure.divisions.map((d) => [d.id, lines(rank(teams.filter((t) => t.divisionId === d.id).map((t) => t.id)))]),
    ),
    played: n('final'),
    scheduled: n('scheduled'),
    total: shape && !past ? shape.rounds * shape.perRound : n('final') + n('scheduled'),
  }
}

/**
 * The order a season's regular season ended in, fixed when the playoffs were
 * seeded: the overall ranking and the seeds per bracket group. Null before
 * that. Seeds come first in a conference: ranking a conference on its own
 * can break a tie differently from the overall ranking (head-to-head among
 * fewer teams).
 */
function endedOrder(db: Db, seasonId: number): { ranking: string[]; seeds: Record<string, string[]> } | null {
  const row = db.prepare('SELECT final_ranking, playoff_seeds FROM seasons WHERE id = ?').get(seasonId) as {
    final_ranking: string | null
    playoff_seeds: string | null
  }
  if (row.final_ranking === null) return null
  return { ranking: JSON.parse(row.final_ranking) as string[], seeds: JSON.parse(row.playoff_seeds ?? '{}') as Record<string, string[]> }
}

function line(r: StandingRow, gb: number): StandingLine {
  return {
    teamId: r.teamId,
    wins: r.wins,
    losses: r.losses,
    pct: r.pct,
    gamesBehind: gb,
    pointsFor: r.pointsFor,
    pointsAgainst: r.pointsAgainst,
    home: rec(r.home),
    away: rec(r.away),
    conference: rec(r.conference),
    division: rec(r.division),
    last10: rec(r.last10),
    streak: r.streak,
  }
}

// ── Playoffs ─────────────────────────────────────────────────────────────

interface SeriesDbRow {
  id: number
  slot: string
  stage: 'play-in' | 'playoffs' | 'finals'
  round: number
  conference_id: string | null
  a_ref: string
  b_ref: string
  high_team_id: string | null
  low_team_id: string | null
  high_seed: number | null
  low_seed: number | null
  best_of: number
  winner_id: string | null
}

const seriesRows = (db: Db, seasonId: number) =>
  db.prepare('SELECT * FROM series WHERE season_id = ? ORDER BY id').all(seasonId) as unknown as SeriesDbRow[]

/** True when, with this score, one team would have clinched the series before its last finished game. */
function seriesWouldEndEarly(db: Db, seriesId: number, gameId: number, homeScore: number, awayScore: number): boolean {
  const series = db.prepare('SELECT best_of FROM series WHERE id = ?').get(seriesId) as { best_of: number }
  const games = db
    .prepare("SELECT id, home_id, away_id, home_score, away_score, status FROM games WHERE series_id = ? ORDER BY round")
    .all(seriesId) as { id: number; home_id: string; away_id: string; home_score: number | null; away_score: number | null; status: string }[]
  const finals = games
    .map((g) => (g.id === gameId ? { ...g, home_score: homeScore, away_score: awayScore, status: 'final' } : g))
    .filter((g) => g.status === 'final')
  const need = winsNeeded(series.best_of)
  const wins = new Map<string, number>()
  for (let i = 0; i < finals.length; i++) {
    const g = finals[i]!
    const w = g.home_score! > g.away_score! ? g.home_id : g.away_id
    wins.set(w, (wins.get(w) ?? 0) + 1)
    if (wins.get(w)! >= need && i < finals.length - 1) return true
  }
  return false
}

/** True when a series that this one feeds already has a finished game. */
function seriesHasPlayedDependents(db: Db, seriesId: number): boolean {
  const row = db.prepare('SELECT season_id, slot FROM series WHERE id = ?').get(seriesId) as { season_id: number; slot: string } | undefined
  if (!row) return false
  const feeds = (r: SeriesDbRow) =>
    [r.a_ref, r.b_ref].some((ref) => {
      const p = JSON.parse(ref) as Participant
      return p.kind !== 'seed' && p.slot === row.slot
    })
  const dependents = seriesRows(db, row.season_id).filter(feeds)
  return dependents.some(
    (d) => (db.prepare("SELECT COUNT(*) AS n FROM games WHERE series_id = ? AND status = 'final'").get(d.id) as { n: number }).n > 0,
  )
}

/** regular → playoffs: fixes the final ranking and seeds, and opens the bracket. */
export function startPlayoffs(db: Db): void {
  const season = currentSeason(db)
  if (season.phase !== 'regular') refuse('wrong-phase', { phase: season.phase })
  const { config } = loadConfig(db)
  const view = standings(db)
  // Every game of the season, built yet or not (rounds built by hand), must be played.
  const left = view.total - view.played
  if (left > 0 || view.total === 0) refuse('games-left', { count: Math.max(left, 0) })
  const ranking = view.overall.map((l) => l.teamId)
  transaction(db, () => {
    // 2K 일정대로: a last session not closed with 오늘 경기 끝 closes now, so its round-up still comes.
    closeLastSession(db, season, config)
    db.prepare('UPDATE seasons SET final_ranking = ? WHERE id = ?').run(JSON.stringify(ranking), season.id)
    if (!config.season.playoffs.enabled) {
      afterPlayoffs(db, { ...season, phase: 'regular' }, config)
      return
    }
    const need = seedsNeeded(config)
    const seeds: Record<string, string[]> =
      config.season.playoffs.bracket === 'conference'
        ? Object.fromEntries(Object.entries(view.conferences).map(([id, lines]) => [id, lines.slice(0, need).map((l) => l.teamId)]))
        : { league: ranking.slice(0, need) }
    db.prepare('UPDATE seasons SET playoff_seeds = ? WHERE id = ?').run(JSON.stringify(seeds), season.id)
    const insert = db.prepare(
      'INSERT INTO series (season_id, stage, round, slot, conference_id, a_ref, b_ref, best_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const p of planBracket(config)) {
      insert.run(season.id, p.stage, p.round, p.slot, p.group, JSON.stringify(p.a), JSON.stringify(p.b), p.bestOf)
    }
    setPhase(db, season, 'playoffs')
    appendEvent(db, 'playoffs_seeded', { seeds }, season.id)
    syncPlayoffs(db, { ...season, phase: 'playoffs' })
  })
}

/**
 * Brings the bracket in line with the games: series results, teams moving
 * on, home court, and the next game of every live series. Safe to run any
 * time; corrections flow through it too.
 */
export function syncPlayoffs(db: Db, season: SeasonInfo): void {
  const rows = seriesRows(db, season.id)
  if (rows.length === 0) return
  const seasonRow = db.prepare('SELECT final_ranking, playoff_seeds FROM seasons WHERE id = ?').get(season.id) as {
    final_ranking: string | null
    playoff_seeds: string | null
  }
  const seeds = new Map(Object.entries(JSON.parse(seasonRow.playoff_seeds ?? '{}') as Record<string, string[]>))
  const ranking = JSON.parse(seasonRow.final_ranking ?? '[]') as string[]
  const plans: SeriesPlan[] = rows.map((r) => ({
    slot: r.slot,
    stage: r.stage,
    round: r.round,
    group: r.conference_id,
    a: JSON.parse(r.a_ref) as Participant,
    b: JSON.parse(r.b_ref) as Participant,
    bestOf: r.best_of,
  }))
  // Home court follows the seed a team holds now: play-in winners take 7th/8th.
  let effective = effectiveSeeds(plans, seeds, new Map())
  const seedOf = (team: string, group: string | null): number | null => {
    const s = group === null ? undefined : effective.get(group)?.get(team)
    if (s !== undefined) return s
    const i = ranking.indexOf(team)
    return i >= 0 ? i + 1 : null
  }
  const finals = (seriesId: number) =>
    db.prepare("SELECT home_id, away_id, home_score, away_score FROM games WHERE series_id = ? AND status = 'final' ORDER BY round").all(seriesId) as {
      home_id: string
      away_id: string
      home_score: number
      away_score: number
    }[]

  // Results can unlock later series, so repeat until nothing changes.
  for (let pass = 0; pass < rows.length + 1; pass++) {
    const results = new Map<string, { winner: string; loser: string }>()
    for (const r of rows) {
      const wins = new Map<string, number>()
      for (const g of finals(r.id)) {
        const w = g.home_score > g.away_score ? g.home_id : g.away_id
        wins.set(w, (wins.get(w) ?? 0) + 1)
      }
      for (const [team, n] of wins) {
        if (n >= winsNeeded(r.best_of)) {
          const loser = [...wins.keys()].find((t) => t !== team) ?? (r.high_team_id === team ? r.low_team_id : r.high_team_id)
          if (loser) results.set(r.slot, { winner: team, loser })
        }
      }
    }
    const states = resolveBracket(plans, seeds, results)
    effective = effectiveSeeds(plans, seeds, results)
    let changed = false
    states.forEach((s, i) => {
      const r = rows[i]!
      let high = s.a
      let low = s.b
      if (high && low) {
        const sh = seedOf(high, r.conference_id)
        const sl = seedOf(low, r.conference_id)
        if (sh !== null && sl !== null && sl < sh) [high, low] = [low, high]
      }
      // A finished series keeps the seeds it was played with.
      const decided = r.winner_id !== null && s.winner === r.winner_id
      const next = {
        high: decided ? r.high_team_id : high,
        low: decided ? r.low_team_id : low,
        highSeed: decided ? r.high_seed : high ? seedOf(high, r.conference_id) : null,
        lowSeed: decided ? r.low_seed : low ? seedOf(low, r.conference_id) : null,
        winner: s.winner,
      }
      if (
        next.high !== r.high_team_id ||
        next.low !== r.low_team_id ||
        next.winner !== r.winner_id ||
        next.highSeed !== r.high_seed ||
        next.lowSeed !== r.low_seed
      ) {
        changed = true
        const newlyWon = next.winner !== null && r.winner_id !== next.winner
        const before = r.winner_id
        db.prepare('UPDATE series SET high_team_id = ?, low_team_id = ?, high_seed = ?, low_seed = ?, winner_id = ? WHERE id = ?').run(
          next.high,
          next.low,
          next.highSeed,
          next.lowSeed,
          next.winner,
          r.id,
        )
        Object.assign(r, { high_team_id: next.high, low_team_id: next.low, high_seed: next.highSeed, low_seed: next.lowSeed, winner_id: next.winner })
        // Compared with the winner from before the update (r now holds the new one).
        if (before !== null && before !== next.winner) {
          appendEvent(db, 'series_result_changed', { seriesId: r.id, slot: r.slot, before, after: next.winner }, season.id)
        }
        if (newlyWon) {
          const fs = finals(r.id)
          const w = fs.filter((g) => (g.home_score > g.away_score ? g.home_id : g.away_id) === next.winner).length
          appendEvent(
            db,
            'series_won',
            { seriesId: r.id, slot: r.slot, winner: next.winner!, loser: s.loser!, wins: w, losses: fs.length - w },
            season.id,
          )
        }
      }
    })
    if (!changed) break
  }

  // Next games: one scheduled game for every live series; none for finished
  // ones or ones whose teams changed.
  for (const r of rows) {
    const scheduled = db.prepare("SELECT id, home_id, away_id FROM games WHERE series_id = ? AND status = 'scheduled'").all(r.id) as {
      id: number
      home_id: string
      away_id: string
    }[]
    const live = r.winner_id === null && r.high_team_id !== null && r.low_team_id !== null
    const teams = new Set([r.high_team_id, r.low_team_id])
    for (const g of scheduled) {
      // A live thread or a screenshot reading may point at it: they let go rather than block the correction.
      if (!live || !teams.has(g.home_id) || !teams.has(g.away_id)) dropGame(db, g.id, 'the series changed')
    }
    if (!live) continue
    const stillScheduled = scheduled.filter((g) => teams.has(g.home_id) && teams.has(g.away_id))
    if (stillScheduled.length > 0) continue
    const n = finals(r.id).length + 1
    const hostHigh = highSeedHosts(n, r.best_of)
    db.prepare("INSERT INTO games (season_id, stage, round, series_id, home_id, away_id, status) VALUES (?, ?, ?, ?, ?, ?, 'scheduled')").run(
      season.id,
      r.stage,
      n,
      r.id,
      hostHigh ? r.high_team_id : r.low_team_id,
      hostHigh ? r.low_team_id : r.high_team_id,
    )
  }
}

/** A season's bracket, the current one by default. */
export function playoffsView(db: Db, seasonId?: number): PlayoffsView {
  const season = seasonFor(db, seasonId)
  const row = db.prepare('SELECT playoff_seeds FROM seasons WHERE id = ?').get(season.id) as { playoff_seeds: string | null }
  const wins = (seriesId: number, team: string | null) =>
    team === null
      ? 0
      : (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM games WHERE series_id = ? AND status = 'final' AND ((home_id = ? AND home_score > away_score) OR (away_id = ? AND away_score > home_score))",
            )
            .get(seriesId, team, team) as { n: number }
        ).n
  const series: SeriesRow[] = seriesRows(db, season.id).map((r) => ({
    id: r.id,
    slot: r.slot,
    stage: r.stage,
    round: r.round,
    group: r.conference_id,
    high: r.high_team_id,
    low: r.low_team_id,
    highSeed: r.high_seed,
    lowSeed: r.low_seed,
    bestOf: r.best_of,
    highWins: wins(r.id, r.high_team_id),
    lowWins: wins(r.id, r.low_team_id),
    winner: r.winner_id,
  }))
  return { seeds: row.playoff_seeds ? (JSON.parse(row.playoff_seeds) as Record<string, string[]>) : null, series }
}

/** playoffs → draft (card swap) or offseason, once every series is decided. */
export function finishPlayoffs(db: Db): void {
  const season = currentSeason(db)
  if (season.phase !== 'playoffs') refuse('wrong-phase', { phase: season.phase })
  const open = seriesRows(db, season.id).filter((r) => r.winner_id === null).length
  if (open > 0) refuse('series-left', { count: open })
  const { config } = loadConfig(db)
  transaction(db, () => afterPlayoffs(db, season, config))
}

/** Hands out the rest of the cards by final rank and opens the draft, or goes to the offseason. */
function afterPlayoffs(db: Db, season: SeasonInfo, config: LeagueConfig): void {
  if (config.draft.kind !== 'card-swap') {
    setPhase(db, season, 'offseason')
    return
  }
  const row = db.prepare('SELECT final_ranking FROM seasons WHERE id = ?').get(season.id) as { final_ranking: string | null }
  const ranking = JSON.parse(row.final_ranking ?? '[]') as string[]
  const frozen = new Set(listTeams(db).filter((t) => t.control === 'frozen').map((t) => t.id))
  // Only cards this season issued count; carried-over ones are extra.
  const existing = db
    .prepare('SELECT original_team_id, MAX(number) AS n FROM cards WHERE issued_season_id = ? GROUP BY original_team_id')
    .all(season.id) as {
    original_team_id: string
    n: number
  }[]
  const have = new Map(existing.map((e) => [e.original_team_id, e.n]))
  const insert = db.prepare(
    "INSERT INTO cards (season_id, issued_season_id, original_team_id, owner_team_id, number, status) VALUES (?, ?, ?, ?, ?, 'held')",
  )
  let added = 0
  ranking.forEach((teamId, i) => {
    if (frozen.has(teamId)) return
    const tier = config.draft.kind === 'card-swap' ? config.draft.allocation.find((t) => i + 1 >= t.fromRank && i + 1 <= t.toRank) : undefined
    const count = tier?.cards ?? 0
    for (let n = (have.get(teamId) ?? 0) + 1; n <= count; n++) {
      insert.run(season.id, season.id, teamId, teamId, n)
      added++
    }
  })
  appendEvent(db, 'cards_allocated', { cards: added }, season.id)
  setPhase(db, season, 'draft')
}
