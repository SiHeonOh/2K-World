import { describe, expect, it } from 'vitest'
import { computeRows, gamesBehind, rankTeams, type FinalScore, type TeamRef } from './standings'

const teams: TeamRef[] = [
  { id: 'a', divisionId: 'd1', conferenceId: 'c1' },
  { id: 'b', divisionId: 'd1', conferenceId: 'c1' },
  { id: 'c', divisionId: 'd2', conferenceId: 'c1' },
  { id: 'd', divisionId: 'd3', conferenceId: 'c2' },
]

let nextId = 1
const g = (round: number, home: string, away: string, homeScore: number, awayScore: number): FinalScore => ({
  id: nextId++,
  round,
  home,
  away,
  homeScore,
  awayScore,
})

describe('computeRows', () => {
  it('counts records, splits, points, streaks and last 10', () => {
    const games = [g(1, 'a', 'b', 100, 90), g(2, 'b', 'a', 80, 85), g(3, 'a', 'd', 70, 75), g(4, 'c', 'a', 60, 99)]
    const rows = computeRows(teams, games)
    expect(rows.get('a')).toMatchObject({
      wins: 3,
      losses: 1,
      pct: 0.75,
      pointsFor: 354,
      pointsAgainst: 305,
      home: { w: 1, l: 1 },
      away: { w: 2, l: 0 },
      conference: { w: 3, l: 0 },
      division: { w: 2, l: 0 },
      last10: { w: 3, l: 1 },
      streak: 'W1',
    })
    expect(rows.get('b')!.streak).toBe('L2')
    expect(rows.get('d')!.conference).toEqual({ w: 0, l: 0 })
  })

  it('ignores games with unknown teams or equal scores', () => {
    const rows = computeRows(teams, [g(1, 'a', 'zz', 90, 80), g(1, 'a', 'b', 80, 80)])
    expect(rows.get('a')!.wins + rows.get('a')!.losses).toBe(0)
  })
})

describe('rankTeams', () => {
  const ids = teams.map((t) => t.id)

  it('ranks by win % first', () => {
    const games = [g(1, 'a', 'b', 90, 80), g(1, 'c', 'd', 90, 80), g(2, 'a', 'c', 90, 80), g(2, 'b', 'd', 90, 80)]
    const rows = computeRows(teams, games)
    expect(rankTeams(ids, rows, games, [], 's')).toEqual(['a', expect.any(String), expect.any(String), 'd'])
  })

  it('breaks a two-team tie head to head before point differential', () => {
    // a and b both 1-1; b beat a, but a has the far better margin.
    const games = [g(1, 'b', 'a', 81, 80), g(2, 'a', 'c', 130, 80), g(3, 'b', 'd', 80, 90)]
    const rows = computeRows(teams, games)
    expect(rankTeams(['a', 'b'], rows, games, ['head-to-head', 'point-diff'], 's')).toEqual(['b', 'a'])
    expect(rankTeams(['a', 'b'], rows, games, ['point-diff', 'head-to-head'], 's')).toEqual(['a', 'b'])
  })

  it('restarts the tiebreakers inside a split group', () => {
    // Four teams all 2-2. Among the four, a and b are 2-1, c and d 1-2, so
    // head-to-head splits them in two. Inside each pair it starts over: b beat a
    // and d beat c, even though a and c have the better point differentials.
    const five = [...teams, { id: 'e', divisionId: 'd3', conferenceId: 'c2' }]
    const games = [
      g(1, 'b', 'a', 81, 80),
      g(1, 'a', 'c', 130, 80),
      g(2, 'a', 'd', 130, 80),
      g(2, 'c', 'b', 81, 80),
      g(3, 'b', 'd', 81, 80),
      g(3, 'd', 'c', 81, 80),
      g(4, 'e', 'a', 90, 89),
      g(4, 'e', 'b', 90, 89),
      g(5, 'c', 'e', 120, 80),
      g(5, 'd', 'e', 81, 80),
    ]
    const rows = computeRows(five, games)
    expect(['a', 'b', 'c', 'd'].map((id) => rows.get(id)!.wins)).toEqual([2, 2, 2, 2])
    expect(rankTeams(['a', 'b', 'c', 'd'], rows, games, ['point-diff'], 's')).toEqual(['a', 'b', 'c', 'd'])
    expect(rankTeams(['a', 'b', 'c', 'd'], rows, games, ['head-to-head', 'point-diff'], 's')).toEqual(['b', 'a', 'd', 'c'])
  })

  it('always ends with a repeatable coin flip', () => {
    const rows = computeRows(teams, [])
    const one = rankTeams(ids, rows, [], ['point-diff'], 'seed-1')
    expect(rankTeams(ids, rows, [], ['point-diff'], 'seed-1')).toEqual(one)
    expect(new Set(one).size).toBe(4)
    const seeds = new Set(Array.from({ length: 20 }, (_, i) => rankTeams(ids, rows, [], [], `s${i}`).join()))
    expect(seeds.size).toBeGreaterThan(1)
  })
})

describe('teams without games', () => {
  it('rank a 0-0 team above a winless one, and treat no head-to-head as even', () => {
    const games = [g(1, 'a', 'b', 90, 80), g(2, 'a', 'b', 90, 80)]
    const rows = computeRows(teams, games)
    expect(rankTeams(['b', 'c'], rows, games, [], 's')).toEqual(['c', 'b'])
    // a is 2-0 and b 0-2; c and d haven't played, so they count as .500 and sit above b.
    expect(rankTeams(['a', 'b', 'c', 'd'], rows, games, ['head-to-head', 'point-diff'], 's').at(-1)).toBe('b')
  })
})

describe('gamesBehind', () => {
  it('measures distance from the leader', () => {
    const games = [g(1, 'a', 'b', 90, 80), g(2, 'a', 'c', 90, 80), g(3, 'c', 'b', 90, 80)]
    const rows = computeRows(teams, games)
    const gb = gamesBehind(['a', 'c', 'b'], rows)
    expect([gb.get('a'), gb.get('c'), gb.get('b')]).toEqual([0, 1, 2])
  })
})
