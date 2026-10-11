import type { LeagueConfig, StatMeaning } from '@shared/config/schema'
import type { BoxIssue, LeaderBoard } from '@shared/season'
import { columnFor } from '@shared/boxcheck'

export type { BoxIssue, LeaderBoard }
// The box-score checks are pure and shared with the confirm screen, which runs them before saving.
export { checkBoxScore, columnFor, expectedPoints } from '@shared/boxcheck'

/** One player's line in one game; stats keyed by stat column id. */
export interface BoxLine {
  gameId: number
  playerId: string
  teamId: string
  stats: Record<string, number>
}

export interface PlayerTotals {
  playerId: string
  /** The team of his most recent line. */
  teamId: string
  games: number
  totals: Record<string, number>
}

/**
 * Sums each player's lines. `lines` come in the order the season was played
 * (seasonBoxLines gives it), so his team is the one on his last line; game
 * ids can't stand in for that order, as rounds built by hand don't follow them.
 */
export function seasonTotals(lines: readonly BoxLine[]): Map<string, PlayerTotals> {
  const out = new Map<string, PlayerTotals>()
  for (const line of lines) {
    const t = out.get(line.playerId) ?? { playerId: line.playerId, teamId: line.teamId, games: 0, totals: {} }
    t.teamId = line.teamId
    t.games++
    for (const [k, v] of Object.entries(line.stats)) t.totals[k] = (t.totals[k] ?? 0) + v
    out.set(line.playerId, t)
  }
  return out
}

/**
 * League leaders: per-game averages for leader columns, and shooting
 * percentages when made/attempted columns exist. A player needs `minGames`
 * games (and some attempts for percentages) to qualify.
 */
export function leaders(config: LeagueConfig, totals: Map<string, PlayerTotals>, minGames: number, top = 10): LeaderBoard[] {
  const all = [...totals.values()].filter((t) => t.games >= minGames)
  const boards: LeaderBoard[] = []
  const byValue = (rows: LeaderBoard['rows']) => rows.sort((a, b) => b.value - a.value || a.playerId.localeCompare(b.playerId)).slice(0, top)
  for (const col of config.stats.columns.filter((c) => c.leader)) {
    boards.push({
      key: col.id,
      label: col.name,
      kind: 'per-game',
      rows: byValue(
        all.map((t) => ({ playerId: t.playerId, teamId: t.teamId, games: t.games, value: (t.totals[col.id] ?? 0) / t.games })),
      ),
    })
  }
  const pct: [string, StatMeaning, StatMeaning, number][] = [
    ['FG%', 'fgm', 'fga', 3],
    ['3P%', 'tpm', 'tpa', 1],
    ['FT%', 'ftm', 'fta', 1],
  ]
  for (const [label, made, att, perGame] of pct) {
    const m = columnFor(config, made)
    const a = columnFor(config, att)
    if (m === null || a === null) continue
    boards.push({
      key: label.toLowerCase(),
      label,
      kind: 'percent',
      rows: byValue(
        all
          .filter((t) => (t.totals[a] ?? 0) >= perGame * t.games)
          .map((t) => ({ playerId: t.playerId, teamId: t.teamId, games: t.games, value: (t.totals[m] ?? 0) / (t.totals[a] ?? 1) })),
      ),
    })
  }
  return boards
}
