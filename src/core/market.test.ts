import { describe, expect, it } from 'vitest'
import { sampleConfig } from '@shared/testing/fixtures'
import { candidates, cardValue, counters, dealEffect, LOPSIDED_GAP, scoreDeal, type Market, type MarketPlayer, type MarketTeam } from './market'

/** Four teams of six; team t1 has a star (90), the rest are even (60), team t4 is frozen. */
function market(over: { leaning?: Partial<Record<string, MarketTeam['leaning']>>; unhappy?: string[]; locked?: string[] } = {}): Market {
  const config = sampleConfig()
  const slots = config.roster.slots.map((s) => s.id)
  const teams: MarketTeam[] = ['t1', 't2', 't3', 't4'].map((id, i) => ({
    id,
    divisionId: i < 2 ? 'n' : 's',
    leaning: over.leaning?.[id] ?? { philosophy: 'balanced', traits: {} },
    tradable: id !== 't4',
  }))
  const players: MarketPlayer[] = teams.flatMap((t, ti) =>
    slots.map((slot, si) => ({
      id: `${t.id}p${si + 1}`,
      teamId: t.id,
      slotId: slot,
      value: ti === 0 && si === 0 ? 90 : 60 - si * 2,
      unhappy: over.unhappy?.includes(`${t.id}p${si + 1}`) ?? false,
      locked: over.locked?.includes(`${t.id}p${si + 1}`) ?? false,
    })),
  )
  return {
    config,
    teams,
    players,
    cards: [
      { id: 1, ownerTeamId: 't2', originalTeamId: 't2', tradable: true },
      { id: 2, ownerTeamId: 't3', originalTeamId: 't3', tradable: true },
    ],
    ranking: ['t1', 't2', 't3', 't4'],
  }
}

describe('the market', () => {
  it('measures a deal on both sides, and the gap', () => {
    const m = market()
    const d = { a: 't2', b: 't1', aGives: ['t2p1'], bGives: ['t1p1'], aCards: [], bCards: [] }
    const e = dealEffect(m, d)
    expect(e.a.after).toBeGreaterThan(e.a.before)
    expect(e.b.after).toBeLessThan(e.b.before)
    const s = scoreDeal(m, d)
    expect(s.gap).toBe(30)
    expect(s.gap).toBeGreaterThan(LOPSIDED_GAP)
    expect(s.ua).toBeGreaterThan(0)
    expect(s.ub).toBeLessThan(0)
  })

  it('values an earlier pick more', () => {
    const m = market()
    expect(cardValue(m, { originalTeamId: 't4' })).toBeGreaterThan(cardValue(m, { originalTeamId: 't1' }))
  })

  it('weighs a deal by each GM: win-now wants strength, developers want cards, an unhappy player is easier to move', () => {
    const swap = { a: 't2', b: 't3', aGives: ['t2p1'], bGives: ['t3p2'], aCards: [], bCards: [2] }
    const plain = scoreDeal(market(), swap)
    const dev = scoreDeal(market({ leaning: { t2: { philosophy: 'development', traits: {} } } }), swap)
    const now = scoreDeal(market({ leaning: { t2: { philosophy: 'win-now', traits: {} } } }), swap)
    expect(dev.ua).toBeGreaterThan(plain.ua)
    expect(now.ua).toBeLessThan(plain.ua)
    const fed = scoreDeal(market({ unhappy: ['t2p1'] }), swap)
    expect(fed.ua).toBeGreaterThan(plain.ua)
  })

  it('lists offers with trade partners only, never locked players or frozen teams, at most two per partner', () => {
    const m = market({ locked: ['t3p1'] })
    const list = candidates(m, 't2')
    expect(list.length).toBeGreaterThan(0)
    for (const s of list) {
      expect(s.deal.a).toBe('t2')
      expect(s.deal.b).not.toBe('t4')
      expect([...s.deal.aGives, ...s.deal.bGives]).not.toContain('t3p1')
      expect(s.deal.aGives.length).toBe(s.deal.bGives.length)
      expect(s.ua).toBeGreaterThan(0)
    }
    const perPartner = new Map<string, number>()
    for (const s of list) perPartner.set(s.deal.b, (perPartner.get(s.deal.b) ?? 0) + 1)
    expect(Math.max(...perPartner.values())).toBeLessThanOrEqual(2)
  })

  it('a star chaser also gets its boldest try', () => {
    const m = market({ leaning: { t2: { philosophy: 'win-now', traits: { star_chasing: 5 } } } })
    expect(candidates(m, 't2').some((s) => s.deal.bGives.includes('t1p1'))).toBe(true)
  })

  it('offers the receiver counters that are better for it, from the same two teams', () => {
    const m = market()
    const offer = { a: 't2', b: 't3', aGives: ['t2p6'], bGives: ['t3p1'], aCards: [], bCards: [] }
    const base = scoreDeal(m, offer)
    const list = counters(m, offer)
    expect(list.length).toBeGreaterThan(0)
    for (const c of list) {
      expect([c.deal.a, c.deal.b]).toEqual(['t2', 't3'])
      expect(c.ub).toBeGreaterThan(base.ub)
    }
  })
})
