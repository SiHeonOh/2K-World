import type { GameStage } from './season'

/**
 * How a 2K name was matched to a player. 'same-name' is a learned match for a
 * 2K name that more than one player on the team goes by: row order picked
 * one, and row order can change between games, so it needs a look. 'exact'
 * is a roster name written just as 2K shows it.
 */
export type MatchHow = 'learned' | 'same-name' | 'exact' | 'guess' | 'elimination' | 'none'

export interface ReadRow {
  /** 0-based row in that team's box score. */
  row: number
  /** The name as 2K shows it, e.g. "H. Hu". */
  source: string
  /** Keyed by the league's stat column ids. */
  stats: Record<string, number>
  playerId: string | null
  how: MatchHow
  /** Other plausible players, best first. */
  candidates: string[]
}

export interface ReadTeam {
  teamId: string
  /** Which of the read teams this is (0 or 1, in the order Claude returned them), so edits survive a side swap. */
  readIndex: number
  /** The team name as the screenshot shows it. */
  label: string
  rows: ReadRow[]
  /** Sum of the rows' points. */
  score: number
  /**
   * The team's points as the screenshot showed them (a totals row or the
   * scoreboard), or null when it showed none (or an older read didn't say).
   * A cropped screenshot can drop rows, so this beats the rows' sum.
   */
  shown: number | null
}

/** Why a read can't be recorded as it is: only one team, or the same team twice. */
export type ReadProblem = 'one-team' | 'same-team'

/** What the confirm screen checks before saving, on the numbers as they stand. */
export type ConfirmIssue =
  | { code: 'line-points'; teamId: string; row: number; source: string; points: number; expected: number }
  | { code: 'made-over-attempts'; teamId: string; row: number; source: string; column: string }
  /** The screenshot's own total isn't what its rows add up to (a row cut off or misread). */
  | { code: 'shown-total'; teamId: string; rows: number; shown: number }
  /** The final score isn't what the side's rows add up to. */
  | { code: 'final-vs-rows'; teamId: string; rows: number; score: number }
  /** By the rows' sums the other team won: the final score and the rows tell different stories. */
  | { code: 'winner-differs'; winner: string; rows: { home: number; away: number } }

/** Another game the same screenshots were read for. */
export interface GameRef {
  id: number
  stage: GameStage
  round: number
  home: string
  away: string
  /** 'final': the screenshots are that game's box score, and can't be another's. */
  status: 'scheduled' | 'final'
}

/** What the confirm screen shows after Claude reads a game's screenshots. */
export interface ConfirmView {
  gameId: number
  jobId: number
  home: ReadTeam
  away: ReadTeam
  /** True when the read teams were matched to home/away with little to go on. */
  sidesUncertain: boolean
  /** Set when the read can't be recorded; the screenshots need another look. */
  problem: ReadProblem | null
  /** The checks on the numbers as read, with the suggested final score (the screen reruns them as you edit). */
  issues: ConfirmIssue[]
  /** Other games these same screenshots were read for (by their bytes). A final one blocks saving. */
  usedFor: GameRef[]
  /** Teams with moves still to make in 2K: the game can't be recorded until they're ticked off. */
  waiting2k: string[]
  /** How many screenshots were read (the screen fetches them to show beside the tables). */
  images: number
  /** Anything Claude flagged as unreadable. */
  notes: string
}

export interface ConfirmInput {
  /** The read_box_score job this confirms; it must be done and be for this game. */
  jobId: number
  gameId: number
  homeScore: number
  awayScore: number
  lines: { playerId: string; teamId: string; stats: Record<string, number> }[]
  /** Confirmed matches to remember for next time. */
  names: { teamId: string; source: string; playerId: string; row: number }[]
}

export interface JobInfo {
  id: number
  kind: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  errorKind: string | null
  attempts: number
  /** The game a read_box_score job is for. */
  gameId: number | null
  createdAt: string
}
