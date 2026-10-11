import type { LeagueSnapshot } from '@shared/league'

/**
 * Who a lore reference can point at, as the pickers offer them. A player is
 * written as his name, or 이름(학교) when another player shares it, the
 * school being the one he started at (as the mood engine reads it).
 */
export interface Person {
  /** What goes in the file. */
  value: string
  name: string
  /** Shown beside the name: school and slot. */
  detail: string
  playerId?: string
  teamId: string
}

export interface People {
  players: Person[]
  gms: Person[]
  schools: Person[]
  schoolName: (teamId: string) => string
}

export function peopleOf(league: LeagueSnapshot, firstTeams: Record<string, string>): People {
  const school = new Map(league.teams.map((t) => [t.id, t.shortName]))
  const slot = new Map(league.config.roster.slots.map((s) => [s.id, s.name]))
  const count = new Map<string, number>()
  for (const p of league.players) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  const order = new Map(league.teams.map((t, i) => [t.id, i]))
  const players = [...league.players]
    .sort((a, b) => (order.get(a.teamId) ?? 0) - (order.get(b.teamId) ?? 0))
    .map((p) => {
      const first = firstTeams[p.id] ?? p.teamId
      return {
        value: (count.get(p.name) ?? 0) > 1 ? `${p.name}(${school.get(first) ?? first})` : p.name,
        name: p.name,
        detail: [school.get(p.teamId), p.slotId ? slot.get(p.slotId) : null].filter(Boolean).join(' · '),
        playerId: p.id,
        teamId: p.teamId,
      }
    })
  return {
    players,
    gms: league.teams.map((t) => ({ value: `${t.shortName} 단장`, name: `${t.shortName} 단장`, detail: t.name, teamId: t.id })),
    schools: league.teams.map((t) => ({ value: t.shortName, name: t.shortName, detail: t.name, teamId: t.id })),
    schoolName: (id) => school.get(id) ?? id,
  }
}

export type Resolved = { status: 'empty' } | { status: 'ok'; person: Person } | { status: 'missing' } | { status: 'ambiguous' }

/**
 * Which player a written reference means, the way the mood engine reads it:
 * 이름(학교) is the school he started at, then the one he's at now.
 */
export function resolvePlayer(text: string, league: LeagueSnapshot, firstTeams: Record<string, string>, people: People): Resolved {
  const ref = text.trim().normalize('NFC')
  if (ref === '') return { status: 'empty' }
  const byId = (id: string) => people.players.find((p) => p.playerId === id)!
  const m = ref.match(/^(.+?)\((.+)\)$/)
  const named = league.players.filter((p) => p.name.normalize('NFC') === (m ? m[1]! : ref))
  let hits = named
  if (m) {
    const at = (teamOf: (p: (typeof named)[number]) => string) => named.filter((p) => people.schoolName(teamOf(p)).normalize('NFC') === m[2])
    const started = at((p) => firstTeams[p.id] ?? p.teamId)
    hits = started.length > 0 ? started : at((p) => p.teamId)
  }
  if (hits.length === 1) return { status: 'ok', person: byId(hits[0]!.id) }
  return hits.length > 1 || (m === null && named.length > 1) ? { status: 'ambiguous' } : { status: 'missing' }
}

/** Search: every word must match the name, the written value or the detail. */
export function matches(person: Person, query: string): boolean {
  const hay = `${person.name} ${person.value} ${person.detail}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}
