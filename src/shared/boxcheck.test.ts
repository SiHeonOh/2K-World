import { describe, expect, it } from 'vitest'
import { sampleConfig } from './testing/fixtures'
import { confirmIssues, rowsPoints, suggestedScore, type ConfirmSide } from './boxcheck'

const config = sampleConfig()
const row = (source: string, fgm: number, tpm: number, ftm: number, extra = 0) => ({
  source,
  stats: { pts: 2 * fgm + tpm + ftm + extra, fgm, fga: fgm + 4, '3pm': tpm, '3pa': tpm + 2, ftm, fta: ftm + 1 },
})

describe('the confirm screen checks', () => {
  // Home's rows add up to 40, away's to 42.
  const home: ConfirmSide = { teamId: 'h', rows: [row('A. One', 10, 0, 0), row('B. Two', 10, 0, 0)], shown: null }
  const away: ConfirmSide = { teamId: 'a', rows: [row('C. Three', 10, 1, 1), row('D. Four', 10, 0, 0)], shown: null }

  it('suggests the screenshot total over the rows sum', () => {
    expect(rowsPoints(config, home.rows)).toBe(40)
    expect(suggestedScore(config, home)).toBe(40)
    expect(suggestedScore(config, { ...home, shown: 47 })).toBe(47)
  })

  it('says nothing when the rows, the totals and the final score agree', () => {
    expect(confirmIssues(config, home, away, { home: 40, away: 42 })).toEqual([])
  })

  it('names the row whose points or shots do not add up', () => {
    const bad = { ...home, rows: [row('A. One', 10, 0, 0, 3), { source: 'B. Two', stats: { ...row('B. Two', 5, 0, 0).stats, fgm: 9, fga: 8, pts: 18 } }] }
    expect(confirmIssues(config, bad, away, { home: 41, away: 42 })).toEqual([
      { code: 'line-points', teamId: 'h', row: 0, source: 'A. One', points: 23, expected: 20 },
      { code: 'made-over-attempts', teamId: 'h', row: 1, source: 'B. Two', column: 'fgm' },
    ])
  })

  it('warns when the final score is not what the rows add up to, and loudest when it flips the winner', () => {
    // A cropped home screenshot lost a bench player: the rows say away won, the scoreboard says home did.
    const cropped = { ...home, shown: 45 }
    expect(confirmIssues(config, cropped, away, { home: 45, away: 42 })).toEqual([
      { code: 'shown-total', teamId: 'h', rows: 40, shown: 45 },
      { code: 'final-vs-rows', teamId: 'h', rows: 40, score: 45 },
      { code: 'winner-differs', winner: 'h', rows: { home: 40, away: 42 } },
    ])
    // Typed by hand with no total on the screenshot.
    expect(confirmIssues(config, home, away, { home: 40, away: 39 }).map((i) => i.code)).toEqual(['final-vs-rows', 'winner-differs'])
    // A tie isn't a winner either way (saving refuses it anyway).
    expect(confirmIssues(config, home, away, { home: 42, away: 42 }).map((i) => i.code)).toEqual(['final-vs-rows'])
  })
})
