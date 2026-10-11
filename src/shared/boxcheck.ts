import type { LeagueConfig, StatMeaning } from './config/schema'
import type { ConfirmIssue } from './gameday'
import type { BoxIssue } from './season'

/**
 * Box-score self-checks. Pure, so the League engine (core/stats re-exports
 * them) and the confirm screen run the very same checks: the screen before
 * saving, on the numbers as you edit them.
 */

/** Column id for a meaning, if the league tracks it. */
export function columnFor(config: LeagueConfig, meaning: StatMeaning): string | null {
  return config.stats.columns.find((c) => c.meaning === meaning)?.id ?? null
}

/**
 * PTS = 2×FGM + 3PM + FTM. Returns the points the shooting lines add up to,
 * or null when the league doesn't track all four columns. A mismatch usually
 * means a misread or mistyped number.
 */
export function expectedPoints(config: LeagueConfig, stats: Record<string, number>): number | null {
  const fgm = columnFor(config, 'fgm')
  const tpm = columnFor(config, 'tpm')
  const ftm = columnFor(config, 'ftm')
  if (fgm === null || tpm === null || ftm === null) return null
  return 2 * (stats[fgm] ?? 0) + (stats[tpm] ?? 0) + (stats[ftm] ?? 0)
}

const SHOT_PAIRS: [StatMeaning, StatMeaning][] = [
  ['fgm', 'fga'],
  ['tpm', 'tpa'],
  ['ftm', 'fta'],
]

/** One line's own problems: points that don't add up, more made than tried. */
function lineIssues(config: LeagueConfig, stats: Record<string, number>): ({ code: 'line-points'; points: number; expected: number } | { code: 'made-over-attempts'; column: string })[] {
  const out: ({ code: 'line-points'; points: number; expected: number } | { code: 'made-over-attempts'; column: string })[] = []
  const pts = columnFor(config, 'points')
  const expected = expectedPoints(config, stats)
  const points = pts === null ? null : (stats[pts] ?? 0)
  if (expected !== null && points !== null && expected !== points) out.push({ code: 'line-points', points, expected })
  for (const [made, att] of SHOT_PAIRS) {
    const m = columnFor(config, made)
    const a = columnFor(config, att)
    if (m !== null && a !== null && (stats[m] ?? 0) > (stats[a] ?? 0)) out.push({ code: 'made-over-attempts', column: m })
  }
  return out
}

/** Self-checks for a game's box score against its final score. */
export function checkBoxScore(
  config: LeagueConfig,
  lines: readonly { playerId: string; teamId: string; stats: Record<string, number> }[],
  scores: ReadonlyMap<string, number>,
): BoxIssue[] {
  const issues: BoxIssue[] = []
  const pts = columnFor(config, 'points')
  for (const line of lines) for (const i of lineIssues(config, line.stats)) issues.push({ ...i, playerId: line.playerId })
  if (pts !== null) {
    for (const [teamId, score] of scores) {
      const teamLines = lines.filter((l) => l.teamId === teamId)
      if (teamLines.length === 0) continue
      const points = teamLines.reduce((sum, l) => sum + (l.stats[pts] ?? 0), 0)
      if (points !== score) issues.push({ code: 'team-points', teamId, points, score })
    }
  }
  return issues
}

// ── The confirm screen ───────────────────────────────────────────────────

/** One side as the confirm screen has it: its read rows (as edited) and the total its screenshot showed, if any. */
export interface ConfirmSide {
  teamId: string
  rows: readonly { source: string; stats: Record<string, number> }[]
  /** The team's points as the screenshot showed them (a totals row or the scoreboard); null when it didn't. */
  shown: number | null
}

/** The sum of the rows' points (0 when the league tracks no points). */
export function rowsPoints(config: LeagueConfig, rows: ConfirmSide['rows']): number {
  const pts = columnFor(config, 'points')
  return pts === null ? 0 : rows.reduce((sum, r) => sum + (r.stats[pts] ?? 0), 0)
}

/**
 * The final score to suggest for a side: what the screenshot showed, else
 * the rows' sum. A cropped screenshot can drop bench rows, so a shown total
 * is worth more than the sum.
 */
export function suggestedScore(config: LeagueConfig, side: ConfirmSide): number {
  return side.shown ?? rowsPoints(config, side.rows)
}

/**
 * Everything worth a look before saving: each row's own checks, a
 * screenshot total that the rows don't reach, a final score the rows don't
 * add up to, and above all rows that would make the other team the winner.
 */
export function confirmIssues(config: LeagueConfig, home: ConfirmSide, away: ConfirmSide, final: { home: number; away: number }): ConfirmIssue[] {
  const out: ConfirmIssue[] = []
  const tracksPoints = columnFor(config, 'points') !== null
  for (const side of [home, away]) {
    side.rows.forEach((r, row) => {
      for (const i of lineIssues(config, r.stats)) out.push({ ...i, teamId: side.teamId, row, source: r.source })
    })
  }
  if (!tracksPoints) return out
  const sums = { home: rowsPoints(config, home.rows), away: rowsPoints(config, away.rows) }
  for (const [side, key] of [
    [home, 'home'],
    [away, 'away'],
  ] as const) {
    const rows = sums[key]
    if (side.shown !== null && side.shown !== rows) out.push({ code: 'shown-total', teamId: side.teamId, rows, shown: side.shown })
    if (final[key] !== rows) out.push({ code: 'final-vs-rows', teamId: side.teamId, rows, score: final[key] })
  }
  const byFinal = Math.sign(final.home - final.away)
  const byRows = Math.sign(sums.home - sums.away)
  if (byFinal !== 0 && byRows !== byFinal) out.push({ code: 'winner-differs', winner: byFinal > 0 ? home.teamId : away.teamId, rows: sums })
  return out
}
