import type { EventPayloads } from '@shared/events'
import { aloneAtTop, currentMoments, type MomentTeam } from '@core/moments'
import { scheduleShape } from '@core/schedule'
import type { Db } from './db'
import { appendEvent, currentSeason, listTeams, loadConfig } from './league'
import { listGames, standings, teamRefs } from './season'

/** Games every team has played before anyone can take over #1: a round or two is noise. */
const LEADER_AFTER = 3

type MomentPayload = EventPayloads['standings_moment']

/** Two moments are the same news when this matches: a clinch or elimination once a season, a streak once per milestone of a run. */
const momentKey = (m: MomentPayload) =>
  m.kind === 'clinch'
    ? `clinch:${m.teamId}:${m.place}`
    : m.kind === 'eliminated'
      ? `out:${m.teamId}`
      : m.kind === 'streak'
        ? `streak:${m.teamId}:${m.runStart}:${m.length}`
        : m.kind === 'streak-snapped'
          ? `snap:${m.teamId}:${m.runStart}`
          : `leader:${m.teamId}`

/**
 * Records the standings moments the regular season hasn't announced yet:
 * places clinched, eliminations, a new overall #1 and streak milestones
 * (see core/moments). Called after results change; returns the new events.
 */
export function announceStandingsMoments(db: Db): number[] {
  const season = currentSeason(db)
  if (season.phase !== 'regular') return []
  const { config } = loadConfig(db)
  const { schedule, playoffs } = config.season
  const teams = listTeams(db)
  if (teams.length < 2) return []
  const perTeam = schedule.kind === 'round-robin' ? schedule.cycles * (teams.length - 1) : schedule.gamesPerTeam
  const refs = new Map(teamRefs(db, config).map((r) => [r.id, r]))
  // Schedule order (round, then game), the same order standings use for streaks.
  const games = listGames(db, season.id).filter((g) => g.stage === 'regular')
  // A round robin's rounds not yet full (built by hand): a game could still come in behind a streak.
  const shape = scheduleShape(config, teams.length)
  const perRound = new Map<number, number>()
  for (const g of games) perRound.set(g.round, (perRound.get(g.round) ?? 0) + 1)
  const unfullBefore = (round: number) => shape !== null && Array.from({ length: round - 1 }, (_, i) => i + 1).some((r) => (perRound.get(r) ?? 0) < shape.perRound)
  const list: MomentTeam[] = teams.map((t) => {
    const own = games.filter((g) => g.home === t.id || g.away === t.id)
    const played = own.filter((g) => g.status === 'final')
    const results = played.map((g) => (g.home === t.id ? g.homeScore! > g.awayScore! : g.awayScore! > g.homeScore!))
    const wins = results.filter(Boolean).length
    const lastRound = played.at(-1)?.round ?? 0
    return {
      teamId: t.id,
      group: playoffs.bracket === 'conference' ? (refs.get(t.id)?.conferenceId ?? 'none') : 'league',
      wins,
      losses: results.length - wins,
      left: Math.max(0, perTeam - results.length),
      results,
      gameIds: played.map((g) => g.id),
      settled: !own.some((g) => g.status === 'scheduled' && g.round < lastRound) && !unfullBefore(lastRound),
    }
  })
  const direct = playoffs.enabled ? playoffs.directSeeds : 0
  const field = playoffs.enabled ? direct + (playoffs.playIn.enabled ? 4 : 0) : 0
  const moments: MomentPayload[] = currentMoments(list, direct, field)

  const earlier = (
    db.prepare("SELECT payload FROM events WHERE type = 'standings_moment' AND season_id = ? ORDER BY id").all(season.id) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as MomentPayload)
  // A new #1, once everyone has a few games in, and only one sure to stay ahead of every rival's
  // games in hand (a tie, or a lead from typing its game first, isn't a new leader).
  if (list.every((t) => t.wins + t.losses >= LEADER_AFTER)) {
    const first = standings(db).overall[0]?.teamId
    const leader = list.find((t) => t.teamId === first)
    const record = (t: MomentTeam) => ({ wins: t.wins, games: t.wins + t.losses })
    const alone = leader !== undefined && aloneAtTop(record(leader), list.filter((t) => t !== leader).map(record))
    const lastLeader = [...earlier].reverse().find((m) => m.kind === 'leader')?.teamId ?? null
    if (alone && leader.teamId !== lastLeader) moments.push({ kind: 'leader', teamId: leader.teamId, previous: lastLeader })
  }
  const told = new Set(earlier.filter((m) => m.kind !== 'leader').map(momentKey))
  const ids: number[] = []
  for (const m of moments) {
    if (m.kind !== 'leader' && told.has(momentKey(m))) continue
    if (sameRunTold(m, earlier, list)) continue
    told.add(momentKey(m))
    ids.push(appendEvent(db, 'standings_moment', m, season.id))
  }
  return ids
}

/**
 * A streak (or snapped run) already told under another first game: a
 * corrected score can stretch a run back to an earlier game, which would
 * make it look like a new run. It's the same run when an earlier
 * announcement's first game lies inside it (and had at least this length).
 */
function sameRunTold(m: MomentPayload, earlier: MomentPayload[], teams: MomentTeam[]): boolean {
  if (m.kind !== 'streak' && m.kind !== 'streak-snapped') return false
  const t = teams.find((x) => x.teamId === m.teamId)
  const from = t ? t.gameIds.indexOf(m.runStart!) : -1
  if (!t || from < 0) return false
  // The run's games: to the end for a streak; for a snapped run, up to the result that ended it.
  let to = from
  while (to + 1 < t.results.length && t.results[to + 1] === t.results[from]) to++
  const run = new Set(t.gameIds.slice(from, to + 1))
  return earlier.some(
    (e) => e.kind === m.kind && e.teamId === m.teamId && e.won === m.won && e.runStart !== undefined && run.has(e.runStart) && (m.kind === 'streak-snapped' || (e.length ?? 0) >= m.length!),
  )
}
