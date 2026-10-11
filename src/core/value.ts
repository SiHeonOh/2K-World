import type { LeagueConfig } from '@shared/config/schema'
import type { RatingValue } from '@shared/setup'

/**
 * Player value from ratings, in code (the AI uses these numbers, it never
 * does the math). Each rating column counts by its weight in the config;
 * grades go through the grade scale. 0 = the worst possible, 100 = the best.
 */

type Ratings = Record<string, RatingValue>

/** One rating as 0..1, or null when it's missing or unreadable. */
function normalized(config: LeagueConfig, columnId: string, value: RatingValue | undefined): number | null {
  const col = config.ratings.columns.find((c) => c.id === columnId)
  if (!col || value === null || value === undefined || value === '') return null
  if (col.kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || col.max <= col.min) return null
    return Math.min(1, Math.max(0, (n - col.min) / (col.max - col.min)))
  }
  const scale = config.ratings.gradeScale
  const step = scale.find((g) => g.label === String(value).trim())
  if (!step) return null
  const values = scale.map((g) => g.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return hi > lo ? (step.value - lo) / (hi - lo) : null
}

export function playerValue(config: LeagueConfig, ratings: Ratings): number {
  let sum = 0
  let weights = 0
  for (const col of config.ratings.columns) {
    if (col.weight <= 0) continue
    const v = normalized(config, col.id, ratings[col.id])
    if (v === null) continue
    sum += v * col.weight
    weights += col.weight
  }
  if (weights > 0) return Math.round((sum / weights) * 1000) / 10
  // No weighted columns: fall back to the headline rating, else the middle.
  const overall = config.ratings.overallColumnId
  const v = overall ? normalized(config, overall, ratings[overall]) : null
  return v === null ? 50 : Math.round(v * 1000) / 10
}

export interface ValuedPlayer {
  id: string
  teamId: string
  slotId: string | null
  value: number
}

/** A team's players, best first (ties by id, so the order is stable). */
export function peckingOrder(players: ValuedPlayer[]): ValuedPlayer[] {
  return [...players].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
}

/** Team strength: the starters count fully, the bench a quarter. */
export function teamStrength(config: LeagueConfig, players: ValuedPlayer[]): number {
  const starters = config.roster.slots.filter((s) => s.starter).length || 5
  const order = peckingOrder(players)
  const top = order.slice(0, starters)
  const bench = order.slice(starters)
  const total = top.reduce((s, p) => s + p.value, 0) + bench.reduce((s, p) => s + p.value * 0.25, 0)
  const weight = top.length + bench.length * 0.25
  return weight > 0 ? Math.round((total / weight) * 10) / 10 : 0
}

/**
 * The share of the team's shots each player expects: the better he is, the
 * more (value squared), then scaled by his appetite for the ball (usage
 * trait 1..5, 3 = neutral). Shares sum to 1.
 */
export function expectedShares(players: { id: string; value: number; usage: number }[]): Map<string, number> {
  const raw = players.map((p) => ({ id: p.id, w: Math.max(1, p.value) ** 2 * (0.7 + 0.1 * p.usage) }))
  const total = raw.reduce((s, p) => s + p.w, 0)
  return new Map(raw.map((p) => [p.id, total > 0 ? p.w / total : 0]))
}

/** Possessions a player used in a line: FGA + 0.44 × FTA + TO. */
export function possessions(stats: Record<string, number>, ids: { fga?: string; fta?: string; to?: string }): number {
  const n = (id?: string) => (id ? (stats[id] ?? 0) : 0)
  return n(ids.fga) + 0.44 * n(ids.fta) + n(ids.to)
}
