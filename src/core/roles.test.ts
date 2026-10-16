import { describe, expect, it } from 'vitest'
import { sampleConfig, twoKConfig, TWO_K_CATEGORIES } from '@shared/testing/fixtures'
import { coverOf, fitValue, knownRoles, playerRoles, roleChanges, ROLE_GAIN, ROLE_LOSS, type Role } from './roles'

const rated = (grades: string) => {
  const g = grades.split(' ')
  return { ovr: 85, ...Object.fromEntries(TWO_K_CATEGORIES.map((name, i) => [name.toLowerCase().replace(/\s+/g, '-'), g[i]!])) }
}
//                       골밑 중거리 3점 골밑D 외곽D 플레이 리바 운동 센스
const passer = rated('B+ B+ B- C- B A C- A- A-')
const pointForward = rated('A B+ A B- C+ A- B A+ C+')
const rimBig = rated('A- D D A+ C- C A+ B C+')
const threeAndD = rated('B B A+ B- A+ B- C+ A+ B+')

describe('core roles from 2K grades and slots', () => {
  it('reads who runs the offense, guards the rim and the boards, spaces the floor and defends the perimeter', () => {
    const config = twoKConfig()
    expect(knownRoles(config)).toEqual(['handler', 'big', 'shooter', 'stopper'])
    // A guard with A playmaking runs the offense; the same player at the 6th man slot only does with A or better.
    expect(playerRoles(config, 'pg', passer)).toEqual(['handler'])
    expect(playerRoles(config, '6th-man', passer)).toEqual(['handler'])
    // A- playmaking at PF is a fine passer, but not the one who brings the ball up.
    expect(playerRoles(config, 'pf', pointForward)).toEqual(['shooter'])
    expect(playerRoles(config, 'c', rimBig)).toEqual(['big'])
    expect(playerRoles(config, 'sg', threeAndD)).toEqual(['shooter', 'stopper'])
  })

  it('tells nothing a league’s ratings can’t say', () => {
    // The sample league has OVR and one shooting grade: only spacing can be read.
    const config = sampleConfig()
    expect(knownRoles(config)).toEqual(['shooter'])
    expect(playerRoles(config, 'pg', { ovr: 80, shoot: 'B+' })).toEqual(['shooter'])
  })

  it('makes losing the only one in a role a clear penalty and filling a gap a smaller bonus, the defense more so for a defense-first GM', () => {
    const known = new Set<Role>(['handler', 'big', 'shooter', 'stopper'])
    const lineup = (...roles: Role[][]) => coverOf(roles.map((r) => ({ roles: r })))
    const before = lineup(['handler'], ['big'], ['shooter'], ['shooter', 'stopper'], [])
    // The only handler goes, and nobody comes in to do it.
    const noHandler = lineup([], ['big'], ['shooter'], ['shooter', 'stopper'], [])
    expect(fitValue(before, noHandler, known)).toBe(-ROLE_LOSS)
    expect(roleChanges(before, noHandler, known)).toEqual({ lost: ['handler'], filled: [] })
    // A second handler is no gap filled; a first big where there was none is.
    expect(fitValue(before, lineup(['handler'], ['handler'], ['big'], ['shooter'], ['shooter', 'stopper']), known)).toBe(0)
    const noBig = lineup(['handler'], [], ['shooter'], ['shooter', 'stopper'], [])
    expect(fitValue(noBig, before, known)).toBe(ROLE_GAIN)
    expect(fitValue(noBig, before, known, 5)).toBeCloseTo(ROLE_GAIN * 1.5)
    expect(fitValue(before, noBig, known, 5)).toBeCloseTo(-ROLE_LOSS * 1.5)
    expect(fitValue(before, noBig, known, 1)).toBeCloseTo(-ROLE_LOSS * 0.5)
    // Spacing wants two shooters: down to one costs half a role.
    expect(fitValue(before, lineup(['handler'], ['big'], ['shooter'], ['stopper'], []), known)).toBe(-ROLE_LOSS / 2)
    // A role the league can't tell never counts.
    expect(fitValue(before, noHandler, new Set<Role>(['big']))).toBe(0)
  })
})
