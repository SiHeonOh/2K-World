import { describe, expect, it } from 'vitest'
import { sampleConfig, twoKConfig, TWO_K_CATEGORIES } from '@shared/testing/fixtures'
import { expectedShares, playerValue, shareSharpness, valueModelOf } from './value'

/** A player's 2K ratings: OVR, then the nine categories in 2K's order (골밑 득점 … 농구 센스). */
const rated = (ovr: number, grades: string) => {
  const g = grades.split(' ')
  return { ovr, ...Object.fromEntries(TWO_K_CATEGORIES.map((name, i) => [name.toLowerCase().replace(/\s+/g, '-'), g[i]!])) }
}

// Made-up players with the ratings of the two trades that went wrong (src/core/market.cases.test.ts).
// 도윤재: a point guard, OVR 88, A playmaking, weak on the boards and inside (C- rebounding and inside D).
const pointGuard = rated(88, 'B+ B+ B- C- B A C- A- A-')
// 윤시우: a 3-and-D shooting guard, OVR 83, A+ 3pt, perimeter D and athleticism.
const wing = rated(83, 'B B A+ B- A+ B- C+ A+ B+')
// 정우빈: a center, OVR 88, A+ inside D and rebounding, D shooting.
const center = rated(88, 'A- D D A+ C- C A+ B C+')

describe('player value led by OVR', () => {
  it('values a specialist by what he is good at, so OVR orders players as 2K does', () => {
    const config = twoKConfig()
    // The flat average of all ten put the 83 above the 88 (75.9 vs 68.9) and the center at 59.7.
    expect(playerValue(config, pointGuard)).toBe(84.5)
    expect(playerValue(config, wing)).toBe(84.2)
    expect(playerValue(config, pointGuard)).toBeGreaterThan(playerValue(config, wing))
    // A center isn't marked down for shooting: his D 3-pointer and midrange are left out of his best six.
    expect(playerValue(config, center)).toBe(82)
  })

  it('is OVR’s share plus the mean of his best categories, each by its weight', () => {
    const config = twoKConfig()
    // OVR 99 and nine A+: the best possible; OVR 0 and nine F: the worst.
    expect(playerValue(config, rated(99, 'A+ A+ A+ A+ A+ A+ A+ A+ A+'))).toBe(100)
    expect(playerValue(config, rated(0, 'F F F F F F F F F'))).toBe(0)
    // OVR 99, six A+ and three F: the three Fs aren't among his best six.
    expect(playerValue(config, rated(99, 'A+ A+ A+ A+ A+ A+ F F F'))).toBe(100)
    // A heavier column counts for more within his best six.
    config.ratings.columns.find((c) => c.id === 'playmaking')!.weight = 5
    const passer = playerValue(config, rated(80, 'C C C C C A+ C C C'))
    config.ratings.columns.find((c) => c.id === 'playmaking')!.weight = 1
    expect(passer).toBeGreaterThan(playerValue(config, rated(80, 'C C C C C A+ C C C')))
    // A weight of 0 leaves a column out altogether (shown only).
    config.ratings.columns.find((c) => c.id === 'rebound')!.weight = 0
    expect(playerValue(config, rated(80, 'C C C C C C A+ C C'))).toBe(playerValue(config, rated(80, 'C C C C C C F C C')))
  })

  it('follows 리그 설정’s value model: OVR’s share and how many categories count', () => {
    const config = twoKConfig()
    expect(valueModelOf(config)).toEqual({ overallShare: 0.55, topCategories: 6 })
    config.ratings.valueModel = { overallShare: 1, topCategories: 6 }
    expect(playerValue(config, pointGuard)).toBe(88.9)
    config.ratings.valueModel = { overallShare: 0.55, topCategories: 9 }
    // All nine count: the point guard's C- rebounding and inside D pull him down again.
    expect(playerValue(config, pointGuard)).toBeLessThan(84.5)
  })

  it('keeps the old average where there is no OVR to lead (or OVR is shown only)', () => {
    const config = twoKConfig()
    config.ratings.overallColumnId = null
    // OVR 88 as a number column among ten, each counting the same.
    expect(playerValue(config, pointGuard)).toBe(68.9)
    expect(playerValue(config, wing)).toBe(75.9)
    const shownOnly = twoKConfig()
    shownOnly.ratings.columns[0]!.weight = 0
    // The nine grades alone.
    expect(playerValue(shownOnly, pointGuard)).toBe(66.7)
  })

  it('shares shots more sharply on OVR-led values, which sit closer together', () => {
    expect(shareSharpness(twoKConfig())).toBe(4)
    const flat = sampleConfig()
    flat.ratings.overallColumnId = null
    expect(shareSharpness(flat)).toBe(2)
    // A star of 95 among 80s: near the 28% a star takes in 2K box scores at the OVR-led sharpness, 22% squared.
    const team = [95, 84, 82, 81, 80, 70].map((value, i) => ({ id: `p${i}`, value, usage: 3 }))
    expect(expectedShares(team, 4).get('p0')!).toBeGreaterThan(0.27)
    expect(expectedShares(team, 2).get('p0')!).toBeLessThan(0.23)
  })
})
