import { describe, expect, it } from 'vitest'
import { sampleConfig, twoKConfig } from '@shared/testing/fixtures'
import { defaultCardSwap } from '@shared/config/defaults'
import { rng } from './random'
import { checkTrade, type TradeContext, type TradeItem } from './trades'
import {
  candidates,
  caution,
  cautionBar,
  cardValue,
  consolidationBy,
  counters,
  dealEffect,
  dealStillOpen,
  isBlockbuster,
  LOPSIDED_GAP,
  roleNews,
  scoreDeal,
  standingOf,
  type Deal,
  type Market,
  type MarketCard,
  type MarketPlayer,
  type MarketTeam,
  type Scored,
} from './market'
import { ROLE_LOSS } from './roles'

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

/**
 * Four teams (t4 frozen) with the values given, in slot order (PG, SG, SF,
 * PF, C, bench); t1 and t2 share a division. `room`: the cards each may still
 * give under the in-season cap.
 */
function custom(
  values: Record<'t1' | 't2' | 't3' | 't4', number[]>,
  over: { leaning?: Partial<Record<string, MarketTeam['leaning']>>; unhappy?: string[]; franchise?: string[]; cards?: MarketCard[]; room?: Partial<Record<string, number>> } = {},
): Market {
  const config = sampleConfig()
  const slots = config.roster.slots.map((s) => s.id)
  const teams: MarketTeam[] = (['t1', 't2', 't3', 't4'] as const).map((id, i) => ({
    id,
    divisionId: i < 2 ? 'n' : 's',
    leaning: over.leaning?.[id] ?? { philosophy: 'balanced', traits: {} },
    tradable: id !== 't4',
    ...(over.room?.[id] !== undefined ? { cardRoom: over.room[id] } : {}),
  }))
  const players: MarketPlayer[] = teams.flatMap((t) =>
    values[t.id as 't1'].map((value, si) => {
      const id = `${t.id}p${si + 1}`
      return { id, teamId: t.id, slotId: slots[si]!, value, unhappy: over.unhappy?.includes(id) ?? false, franchise: over.franchise?.includes(id) ?? false, locked: false }
    }),
  )
  return { config, teams, players, cards: over.cards ?? [], ranking: ['t1', 't2', 't3', 't4'] }
}

const EVEN = [60, 58, 56, 54, 52, 50]
const same = (d: Deal, aGives: string[], bGives: string[]) => [...d.aGives].sort().join() === [...aGives].sort().join() && [...d.bGives].sort().join() === [...bGives].sort().join()

describe('superstar trades: a star and a scrub for two', () => {
  // 가람고(t1): a star and little else. 누리고(t2): deep, no star.
  const thin = [85, 55, 52, 50, 48, 40]
  const deep = [70, 69, 68, 67, 66, 60]

  it('a deep team gets the star and the scrub for two of its middle players, and the thin team likes it too', () => {
    const m = custom({ t1: thin, t2: deep, t3: EVEN, t4: EVEN })
    // Its single legs alone are no good for the star's team: one lesser player can't match him.
    expect(scoreDeal(m, { a: 't2', b: 't1', aGives: ['t2p2'], bGives: ['t1p1'], aCards: [], bCards: [] }).ub).toBeLessThan(-0.5)
    const list = candidates(m, 't2')
    const shape = list.find((s) => s.deal.b === 't1' && consolidationBy(m, s.deal) === 't1')
    expect(shape).toBeDefined()
    expect(shape!.deal.bGives.sort()).toEqual(['t1p1', 't1p6'])
    // Two of the deep team's 2nd–4th best (69, 68, 67), never its best (70).
    expect(shape!.deal.aGives.every((p) => ['t2p2', 't2p3', 't2p4'].includes(p))).toBe(true)
    expect(shape!.ua).toBeGreaterThan(0.15)
    expect(shape!.ub).toBeGreaterThanOrEqual(-0.5)
  })

  it('the star’s own GM can offer it the other way round, competing with its other deals', () => {
    // A GM who doesn't chase stars: sending the best player in a deal costs it nothing extra.
    const m = custom({ t1: thin, t2: deep, t3: EVEN, t4: EVEN }, { leaning: { t1: { philosophy: 'balanced', traits: { star_chasing: 1 } } } })
    const back = candidates(m, 't1').find((s) => s.deal.b === 't2' && consolidationBy(m, s.deal) === 't1')
    expect(back).toBeDefined()
    expect(back!.deal.aGives.sort()).toEqual(['t1p1', 't1p6'])
    expect(back!.ua).toBeGreaterThan(0.15)
    expect(back!.ub).toBeGreaterThanOrEqual(-0.5)
  })

  it('scores a consolidation the same from either side', () => {
    const m = custom({ t1: thin, t2: deep, t3: EVEN, t4: EVEN })
    // (a) 가람고 sends its best and weakest for 누리고's 2nd and 3rd; (b) the same trade offered by 누리고.
    const sells = scoreDeal(m, { a: 't1', b: 't2', aGives: ['t1p1', 't1p6'], bGives: ['t2p2', 't2p3'], aCards: [], bCards: [] })
    const buys = scoreDeal(m, { a: 't2', b: 't1', aGives: ['t2p2', 't2p3'], bGives: ['t1p1', 't1p6'], aCards: [], bCards: [] })
    expect([sells.ua, sells.ub]).toEqual([buys.ub, buys.ua])
    expect(sells.gap).toBe(-buys.gap)
    // 누리고: 85 70 67 66 60 start, 40 sits (68.2), up from 70 69 68 67 66 and 60 (67.6).
    expect([buys.a.before, buys.a.after]).toEqual([67.6, 68.2])
    // 가람고: 69 68 55 52 50 start, 48 sits (58.3), up from 85 55 52 50 48 and 40 (57.1).
    expect([sells.a.before, sells.a.after]).toEqual([57.1, 58.3])
    expect(sells.ua).toBe(1.2)
    expect(buys.ua).toBe(0.6)
    expect(consolidationBy(m, sells.deal)).toBe('t1')
    expect(consolidationBy(m, { a: 't1', b: 't2', aGives: ['t1p1', 't1p2'], bGives: ['t2p2', 't2p3'], aCards: [], bCards: [] })).toBeNull()
  })
})

describe('superstar trades: card packages', () => {
  // 가람고(t1) has an unhappy star (90); 누리고(t2), a contender, has a good player (72) and cards worth 4 to 12.
  const seller = [90, 58, 56, 54, 52, 50]
  const contender = [72, 58, 56, 54, 52, 50]
  const card = (id: number, original: string, tradable = true): MarketCard => ({ id, ownerTeamId: 't2', originalTeamId: original, tradable })
  // Worth (ranking t1..t4): 11 → 4, 12 → 6.7, 13 → 9.3, 14 → 12. 15 can't be traded now.
  const cards = [card(11, 't1'), card(12, 't2'), card(13, 't3'), card(14, 't4'), card(15, 't4', false)]
  const winNow = { philosophy: 'win-now' as const, traits: {} }
  const develop = { philosophy: 'development' as const, traits: {} }
  // 누리고's good player for 가람고's star, whatever cards go with them.
  const forStar = (s: Scored) => same(s.deal, ['t2p1'], ['t1p1'])
  const worth = (m: Market, ids: number[]) => ids.reduce((sum, id) => sum + cardValue(m, m.cards.find((c) => c.id === id)!), 0)

  it('a contender adds the cheapest cards that win the seller over and keep the deal fair, within its room, never one it can’t trade', () => {
    const m = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t1: develop, t2: winNow }, unhappy: ['t1p1'], cards, room: { t2: 2 } })
    const plain = scoreDeal(m, { a: 't2', b: 't1', aGives: ['t2p1'], bGives: ['t1p1'], aCards: [], bCards: [] })
    expect(plain.ub).toBeLessThan(-0.5)
    const offer = candidates(m, 't2').find(forStar)!
    expect(offer).toBeDefined()
    expect(offer.ub).toBeGreaterThanOrEqual(0)
    expect(Math.abs(offer.gap)).toBeLessThan(LOPSIDED_GAP)
    // Every package it could have used (one or two tradable cards): none cheaper wins the seller over in a fair deal.
    // (His unhappy star counts for less to him, so a 4-point card alone would do, but 18 points for 4 is lopsided.)
    const tradable = [11, 12, 13, 14]
    const packs = [...tradable.map((x) => [x]), ...tradable.flatMap((x, i) => tradable.slice(i + 1).map((y) => [x, y]))]
    const cheaper = packs.filter((p) => worth(m, p) < worth(m, offer.deal.aCards))
    for (const p of cheaper) {
      const s = scoreDeal(m, { ...plain.deal, aCards: p })
      expect(s.ub < 0 || Math.abs(s.gap) >= LOPSIDED_GAP).toBe(true)
    }
    expect(offer.deal.aCards).toEqual([13])
    for (const s of [...candidates(m, 't2'), ...counters(m, plain.deal)]) expect([...s.deal.aCards, ...s.deal.bCards]).not.toContain(15)
  })

  it('never goes past the room the in-season cap leaves', () => {
    // A balanced seller of a happy star wants more: two cards (6.7 + 12, the cheapest pair over the line), or none with room for one.
    const open = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t2: winNow }, cards, room: { t2: 2 } })
    const two = candidates(open, 't2').find(forStar)!
    expect(two.deal.aCards.sort()).toEqual([12, 14])
    expect(two.ub).toBeGreaterThanOrEqual(0)
    const capped = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t2: winNow }, cards, room: { t2: 1 } })
    for (const s of [...candidates(capped, 't2'), ...counters(capped, two.deal)]) expect(s.deal.aCards.length).toBeLessThanOrEqual(1)
    expect(candidates(capped, 't2').some(forStar)).toBe(false)
    const spent = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t2: winNow }, cards, room: { t2: 0 } })
    for (const s of candidates(spent, 't2')) expect(s.deal.aCards).toEqual([])
  })

  it('단장 설정 sets how many cards a side may carry: fewer, none, or as many as it holds', () => {
    const market = (dealCards: number | null) => {
      // A balanced seller of a happy star wants two cards (6.7 + 12); no in-season cap left to say otherwise.
      const m = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t2: winNow }, cards })
      m.config.gm.dealCards = dealCards
      return m
    }
    const all = (m: Market) => [...candidates(m, 't2'), ...counters(m, { a: 't2', b: 't1', aGives: ['t2p1'], bGives: ['t1p1'], aCards: [], bCards: [] })]
    const one = market(1)
    for (const s of all(one)) expect(Math.max(s.deal.aCards.length, s.deal.bCards.length)).toBeLessThanOrEqual(1)
    expect(candidates(one, 't2').some(forStar)).toBe(false)
    for (const s of all(market(0))) expect([...s.deal.aCards, ...s.deal.bCards]).toEqual([])
    // No limit: the two-card offer is back, and nothing carries more than the four cards it can trade.
    const open = market(null)
    expect(candidates(open, 't2').find(forStar)?.deal.aCards.sort()).toEqual([12, 14])
    for (const s of all(open)) expect(s.deal.aCards.length).toBeLessThanOrEqual(4)
  })

  it('the receiver can ask for cards in a counter', () => {
    const m = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t2: winNow }, unhappy: ['t1p1'], cards, room: { t2: 2 } })
    const offer: Deal = { a: 't2', b: 't1', aGives: ['t2p1'], bGives: ['t1p1'], aCards: [], bCards: [] }
    expect(scoreDeal(m, offer).ub).toBeLessThan(0)
    const asked = counters(m, offer).find((c) => same(c.deal, ['t2p1'], ['t1p1']))
    expect(asked).toBeDefined()
    expect(asked!.deal.aCards.length).toBeGreaterThan(0)
    expect(asked!.ub).toBeGreaterThanOrEqual(0)
    expect(asked!.ua).toBeGreaterThan(-0.3)
  })

  it('a rebuilding GM with an unhappy star takes a good player and cards from a contender; a win-now GM doesn’t', () => {
    const deal: Deal = { a: 't2', b: 't1', aGives: ['t2p1'], bGives: ['t1p1'], aCards: [13, 14], bCards: [] }
    const rebuilding = scoreDeal(custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t1: develop, t2: winNow }, unhappy: ['t1p1'], cards }), deal)
    const contending = scoreDeal(custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t1: winNow, t2: winNow }, unhappy: ['t1p1'], cards }), deal)
    expect(rebuilding.ub).toBeGreaterThan(0)
    expect(contending.ub).toBeLessThan(0)
    // The contender likes it either way: it gets the star.
    expect(rebuilding.ua).toBeGreaterThan(0)
    expect(Math.abs(rebuilding.gap)).toBeLessThan(LOPSIDED_GAP)
  })

  it('cards top up a player trade, never buy a star for a bench player', () => {
    // 누리고 offers its worst player and its three cards for the star: the cards would cover it for a rebuilding seller, but it isn't offered.
    const m = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t1: develop, t2: winNow }, unhappy: ['t1p1'], cards, room: { t2: 3 } })
    for (const s of [...candidates(m, 't2'), ...counters(m, { a: 't2', b: 't1', aGives: ['t2p6'], bGives: ['t1p1'], aCards: [], bCards: [] })]) {
      if (s.deal.aCards.length + s.deal.bCards.length > 0) expect(Math.abs(s.gap)).toBeLessThan(LOPSIDED_GAP)
      expect(same(s.deal, ['t2p6'], ['t1p1']) && s.deal.aCards.length > 0).toBe(false)
    }
  })

  it('a deal offered earlier is still open only while its players and cards are where they were, and the cap has room', () => {
    const m = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { cards, room: { t2: 2 } })
    const deal = (aCards: number[]): Deal => ({ a: 't2', b: 't1', aGives: ['t2p1'], bGives: ['t1p1'], aCards, bCards: [] })
    expect(dealStillOpen(m, deal([11, 13]))).toBe(true)
    // Past the room the cap leaves, a card that can't be traded now, a card it doesn't hold, a player gone elsewhere.
    expect(dealStillOpen(m, deal([11, 12, 13]))).toBe(false)
    expect(dealStillOpen(m, deal([15]))).toBe(false)
    expect(dealStillOpen(custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { cards: cards.map((c) => (c.id === 13 ? { ...c, ownerTeamId: 't3' } : c)) }), deal([13]))).toBe(false)
    expect(dealStillOpen(m, { ...deal([]), bGives: ['t3p1'] })).toBe(false)
  })

  it('a star chaser’s bold try may come with a package', () => {
    const chaser = { philosophy: 'win-now' as const, traits: { star_chasing: 5 } }
    const m = custom({ t1: seller, t2: contender, t3: EVEN, t4: EVEN }, { leaning: { t1: develop, t2: chaser }, cards, room: { t2: 2 } })
    const bold = candidates(m, 't2').filter((s) => s.deal.bGives.includes('t1p1'))
    expect(bold.length).toBeGreaterThan(0)
    expect(bold.some((s) => s.deal.aCards.length > 0 && s.ub >= 0)).toBe(true)
  })
})

/** A 36-team league like the user's: six a team, a few stars, three cards each under a cap of three, some locks, varied GMs. */
function league36(seed: string): { m: Market; ctx: TradeContext } {
  const config = sampleConfig()
  config.draft = { ...defaultCardSwap(36), cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' } }
  config.trades = { ...config.trades, oncePerSeason: { enabled: true, until: 'draft' } }
  const random = rng(seed)
  const slots = config.roster.slots.map((s) => s.id)
  const divisions = config.structure.divisions.map((d) => d.id)
  const philosophies = ['win-now', 'balanced', 'development'] as const
  const trait = () => 1 + Math.floor(random() * 5)
  const used = new Map<string, number>()
  const teams: MarketTeam[] = Array.from({ length: 36 }, (_, i) => {
    const id = `t${i + 1}`
    used.set(id, Math.floor(random() * 4))
    return {
      id,
      divisionId: divisions[i % divisions.length]!,
      leaning: { philosophy: philosophies[Math.floor(random() * 3)]!, traits: { risk: trait(), loyalty: trait(), star_chasing: trait(), regional_pride: trait() } },
      tradable: i % 9 !== 0,
      cardRoom: 3 - used.get(id)!,
    }
  })
  const players: MarketPlayer[] = teams.flatMap((t, ti) =>
    slots.map((slot, si) => ({
      id: `${t.id}p${si + 1}`,
      teamId: t.id,
      slotId: slot,
      value: Math.round((si === 0 && ti % 3 === 0 ? 80 + random() * 15 : 48 + random() * 26) * 10) / 10,
      unhappy: random() < 0.08,
      franchise: random() < 0.05,
      locked: random() < 0.1,
    })),
  )
  const cards = teams.flatMap((t, ti) => [0, 1, 2].map((n) => ({ id: ti * 3 + n + 1, ownerTeamId: t.id, originalTeamId: teams[(ti + n * 7) % 36]!.id, tradable: (t.cardRoom ?? 3) > 0 })))
  const ranking = teams.map((t) => t.id).sort(() => random() - 0.5)
  const m: Market = { config, teams, players, cards, ranking }
  const ctx: TradeContext = {
    config,
    phase: 'regular',
    teams: teams.map((t) => ({ id: t.id, control: t.tradable ? 'ai' : 'frozen' })),
    players: players.map((p) => ({ id: p.id, teamId: p.teamId, slotId: p.slotId })),
    cards: cards.map((c) => ({ id: c.id, ownerTeamId: c.ownerTeamId, status: 'held' })),
    lockedPlayers: new Set(players.filter((p) => p.locked).map((p) => p.id)),
    cardTradeCounts: new Map([...used].map(([team, given]) => [team, { given, received: 0, trades: given }])),
    draftMoved: new Set(),
  }
  return { m, ctx }
}

const itemsOf = (d: Deal): TradeItem[] => [
  ...d.aGives.map((playerId): TradeItem => ({ kind: 'player', playerId, from: d.a, to: d.b })),
  ...d.bGives.map((playerId): TradeItem => ({ kind: 'player', playerId, from: d.b, to: d.a })),
  ...d.aCards.map((cardId): TradeItem => ({ kind: 'card', cardId, from: d.a, to: d.b })),
  ...d.bCards.map((cardId): TradeItem => ({ kind: 'card', cardId, from: d.b, to: d.a })),
]

describe('the market at league size', () => {
  it('every deal it offers or counters with passes the trade rules (equal counts, slots, locks, cards and the cap)', () => {
    const { m, ctx } = league36('rules')
    let checked = 0
    const shapes = { twos: 0, consolidations: 0, packages: 0, asks: 0 }
    for (const t of m.teams.filter((x) => x.tradable)) {
      const offers = candidates(m, t.id)
      for (const s of [...offers, ...(offers[0] ? counters(m, offers[0].deal) : [])]) {
        const check = checkTrade(itemsOf(s.deal), ctx)
        expect(check.issues, JSON.stringify(s.deal)).toEqual([])
        checked++
        if (s.deal.aGives.length === 2) shapes.twos++
        if (consolidationBy(m, s.deal)) shapes.consolidations++
        if (s.deal.aCards.length) shapes.packages++
        if (s.deal.bCards.length) shapes.asks++
      }
    }
    expect(checked).toBeGreaterThan(100)
    // Every shape turns up somewhere in a league this size.
    for (const n of Object.values(shapes)) expect(n).toBeGreaterThan(0)
  })

  it('stays quick: twelve full searches on 36 teams', () => {
    // About 50 ms on the machine it was written on, before and after consolidations and packages; the bound only catches a blow-up.
    candidates(league36('warm').m, 't2')
    const { m } = league36('speed')
    const start = performance.now()
    for (const t of m.teams.filter((x) => x.tradable).slice(0, 12)) candidates(m, t.id)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('blockbusters', () => {
  // The league's best players here: t1p1 (90) and t3p1 (88) are its top two; the other teams' best are 60.
  const m = custom({ t1: [90, 58, 56, 54, 52, 50], t2: EVEN, t3: [88, 58, 56, 54, 52, 50], t4: EVEN }, { franchise: ['t2p1'], cards: [{ id: 21, ownerTeamId: 't2', originalTeamId: 't4', tradable: true }, { id: 22, ownerTeamId: 't2', originalTeamId: 't3', tradable: true }] })
  const deal = (a: string, b: string, aGives: string[], bGives: string[], aCards: number[] = []): Deal => ({ a, b, aGives, bGives, aCards, bCards: [] })

  it('a trade that moves a star is one; an ordinary trade isn’t', () => {
    // 24 players: the best one (10 of 216) is a star; the best two count when the trade makes them its headline.
    expect(isBlockbuster(m, deal('t2', 't1', ['t2p2'], ['t1p1']))).toBe(true)
    expect(isBlockbuster(m, deal('t2', 't3', ['t2p2'], ['t3p2']))).toBe(false)
    // The second best moving for a player alone isn't one; with two cards, or as his team's best in a consolidation, it is.
    expect(isBlockbuster(m, deal('t2', 't3', ['t2p2'], ['t3p1']))).toBe(false)
    expect(isBlockbuster(m, deal('t2', 't3', ['t2p2'], ['t3p1'], [21, 22]))).toBe(true)
    expect(isBlockbuster(m, deal('t2', 't3', ['t2p2', 't2p3'], ['t3p1', 't3p6']))).toBe(true)
    // A franchise player who isn't among the league's best isn't a star.
    expect(isBlockbuster(m, deal('t2', 't3', ['t2p1'], ['t3p2']))).toBe(false)
  })

  it('the season’s first star trade is one; after it, only a bigger star among the very best', () => {
    // The league's second best, with two cards: the season's first blockbuster.
    const second = deal('t2', 't3', ['t2p2'], ['t3p1'], [21, 22])
    const best = deal('t2', 't1', ['t2p2'], ['t1p1'])
    expect(isBlockbuster(m, second, [])).toBe(true)
    // One already moved the league's best: the second best moving now is ordinary news.
    expect(isBlockbuster(m, second, [['t1p1', 't4p6']])).toBe(false)
    // One already, not as big: the league's best moving still is one; the second best (a star only with cards) isn't.
    expect(isBlockbuster(m, best, [['t3p1', 't4p6']])).toBe(true)
    expect(isBlockbuster(m, second, [['t2p3', 't4p5']])).toBe(false)
  })
})

describe('GMs as a front office: where the team stands, early-season caution, unhappy players, roles', () => {
  const winNow = { philosophy: 'win-now' as const, traits: {} }
  const develop = { philosophy: 'development' as const, traits: {} }
  /** The four schools (all in one conference, two direct playoff seeds) `played` games into a 120-game season, with these records and this table. */
  const at = (m: Market, played: number, records: Record<string, [number, number]>, ranking: string[]) => {
    m.season = { phase: 'regular', played, total: 120 }
    for (const t of m.teams) {
      const r = records[t.id]
      if (r) t.record = { wins: r[0], losses: r[1] }
    }
    m.ranking = ranking
    return m
  }
  const card = (id: number, owner: string): MarketCard => ({ id, ownerTeamId: owner, originalTeamId: owner, tradable: true })

  it('reads contender, bubble or rebuilding from strength early on and from the table as games mount', () => {
    // 가람고 (t1) is the strongest; 나람고 (t3) the weakest.
    const values = { t1: [72, 70, 68, 66, 64, 60], t2: EVEN, t3: [52, 50, 48, 46, 44, 40], t4: EVEN }
    const early = at(custom(values), 4, { t1: [0, 2], t2: [1, 1], t3: [2, 0], t4: [1, 1] }, ['t3', 't2', 't4', 't1'])
    expect(standingOf(early, 't1')).toMatchObject({ stance: 'contender', rank: 4, strengthRank: 1, line: 2 })
    expect(standingOf(early, 't3').stance).toBe('rebuilding')
    // Late, the table says it: 가람고 last, 나람고 first.
    const late = at(custom(values), 108, { t1: [4, 50], t2: [27, 27], t3: [50, 4], t4: [27, 27] }, ['t3', 't2', 't4', 't1'])
    expect(standingOf(late, 't1').stance).toBe('rebuilding')
    expect(standingOf(late, 't3').stance).toBe('contender')
    // The lean grows with the season: a quarter of it early, all of it by 60% of the games.
    expect(standingOf(early, 't1').lean).toBeCloseTo(0.25 + 0.75 * (4 / 120 / 0.6))
    expect(standingOf(late, 't1').lean).toBe(-1)
    // No season known (the draft, the offseason, tests without one): no lean.
    expect(standingOf(custom(values), 't1').lean).toBe(0)
  })

  it('makes a losing win-now GM lean less win-now late in the season, and a contending developer more willing to buy', () => {
    const cards = [card(31, 't2'), card(32, 't1')]
    // 가람고 sells its third best (68) for 누리고's sixth man (50) and a card.
    const sell: Deal = { a: 't1', b: 't2', aGives: ['t1p3'], bGives: ['t2p6'], aCards: [], bCards: [31] }
    const loser = (played: number, record: [number, number]) =>
      at(custom({ t1: [72, 70, 68, 66, 64, 60], t2: EVEN, t3: EVEN, t4: EVEN }, { leaning: { t1: winNow }, cards }), played, { t1: record }, ['t2', 't3', 't4', 't1'])
    expect(scoreDeal(loser(108, [5, 49]), sell).ua).toBeGreaterThan(scoreDeal(loser(6, [0, 3]), sell).ua + 0.5)
    // 가람고, a developer leading the table late, adds its sixth man (50) and a card for 누리고's best (60).
    const buy: Deal = { a: 't1', b: 't2', aGives: ['t1p6'], bGives: ['t2p1'], aCards: [32], bCards: [] }
    const developer = (record: [number, number], ranking: string[]) => at(custom({ t1: EVEN, t2: EVEN, t3: EVEN, t4: EVEN }, { leaning: { t1: develop }, cards }), 108, { t1: record }, ranking)
    const leading = developer([49, 5], ['t1', 't2', 't3', 't4'])
    const trailing = developer([5, 49], ['t2', 't3', 't4', 't1'])
    expect(standingOf(leading, 't1').stance).toBe('contender')
    expect(scoreDeal(leading, buy).ua).toBeGreaterThan(scoreDeal(trailing, buy).ua + 0.5)
  })

  it('is cautious early in the regular season: in full until 20% of the games, gone by 35%, never in the preseason or when 단장 설정 turns it off', () => {
    const when = (phase: 'preseason' | 'regular', played: number, on = true) => {
      const m = market()
      m.season = { phase, played, total: 100 }
      m.config.gm.earlyCaution = on
      return m
    }
    expect(caution(when('regular', 10))).toBe(1)
    expect(caution(when('regular', 20))).toBe(1)
    expect(caution(when('regular', 27.5))).toBeCloseTo(0.5)
    expect(caution(when('regular', 35))).toBe(0)
    expect(caution(when('preseason', 0))).toBe(0)
    expect(caution(when('regular', 10, false))).toBe(0)
    expect(cautionBar(when('regular', 10))).toBe(0.6)
    // Every deal offered early must clear the higher bar, so there are fewer of them.
    const early = candidates(when('regular', 10), 't2')
    for (const s of early) expect(s.ua).toBeGreaterThan(0.75)
    expect(early.length).toBeLessThan(candidates(when('regular', 50), 't2').length)
  })

  it('counts an unhappy player for less on both sides: the buyer pays less, the seller takes less', () => {
    const swap: Deal = { a: 't2', b: 't3', aGives: ['t2p2'], bGives: ['t3p1'], aCards: [], bCards: [] }
    const happy = scoreDeal(market(), swap)
    const sour = scoreDeal(market({ unhappy: ['t3p1'] }), swap)
    expect(sour.ua).toBeLessThan(happy.ua)
    expect(sour.a.perceived!.after).toBeLessThan(sour.a.after)
    // Losing him costs his own GM less (and moving him on is a plus besides).
    expect(sour.ub).toBeGreaterThan(happy.ub + 0.8)
    // What the report shows is his real worth.
    expect([sour.a.after, sour.b.after, sour.gap]).toEqual([happy.a.after, happy.b.after, happy.gap])
  })

  it('weighs a lineup’s core roles: losing the only ball handler costs a clear point', () => {
    const roled = () => {
      const m = custom({ t1: EVEN, t2: EVEN, t3: EVEN, t4: EVEN })
      m.config = twoKConfig()
      for (const p of m.players) p.roles = p.slotId === 'pg' ? ['handler'] : p.slotId === 'c' ? ['big'] : p.slotId === 'sg' ? ['shooter', 'stopper'] : ['shooter']
      return m
    }
    // 가람고 sends its point guard (60, its only handler) for 누리고's small forward (56).
    const d: Deal = { a: 't1', b: 't2', aGives: ['t1p1'], bGives: ['t2p3'], aCards: [], bCards: [] }
    const m = roled()
    const s = scoreDeal(m, d)
    expect(roleNews(m, s.a)).toEqual({ lost: ['handler'], filled: [] })
    const blind = custom({ t1: EVEN, t2: EVEN, t3: EVEN, t4: EVEN })
    blind.config = twoKConfig()
    expect(s.ua).toBeCloseTo(scoreDeal(blind, d).ua - ROLE_LOSS, 1)
    // 누리고 gets a second handler: no gap filled, nothing lost.
    expect(roleNews(m, s.b)).toEqual({ lost: [], filled: [] })
  })
})
