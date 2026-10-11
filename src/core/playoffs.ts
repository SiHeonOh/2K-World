import type { LeagueConfig } from '@shared/config/schema'

/**
 * Playoff brackets as data. The whole bracket is planned up front from the
 * config; teams fill in as seeds are set and series are won.
 */

export type Participant =
  | { kind: 'seed'; group: string; seed: number }
  /** `seed`: the bracket seed the winner takes (a play-in winner becomes seed 7 or 8). */
  | { kind: 'winner'; slot: string; seed?: number }
  | { kind: 'loser'; slot: string }

export interface SeriesPlan {
  /** Unique within a season, e.g. `east:r1:0`, `east:pi:a`, `finals`. */
  slot: string
  stage: 'play-in' | 'playoffs' | 'finals'
  /** 1-based within its stage. */
  round: number
  /** Conference id, or 'league' for a league-wide bracket; null for the cross-conference final. */
  group: string | null
  a: Participant
  b: Participant
  bestOf: number
}

/** Seed order for round one: 1v8, 4v5, 3v6, 2v7 — so 1 and 2 can only meet in the last round. */
export function bracketOrder(field: number): number[] {
  let order = [1]
  while (order.length < field) {
    const size = order.length * 2
    order = order.flatMap((s) => [s, size + 1 - s])
  }
  return order
}

export const winsNeeded = (bestOf: number) => Math.floor(bestOf / 2) + 1

/**
 * Home court for game `n` (1-based) of a series: the higher seed hosts games
 * 1, 2, 5 and 7 of a best-of-7 (2-2-1-1-1), games 1, 2, 5 of a best-of-5,
 * and alternates otherwise, starting at home.
 */
export function highSeedHosts(n: number, bestOf: number): boolean {
  if (bestOf >= 5) return n <= 2 || (n > 4 && (n - 5) % 2 === 0)
  return n % 2 === 1
}

/** Every series of a season's playoffs, in the order they can be played. */
export function planBracket(config: LeagueConfig): SeriesPlan[] {
  const { playoffs } = config.season
  if (!playoffs.enabled) return []
  const groups =
    playoffs.bracket === 'conference' ? config.structure.conferences.map((c) => c.id) : ['league']
  const d = playoffs.directSeeds
  const playIn = playoffs.playIn.enabled
  const field = d + (playIn ? 2 : 0)
  const rounds = Math.log2(field)
  if (!Number.isInteger(rounds) || field < 2) return []

  const plans: SeriesPlan[] = []
  for (const g of groups) {
    const seed = (s: number): Participant => ({ kind: 'seed', group: g, seed: s })
    // NBA play-in: (d+1) v (d+2) → winner is seed d+1; (d+3) v (d+4) → loser out;
    // loser of the first v winner of the second → winner is seed d+2.
    if (playIn) {
      const bo = playoffs.playIn.bestOf
      plans.push({ slot: `${g}:pi:a`, stage: 'play-in', round: 1, group: g, a: seed(d + 1), b: seed(d + 2), bestOf: bo })
      plans.push({ slot: `${g}:pi:b`, stage: 'play-in', round: 1, group: g, a: seed(d + 3), b: seed(d + 4), bestOf: bo })
      plans.push({
        slot: `${g}:pi:c`,
        stage: 'play-in',
        round: 2,
        group: g,
        a: { kind: 'loser', slot: `${g}:pi:a` },
        b: { kind: 'winner', slot: `${g}:pi:b` },
        bestOf: bo,
      })
    }
    const bracketSeed = (s: number): Participant => {
      if (playIn && s === d + 1) return { kind: 'winner', slot: `${g}:pi:a`, seed: s }
      if (playIn && s === d + 2) return { kind: 'winner', slot: `${g}:pi:c`, seed: s }
      return seed(s)
    }
    const order = bracketOrder(field)
    // A league-wide bracket's last round is the finals.
    const lastIsFinals = playoffs.bracket === 'league'
    for (let r = 1; r <= rounds; r++) {
      const count = field / 2 ** r
      const isFinals = lastIsFinals && r === rounds
      for (let i = 0; i < count; i++) {
        plans.push({
          slot: `${g}:r${r}:${i}`,
          stage: isFinals ? 'finals' : 'playoffs',
          round: r,
          group: g,
          a: r === 1 ? bracketSeed(order[2 * i]!) : { kind: 'winner', slot: `${g}:r${r - 1}:${2 * i}` },
          b: r === 1 ? bracketSeed(order[2 * i + 1]!) : { kind: 'winner', slot: `${g}:r${r - 1}:${2 * i + 1}` },
          bestOf: isFinals ? playoffs.finals.bestOf : playoffs.seriesBestOf,
        })
      }
    }
  }
  if (playoffs.bracket === 'conference' && playoffs.finals.kind === 'conference-champions' && groups.length === 2) {
    const last = (g: string) => `${g}:r${rounds}:0`
    plans.push({
      slot: 'finals',
      stage: 'finals',
      round: 1,
      group: null,
      a: { kind: 'winner', slot: last(groups[0]!) },
      b: { kind: 'winner', slot: last(groups[1]!) },
      bestOf: playoffs.finals.bestOf,
    })
  }
  return plans
}

export interface SeriesState {
  slot: string
  /** Team ids once known. */
  a: string | null
  b: string | null
  winner: string | null
  loser: string | null
}

/** Fills in participants from seeds and finished series. Pure: returns new states. */
export function resolveBracket(
  plans: readonly SeriesPlan[],
  seeds: ReadonlyMap<string, readonly string[]>,
  results: ReadonlyMap<string, { winner: string; loser: string }>,
): SeriesState[] {
  const states = new Map<string, SeriesState>()
  const resolve = (p: Participant): string | null => {
    if (p.kind === 'seed') return seeds.get(p.group)?.[p.seed - 1] ?? null
    const r = results.get(p.slot)
    if (!r) return null
    return p.kind === 'winner' ? r.winner : r.loser
  }
  for (const plan of plans) {
    const result = results.get(plan.slot)
    const a = resolve(plan.a)
    const b = resolve(plan.b)
    // A result only counts if its teams are the ones this series has.
    if (result && !(a !== null && b !== null && [a, b].includes(result.winner) && [a, b].includes(result.loser))) {
      throw new Error(`result for ${plan.slot} names teams not in the series`)
    }
    states.set(plan.slot, {
      slot: plan.slot,
      a,
      b,
      winner: result?.winner ?? null,
      loser: result?.loser ?? null,
    })
  }
  return plans.map((p) => states.get(p.slot)!)
}

/**
 * Each team's seed for home court, per group: the regular-season seed, except
 * play-in winners, who take the bracket seed they earned (7th or 8th).
 */
export function effectiveSeeds(
  plans: readonly SeriesPlan[],
  seeds: ReadonlyMap<string, readonly string[]>,
  results: ReadonlyMap<string, { winner: string; loser: string }>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const [group, teams] of seeds) out.set(group, new Map(teams.map((t, i) => [t, i + 1])))
  for (const plan of plans) {
    if (plan.group === null) continue
    for (const p of [plan.a, plan.b]) {
      if (p.kind !== 'winner' || p.seed === undefined) continue
      const r = results.get(p.slot)
      if (r) out.get(plan.group)?.set(r.winner, p.seed)
    }
  }
  return out
}

/** Teams a bracket needs from each group: direct seeds plus the play-in field. */
export function seedsNeeded(config: LeagueConfig): number {
  const { playoffs } = config.season
  return playoffs.directSeeds + (playoffs.playIn.enabled ? 4 : 0)
}
