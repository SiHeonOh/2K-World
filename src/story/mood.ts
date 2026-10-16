import { hash32, rng } from '@core/random'
import { computeMood, DEFAULT_TRAITS, usageClashes, type Mood, type MoodPart, type Traits } from '@core/mood'
import { expectedShares, peckingOrder, playerValue, possessions, shareSharpness, teamStrength } from '@core/value'
import { WANTING_OUT_LINE, type LockerRoomView, type PlayerFeelingsView, type PlayerMoodView } from '@shared/mood'
import type { LeagueEvent } from '@shared/events'
import { jsonField, type Db } from '@data/db'
import { parseFlags } from '@data/flags'
import { appendEvent, currentSeason, listEvents, listPlayers } from '@data/league'
import { listAwards } from '@data/moves'
import { standings } from '@data/season'
import type { League } from './context'
import { leagueFeelings, type PlayerFeelings } from './feelings'

export { WANTING_OUT_LINE } from '@shared/mood'

/**
 * Builds each player's mood inputs from the league (lore traits and
 * relationships, the last few games' shots and points, results, awards,
 * recent moves) and runs the mood engine. Snapshots after each game keep a
 * history; crossing into or out of the unhappy bands is a `mood_changed`
 * event the community can pick up.
 */

/** Games the shot shares and points are taken from. */
export const RECENT_GAMES = 5
/** Moves fade out over this many of the team's games. */
const MOVE_FADE_GAMES = 6

interface Line {
  gameId: number
  playerId: string
  teamId: string
  stats: Record<string, number>
}

function statId(league: League, meaning: string): string | undefined {
  return league.config.stats.columns.find((c) => c.meaning === meaning)?.id
}

/** Lore traits (1..5) and relationships for a player; defaults when he has no file. */
export function loreOf(league: League, playerId: string) {
  const e = league.lore.player.get(playerId)
  if (e?.kind !== 'player') return { traits: DEFAULT_TRAITS, relationships: [], hooks: [], fromLore: false }
  const { traits, relationships, hooks } = e.settings
  return { traits: { ...DEFAULT_TRAITS, ...traits } as Traits, relationships, hooks, fromLore: true }
}

/**
 * A relationship's other side, by name, as a player id. "이름(학교)" names the
 * school he started at, as in lore file names; failing that, his school now.
 */
export function relationTarget(league: League, name: string): string | null {
  const players = [...league.players.values()]
  const only = (hits: typeof players) => (hits.length === 1 ? hits[0]!.id : null)
  const same = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC')
  const m = name.trim().match(/^(.+?)\((.+)\)$/)
  if (!m) return only(players.filter((p) => same(p.name, name.trim())))
  const at = (teamOf: (p: (typeof players)[number]) => string) =>
    players.filter((p) => same(p.name, m[1]!) && same(league.teams.get(teamOf(p))?.shortName ?? '', m[2]!))
  const started = at((p) => p.firstTeamId)
  return only(started.length > 0 ? started : at((p) => p.teamId))
}

export function lockerRoom(league: League, teamId: string, feelings: Map<string, PlayerFeelings> = leagueFeelings(league)): LockerRoomView {
  const { db, config } = league
  const season = currentSeason(db)
  const roster = listPlayers(db).filter((p) => p.teamId === teamId)
  const valued = roster.map((p) => ({ id: p.id, teamId, slotId: p.slotId, value: playerValue(config, p.ratings) }))
  const order = peckingOrder(valued)
  const starters = config.roster.slots.filter((s) => s.starter).length || 5
  const lore = new Map(roster.map((p) => [p.id, loreOf(league, p.id)]))
  const shares = expectedShares(valued.map((v) => ({ id: v.id, value: v.value, usage: lore.get(v.id)!.traits.usage })), shareSharpness(config))

  // The team's last few games with box scores.
  const games = db
    .prepare(
      `SELECT g.id FROM games g WHERE g.season_id = ? AND g.status = 'final' AND (g.home_id = ? OR g.away_id = ?)
       AND EXISTS (SELECT 1 FROM box_lines b WHERE b.game_id = g.id AND b.team_id = ?)
       ORDER BY g.recorded_at DESC, g.id DESC LIMIT ?`,
    )
    .all(season.id, teamId, teamId, teamId, RECENT_GAMES) as { id: number }[]
  const lines: Line[] = games.flatMap((g) =>
    (db.prepare('SELECT game_id, player_id, team_id, stats FROM box_lines WHERE game_id = ? AND team_id = ?').all(g.id, teamId) as {
      game_id: number
      player_id: string
      team_id: string
      stats: string
    }[]).map((r) => ({ gameId: r.game_id, playerId: r.player_id, teamId: r.team_id, stats: JSON.parse(r.stats) as Record<string, number> })),
  )
  const ids = { fga: statId(league, 'fga'), fta: statId(league, 'fta'), to: statId(league, 'turnovers') }
  const pts = statId(league, 'points')
  const teamPoss = lines.reduce((s, l) => s + possessions(l.stats, ids), 0)
  const teamPoints = lines.reduce((s, l) => s + (pts ? (l.stats[pts] ?? 0) : 0), 0)

  const view = standings(db)
  const line = view.overall.find((s) => s.teamId === teamId)
  const played = line ? line.wins + line.losses : 0
  const streak = line?.streak ? (line.streak.startsWith('W') ? 1 : -1) * Number(line.streak.slice(1)) : 0
  const awards = listAwards(db, season.id, config)
  const events = listEvents(db).filter((e) => e.seasonId === season.id)
  const teamGameTimes = (db.prepare("SELECT recorded_at FROM games WHERE season_id = ? AND status = 'final' AND (home_id = ? OR away_id = ?) ORDER BY recorded_at").all(season.id, teamId, teamId) as { recorded_at: string }[]).map((r) => r.recorded_at)
  /** 1 right after an event, fading to 0 over the team's next few games. */
  const recency = (e: LeagueEvent) => Math.max(0, 1 - teamGameTimes.filter((at) => at > e.createdAt).length / MOVE_FADE_GAMES)
  const movedEvents = events.filter((e) => e.type === 'trade_applied' || e.type === 'draft_swap')
  const movesOf = (pid: string) =>
    movedEvents
      .filter((e) => {
        const x = e.payload as { players?: string[]; playerId?: string; targetPlayerId?: string }
        return x.players?.includes(pid) || x.playerId === pid || x.targetPlayerId === pid
      })
      .reduce((s, e) => s + recency(e), 0)
  const seasonPpg = seasonPoints(db, season.id, pts)
  // Each player's latest words this season (player_reaction).
  const saidStmt = db.prepare(
    `SELECT q.channel, q.quote, q.action, q.note, q.created_at, f.numbers AS flags FROM player_quotes q
     LEFT JOIN ai_flags f ON f.target_kind = 'player_quote' AND f.target_id = q.id
     WHERE q.player_id = ? AND q.season_id = ? ORDER BY q.id DESC LIMIT 1`,
  )

  const moods = order.map((v, rank): PlayerMoodView & { mood: Mood; traits: Traits } => {
    const p = league.players.get(v.id)!
    const l = lore.get(v.id)!
    const mine = lines.filter((x) => x.playerId === v.id)
    const share = teamPoss > 0 && mine.length > 0 ? mine.reduce((s, x) => s + possessions(x.stats, ids), 0) / teamPoss : null
    const gamesPlayed = new Set(lines.map((x) => x.gameId)).size
    const points = pts && mine.length > 0 ? mine.reduce((s, x) => s + (x.stats[pts] ?? 0), 0) / mine.length : null
    const expectedPoints = gamesPlayed > 0 ? (teamPoints / gamesPlayed) * shares.get(v.id)! : 0
    const rel = l.relationships.map((r) => ({ ...r, id: relationTarget(league, r.with) })).filter((r) => r.id !== null && r.id !== v.id)
    const friends = rel.filter((r) => ['friend', 'family', 'mentor'].includes(r.type))
    const rivals = rel.filter((r) => ['rival', 'dislikes'].includes(r.type))
    const friendsLost = friends
      .filter((f) => league.players.get(f.id!)?.teamId !== teamId)
      .reduce((s, f) => s + movesOf(f.id!), 0)
    const away = rivals.filter((r) => league.players.get(r.id!)?.teamId !== teamId)
    const myPpg = seasonPpg.get(v.id) ?? 0
    const rivalEdge = away.length ? Math.max(-1, Math.min(1, away.reduce((s, r) => s + ((seasonPpg.get(r.id!) ?? 0) - myPpg) / 15, 0) / away.length)) : 0
    const awardCount = awards.filter((a) => a.playerId === v.id).reduce((s, a) => s + (a.teamRank > 1 ? 0.5 : 1), 0)
    const recentMoves = movesOf(v.id)
    const starterSlot = config.roster.slots.find((s) => s.id === v.slotId)?.starter ?? rank < starters
    const hooks: Partial<Record<MoodPart, number>> = {}
    const active = new Set<string>()
    if (recentMoves > 0.3) active.add('traded')
    if (!starterSlot && rank < starters) active.add('benched')
    if (streak <= -3) active.add('losing_streak')
    if (streak >= 3) active.add('winning_streak')
    if (awardCount > 0) active.add('award')
    if (rivalEdge > 0.3) active.add('rival_ahead')
    for (const h of l.hooks) {
      // rival_award: this season, the named rival (or any of his rivals) won something.
      if (h.when === 'rival_award') {
        const named = h.rival ? relationTarget(league, h.rival) : null
        const whose = h.rival ? (named ? [named] : []) : rivals.map((r) => r.id!)
        if (!awards.some((a) => whose.includes(a.playerId))) continue
      } else if (!active.has(h.when)) continue
      for (const [part, delta] of Object.entries(h.mood)) hooks[part as MoodPart] = (hooks[part as MoodPart] ?? 0) + (delta ?? 0)
    }
    const mood = computeMood({
      traits: l.traits,
      starter: starterSlot,
      expectsToStart: rank < starters,
      usageShare: share,
      expectedShare: shares.get(v.id)!,
      points,
      expectedPoints,
      winPct: played > 0 ? line!.wins / played : null,
      streak,
      awards: awardCount,
      // Past two played for every five to go, and not over yet (as before), counted against the whole
      // season: rounds built by hand aren't all there yet, so unplayed games alone can't say.
      seasonMature: view.played < view.total && view.played / view.total > 2 / 7,
      isStar: rank === 0,
      friendsOnTeam: friends.filter((f) => league.players.get(f.id!)?.teamId === teamId).length,
      rivalsOnTeam: rivals.filter((r) => league.players.get(r.id!)?.teamId === teamId).length,
      friendsLost,
      rivalEdge,
      recentMoves,
      belonging: feelings.get(v.id)?.belonging ?? 0,
      hooks,
      noise: rng(hash32(`${v.id}:${played}`))(),
    })
    return {
      playerId: v.id,
      name: p.name,
      slot: config.roster.slots.find((s) => s.id === v.slotId)?.name ?? null,
      value: v.value,
      overall: mood.overall,
      band: mood.band,
      parts: mood.parts,
      reasons: mood.reasons,
      share,
      expectedShare: shares.get(v.id)!,
      fromLore: l.fromLore,
      said: (() => {
        const q = saidStmt.get(v.id, season.id) as { channel: string; quote: string; action: string; note: string; created_at: string; flags: string | null } | undefined
        return q ? { channel: q.channel, quote: q.quote, action: q.action, note: q.note, at: q.created_at, flags: parseFlags(q.flags) } : null
      })(),
      feelings: feelingsView(league, feelings.get(v.id)),
      mood,
      traits: l.traits,
    }
  })
  const clashes = usageClashes(moods.map((m) => ({ id: m.playerId, traits: m.traits, mood: m.mood }))).map(
    ([a, b]) => [league.players.get(a)!.name, league.players.get(b)!.name] as [string, string],
  )
  return {
    teamId,
    strength: teamStrength(config, valued),
    players: moods.map(({ mood: _m, traits: _t, ...rest }) => rest).sort((a, b) => a.overall - b.overall),
    clashes,
    games: games.length,
  }
}

/** His feelings for the screens: grudges with their targets' names. */
export function feelingsView(league: League, f: PlayerFeelings | undefined): PlayerFeelingsView {
  if (!f) return { trust: 0, attachment: 0, wantingOut: 0, belonging: 0, grudges: [], why: { trust: [], attachment: [] } }
  return {
    trust: f.trust,
    attachment: f.attachment,
    wantingOut: f.wantingOut,
    belonging: f.belonging,
    grudges: f.grudges.map((g) => ({
      kind: g.target.kind,
      id: g.target.id,
      name: g.target.kind === 'team' ? (league.teams.get(g.target.id)?.shortName ?? g.target.id) : (league.players.get(g.target.id)?.name ?? g.target.id),
      value: g.value,
      why: g.why,
      games: g.games,
    })),
    why: f.why,
  }
}

function seasonPoints(db: Db, seasonId: number, pts: string | undefined): Map<string, number> {
  if (!pts) return new Map()
  const rows = db
    .prepare(
      `SELECT b.player_id, AVG(json_extract(b.stats, '$.' || ?)) AS ppg FROM box_lines b JOIN games g ON g.id = b.game_id
       WHERE g.season_id = ? GROUP BY b.player_id`,
    )
    .all(pts, seasonId) as { player_id: string; ppg: number }[]
  return new Map(rows.map((r) => [r.player_id, r.ppg ?? 0]))
}

const BAD = new Set(['unhappy', 'boiling'])

/**
 * Snapshots a team's moods (after a game or a move) and records a
 * `mood_changed` event for each player who crossed into or out of the
 * unhappy bands. Returns the players who changed.
 */
export function snapshotMoods(league: League, teamId: string, nowMs: number, feelings: Map<string, PlayerFeelings> = leagueFeelings(league)): string[] {
  const { db } = league
  const season = currentSeason(db)
  const room = lockerRoom(league, teamId, feelings)
  const last = db.prepare('SELECT band, feelings FROM player_mood WHERE player_id = ? AND season_id = ? ORDER BY id DESC LIMIT 1')
  const insert = db.prepare('INSERT INTO player_mood (season_id, player_id, overall, band, parts, feelings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const toldStmt = db.prepare(
    `SELECT 1 FROM events WHERE type = 'wanting_out' AND season_id = ? AND ${jsonField('payload', '$.playerId')} = ? AND ${jsonField('payload', '$.teamId')} = ? LIMIT 1`,
  )
  const changed: string[] = []
  for (const p of room.players) {
    const prev = last.get(p.playerId, season.id) as { band: string; feelings: string | null } | undefined
    const before = prev?.band ?? null
    const f = p.feelings
    insert.run(
      season.id,
      p.playerId,
      p.overall,
      p.band,
      JSON.stringify(p.parts),
      JSON.stringify({ trust: f.trust, attachment: f.attachment, wantingOut: f.wantingOut }),
      new Date(nowMs).toISOString(),
    )
    // Wanting out crossing its line is news, once per player, school and season. Going back under it
    // isn't (a rumor doesn't take itself back), and a snapshot with nothing known before it (the first
    // one, or one from before feelings were kept) is never a crossing.
    const wasOut = prev?.feelings ? (JSON.parse(prev.feelings) as { wantingOut?: number }).wantingOut : undefined
    if (wasOut !== undefined && wasOut < WANTING_OUT_LINE && f.wantingOut >= WANTING_OUT_LINE && !toldStmt.get(season.id, p.playerId, teamId)) {
      appendEvent(db, 'wanting_out', { playerId: p.playerId, teamId, value: f.wantingOut }, season.id)
    }
    const crossed = before !== null && before !== p.band && (BAD.has(before) !== BAD.has(p.band) || (before === 'unhappy' && p.band === 'boiling'))
    if (crossed) {
      appendEvent(db, 'mood_changed', { playerId: p.playerId, teamId, from: before, to: p.band, reasons: p.reasons.slice(0, 3).map((r) => r.part) }, season.id)
      changed.push(p.playerId)
    }
  }
  return changed
}
