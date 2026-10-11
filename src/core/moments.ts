/**
 * Standings moments worth a forum post: clinching a place, being eliminated,
 * a new #1, and long streaks. Pure: the caller passes the table and each
 * team's results, and remembers which moments it already announced.
 *
 * Clinching and elimination are worked out conservatively, so later results
 * never undo a moment (a score corrected afterwards can, and nothing takes
 * an announcement back):
 * - a team has clinched the top k when at most k−1 rivals can still reach
 *   its current win total (ties count against it, so tiebreakers can't
 *   change the answer);
 * - a team is out of the top k when at least k rivals already have more
 *   wins than it can still reach.
 * Games between the rivals themselves would sometimes settle it earlier;
 * the moment then just comes a little later.
 */

export interface MomentTeam {
  teamId: string
  /** The seeding group: a conference id, or one group for a league-wide bracket. */
  group: string
  wins: number
  losses: number
  /** Regular-season games still to play (built or not). */
  left: number
  /** Results in schedule order, true for a win, and the game each came from. */
  results: readonly boolean[]
  gameIds: readonly number[]
  /**
   * False while a game from before its latest result is still unplayed: the
   * order isn't final, so a streak could still be broken behind it.
   */
  settled: boolean
}

export type Moment =
  | { kind: 'clinch'; teamId: string; place: 'top' | 'direct' | 'field' }
  | { kind: 'eliminated'; teamId: string }
  /** `length` is the milestone reached; `runStart` the run's first game. */
  | { kind: 'streak'; teamId: string; won: boolean; length: number; runStart: number }
  | { kind: 'streak-snapped'; teamId: string; won: boolean; length: number; runStart: number }

/** Where a team stands in its group's race, for places `top` (1st), `direct` (straight in) and `field` (with the play-in). */
export function playoffPicture(teams: readonly MomentTeam[], direct: number, field: number): Map<string, { top: boolean; direct: boolean; field: boolean; out: boolean }> {
  const out = new Map<string, { top: boolean; direct: boolean; field: boolean; out: boolean }>()
  for (const t of teams) {
    const rivals = teams.filter((x) => x.group === t.group && x.teamId !== t.teamId)
    // Rivals that could still finish level with or above it, and rivals already sure to finish above it.
    const couldReach = rivals.filter((x) => x.wins + x.left >= t.wins).length
    const surelyAbove = rivals.filter((x) => x.wins > t.wins + t.left).length
    const size = rivals.length + 1
    // A place every team in the group gets anyway is no news.
    const clinched = (k: number) => k > 0 && k < size && couldReach <= k - 1
    out.set(t.teamId, {
      top: clinched(1),
      direct: clinched(direct),
      field: clinched(field),
      out: field > 0 && field < size && surelyAbove >= field,
    })
  }
  return out
}

export interface Run {
  won: boolean
  length: number
  /** Index in the results where the run began. */
  start: number
}

/** The run a team is on now, and the one before it (null when there's none). */
export function runs(results: readonly boolean[]): { current: Run | null; previous: Run | null } {
  const runAt = (end: number): Run | null => {
    if (end < 0) return null
    const won = results[end]!
    let start = end
    while (start > 0 && results[start - 1] === won) start--
    return { won, length: end - start + 1, start }
  }
  const current = runAt(results.length - 1)
  return { current, previous: current ? runAt(current.start - 1) : null }
}

/** The streak lengths worth a post: 5, 7, 10, then every 5. */
export const streakMilestone = (n: number) => n === 5 || n === 7 || (n >= 10 && n % 5 === 0)

/** The biggest milestone a run of `n` has reached (0 for none): a run that skipped past one still gets it told. */
export function milestoneReached(n: number): number {
  for (let m = n; m >= 5; m--) if (streakMilestone(m)) return m
  return 0
}

/** A snapped run is news while the team has played at most this many games since. */
const SNAP_FRESH = 2

/**
 * Every moment true of the table now. The caller announces only the ones it
 * hasn't before: clinches and eliminations once a season, a streak once per
 * milestone of a run, and a snapped run once.
 */
export function currentMoments(teams: readonly MomentTeam[], direct: number, field: number): Moment[] {
  const picture = playoffPicture(teams, direct, field)
  const out: Moment[] = []
  for (const t of teams) {
    const p = picture.get(t.teamId)!
    // The best place clinched is the one worth saying; the lesser ones go unsaid once it's there.
    if (p.top) out.push({ kind: 'clinch', teamId: t.teamId, place: 'top' })
    else if (p.direct) out.push({ kind: 'clinch', teamId: t.teamId, place: 'direct' })
    else if (p.field && field > direct) out.push({ kind: 'clinch', teamId: t.teamId, place: 'field' })
    if (p.out) out.push({ kind: 'eliminated', teamId: t.teamId })
    if (!t.settled) continue
    const { current, previous } = runs(t.results)
    if (!current) continue
    const reached = milestoneReached(current.length)
    if (reached > 0) out.push({ kind: 'streak', teamId: t.teamId, won: current.won, length: reached, runStart: t.gameIds[current.start]! })
    if (previous && previous.length >= 5 && current.length <= SNAP_FRESH) {
      out.push({ kind: 'streak-snapped', teamId: t.teamId, won: previous.won, length: previous.length, runStart: t.gameIds[previous.start]! })
    }
  }
  return out
}

/**
 * Whether a team is alone at #1 no matter how the games others have in hand
 * go: its wins beat every rival's wins plus the games that rival has yet to
 * play to catch up on games played. Entry order within a round can't make
 * a leader, then.
 */
export function aloneAtTop(leader: { wins: number; games: number }, rivals: readonly { wins: number; games: number }[]): boolean {
  return rivals.every((x) => leader.wins > x.wins + Math.max(0, leader.games - x.games))
}
