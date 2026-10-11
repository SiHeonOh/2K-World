import { describe, expect, it } from 'vitest'
import { sampleConfig } from '@shared/testing/fixtures'
import { band, computeMood, DEFAULT_TRAITS, usageClashes, type MoodInput } from './mood'
import { expectedShares, peckingOrder, playerValue, possessions, teamStrength } from './value'

const calm: MoodInput = {
  traits: DEFAULT_TRAITS,
  starter: true,
  expectsToStart: true,
  usageShare: 0.2,
  expectedShare: 0.2,
  points: 15,
  expectedPoints: 15,
  winPct: 0.5,
  streak: 0,
  awards: 0,
  seasonMature: false,
  isStar: false,
  friendsOnTeam: 0,
  rivalsOnTeam: 0,
  friendsLost: 0,
  rivalEdge: 0,
  recentMoves: 0,
  belonging: 0,
  hooks: {},
  noise: 0.5,
}

describe('player value', () => {
  it('weights ratings by the config and puts grades on the same scale', () => {
    const config = sampleConfig()
    const cols = config.ratings.columns
    const best: Record<string, string | number> = {}
    const worst: Record<string, string | number> = {}
    for (const c of cols) {
      best[c.id] = c.kind === 'number' ? c.max : config.ratings.gradeScale[0]!.label
      worst[c.id] = c.kind === 'number' ? c.min : config.ratings.gradeScale.at(-1)!.label
    }
    expect(playerValue(config, best)).toBe(100)
    expect(playerValue(config, worst)).toBe(0)
    expect(playerValue(config, {})).toBe(50)
  })

  it('orders a team, sizes its strength, and splits shots by value and appetite', () => {
    const config = sampleConfig()
    const team = [
      { id: 'a', teamId: 't', slotId: null, value: 90 },
      { id: 'b', teamId: 't', slotId: null, value: 60 },
      { id: 'c', teamId: 't', slotId: null, value: 60 },
    ]
    expect(peckingOrder(team).map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(teamStrength(config, team)).toBeGreaterThan(60)
    const shares = expectedShares([
      { id: 'a', value: 90, usage: 3 },
      { id: 'b', value: 60, usage: 5 },
      { id: 'c', value: 60, usage: 1 },
    ])
    expect([...shares.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1)
    expect(shares.get('a')!).toBeGreaterThan(shares.get('b')!)
    expect(shares.get('b')!).toBeGreaterThan(shares.get('c')!)
    expect(possessions({ fga: 10, fta: 5, to: 2 }, { fga: 'fga', fta: 'fta', to: 'to' })).toBeCloseTo(14.2)
  })
})

describe('mood', () => {
  it('is neutral-to-content for a starter getting what he expects', () => {
    const m = computeMood(calm)
    expect(['neutral', 'content']).toContain(m.band)
  })

  it('boils over for a benched star short of shots on a losing team', () => {
    const m = computeMood({
      ...calm,
      traits: { ...DEFAULT_TRAITS, ego: 5, usage: 5 },
      starter: false,
      usageShare: 0.08,
      expectedShare: 0.25,
      points: 6,
      expectedPoints: 18,
      winPct: 0.2,
      streak: -4,
      isStar: true,
      seasonMature: true,
    })
    expect(m.band).toBe('boiling')
    expect(m.reasons[0]!.part).toMatch(/role|usage|winning|production/)
    expect(m.parts.usage).toBeLessThan(-50)
  })

  it('cares about moves less when professional, and hooks add up', () => {
    const moved = { ...calm, recentMoves: 1 }
    const pro = computeMood({ ...moved, traits: { ...DEFAULT_TRAITS, professionalism: 5 } })
    const diva = computeMood({ ...moved, traits: { ...DEFAULT_TRAITS, professionalism: 1 } })
    expect(pro.overall).toBeGreaterThan(diva.overall)
    expect(computeMood({ ...calm, hooks: { stability: -30 } }).parts.stability).toBe(-30)
    expect(band(60)).toBe('happy')
    expect(band(-60)).toBe('boiling')
  })

  it('flags two ball-hungry players both short of shots', () => {
    const hungry = { ...DEFAULT_TRAITS, usage: 5 }
    const short = computeMood({ ...calm, traits: hungry, usageShare: 0.1, expectedShare: 0.25 })
    const fine = computeMood({ ...calm, traits: hungry })
    expect(usageClashes([
      { id: 'a', traits: hungry, mood: short },
      { id: 'b', traits: hungry, mood: short },
      { id: 'c', traits: hungry, mood: fine },
    ])).toEqual([['a', 'b']])
  })
})
