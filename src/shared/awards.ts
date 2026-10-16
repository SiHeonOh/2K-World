import type { LeagueConfig, PeriodicAward } from './config/schema'

/**
 * Weekly and monthly awards, said one way on every screen and in every
 * writer's facts (one helper, as roundLabel is for rounds): "3주차 동부 이주의
 * 선수", "11월 서부 이달의 선수". Periods are stored as codes (w3: the 3rd
 * week; m2: the 2nd month of the NBA's calendar, 11월) and never shown.
 *
 * An award given per conference or division counts its winners in each group
 * apart: the group of the school he won it for (`awards.team_id`), by the
 * league's structure today (past structures aren't stored).
 */

export type AwardScope = PeriodicAward['scope']
type Structure = Pick<LeagueConfig['structure'], 'conferences' | 'divisions'>

/** How a scope works in this league: per conference takes two conferences or more, per division two divisions; else it's league-wide. */
export function scopeIn(structure: Structure, scope: AwardScope): AwardScope {
  if (scope === 'conference') return structure.conferences.length >= 2 ? 'conference' : 'league'
  if (scope === 'division') return structure.divisions.length >= 2 ? 'division' : 'league'
  return 'league'
}

/**
 * The group a school's winner counts in: its conference's or division's id.
 * Null when the award is league-wide, and for a school in no conference
 * (those count among themselves).
 */
export function groupOf(structure: Structure, scope: AwardScope, divisionId: string | null | undefined): string | null {
  const s = scopeIn(structure, scope)
  const division = structure.divisions.find((d) => d.id === divisionId)
  if (s === 'league' || !division) return null
  return s === 'division' ? division.id : division.conferenceId
}

/** A group's name by its id ('동부'): a conference's, else a division's; '' for none. Events keep the id, so it's found whatever the scope is now. */
export function groupName(structure: Structure, id: string | null | undefined): string {
  if (!id) return ''
  return structure.conferences.find((c) => c.id === id)?.name ?? structure.divisions.find((d) => d.id === id)?.name ?? ''
}

export interface AwardGroup {
  /** The conference's or division's id; null for the whole league, or for the schools in no conference. */
  id: string | null
  /** Its name; '' for those. */
  name: string
}

/**
 * Where an award's winners are counted, in the league's order: each
 * conference or division, or the whole league (one group). Schools in a
 * division with no conference get a group of their own after the rest.
 */
export function awardGroups(structure: Structure, scope: AwardScope, teams: readonly { divisionId: string }[]): AwardGroup[] {
  const s = scopeIn(structure, scope)
  if (s === 'league') return [{ id: null, name: '' }]
  const groups: AwardGroup[] = (s === 'conference' ? structure.conferences : structure.divisions).map((g) => ({ id: g.id, name: g.name }))
  if (teams.some((t) => groupOf(structure, s, t.divisionId) === null)) groups.push({ id: null, name: '' })
  return groups
}

// ── Periods ──────────────────────────────────────────────────────────────

/** The NBA's months from the season's start: m1 is 10월, m7 is 4월, m8 is 5월 (and on, for a long season). */
const MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/** A period's number (w3 → 3); 0 for anything else ('' for a season award). */
export function periodNumber(period: string): number {
  const m = /^[wm](\d+)$/.exec(period)
  return m ? Number(m[1]) : 0
}

/** A period as it's said: 'w3' → '3주차', 'm2' → '11월'; '' (a season award) stays ''. */
export function periodLabel(period: string): string {
  const m = /^([wm])(\d+)$/.exec(period)
  if (!m) return period
  const n = Number(m[2])
  if (m[1] === 'w') return `${n}주차`
  return n >= 1 && n <= MONTHS.length ? `${MONTHS[n - 1]}월` : `${n}번째 달`
}

/** Periods in order, first to last (w2 before w10). */
export const byPeriod = (a: string, b: string) => periodNumber(a) - periodNumber(b) || a.localeCompare(b)

/**
 * Weeks a regular season spans by the calendar (rounds a week; a school
 * plays once a round, so a round robin of N schools has N − 1 rounds a
 * cycle, N with an odd count), and months (weeks a month). At least one each.
 */
export function seasonSpan(config: Pick<LeagueConfig, 'season'>, teamCount: number): { weeks: number; months: number } {
  const { schedule, calendar } = config.season
  const rounds = schedule.kind === 'custom' ? schedule.gamesPerTeam : teamCount < 2 ? 0 : schedule.cycles * (teamCount % 2 === 0 ? teamCount - 1 : teamCount)
  const weeks = Math.max(1, Math.ceil(rounds / calendar.roundsPerWeek))
  return { weeks, months: Math.max(1, Math.ceil(weeks / calendar.weeksPerMonth)) }
}

/** An NBA season's worth at least: late October to mid-April is about 25 weeks; 10월 to 4월, and 5월 in case. */
const MIN_WEEKS = 30
const MIN_MONTHS = 8
/** Codes have three digits at most (giveAward). */
const MAX_PERIODS = 999

/** The periods an award's picker offers, first to last: 1주차 to 30주차, or 10월 to 5월 (more for a season that runs longer). */
export function periodChoices(config: Pick<LeagueConfig, 'season'>, teamCount: number, period: PeriodicAward['period']): string[] {
  const span = seasonSpan(config, teamCount)
  const n = Math.min(MAX_PERIODS, period === 'week' ? Math.max(MIN_WEEKS, span.weeks) : Math.max(MIN_MONTHS, span.months))
  const letter = period === 'week' ? 'w' : 'm'
  return Array.from({ length: n }, (_, i) => `${letter}${i + 1}`)
}

// ── Labels ───────────────────────────────────────────────────────────────

/** An award as it's said: its period, its group, its name ("3주차 동부 이주의 선수", "11월 서부 이달의 선수", "MVP"). */
export function awardLabel(a: { award: string; period?: string; group?: string }): string {
  return [periodLabel(a.period ?? ''), a.group ?? '', a.award]
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .join(' ')
}

/** The same from what's kept (an award's id, its period and its group's id): the names come from the config. */
export function awardTitle(config: Pick<LeagueConfig, 'awards' | 'structure'>, a: { awardId: string; period?: string; group?: string | null }): string {
  const name = [...config.awards.season, ...config.awards.periodic].find((x) => x.id === a.awardId)?.name ?? a.awardId
  return awardLabel({ award: name, period: a.period ?? '', group: groupName(config.structure, a.group) })
}
