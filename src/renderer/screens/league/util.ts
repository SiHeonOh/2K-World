import type { LeagueConfig, RatingColumn } from '@shared/config/schema'
import type { LeagueSnapshot, PlayerRow } from '@shared/league'
import type { Team } from '@shared/setup'
import { t } from '../../i18n'

export function overallColumn(config: LeagueConfig): RatingColumn | null {
  return config.ratings.columns.find((c) => c.id === config.ratings.overallColumnId) ?? null
}

export function overallOf(player: PlayerRow, config: LeagueConfig): number | null {
  const id = config.ratings.overallColumnId
  const v = id === null ? null : player.ratings[id]
  return typeof v === 'number' ? v : null
}

/**
 * A card's name as a season shows it. Numbers restart each season, so a card
 * issued in another season (one that carried over) names that season too.
 */
export function cardName(league: LeagueSnapshot, card: { originalTeamId: string; number: number; issuedSeasonId: number }, seasonId: number): string {
  const team = league.teams.find((tm) => tm.id === card.originalTeamId)?.shortName ?? card.originalTeamId
  return t.trades.card(team, card.number, card.issuedSeasonId === seasonId ? undefined : seasonLabel(league, card.issuedSeasonId))
}

/** A season's label, or its id when the snapshot doesn't have it. */
export function seasonLabel(league: LeagueSnapshot, seasonId: number): string {
  return league.seasons.find((s) => s.id === seasonId)?.label ?? String(seasonId)
}

/** A team's players in slot order. */
export function rosterOf(league: LeagueSnapshot, teamId: string): PlayerRow[] {
  const order = new Map(league.config.roster.slots.map((s, i) => [s.id, i]))
  return league.players
    .filter((p) => p.teamId === teamId)
    .sort((a, b) => (order.get(a.slotId ?? '') ?? 99) - (order.get(b.slotId ?? '') ?? 99))
}

export function averageOverall(players: PlayerRow[], config: LeagueConfig): number | null {
  const values = players.map((p) => overallOf(p, config)).filter((v): v is number => v !== null)
  if (values.length === 0) return null
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
}

/** Lowest and highest team average overall, so team badges are coloured against each other. */
export function teamAverageRange(league: LeagueSnapshot): { lo: number; hi: number } {
  const { config } = league
  const avgs = league.teams.map((team) => averageOverall(rosterOf(league, team.id), config)).filter((v): v is number => v !== null)
  if (avgs.length > 0) return { lo: Math.min(...avgs), hi: Math.max(...avgs) }
  const overall = overallColumn(config)
  return overall?.kind === 'number' ? { lo: overall.min, hi: overall.max } : { lo: 0, hi: 99 }
}

/** Teams grouped conference → division, in config order. Divisions without a conference form one group. */
export function groupTeams(league: LeagueSnapshot): { conference: string | null; divisions: { name: string; teams: Team[] }[] }[] {
  const { conferences, divisions } = league.config.structure
  const groups = [
    ...conferences.map((c) => ({ id: c.id as string | null, name: c.name as string | null })),
    { id: null, name: null },
  ]
  return groups
    .map((g) => ({
      conference: g.name,
      divisions: divisions
        .filter((d) => d.conferenceId === g.id)
        .map((d) => ({ name: d.name, teams: league.teams.filter((t) => t.divisionId === d.id) })),
    }))
    .filter((g) => g.divisions.length > 0)
}

export const gradeLabels = (config: LeagueConfig) => config.ratings.gradeScale.map((g) => g.label)

const dateFormat = new Intl.DateTimeFormat(t.app.locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
const dateTimeFormat = new Intl.DateTimeFormat(t.app.locale, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** A stored UTC ISO timestamp as a local date (or date and time). */
export function formatDate(iso: string, withTime = false): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return (withTime ? dateTimeFormat : dateFormat).format(d)
}
