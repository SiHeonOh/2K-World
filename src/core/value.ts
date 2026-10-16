import { DEFAULT_VALUE_MODEL, type LeagueConfig, type ValueModel } from '@shared/config/schema'
import type { RatingValue } from '@shared/setup'

/**
 * Player value from ratings, in code (the AI uses these numbers, it never
 * does the math). 0 = the worst possible, 100 = the best.
 *
 * A league with a headline rating (2K's OVR) is valued by it first: OVR's
 * share (55% unless 리그 설정 says otherwise), and the rest from the
 * player's best few other ratings (his best 6 of them), each counting by its
 * weight. So a specialist is valued by what he's good at: a point guard isn't
 * marked down for rebounding, nor a center for shooting. A league without
 * one (or a player missing it) averages every rating column by its weight.
 * Grades go through the grade scale.
 */

type Ratings = Record<string, RatingValue>

export { DEFAULT_VALUE_MODEL }

/** The league's value model: its own settings over the defaults. */
export function valueModelOf(config: Pick<LeagueConfig, 'ratings'>): ValueModel {
  return { ...DEFAULT_VALUE_MODEL, ...config.ratings.valueModel }
}

/** The headline rating's column when value is led by it (it exists and isn't display only), else null. */
export function overallLed(config: Pick<LeagueConfig, 'ratings'>): string | null {
  const id = config.ratings.overallColumnId
  const col = id ? config.ratings.columns.find((c) => c.id === id) : undefined
  return col && col.weight > 0 ? col.id : null
}

/** One rating as 0..1, or null when it's missing or unreadable. */
export function normalized(config: Pick<LeagueConfig, 'ratings'>, columnId: string, value: RatingValue | undefined): number | null {
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
  const overall = overallLed(config)
  const o = overall ? normalized(config, overall, ratings[overall]) : null
  if (overall && o !== null) {
    const { overallShare, topCategories } = valueModelOf(config)
    const rated: { v: number; w: number }[] = []
    for (const col of config.ratings.columns) {
      if (col.id === overall || col.weight <= 0) continue
      const v = normalized(config, col.id, ratings[col.id])
      if (v !== null) rated.push({ v, w: col.weight })
    }
    // His best ratings (a heavier one first on a tie), each by its weight; none known: OVR alone.
    const best = rated.sort((a, b) => b.v - a.v || b.w - a.w).slice(0, topCategories)
    const weights = best.reduce((s, c) => s + c.w, 0)
    const rest = weights > 0 ? best.reduce((s, c) => s + c.v * c.w, 0) / weights : o
    return Math.round((overallShare * o + (1 - overallShare) * rest) * 1000) / 10
  }
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
  const headline = config.ratings.overallColumnId
  const v = headline ? normalized(config, headline, ratings[headline]) : null
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
 * How sharply shots follow value (expectedShares). OVR-led values sit closer
 * together than an average of every rating, so they're raised higher to give
 * the same spread: the user's league's box scores (a star near 28% of his
 * team's possessions, a sixth man near 6%) fit value⁴ best there.
 */
export function shareSharpness(config: Pick<LeagueConfig, 'ratings'>): number {
  return overallLed(config) ? 4 : 2
}

/**
 * The share of the team's shots each player expects: the better he is, the
 * more (value raised to `sharpness`, see shareSharpness), then scaled by his
 * appetite for the ball (usage trait 1..5, 3 = neutral). Shares sum to 1.
 */
export function expectedShares(players: { id: string; value: number; usage: number }[], sharpness = 2): Map<string, number> {
  const raw = players.map((p) => ({ id: p.id, w: Math.max(1, p.value) ** sharpness * (0.7 + 0.1 * p.usage) }))
  const total = raw.reduce((s, p) => s + p.w, 0)
  return new Map(raw.map((p) => [p.id, total > 0 ? p.w / total : 0]))
}

/** Possessions a player used in a line: FGA + 0.44 × FTA + TO. */
export function possessions(stats: Record<string, number>, ids: { fga?: string; fta?: string; to?: string }): number {
  const n = (id?: string) => (id ? (stats[id] ?? 0) : 0)
  return n(ids.fga) + 0.44 * n(ids.fta) + n(ids.to)
}
