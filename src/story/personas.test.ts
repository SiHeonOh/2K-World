import { describe, expect, it } from 'vitest'
import { ARCHETYPES, makeCast, type CastInput } from './personas'

const input = (over: Partial<CastInput> = {}): CastInput => ({
  seed: 'test',
  fans: 100,
  reporters: 4,
  maxSpice: 3,
  teams: [
    { id: 't1', shortName: '가람고', fanSize: 5 },
    { id: 't2', shortName: '누리고', fanSize: 1 },
  ],
  players: [
    { id: 'p1', teamId: 't1', name: '허다솜' },
    { id: 'p2', teamId: 't2', name: '강하늘' },
  ],
  ...over,
})

describe('makeCast', () => {
  it('is repeatable from the seed', () => {
    expect(makeCast(input())).toEqual(makeCast(input()))
    expect(makeCast(input({ seed: 'other' }))).not.toEqual(makeCast(input()))
  })

  it('spreads fans by fan base size, with some neutral, plus reporters', () => {
    const cast = makeCast(input())
    const fans = cast.filter((p) => p.kind === 'fan')
    expect(fans).toHaveLength(100)
    expect(cast.filter((p) => p.kind === 'reporter')).toHaveLength(4)
    const of = (id: string | null) => fans.filter((f) => f.teamId === id).length
    expect(of('t1')).toBeGreaterThan(of('t2') * 3)
    expect(of(null)).toBe(15)
  })

  it('keeps nicks unique, never a player name, and spice under the cap', () => {
    const cast = makeCast(input({ fans: 300 }))
    expect(new Set(cast.map((p) => p.nick)).size).toBe(cast.length)
    expect(cast.some((p) => p.nick === '허다솜' || p.nick === '강하늘')).toBe(false)
    expect(Math.max(...cast.map((p) => p.spice))).toBeLessThanOrEqual(3)
    for (const p of cast.filter((c) => c.kind === 'fan')) expect(ARCHETYPES.some((a) => a.id === p.archetype)).toBe(true)
  })

  it('gives stans a favourite player from their own school', () => {
    const cast = makeCast(input({ fans: 300 }))
    const stans = cast.filter((p) => p.archetype === 'stan' && p.teamId === 't1')
    expect(stans.length).toBeGreaterThan(0)
    for (const s of stans) expect(s.favPlayerId).toBe('p1')
  })

  it('works with no teams', () => {
    const cast = makeCast(input({ teams: [], fans: 10, reporters: 0 }))
    expect(cast.every((p) => p.teamId === null)).toBe(true)
    expect(cast).toHaveLength(10)
  })
})
