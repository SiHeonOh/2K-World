import { describe, expect, it } from 'vitest'
import { twoKConfig, TWO_K_CATEGORIES } from '@shared/testing/fixtures'
import { candidates, cardValue, counters, draftAfter, draftOutlook, projectedCards, roleNews, scoreDeal, versusAsk, type Deal, type Market, type MarketPlayer, type MarketTeam } from './market'
import { playerRoles } from './roles'
import { playerValue } from './value'

/**
 * Two trades the AI GMs made in a real 36-school 2K league early in its
 * first season, rebuilt with made-up names and the same ratings, slots,
 * cards and GMs. With the flat average of every rating, both looked fine to
 * code; a 2K front office would have turned down the first and kept its
 * cards in the second.
 */

const config = twoKConfig()
const SLOTS = ['pg', 'sg', 'sf', 'pf', 'c', '6th-man']
const rated = (ovr: number, grades: string) => {
  const g = grades.split(' ')
  return { ovr, ...Object.fromEntries(TWO_K_CATEGORIES.map((name, i) => [name.toLowerCase().replace(/\s+/g, '-'), g[i]!])) }
}

/** A school of six (PG, SG, SF, PF, C, 6th man): name, OVR and the nine grades (골밑 득점 … 농구 센스). */
type Six = [string, number, string][]

// 누리고 (win-now, hardball): a 96 at SG, and 도윤재, its only point guard who runs the offense.
const NURI: Six = [
  ['도윤재', 88, 'B+ B+ B- C- B A C- A- A-'],
  ['김하람', 96, 'A A A+ B- A B C+ A+ A-'],
  ['이서진', 85, 'B C B+ A A C+ B+ A C+'],
  ['박태오', 84, 'A B+ A B- C+ A- B A+ C+'],
  ['정우빈', 88, 'A- D D A+ C- C A+ B C+'],
  ['최민재', 76, 'C+ C C C- B+ C- C A+ D+'],
]
// 가람고 (development, fair, patience 5).
const GARAM: Six = [
  ['한지후', 83, 'C+ B+ A+ D+ C+ A- C B+ B'],
  ['윤시우', 83, 'B B A+ B- A+ B- C+ A+ B+'],
  ['강도현', 87, 'B+ A- A B+ B+ B- B A+ B+'],
  ['임건우', 81, 'C+ C- C- A B- C- A A D-'],
  ['오준서', 75, 'C B- B A B- C C+ B C-'],
  ['서은호', 72, 'D+ B A C- B+ C C- C+ D'],
]
// 다온고 (win-now, hardball): 진세윤, a 95 and one of the league's best, and 남궁현, an unhappy sixth man.
const DAON: Six = [
  ['문태윤', 77, 'B- B- A C A- B+ C- C+ B'],
  ['배준혁', 80, 'C+ C A B- A- B- C B B+'],
  ['송하준', 88, 'A- C+ C- A- B- C+ A A+ B+'],
  ['진세윤', 95, 'A- A A A- B+ A- A- B- A+'],
  ['홍지원', 88, 'A- B+ B- A- C+ C B C B-'],
  ['남궁현', 80, 'C B- B- B- A C+ C+ B+ B-'],
]
// 한빛고 (development, fair, defense first).
const HANBIT: Six = [
  ['유태민', 78, 'C B- C+ C B+ B+ C A- B'],
  ['차은결', 84, 'B B+ A B B+ A- C+ A- B+'],
  ['권시온', 85, 'C+ B- A- A- A+ B- B+ A- A-'],
  ['하준영', 87, 'B+ A- D+ B- C- A- B+ C- A'],
  ['양도겸', 83, 'A D+ D+ B+ C+ C B+ A+ C-'],
  ['구민혁', 82, 'A- A A+ D+ D+ C- C- A+ D-'],
]

const lean = (philosophy: MarketTeam['leaning']['philosophy'], traits: Record<string, number>) => ({ philosophy, traits })
const LEANINGS: Record<string, MarketTeam['leaning']> = {
  nuri: lean('win-now', { risk: 4, patience: 2, loyalty: 3, star_chasing: 4, defense_first: 2, regional_pride: 4, ego: 4 }),
  garam: lean('development', { risk: 2, patience: 5, loyalty: 4, star_chasing: 2, defense_first: 2, regional_pride: 4, ego: 2 }),
  daon: lean('win-now', { risk: 3, patience: 2, loyalty: 4, star_chasing: 4, defense_first: 3, regional_pride: 3, ego: 4 }),
  hanbit: lean('development', { risk: 2, patience: 4, loyalty: 4, star_chasing: 2, defense_first: 4, regional_pride: 4, ego: 2 }),
}
// 누리고 and 가람고 in the east, in different divisions; 한빛고 with 가람고; 다온고 in the west.
const DIVISIONS: Record<string, string> = { nuri: 'd4', garam: 'd5', daon: 'd1', hanbit: 'd5' }
const ROSTERS: Record<string, Six> = { nuri: NURI, garam: GARAM, daon: DAON, hanbit: HANBIT }
const id = (name: string) => `${Object.entries(ROSTERS).find(([, six]) => six.some(([n]) => n === name))![0]}:${name}`

/**
 * The league early in its first season: the four schools above and 32 others
 * valued like a 2K league's players (made-up), each covering the usual
 * roles. Every school holds its own three cards; `at` puts schools at places
 * in the table (0 the first), everyone else after them in order.
 */
function league(over: { at: Record<string, number>; unhappy?: string[]; played: number }): Market {
  const teams: MarketTeam[] = []
  const players: MarketPlayer[] = []
  for (const [team, six] of Object.entries(ROSTERS)) {
    teams.push({ id: team, divisionId: DIVISIONS[team]!, leaning: LEANINGS[team]!, tradable: true, cardRoom: 3, record: { wins: 0, losses: 0 }, issued: 3 })
    six.forEach(([name, ovr, grades], i) => {
      const ratings = rated(ovr, grades)
      players.push({
        id: `${team}:${name}`,
        teamId: team,
        slotId: SLOTS[i]!,
        value: playerValue(config, ratings),
        unhappy: over.unhappy?.includes(name) ?? false,
        locked: false,
        roles: playerRoles(config, SLOTS[i]!, ratings),
      })
    })
  }
  const usual = [['handler'], ['shooter', 'stopper'], ['shooter'], [], ['big'], []] as const
  for (let k = 0; k < 32; k++) {
    const team = `x${k + 1}`
    teams.push({ id: team, divisionId: `d${(k % 6) + 1}`, leaning: lean('balanced', {}), tradable: true, cardRoom: 3, record: { wins: 0, losses: 0 }, issued: 3 })
    const lift = (((k * 7) % 11) - 5) * 1.1
    ;[83, 82, 84, 82, 81, 73].forEach((base, i) => {
      // Every fourth school has a star of its own.
      const value = Math.round((k % 4 === 0 && i === 2 ? 91 + (k % 5) : base + lift) * 10) / 10
      players.push({ id: `${team}p${i + 1}`, teamId: team, slotId: SLOTS[i]!, value, unhappy: false, locked: false, roles: [...usual[i]!] })
    })
  }
  const placed = Object.entries(over.at).sort((a, b) => a[1] - b[1])
  const rest = teams.map((t) => t.id).filter((t) => !(t in over.at))
  const ranking: string[] = []
  for (let i = 0; i < teams.length; i++) {
    const here = placed.find(([, at]) => at === i)
    ranking.push(here ? here[0] : rest.shift()!)
  }
  const cards = teams.flatMap((t, ti) => [1, 2, 3].map((n) => ({ id: ti * 3 + n, ownerTeamId: t.id, originalTeamId: t.id, tradable: true })))
  return { config, teams, players, cards, ranking, season: { phase: 'regular', played: over.played, total: 630 } }
}

const ownCards = (m: Market, team: string) => m.cards.filter((c) => c.ownerTeamId === team).map((c) => c.id)
const deal = (a: string, b: string, aGives: string[], bGives: string[], aCards: number[] = []): Deal => ({ a, b, aGives: aGives.map(id), bGives: bGives.map(id), aCards, bCards: [] })

describe('the real case of a counter a win-now GM should have refused', () => {
  // After 13 of 630 games. 누리고's two cards are worth about 8.6 each (its place in the table then).
  const m = league({ at: { nuri: 20 }, played: 13 })
  const cards = ownCards(m, 'nuri').slice(0, 2)
  // It asked for 강도현 (SF 87) and 윤시우 (SG 83), offering 정우빈 (C 88), 도윤재 (PG 88) and two cards…
  const asked = deal('nuri', 'garam', ['정우빈', '도윤재'], ['강도현', '윤시우'], cards)
  // …and 가람고 came back with 윤시우 and 서은호 (6th 72) for 도윤재, 최민재 (6th 76) and the same two cards.
  const counter = deal('nuri', 'garam', ['도윤재', '최민재'], ['윤시우', '서은호'], cards)

  it('values the point guard above the shooting guard now, as 2K does', () => {
    const value = (name: string) => m.players.find((p) => p.id === id(name))!.value
    expect(value('도윤재')).toBeGreaterThan(value('윤시우'))
    expect(cardValue(m, { originalTeamId: 'nuri' }) * 2).toBeCloseTo(17.1, 0)
  })

  it('gives the win-now GM a negative utility for the counter it took at 0.61', () => {
    const s = scoreDeal(m, counter)
    expect(s.ua).toBeLessThan(0)
    // Its strength drops, and its lineup loses the only player who runs the offense.
    expect(s.a.after).toBeLessThan(s.a.before)
    expect(roleNews(m, s.a).lost).toContain('handler')
    // Even its own first ask was no good for it by these numbers: no offer code would have listed.
    expect(scoreDeal(m, asked).ua).toBeLessThan(0)
    expect(candidates(m, 'nuri').some((o) => o.deal.b === 'garam' && o.deal.aGives.includes(id('도윤재')) && o.deal.aCards.length === 2)).toBe(false)
  })

  it('shows the counter against its ask: whom it got instead of the player it wanted, and what that costs', () => {
    const diff = versusAsk(m, asked, counter)
    expect(diff.dropped).toEqual([id('강도현')])
    expect(diff.added).toEqual([id('서은호')])
    expect(diff.spared).toEqual([id('정우빈')])
    expect(diff.extra).toEqual([id('최민재')])
    expect(diff.value).toBeLessThan(0)
    expect(diff.strength).toBeLessThan(0)
    expect(diff.utility).toBeLessThan(0)
  })
})

describe('the real case of a contender that traded away every card it had', () => {
  // After 16 games, 다온고 is 13th (its cards worth about 6.7 each): 4 cards by season's end (3 held + 1 for 2nd–16th).
  const m = league({ at: { daon: 12 }, unhappy: ['남궁현'], played: 16 })
  const players = deal('daon', 'hanbit', ['문태윤', '남궁현'], ['차은결', '유태민'])
  const all3 = { ...players, aCards: ownCards(m, 'daon') }

  it('projects its draft cards from the cards it holds and what its place earns, by one formula', () => {
    expect(projectedCards(config.draft.kind === 'card-swap' ? config.draft.allocation : [], 13, 3, 3)).toBe(4)
    expect(projectedCards(config.draft.kind === 'card-swap' ? config.draft.allocation : [], 20, 3, 3)).toBe(3)
    expect(projectedCards(config.draft.kind === 'card-swap' ? config.draft.allocation : [], 1, 0, 3)).toBe(2)
    const now = draftOutlook(m, 'daon')!
    expect(now.cards).toBe(4)
    // Its 95 and its 88 are the two worth a card; it can protect both now.
    expect(now.need).toEqual([id('진세윤'), id('송하준')])
    expect(now.exposed).toEqual([])
  })

  it('makes all three cards cost far more than their worth as picks: they leave a star for the draft', () => {
    const plain = scoreDeal(m, players)
    const s = scoreDeal(m, all3)
    expect(draftAfter(m, all3, 'daon')!.exposed).toEqual([id('송하준')])
    expect(s.a.draft!.premium).toBeGreaterThan(8)
    // Its utility falls by more than the three cards' worth as picks to a win-now GM, and goes below zero.
    const asPicks = (0.6 * s.a.cardsOut) / 5
    expect(plain.ua - s.ua).toBeGreaterThan(asPicks + 1.5)
    expect(s.ua).toBeLessThan(0)
    // Had it been 20th (no card more at season's end), the 95 himself would go unprotected.
    const lower = league({ at: { daon: 19 }, unhappy: ['남궁현'], played: 16 })
    const worse = scoreDeal(lower, { ...all3, aCards: ownCards(lower, 'daon') })
    expect(worse.a.draft!.exposed).toEqual([id('진세윤'), id('송하준')])
    expect(worse.a.draft!.premium).toBeGreaterThan(s.a.draft!.premium + 15)
  })

  it('prefers a smaller package, or none: what 한빛고 may ask for leaves 다온고 able to protect both', () => {
    for (const c of counters(m, players)) {
      if (c.deal.aCards.length === 0) continue
      expect(c.deal.aCards.length).toBeLessThanOrEqual(2)
      expect(draftAfter(m, c.deal, 'daon')!.exposed).toEqual([])
    }
    for (const o of candidates(m, 'daon').filter((x) => x.deal.b === 'hanbit')) expect(o.deal.aCards.length).toBeLessThanOrEqual(2)
    // A rebuilding-minded GM still takes cards gladly: two of them are worth it to 한빛고.
    const two = scoreDeal(m, { ...players, aCards: ownCards(m, 'daon').slice(0, 2) })
    expect(two.ub).toBeGreaterThan(scoreDeal(m, players).ub)
    expect(two.ua).toBeGreaterThan(scoreDeal(m, all3).ua + 2)
  })
})
