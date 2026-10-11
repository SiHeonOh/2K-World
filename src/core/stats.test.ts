import { describe, expect, it } from 'vitest'
import { sampleConfig } from '@shared/testing/fixtures'
import { checkBoxScore, expectedPoints, leaders, seasonTotals, type BoxLine } from './stats'

const config = sampleConfig()
const line = (gameId: number, playerId: string, teamId: string, s: Partial<Record<string, number>>): BoxLine => ({
  gameId,
  playerId,
  teamId,
  stats: { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, fgm: 0, fga: 0, '3pm': 0, '3pa': 0, ftm: 0, fta: 0, ...s } as Record<string, number>,
})

describe('box score checks', () => {
  it('computes points from shooting lines', () => {
    expect(expectedPoints(config, { fgm: 10, '3pm': 3, ftm: 4 })).toBe(27)
  })

  it('flags lines and teams that do not add up', () => {
    const lines = [
      line(1, 'p1', 't1', { pts: 27, fgm: 10, fga: 20, '3pm': 3, '3pa': 6, ftm: 4, fta: 5 }),
      line(1, 'p2', 't1', { pts: 10, fgm: 4, fga: 3, '3pm': 0, ftm: 1, fta: 2 }),
      line(1, 'p7', 't2', { pts: 20, fgm: 8, fga: 15, ftm: 4, fta: 4 }),
    ]
    const issues = checkBoxScore(config, lines, new Map([['t1', 37], ['t2', 21]]))
    expect(issues).toEqual([
      { code: 'line-points', playerId: 'p2', points: 10, expected: 9 },
      { code: 'made-over-attempts', playerId: 'p2', column: 'fgm' },
      { code: 'team-points', teamId: 't2', points: 20, score: 21 },
    ])
  })
})

describe('totals and leaders', () => {
  const lines = [
    line(1, 'p1', 't1', { pts: 30, reb: 5, fgm: 12, fga: 20, '3pm': 2, '3pa': 4, ftm: 4, fta: 4 }),
    line(2, 'p1', 't2', { pts: 20, reb: 7, fgm: 8, fga: 20, '3pm': 1, '3pa': 5, ftm: 3, fta: 4 }),
    line(1, 'p2', 't1', { pts: 40, reb: 2, fgm: 15, fga: 25, '3pm': 5, '3pa': 10, ftm: 5, fta: 6 }),
  ]

  it('sums a season and follows trades', () => {
    const totals = seasonTotals(lines)
    expect(totals.get('p1')).toEqual(
      expect.objectContaining({ games: 2, teamId: 't2', totals: expect.objectContaining({ pts: 50, reb: 12 }) }),
    )
  })

  it('takes his team from his last line as given, not from the highest game id (rounds built by hand)', () => {
    const played = [line(9, 'p1', 't1', { pts: 10 }), line(4, 'p1', 't2', { pts: 12 })]
    expect(seasonTotals(played).get('p1')).toMatchObject({ teamId: 't2', games: 2 })
  })

  it('ranks per-game leaders and shooting percentages with minimums', () => {
    const boards = leaders(config, seasonTotals(lines), 1)
    const pts = boards.find((b) => b.key === 'pts')!
    expect(pts.rows.map((r) => [r.playerId, r.value])).toEqual([
      ['p2', 40],
      ['p1', 25],
    ])
    const fg = boards.find((b) => b.key === 'fg%')!
    expect(fg.rows[0]).toMatchObject({ playerId: 'p2', value: 0.6 })
    expect(leaders(config, seasonTotals(lines), 2).find((b) => b.key === 'pts')!.rows.map((r) => r.playerId)).toEqual(['p1'])
  })
})
