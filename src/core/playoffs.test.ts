import { describe, expect, it } from 'vitest'
import { sampleConfig } from '@shared/testing/fixtures'
import { bracketOrder, effectiveSeeds, highSeedHosts, planBracket, resolveBracket, winsNeeded } from './playoffs'

describe('bracketOrder', () => {
  it('keeps the top seeds apart', () => {
    expect(bracketOrder(2)).toEqual([1, 2])
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3])
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6])
  })
})

describe('series rules', () => {
  it('counts wins needed and home court', () => {
    expect([1, 3, 5, 7].map(winsNeeded)).toEqual([1, 2, 3, 4])
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => highSeedHosts(n, 7))).toEqual([true, true, false, false, true, false, true])
    expect([1, 2, 3, 4, 5].map((n) => highSeedHosts(n, 5))).toEqual([true, true, false, false, true])
    expect([1, 2, 3].map((n) => highSeedHosts(n, 3))).toEqual([true, false, true])
  })
})

describe('planBracket', () => {
  it('plans an NBA-style conference bracket with play-in and a final', () => {
    const config = sampleConfig()
    config.season.playoffs = {
      enabled: true,
      bracket: 'conference',
      directSeeds: 6,
      playIn: { enabled: true, format: 'nba', bestOf: 1 },
      seriesBestOf: 7,
      finals: { kind: 'conference-champions', bestOf: 7 },
    }
    const plans = planBracket(config)
    // Per conference: 3 play-in + 4 + 2 + 1 series; plus the final.
    expect(plans).toHaveLength(2 * (3 + 7) + 1)
    const east = plans.filter((p) => p.group === 'east')
    expect(east.filter((p) => p.stage === 'play-in').map((p) => [p.slot, p.a, p.b])).toEqual([
      ['east:pi:a', { kind: 'seed', group: 'east', seed: 7 }, { kind: 'seed', group: 'east', seed: 8 }],
      ['east:pi:b', { kind: 'seed', group: 'east', seed: 9 }, { kind: 'seed', group: 'east', seed: 10 }],
      ['east:pi:c', { kind: 'loser', slot: 'east:pi:a' }, { kind: 'winner', slot: 'east:pi:b' }],
    ])
    const r1 = east.filter((p) => p.round === 1 && p.stage === 'playoffs')
    expect(r1.map((p) => [p.a, p.b])).toEqual([
      [{ kind: 'seed', group: 'east', seed: 1 }, { kind: 'winner', slot: 'east:pi:c', seed: 8 }],
      [{ kind: 'seed', group: 'east', seed: 4 }, { kind: 'seed', group: 'east', seed: 5 }],
      [{ kind: 'seed', group: 'east', seed: 2 }, { kind: 'winner', slot: 'east:pi:a', seed: 7 }],
      [{ kind: 'seed', group: 'east', seed: 3 }, { kind: 'seed', group: 'east', seed: 6 }],
    ])
    expect(plans.at(-1)).toMatchObject({
      slot: 'finals',
      stage: 'finals',
      a: { kind: 'winner', slot: 'east:r3:0' },
      b: { kind: 'winner', slot: 'west:r3:0' },
    })
  })

  it('makes the last round of a league bracket the finals', () => {
    const config = sampleConfig()
    config.season.playoffs = {
      enabled: true,
      bracket: 'league',
      directSeeds: 4,
      playIn: { enabled: false, format: 'nba', bestOf: 1 },
      seriesBestOf: 5,
      finals: { kind: 'none', bestOf: 7 },
    }
    const plans = planBracket(config)
    expect(plans.map((p) => [p.slot, p.stage, p.bestOf])).toEqual([
      ['league:r1:0', 'playoffs', 5],
      ['league:r1:1', 'playoffs', 5],
      ['league:r2:0', 'finals', 7],
    ])
  })

  it('plans nothing when playoffs are off or the field is not a power of two', () => {
    const config = sampleConfig()
    config.season.playoffs.enabled = false
    expect(planBracket(config)).toEqual([])
    config.season.playoffs.enabled = true
    config.season.playoffs.directSeeds = 3
    expect(planBracket(config)).toEqual([])
  })
})

describe('resolveBracket', () => {
  it('fills teams from seeds and results as they come in', () => {
    const config = sampleConfig()
    config.season.playoffs = {
      enabled: true,
      bracket: 'league',
      directSeeds: 2,
      playIn: { enabled: true, format: 'nba', bestOf: 1 },
      seriesBestOf: 3,
      finals: { kind: 'none', bestOf: 3 },
    }
    const plans = planBracket(config)
    const seeds = new Map([['league', ['s1', 's2', 's3', 's4', 's5', 's6']]])
    let states = resolveBracket(plans, seeds, new Map())
    const at = (slot: string) => states.find((s) => s.slot === slot)!
    expect([at('league:pi:a').a, at('league:pi:a').b]).toEqual(['s3', 's4'])
    expect(at('league:pi:c').a).toBeNull()
    expect(at('league:r1:0').a).toBe('s1')
    expect(at('league:r1:0').b).toBeNull()

    const results = new Map([
      ['league:pi:a', { winner: 's4', loser: 's3' }],
      ['league:pi:b', { winner: 's5', loser: 's6' }],
    ])
    states = resolveBracket(plans, seeds, results)
    expect([at('league:pi:c').a, at('league:pi:c').b]).toEqual(['s3', 's5'])
    // pi:a's winner is seed 3 in the bracket, so it meets seed 2.
    expect([at('league:r1:1').a, at('league:r1:1').b]).toEqual(['s2', 's4'])
    // s4 won the first play-in game, so it is now seed 3; s3 can at best be seed 4.
    const eff = effectiveSeeds(plans, seeds, results).get('league')!
    expect([eff.get('s4'), eff.get('s3')]).toEqual([3, 3])
    const all = new Map([...results, ['league:pi:c', { winner: 's3', loser: 's5' }]])
    const eff2 = effectiveSeeds(plans, seeds, all).get('league')!
    expect([eff2.get('s4'), eff2.get('s3')]).toEqual([3, 4])
  })

  it('refuses results that name teams not in the series', () => {
    const config = sampleConfig()
    const plans = planBracket(config)
    const seeds = new Map([
      ['east', ['e1', 'e2']],
      ['west', ['w1', 'w2']],
    ])
    expect(() => resolveBracket(plans, seeds, new Map([['east:r1:0', { winner: 'w1', loser: 'e2' }]]))).toThrow(/not in the series/)
  })
})
