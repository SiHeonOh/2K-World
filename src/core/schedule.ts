import type { LeagueConfig } from '@shared/config/schema'
import { rng, shuffle } from './random'

export interface ScheduledGame {
  /** 1-based. Every team plays at most once per round. */
  round: number
  home: string
  away: string
}

/**
 * One full round robin by the circle method: n−1 rounds (n rounds when n is
 * odd, with one team resting each round). Venues follow Berger's rule: the
 * fixed team alternates, and in pair i the left team hosts when i is odd.
 * Each team then alternates home and away except once, at its game against
 * the fixed team, so runs stay at two and home/away counts within one.
 */
export function roundRobin(teamIds: readonly string[]): [string, string][][] {
  if (teamIds.length < 2) return []
  // With an odd count the bye is the fixed slot: whoever would meet it rests,
  // which is exactly where the one home/away break would have been.
  const ids: (string | null)[] = teamIds.length % 2 === 1 ? [null, ...teamIds] : [...teamIds]
  const n = ids.length
  const rounds: [string, string][][] = []
  let order = ids
  for (let r = 0; r < n - 1; r++) {
    const games: [string, string][] = []
    for (let i = 0; i < n / 2; i++) {
      const a = order[i]!
      const b = order[n - 1 - i]!
      if (a === null || b === null) continue
      const leftHosts = i === 0 ? r % 2 === 0 : i % 2 === 1
      games.push(leftHosts ? [a, b] : [b, a])
    }
    rounds.push(games)
    // Rotate everything but the first slot.
    order = [order[0]!, order[n - 1]!, ...order.slice(1, n - 1)]
  }
  return rounds
}

/**
 * The season schedule from the league config. Team order is shuffled with
 * `seed`, so two leagues with the same teams get different schedules but the
 * same league always gets the same one. Repeated cycles mirror the first
 * (each pair meets once at each venue).
 */
export function buildSchedule(config: LeagueConfig, teamIds: readonly string[], seed: string): ScheduledGame[] {
  const order = shuffle(teamIds, rng(`schedule:${seed}`))
  const base = roundRobin(order)
  if (base.length === 0) return []
  const out: ScheduledGame[] = []
  const { schedule } = config.season
  const venue = (pair: [string, string], cycle: number) => (cycle % 2 === 1 ? { home: pair[1], away: pair[0] } : { home: pair[0], away: pair[1] })
  if (schedule.kind === 'round-robin') {
    for (let cycle = 0; cycle < schedule.cycles; cycle++) {
      base.forEach((games, r) => {
        for (const pair of games) out.push({ round: cycle * base.length + r + 1, ...venue(pair, cycle) })
      })
    }
    return out
  }
  // Custom game count: walk round-robin rounds until each team has its games.
  // With an odd team count some teams rest, so a few may end one game short.
  const target = schedule.gamesPerTeam
  const played = new Map(teamIds.map((id) => [id, 0]))
  for (let r = 0; out.length < (target * teamIds.length) / 2; r++) {
    let added = 0
    for (const pair of base[r % base.length]!) {
      const [a, b] = pair
      if ((played.get(a) ?? 0) >= target || (played.get(b) ?? 0) >= target) continue
      out.push({ round: r + 1, ...venue(pair, Math.floor(r / base.length)) })
      played.set(a, (played.get(a) ?? 0) + 1)
      played.set(b, (played.get(b) ?? 0) + 1)
      added++
    }
    if (added === 0 && r > base.length * (target + 1)) break
  }
  return out
}

// ── Rounds built by hand ─────────────────────────────────────────────────

/**
 * A round robin's shape: how many rounds, how many games fill a round (with
 * an odd count one team rests each round), and how often each pair meets.
 */
export interface RoundRobinShape {
  teams: number
  rounds: number
  perRound: number
  meetings: number
}

export function roundRobinShape(teamCount: number, cycles: number): RoundRobinShape {
  const vertices = teamCount % 2 === 0 ? teamCount : teamCount + 1
  return { teams: teamCount, rounds: cycles * (vertices - 1), perRound: Math.floor(teamCount / 2), meetings: cycles }
}

/** The league's round-robin shape, or null for a custom game count (no fixed rounds). */
export function scheduleShape(config: LeagueConfig, teamCount: number): RoundRobinShape | null {
  const { schedule } = config.season
  return schedule.kind === 'round-robin' && teamCount >= 2 ? roundRobinShape(teamCount, schedule.cycles) : null
}

/** What's wrong with a set of games for a round robin: a team twice in a round, a pair met too often, a round out of range. */
export type ScheduleProblem =
  | { code: 'round-out-of-range'; round: number }
  | { code: 'same-team'; round: number; team: string }
  | { code: 'twice-in-round'; round: number; team: string }
  | { code: 'too-many-meetings'; a: string; b: string }
  | { code: 'unknown-team'; team: string }

export function scheduleProblems(teamIds: readonly string[], shape: RoundRobinShape, games: readonly ScheduledGame[]): ScheduleProblem[] {
  const known = new Set(teamIds)
  const out: ScheduleProblem[] = []
  const seen = new Set<string>()
  const met = new Map<string, number>()
  for (const g of games) {
    if (!Number.isInteger(g.round) || g.round < 1 || g.round > shape.rounds) out.push({ code: 'round-out-of-range', round: g.round })
    for (const t of [g.home, g.away]) if (!known.has(t)) out.push({ code: 'unknown-team', team: t })
    if (g.home === g.away) {
      out.push({ code: 'same-team', round: g.round, team: g.home })
      continue
    }
    for (const t of [g.home, g.away]) {
      const key = `${g.round}:${t}`
      if (seen.has(key)) out.push({ code: 'twice-in-round', round: g.round, team: t })
      seen.add(key)
    }
    const pair = g.home < g.away ? `${g.home}|${g.away}` : `${g.away}|${g.home}`
    const n = (met.get(pair) ?? 0) + 1
    met.set(pair, n)
    if (n === shape.meetings + 1) {
      const [a, b] = pair.split('|') as [string, string]
      out.push({ code: 'too-many-meetings', a, b })
    }
  }
  return out
}

export type Completion = { ok: true; games: ScheduledGame[] } | { ok: false; reason: 'impossible' | 'too-hard' }

/**
 * The rest of a round robin, given the games already in it (played or not):
 * every round filled so each team plays once (or, with an odd count, rests
 * once per cycle), and each pair meets exactly `meetings` times. Building
 * rounds by hand can paint a season into a corner, so every change is
 * checked here: 'impossible' means no completion exists; 'too-hard' means
 * the search gave up (never seen in practice for 36 teams, but bounded).
 *
 * The search is depth-first on the most constrained choice: a team's free
 * slot in some round with the fewest possible opponents, or a pair whose
 * remaining meetings have the fewest rounds left to go in. It keeps its own
 * stack (one level per game placed, thousands for a long season), and its
 * node budget grows with the games left. Seeded restarts shuffle the tie
 * order. Venues for the new games give a pair's meetings to alternating
 * schools, balance each team's home games, and avoid a third straight home
 * or away game where they can.
 */
export function completeRoundRobin(
  teamIds: readonly string[],
  shape: RoundRobinShape,
  games: readonly ScheduledGame[],
  seed: string,
  opts: { budget?: number; restarts?: number } = {},
): Completion {
  if (scheduleProblems(teamIds, shape, games).length > 0) return { ok: false, reason: 'impossible' }
  const n = teamIds.length
  // An odd league gets a rest "team": meeting it is a round off.
  const N = n % 2 === 0 ? n : n + 1
  const R = shape.rounds
  const index = new Map(teamIds.map((t, i) => [t, i]))
  const owed = Array.from({ length: N }, (_, i) => new Int16Array(N).fill(shape.meetings).fill(0, i, i + 1))
  const fixed = Array.from({ length: R }, () => new Int16Array(N).fill(-1))
  for (const g of games) {
    const a = index.get(g.home)!
    const b = index.get(g.away)!
    fixed[g.round - 1]![a] = b
    fixed[g.round - 1]![b] = a
    owed[a]![b]!--
    owed[b]![a]!--
  }
  // Each game placed is one node (an odd league also spends one per round on its rest); a search that
  // never backtracks needs about one per game left.
  const budget = Math.max(opts.budget ?? 20_000, 4 * (shape.rounds * shape.perRound - games.length))
  const random = rng(`complete:${seed}`)
  for (let attempt = 0; attempt < (opts.restarts ?? 3); attempt++) {
    const partner = fixed.map((p) => Int16Array.from(p))
    const left = owed.map((row) => Int16Array.from(row))
    // Kept up to date as games are placed, so each step looks at counts instead of recounting:
    // options[r][v]: opponents v could still meet in round r (for v free in r);
    // shared[i][j]: rounds where both i and j are still free.
    const free = (r: number, v: number) => partner[r]![v] === -1
    const countOptions = (r: number, v: number) => {
      let c = 0
      for (let u = 0; u < N; u++) if (u !== v && free(r, u) && left[v]![u]! > 0) c++
      return c
    }
    const options = Array.from({ length: R }, (_, r) => Int16Array.from({ length: N }, (_, v) => (free(r, v) ? countOptions(r, v) : 0)))
    const shared = Array.from({ length: N }, (_, i) =>
      Int16Array.from({ length: N }, (_, j) => {
        let c = 0
        if (i !== j) for (let r = 0; r < R; r++) if (free(r, i) && free(r, j)) c++
        return c
      }),
    )
    let nodes = 0
    const pick = (): { kind: 'slot'; r: number; v: number } | { kind: 'pair'; i: number; j: number } | 'done' | 'dead' => {
      let best: { kind: 'slot'; r: number; v: number } | { kind: 'pair'; i: number; j: number } | null = null
      let bestCount = Infinity
      for (let r = 0; r < R; r++) {
        const p = partner[r]!
        const o = options[r]!
        for (let v = 0; v < N; v++) {
          if (p[v] !== -1) continue
          const c = o[v]!
          if (c === 0) return 'dead'
          if (c < bestCount) {
            bestCount = c
            best = { kind: 'slot', r, v }
          }
        }
      }
      if (!best) return 'done'
      if (bestCount === 1) return best
      for (let i = 0; i < N; i++) {
        const row = left[i]!
        const sharedRow = shared[i]!
        for (let j = i + 1; j < N; j++) {
          const need = row[j]!
          if (need === 0) continue
          const rounds = sharedRow[j]!
          if (rounds < need) return 'dead'
          if (rounds - need + 1 < bestCount) {
            bestCount = rounds - need + 1
            best = { kind: 'pair', i, j }
          }
        }
      }
      return best
    }
    type Move = [number, number, number]
    /** Places game a–b in round r (or takes it back), keeping `options` and `shared` up to date. */
    const place = ([r, a, b]: Move, on: boolean) => {
      const step = on ? -1 : 1
      const o = options[r]!
      if (!on) {
        // Taking back: first undo the meeting count's effect, while a and b are still placed in r.
        if (left[a]![b] === 0) {
          for (let x = 0; x < R; x++) {
            if (!free(x, a) || !free(x, b)) continue
            options[x]![a]!++
            options[x]![b]!++
          }
        }
        left[a]![b]!++
        left[b]![a]!++
      }
      // a and b leave (or rejoin) round r's free schools.
      for (let v = 0; v < N; v++) {
        if (v === a || v === b || !free(r, v)) continue
        if (left[v]![a]! > 0) o[v]! += step
        if (left[v]![b]! > 0) o[v]! += step
        shared[a]![v]! += step
        shared[v]![a]! += step
        shared[b]![v]! += step
        shared[v]![b]! += step
      }
      shared[a]![b]! += step
      shared[b]![a]! += step
      partner[r]![a] = on ? b : -1
      partner[r]![b] = on ? a : -1
      if (on) {
        left[a]![b]!--
        left[b]![a]!--
        // Their last meeting placed: neither is an option for the other in any round now.
        if (left[a]![b] === 0) {
          for (let x = 0; x < R; x++) {
            if (!free(x, a) || !free(x, b)) continue
            options[x]![a]!--
            options[x]![b]!--
          }
        }
      } else {
        // Their counts in round r went stale while they were placed there.
        o[a] = countOptions(r, a)
        o[b] = countOptions(r, b)
      }
    }
    /** The moves for the most constrained choice, in this attempt's order; 'done' or 'dead' when there's none. */
    const branch = (): Move[] | 'done' | 'dead' => {
      const choice = pick()
      if (choice === 'done' || choice === 'dead') return choice
      const moves: Move[] = []
      if (choice.kind === 'slot') {
        const p = partner[choice.r]!
        for (let u = 0; u < N; u++) if (u !== choice.v && p[u] === -1 && left[choice.v]![u]! > 0) moves.push([choice.r, choice.v, u])
      } else {
        for (let r = 0; r < R; r++) if (partner[r]![choice.i] === -1 && partner[r]![choice.j] === -1) moves.push([r, choice.i, choice.j])
      }
      return shuffle(moves, random)
    }
    // Depth-first with an explicit stack: each frame is one choice, its moves, and the move now placed.
    const first = branch()
    if (first === 'dead') return { ok: false, reason: 'impossible' }
    let solved = first === 'done'
    const stack: { moves: Move[]; next: number; placed: Move | null }[] = first === 'done' ? [] : [{ moves: first, next: 0, placed: null }]
    let outOfBudget = false
    while (!solved && stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (frame.placed) {
        place(frame.placed, false)
        frame.placed = null
      }
      if (frame.next >= frame.moves.length) {
        stack.pop()
        continue
      }
      if (++nodes > budget) {
        outOfBudget = true
        break
      }
      const move = frame.moves[frame.next++]!
      place(move, true)
      frame.placed = move
      const child = branch()
      if (child === 'done') solved = true
      else if (child !== 'dead') stack.push({ moves: child, next: 0, placed: null })
    }
    if (outOfBudget) continue
    if (!solved) return { ok: false, reason: 'impossible' }
    return { ok: true, games: withVenues(teamIds, games, partner, fixed, random) }
  }
  return { ok: false, reason: 'too-hard' }
}

/** Venues for the games a completion added, round by round after the games already set. */
function withVenues(
  teamIds: readonly string[],
  games: readonly ScheduledGame[],
  partner: Int16Array[],
  fixed: Int16Array[],
  random: () => number,
): ScheduledGame[] {
  const n = teamIds.length
  const homes = new Array<number>(n).fill(0)
  const streak = new Array<number>(n).fill(0) // +k: k straight home games, −k: away
  // How often each school hosted each pair's meetings: every game already set counts, in whatever round it is,
  // so filling an early round after a later one still gives the pair's meetings to alternating schools.
  const hosted = new Map<string, number>()
  const key = (h: number, a: number) => `${h}>${a}`
  const byRound = new Map<number, ScheduledGame[]>()
  const index = new Map(teamIds.map((t, i) => [t, i]))
  for (const g of games) {
    byRound.set(g.round, [...(byRound.get(g.round) ?? []), g])
    const k = key(index.get(g.home)!, index.get(g.away)!)
    hosted.set(k, (hosted.get(k) ?? 0) + 1)
  }
  const host = (h: number, a: number) => {
    homes[h]!++
    streak[h] = streak[h]! > 0 ? streak[h]! + 1 : 1
    streak[a] = streak[a]! < 0 ? streak[a]! - 1 : -1
  }
  const out: ScheduledGame[] = []
  for (let r = 0; r < partner.length; r++) {
    for (const g of byRound.get(r + 1) ?? []) host(index.get(g.home)!, index.get(g.away)!)
    for (let a = 0; a < n; a++) {
      const b = partner[r]![a]!
      if (b <= a || b >= n || fixed[r]![a] !== -1) continue
      // Score how much each side "should" host: the pair's meetings alternate; then home counts; then streaks.
      const want = (t: number, o: number) =>
        ((hosted.get(key(o, t)) ?? 0) - (hosted.get(key(t, o)) ?? 0)) * 100 +
        (homes[o]! - homes[t]!) * 10 +
        (streak[t]! < 0 ? -streak[t]! : -streak[t]! * 2) -
        (streak[o]! < 0 ? -streak[o]! : -streak[o]! * 2)
      const aHosts = want(a, b) > 0 || (want(a, b) === 0 && random() < 0.5)
      const [h, w] = aHosts ? [a, b] : [b, a]
      host(h, w)
      hosted.set(key(h, w), (hosted.get(key(h, w)) ?? 0) + 1)
      out.push({ round: r + 1, home: teamIds[h]!, away: teamIds[w]! })
    }
  }
  return out
}

/**
 * Whether the game a–b, which `schedule` (a whole season) puts in round
 * `from`, can move to round `to` without touching any game in `fixed`. In
 * two whole rounds every school plays (or, in an odd league, rests) once in
 * each, so their games form cycles alternating between the two rounds;
 * swapping the rounds along a–b's cycle keeps both rounds whole. Checking
 * that takes microseconds, so the options screen tries it before searching.
 */
export function canSwapInto(
  teamIds: readonly string[],
  schedule: readonly ScheduledGame[],
  fixed: ReadonlySet<string>,
  a: string,
  b: string,
  from: number,
  to: number,
): boolean {
  if (from === to) return true
  const REST = '\u0000rest'
  const odd = teamIds.length % 2 === 1
  const partners = (round: number) => {
    const m = new Map<string, string>()
    for (const g of schedule) {
      if (g.round !== round) continue
      m.set(g.home, g.away)
      m.set(g.away, g.home)
    }
    if (odd) {
      const resting = teamIds.find((t) => !m.has(t))
      if (resting === undefined) return null
      m.set(resting, REST)
      m.set(REST, resting)
    }
    return m.size === teamIds.length + (odd ? 1 : 0) ? m : null
  }
  const inFrom = partners(from)
  const inTo = partners(to)
  if (!inFrom || !inTo || inFrom.get(a) !== b) return false
  const isFixed = (round: number, x: string, y: string) => fixed.has(gameKey(round, x, y))
  // Walk the cycle: a–b in `from`, then b's game in `to`, then that school's game in `from`, … back to a.
  let at = a
  for (let steps = 0; steps <= teamIds.length + 1; steps++) {
    const viaFrom = inFrom.get(at)!
    if (viaFrom !== REST && at !== REST && isFixed(from, at, viaFrom)) return false
    const viaTo = inTo.get(viaFrom)!
    if (viaTo !== REST && viaFrom !== REST && isFixed(to, viaFrom, viaTo)) return false
    at = viaTo
    if (at === a) return true
  }
  return false
}

/** A game's identity within a season: its round and its two schools, either way round. */
export function gameKey(round: number, x: string, y: string): string {
  return x < y ? `${round}:${x}:${y}` : `${round}:${y}:${x}`
}
