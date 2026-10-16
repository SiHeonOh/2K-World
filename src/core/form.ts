/**
 * Season form: how a player's production this season compares with what his
 * value predicts, as a small nudge (up to ±3 points) to the value the GMs
 * trade on. Production is his points a game and, when shots are tracked, his
 * efficiency (true shooting: points / 2 × (FGA + 0.44 × FTA), counting for
 * more the more he shoots). What his value predicts is the league's own line
 * of points a game against value, fitted over every player with FORM_GAMES
 * games or more. Only production clearly off that line moves him. Pure.
 */

export const FORM_GAMES = 5
export const FORM_MAX = 3
/** Players the line needs before it says anything. */
const FIT_MIN = 8
/** Within this many typical misses of the line, form is just noise. */
const BAND = 0.5

export interface FormInput {
  games: number
  points: number
  /** FGA + 0.44 × FTA over those games; null when shots aren't tracked. */
  shots: number | null
}

export interface Form {
  games: number
  /** Points a game, and true shooting (0..1; null without shots). */
  ppg: number
  ts: number | null
  /** Points a game his value predicts. */
  expected: number
  /** The nudge to his value, −FORM_MAX..FORM_MAX (0 inside the band). */
  delta: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
const spread = (xs: number[]) => {
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1))
}

export function seasonForms(lines: ReadonlyMap<string, FormInput>, values: ReadonlyMap<string, number>): Map<string, Form> {
  const rows = [...lines].flatMap(([id, l]) =>
    l.games >= FORM_GAMES && values.has(id)
      ? [{ id, games: l.games, value: values.get(id)!, ppg: l.points / l.games, ts: l.shots && l.shots > 0 ? l.points / (2 * l.shots) : null, volume: (l.shots ?? 0) / l.games }]
      : [],
  )
  const out = new Map<string, Form>()
  if (rows.length < FIT_MIN) return out
  // Points a game against value: the least-squares line.
  const mv = mean(rows.map((r) => r.value))
  const mp = mean(rows.map((r) => r.ppg))
  const sxx = rows.reduce((s, r) => s + (r.value - mv) ** 2, 0)
  const slope = sxx > 0 ? rows.reduce((s, r) => s + (r.value - mv) * (r.ppg - mp), 0) / sxx : 0
  const line = (v: number) => mp + slope * (v - mv)
  const miss = Math.max(2, spread(rows.map((r) => r.ppg - line(r.value))))
  const shooting = rows.flatMap((r) => (r.ts === null ? [] : [r.ts]))
  const tsMean = mean(shooting)
  const tsSpread = Math.max(0.03, spread(shooting))
  for (const r of rows) {
    const points = (r.ppg - line(r.value)) / miss
    const efficiency = r.ts === null ? 0 : ((r.ts - tsMean) / tsSpread) * Math.min(1, r.volume / 10)
    const z = points + 0.5 * efficiency
    const delta = Math.sign(z) * Math.min(FORM_MAX, Math.max(0, Math.abs(z) - BAND) * 2)
    out.set(r.id, {
      games: r.games,
      ppg: Math.round(r.ppg * 10) / 10,
      ts: r.ts === null ? null : Math.round(r.ts * 1000) / 1000,
      expected: Math.round(line(r.value) * 10) / 10,
      delta: Math.round(delta * 10) / 10,
    })
  }
  return out
}
