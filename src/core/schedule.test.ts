import { describe, expect, it } from 'vitest'
import { sampleConfig } from '@shared/testing/fixtures'
import { rng, shuffle } from './random'
import { buildSchedule, canSwapInto, completeRoundRobin, gameKey, roundRobin, roundRobinShape, scheduleProblems, type ScheduledGame } from './schedule'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`)

function check(teams: string[], games: { round: number; home: string; away: string }[]) {
  const perRound = new Map<number, string[]>()
  const count = new Map<string, { home: number; away: number }>()
  const pairs = new Map<string, number>()
  for (const g of games) {
    const list = perRound.get(g.round) ?? []
    list.push(g.home, g.away)
    perRound.set(g.round, list)
    const h = count.get(g.home) ?? { home: 0, away: 0 }
    h.home++
    count.set(g.home, h)
    const a = count.get(g.away) ?? { home: 0, away: 0 }
    a.away++
    count.set(g.away, a)
    const key = [g.home, g.away].sort().join('-')
    pairs.set(key, (pairs.get(key) ?? 0) + 1)
  }
  for (const list of perRound.values()) expect(new Set(list).size).toBe(list.length)
  return { count, pairs }
}

describe('roundRobin', () => {
  it.each([2, 6, 7, 8, 36])('%i teams: everyone meets once, nobody twice in a round', (n) => {
    const teams = ids(n)
    const rounds = roundRobin(teams)
    expect(rounds).toHaveLength(n % 2 === 0 ? n - 1 : n)
    const games = rounds.flatMap((g, r) => g.map(([home, away]) => ({ round: r + 1, home, away })))
    expect(games).toHaveLength((n * (n - 1)) / 2)
    const { count, pairs } = check(teams, games)
    expect([...pairs.values()].every((v) => v === 1)).toBe(true)
    for (const c of count.values()) expect(Math.abs(c.home - c.away)).toBeLessThanOrEqual(1)
  })

  it('alternates venues: runs of at most two, counts within one, for 2–40 teams', () => {
    for (let n = 2; n <= 40; n++) {
      const seq = new Map<string, string[]>(ids(n).map((t) => [t, []]))
      for (const round of roundRobin(ids(n))) {
        for (const [home, away] of round) {
          seq.get(home)!.push('H')
          seq.get(away)!.push('A')
        }
      }
      for (const s of seq.values()) {
        const home = s.filter((x) => x === 'H').length
        expect(Math.abs(home - (s.length - home))).toBeLessThanOrEqual(1)
        expect(s.join('')).not.toMatch(/HHH|AAA/)
      }
    }
  })

  it('handles fewer than two teams', () => {
    expect(roundRobin([])).toEqual([])
    expect(roundRobin(['a'])).toEqual([])
  })
})

describe('buildSchedule', () => {
  it('builds a single round robin: 36 teams → 35 rounds, 630 games', () => {
    const config = sampleConfig()
    const games = buildSchedule(config, ids(36), 'seed')
    expect(games).toHaveLength(630)
    expect(Math.max(...games.map((g) => g.round))).toBe(35)
    check(ids(36), games)
  })

  it('swaps home and away in the second cycle', () => {
    const config = sampleConfig()
    config.season.schedule = { kind: 'round-robin', cycles: 2, build: 'auto' }
    const games = buildSchedule(config, ids(6), 'seed')
    expect(games).toHaveLength(30)
    const { count, pairs } = check(ids(6), games)
    expect([...pairs.values()].every((v) => v === 2)).toBe(true)
    for (const c of count.values()) expect(c).toEqual({ home: 5, away: 5 })
  })

  it('is repeatable per seed and differs between seeds', () => {
    const config = sampleConfig()
    const a = buildSchedule(config, ids(8), 'one')
    expect(buildSchedule(config, ids(8), 'one')).toEqual(a)
    expect(buildSchedule(config, ids(8), 'two')).not.toEqual(a)
  })

  it('gives every team the custom game count', () => {
    const config = sampleConfig()
    config.season.schedule = { kind: 'custom', gamesPerTeam: 10 }
    const games = buildSchedule(config, ids(8), 'seed')
    const { count } = check(ids(8), games)
    for (const c of count.values()) expect(c.home + c.away).toBe(10)
  })
})

describe('rounds built by hand', () => {
  const whole = (teams: string[], cycles: number, games: ScheduledGame[]) => {
    const shape = roundRobinShape(teams.length, cycles)
    const done = completeRoundRobin(teams, shape, games, 'seed')
    if (!done.ok) throw new Error(done.reason)
    const all = [...games, ...done.games]
    expect(scheduleProblems(teams, shape, all)).toEqual([])
    expect(all).toHaveLength((cycles * teams.length * (teams.length - 1)) / 2)
    for (let r = 1; r <= shape.rounds; r++) expect(all.filter((g) => g.round === r)).toHaveLength(shape.perRound)
    return all
  }

  it('knows the shape: rounds, games per round, meetings', () => {
    expect(roundRobinShape(36, 1)).toEqual({ teams: 36, rounds: 35, perRound: 18, meetings: 1 })
    expect(roundRobinShape(35, 1)).toEqual({ teams: 35, rounds: 35, perRound: 17, meetings: 1 })
    expect(roundRobinShape(6, 2)).toEqual({ teams: 6, rounds: 10, perRound: 3, meetings: 2 })
  })

  it('completes a 36-team season from nothing, with balanced venues', () => {
    const all = whole(ids(36), 1, [])
    const { count } = check(ids(36), all)
    for (const c of count.values()) expect(c.home).toBeGreaterThanOrEqual(16)
    for (const c of count.values()) expect(c.home).toBeLessThanOrEqual(19)
  })

  it('keeps the games already set and fills around them, odd leagues resting one team a round', () => {
    // Round 1 of a 7-team league: three games, one team rests.
    const mine = [
      { round: 1, home: 't1', away: 't2' },
      { round: 1, home: 't3', away: 't4' },
      { round: 1, home: 't5', away: 't6' },
      { round: 4, home: 't7', away: 't1' },
    ]
    const all = whole(ids(7), 1, mine)
    for (const g of mine) expect(all).toContainEqual(g)
    // t7 rests in round 1, so t7–t1 can't be in round 1 and isn't added again.
    expect(all.filter((g) => [g.home, g.away].sort().join() === 't1,t7')).toEqual([{ round: 4, home: 't7', away: 't1' }])
  })

  it('gives a pair two meetings at different schools in a double round robin', () => {
    const all = whole(ids(6), 2, [{ round: 1, home: 't1', away: 't2' }])
    const hosts = new Map<string, string[]>()
    for (const g of all) {
      const key = [g.home, g.away].sort().join('-')
      hosts.set(key, [...(hosts.get(key) ?? []), g.home])
    }
    for (const h of hosts.values()) expect(new Set(h).size).toBe(2)
  })

  it('says when the season can no longer be completed, and when games break the rules', () => {
    const shape = roundRobinShape(4, 1)
    // Round 1 has t1–t2, so round 1 must also hold t3–t4; but t3–t4 is already in round 2.
    expect(completeRoundRobin(ids(4), shape, [{ round: 1, home: 't1', away: 't2' }, { round: 2, home: 't3', away: 't4' }], 's')).toEqual({ ok: false, reason: 'impossible' })
    expect(completeRoundRobin(ids(4), shape, [{ round: 1, home: 't1', away: 't2' }, { round: 2, home: 't2', away: 't1' }], 's')).toEqual({ ok: false, reason: 'impossible' })
    expect(scheduleProblems(ids(4), shape, [{ round: 1, home: 't1', away: 't2' }, { round: 1, home: 't1', away: 't3' }, { round: 4, home: 't3', away: 't4' }, { round: 2, home: 't2', away: 't2' }])).toEqual([
      { code: 'twice-in-round', round: 1, team: 't1' },
      { code: 'round-out-of-range', round: 4 },
      { code: 'same-team', round: 2, team: 't2' },
    ])
  })

  it('agrees with a plain exhaustive search on hundreds of random partial schedules, odd and three-cycle leagues too', () => {
    /** Tries every way to fill the first free slot, round by round: slow, but obviously right. */
    const exhaustive = (teams: string[], cycles: number, games: ScheduledGame[]) => {
      const N = teams.length % 2 ? teams.length + 1 : teams.length
      const R = cycles * (N - 1)
      const v = (t: string) => teams.indexOf(t)
      const partner = Array.from({ length: R }, () => new Array<number>(N).fill(-1))
      const left = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 0 : cycles)))
      for (const g of games) {
        partner[g.round - 1]![v(g.home)] = v(g.away)
        partner[g.round - 1]![v(g.away)] = v(g.home)
        left[v(g.home)]![v(g.away)]!--
        left[v(g.away)]![v(g.home)]!--
      }
      const go = (): boolean => {
        for (let r = 0; r < R; r++) {
          const a = partner[r]!.indexOf(-1)
          if (a === -1) continue
          for (let b = 0; b < N; b++) {
            if (b === a || partner[r]![b] !== -1 || left[a]![b]! === 0) continue
            partner[r]![a] = b
            partner[r]![b] = a
            left[a]![b]!--
            left[b]![a]!--
            if (go()) return true
            partner[r]![a] = -1
            partner[r]![b] = -1
            left[a]![b]!++
            left[b]![a]!++
          }
          return false
        }
        return true
      }
      return go()
    }
    const random = rng('cross-check')
    let impossible = 0
    for (let trial = 0; trial < 360; trial++) {
      const [n, cycles] = ([[6, 1], [5, 1], [4, 2], [6, 2], [7, 1], [4, 3]] as const)[trial % 6]!
      const teams = ids(n)
      const shape = roundRobinShape(n, cycles)
      // Random games that break no rule on their own; together they may leave no way to finish.
      const games: ScheduledGame[] = []
      for (let k = 0; k < 3 + Math.floor(random() * 10); k++) {
        const [home, away] = shuffle(teams, random) as [string, string]
        const g = { round: 1 + Math.floor(random() * shape.rounds), home, away }
        if (scheduleProblems(teams, shape, [...games, g]).length === 0) games.push(g)
      }
      const done = completeRoundRobin(teams, shape, games, `x${trial}`)
      const expected = exhaustive(teams, cycles, games)
      expect(done.ok).toBe(expected)
      if (done.ok) expect(scheduleProblems(teams, shape, [...games, ...done.games])).toEqual([])
      else impossible++
    }
    // The random states include plenty of dead ends.
    expect(impossible).toBeGreaterThan(20)
  })

  it('says when a game can be swapped into another round without touching games already set', () => {
    for (const n of [8, 7]) {
      const teams = ids(n)
      const shape = roundRobinShape(n, 1)
      const done = completeRoundRobin(teams, shape, [], `swap${n}`)
      if (!done.ok) throw new Error(done.reason)
      const plan = done.games
      const g = plan.find((x) => x.round === 3)!
      // Nothing fixed: any game can move to any round, and the season really can be completed that way.
      for (const to of [1, 2, 4, shape.rounds]) {
        expect(canSwapInto(teams, plan, new Set(), g.home, g.away, 3, to)).toBe(true)
        expect(completeRoundRobin(teams, shape, [{ round: to, home: g.home, away: g.away }], 'check').ok).toBe(true)
      }
      // A game set in round 1 that the swap would have to move blocks it.
      const blocker = plan.find((x) => x.round === 1 && (x.home === g.home || x.away === g.home))!
      expect(canSwapInto(teams, plan, new Set([gameKey(1, blocker.home, blocker.away)]), g.home, g.away, 3, 1)).toBe(false)
      // A pair the schedule doesn't put in that round can't be swapped from it.
      const other = plan.find((x) => x.round === 3 && x !== g)!
      expect(canSwapInto(teams, plan, new Set(), g.home, other.home, 3, 1)).toBe(false)
    }
  })

  it('checks every opponent of a 36-team league in well under a second, and handles long seasons', () => {
    const teams = ids(36)
    const shape = roundRobinShape(36, 1)
    const t0 = performance.now()
    const done = completeRoundRobin(teams, shape, [], 'opts')
    if (!done.ok) throw new Error(done.reason)
    const ok = teams.slice(1).filter((u) => {
      const g = done.games.find((x) => (x.home === 't1' && x.away === u) || (x.home === u && x.away === 't1'))!
      return canSwapInto(teams, done.games, new Set(), 't1', u, g.round, 1)
    })
    expect(ok).toHaveLength(35)
    expect(performance.now() - t0).toBeLessThan(1000)
    // Twenty schools meeting eight times: 1,520 games in one search, with no recursion to overflow.
    const long = completeRoundRobin(ids(20), roundRobinShape(20, 8), [], 'long')
    expect(long.ok && long.games.length).toBe(1520)
  })

  it('is repeatable per seed, and quick for a 36-team league built by hand', () => {
    const teams = ids(36)
    const shape = roundRobinShape(36, 1)
    // Ten rounds "by hand": a random completion's first ten rounds.
    const start = completeRoundRobin(teams, shape, [], 'hand')
    if (!start.ok) throw new Error(start.reason)
    const mine = start.games.filter((g) => g.round <= 10)
    const t0 = performance.now()
    const a = completeRoundRobin(teams, shape, mine, 'x')
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(completeRoundRobin(teams, shape, mine, 'x')).toEqual(a)
  })
})
