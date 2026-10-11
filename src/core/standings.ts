import type { Tiebreaker } from '@shared/config/schema'
import { hash32 } from './random'

export interface TeamRef {
  id: string
  divisionId: string
  conferenceId: string | null
}

/** A finished game. Basketball has no draws; recording refuses equal scores. */
export interface FinalScore {
  /** Orders games for streaks and last-10: round first, then id. */
  round: number
  id: number
  home: string
  away: string
  homeScore: number
  awayScore: number
}

export interface Record {
  w: number
  l: number
}

export interface StandingRow {
  teamId: string
  wins: number
  losses: number
  pct: number
  pointsFor: number
  pointsAgainst: number
  home: Record
  away: Record
  conference: Record
  division: Record
  /** Last ten games, oldest first. */
  last10: Record
  /** 'W3', 'L1', or '' before any game. */
  streak: string
}

const pctOf = (r: Record) => (r.w + r.l === 0 ? 0 : r.w / (r.w + r.l))
/** For comparing teams, no games counts as .500, not .000. */
const rankPct = (r: Record) => (r.w + r.l === 0 ? 0.5 : r.w / (r.w + r.l))

export function computeRows(teams: readonly TeamRef[], games: readonly FinalScore[]): Map<string, StandingRow> {
  const info = new Map(teams.map((t) => [t.id, t]))
  const rows = new Map<string, StandingRow>()
  const results = new Map<string, boolean[]>()
  for (const t of teams) {
    rows.set(t.id, {
      teamId: t.id,
      wins: 0,
      losses: 0,
      pct: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      home: { w: 0, l: 0 },
      away: { w: 0, l: 0 },
      conference: { w: 0, l: 0 },
      division: { w: 0, l: 0 },
      last10: { w: 0, l: 0 },
      streak: '',
    })
    results.set(t.id, [])
  }
  const ordered = [...games].sort((a, b) => a.round - b.round || a.id - b.id)
  for (const g of ordered) {
    const home = rows.get(g.home)
    const away = rows.get(g.away)
    if (!home || !away || g.homeScore === g.awayScore) continue
    const homeWon = g.homeScore > g.awayScore
    const hi = info.get(g.home)!
    const ai = info.get(g.away)!
    const tally = (row: StandingRow, won: boolean, atHome: boolean, pf: number, pa: number) => {
      if (won) row.wins++
      else row.losses++
      row.pointsFor += pf
      row.pointsAgainst += pa
      const where = atHome ? row.home : row.away
      if (won) where.w++
      else where.l++
      if (hi.conferenceId !== null && hi.conferenceId === ai.conferenceId) {
        if (won) row.conference.w++
        else row.conference.l++
      }
      if (hi.divisionId === ai.divisionId) {
        if (won) row.division.w++
        else row.division.l++
      }
      results.get(row.teamId)!.push(won)
    }
    tally(home, homeWon, true, g.homeScore, g.awayScore)
    tally(away, !homeWon, false, g.awayScore, g.homeScore)
  }
  for (const row of rows.values()) {
    row.pct = pctOf({ w: row.wins, l: row.losses })
    const res = results.get(row.teamId)!
    const last = res.slice(-10)
    row.last10 = { w: last.filter(Boolean).length, l: last.filter((x) => !x).length }
    if (res.length > 0) {
      const latest = res[res.length - 1]!
      let n = 0
      for (let i = res.length - 1; i >= 0 && res[i] === latest; i--) n++
      row.streak = `${latest ? 'W' : 'L'}${n}`
    }
  }
  return rows
}

/**
 * Orders teams by win %, breaking ties with `tiebreakers` in order. When a
 * tiebreaker splits a group, each smaller group starts over from the first
 * tiebreaker (head-to-head among fewer teams can differ). A seeded coin flip
 * is always the last step, so the order is total and repeatable.
 */
export function rankTeams(
  teamIds: readonly string[],
  rows: Map<string, StandingRow>,
  games: readonly FinalScore[],
  tiebreakers: readonly Tiebreaker[],
  seed: string,
): string[] {
  const criteria = tiebreakers.includes('random') ? [...tiebreakers] : [...tiebreakers, 'random' as const]
  const row = (id: string) => rows.get(id)!

  const value = (criterion: Tiebreaker, id: string, group: readonly string[]): number => {
    const r = row(id)
    switch (criterion) {
      case 'head-to-head': {
        const members = new Set(group)
        const rec = { w: 0, l: 0 }
        for (const g of games) {
          if (g.homeScore === g.awayScore) continue
          const opponent = g.home === id ? g.away : g.away === id ? g.home : null
          if (opponent === null || !members.has(opponent)) continue
          const won = g.home === id ? g.homeScore > g.awayScore : g.awayScore > g.homeScore
          if (won) rec.w++
          else rec.l++
        }
        return rankPct(rec)
      }
      case 'point-diff':
        return r.pointsFor - r.pointsAgainst
      case 'points-for':
        return r.pointsFor
      case 'conference-record':
        return rankPct(r.conference)
      case 'division-record':
        return rankPct(r.division)
      case 'random':
        return hash32(`${seed}:${id}`)
    }
  }

  const order = (group: string[]): string[] => {
    if (group.length <= 1) return group
    for (const criterion of criteria) {
      const scored = group.map((id) => ({ id, v: value(criterion, id, group) }))
      if (scored.every((s) => s.v === scored[0]!.v)) continue
      scored.sort((a, b) => b.v - a.v)
      const out: string[] = []
      for (let i = 0; i < scored.length; ) {
        let j = i
        while (j < scored.length && scored[j]!.v === scored[i]!.v) j++
        out.push(...order(scored.slice(i, j).map((s) => s.id)))
        i = j
      }
      return out
    }
    // Only possible when two ids hash alike: fall back to id order.
    return [...group].sort()
  }

  const pct = (id: string) => rankPct({ w: row(id).wins, l: row(id).losses })
  const byPct = [...teamIds].sort((a, b) => pct(b) - pct(a))
  const out: string[] = []
  for (let i = 0; i < byPct.length; ) {
    let j = i
    while (j < byPct.length && pct(byPct[j]!) === pct(byPct[i]!)) j++
    out.push(...order(byPct.slice(i, j)))
    i = j
  }
  return out
}

/** Games behind the leader of an ordered group: ((leader W − W) + (L − leader L)) / 2. */
export function gamesBehind(ordered: readonly string[], rows: Map<string, StandingRow>): Map<string, number> {
  const out = new Map<string, number>()
  const leader = ordered[0] ? rows.get(ordered[0]) : undefined
  for (const id of ordered) {
    const r = rows.get(id)!
    out.set(id, leader ? (leader.wins - r.wins + (r.losses - leader.losses)) / 2 : 0)
  }
  return out
}
