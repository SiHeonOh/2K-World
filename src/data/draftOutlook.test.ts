import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from './db'
import { currentSeason, seedLeague } from './league'
import { applyTrade, closeProtection, listCards } from './moves'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from './season'
import { draftWatch, leagueStars, projectedDraftCards, readDraftOutlook } from './draftOutlook'

const TIERS = [
  { fromRank: 1, toRank: 1, cards: 5 },
  { fromRank: 2, toRank: 16, cards: 4 },
  { fromRank: 17, toRank: 36, cards: 3 },
]

describe('projectedDraftCards', () => {
  it('is the cards held now plus what the place still brings beyond what was issued', () => {
    // Holding its own three: first place brings two more, 2nd to 16th one, the rest none.
    expect(projectedDraftCards(TIERS, 0, 3, 3)).toBe(5)
    expect(projectedDraftCards(TIERS, 15, 3, 3)).toBe(4)
    expect(projectedDraftCards(TIERS, 16, 3, 3)).toBe(3)
    // Others' cards count once held: its three and two bought, at 20th.
    expect(projectedDraftCards(TIERS, 19, 3, 5)).toBe(5)
    // Its cards traded away: none held, one still to come at 13th, none at 25th.
    expect(projectedDraftCards(TIERS, 12, 3, 0)).toBe(1)
    expect(projectedDraftCards(TIERS, 24, 3, 0)).toBe(0)
    // Before the season nothing is issued; once the playoffs end everything is.
    expect(projectedDraftCards(TIERS, 0, 0, 0)).toBe(5)
    expect(projectedDraftCards(TIERS, 0, 5, 4)).toBe(4)
    // Past the last tier, or a place worth less than what was issued: nothing more (cards aren't taken back).
    expect(projectedDraftCards(TIERS, 40, 3, 3)).toBe(3)
    expect(projectedDraftCards([{ fromRank: 1, toRank: 36, cards: 2 }], 0, 3, 1)).toBe(1)
  })
})

/**
 * A card-swap league of the made-up schools (가람고 t1 … 아람고 t8): 5 cards
 * for 1st, 4 for 2nd to 4th, 3 for the rest, a cap of 3 cards given in
 * season, 바람고 (t6) frozen. Everyone is OVR 60 but five stars, one each
 * at 가람고, 나람고, 다람고, 사람고 and 아람고.
 */
function league(): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 1, cards: 5 },
      { fromRank: 2, toRank: 4, cards: 4 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
  }
  setup.teams[5]!.control = 'frozen'
  const stars: Record<string, number> = { p1: 95, p43: 94, p37: 93, p7: 92, p13: 91 }
  for (const p of setup.players) p.ratings = { ovr: stars[p.id] ?? 60, shoot: 'B' }
  seedLeague(db, setup)
  startSeason(db)
  return db
}

/** Plays every scheduled game of these stages, again and again (series add games): the lower-numbered school wins. */
function playAll(db: Db, stages: (stage: string) => boolean, limit = Infinity): void {
  let played = 0
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && stages(g.stage))
    if (open.length === 0) return
    for (const g of open) {
      if (played++ >= limit) return
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
  }
}

/** A card-only trade: `from`'s own cards with these numbers go to `to`. */
function sellCards(db: Db, from: string, to: string, numbers: number[]): void {
  const cards = listCards(db, currentSeason(db).id).filter((c) => c.originalTeamId === from && numbers.includes(c.number))
  applyTrade(db, cards.map((c) => ({ kind: 'card' as const, cardId: c.id, from, to })))
}

describe('readDraftOutlook', () => {
  it('reads each school’s cards: its own and others’, those it sent, the cap it used, and what its place still brings', () => {
    const db = league()
    playAll(db, (s) => s === 'regular')
    sellCards(db, 't8', 't1', [1, 2, 3])
    sellCards(db, 't7', 't2', [1])
    const o = readDraftOutlook(db)!
    expect(o.phase).toBe('regular')
    expect(o.final).toBe(false)
    expect(o.cap).toEqual({ limit: 3, counts: 'given' })
    expect(o.guaranteed).toBe(3)
    // By place: the lower-numbered school won every game.
    expect(o.schools.map((s) => [s.teamId, s.rank])).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((t, i) => [t, i + 1]))
    const of = (t: string) => o.schools.find((s) => s.teamId === t)!
    const cards = (t: string) => of(t).held.map((c) => `${c.originalTeamId}#${c.number}`)
    // 가람고: its own first, then 아람고's; 1st place brings two more.
    expect(cards('t1')).toEqual(['t1#1', 't1#2', 't1#3', 't8#1', 't8#2', 't8#3'])
    expect(of('t1')).toMatchObject({ issued: 3, toCome: 2, projected: 8, sent: [] })
    expect(of('t2')).toMatchObject({ toCome: 1, projected: 5 })
    // 아람고 sold all three (the cap, used up) and its 8th place brings none: nothing at the draft.
    expect(of('t8')).toMatchObject({ held: [], toCome: 0, projected: 0, inSeason: { given: 3, received: 0, trades: 1 } })
    expect(of('t8').sent.map((s) => [s.card.number, s.to])).toEqual([
      [1, 't1'],
      [2, 't1'],
      [3, 't1'],
    ])
    expect(of('t7')).toMatchObject({ projected: 2, inSeason: { given: 1 } })
    // 바람고 is frozen: no cards, none to come.
    expect(of('t6')).toMatchObject({ frozen: true, held: [], toCome: 0, projected: 0 })
    // Its best players first: 가람고's star, then the rest.
    expect(of('t1').roster[0]).toMatchObject({ playerId: 'p1', overall: 95 })
    expect(o.room).toBeNull()
  })

  it('counts the final ranking once the regular season is over, and shows the draft room during the draft', () => {
    const db = league()
    playAll(db, (s) => s === 'regular')
    sellCards(db, 't8', 't1', [1, 2])
    startPlayoffs(db)
    const playoffs = readDraftOutlook(db)!
    expect(playoffs.final).toBe(true)
    expect(playoffs.schools.find((s) => s.teamId === 't1')).toMatchObject({ toCome: 2, projected: 7 })
    playAll(db, (s) => s !== 'regular')
    finishPlayoffs(db)
    const draft = readDraftOutlook(db)!
    expect(draft.phase).toBe('draft')
    // Everything is handed out now: what each school holds is what it has.
    expect(draft.schools.find((s) => s.teamId === 't1')).toMatchObject({ toCome: 0, projected: 7 })
    expect(draft.schools.find((s) => s.teamId === 't8')!.held.map((c) => c.number)).toEqual([3])
    expect(draft.room).toMatchObject({ protectionOpen: true, actions: [], moved: [] })
    // Worst first, frozen 바람고 left out; 아람고's slot plays first, with the card 가람고 now holds.
    expect(draft.room!.order).toEqual(['t8', 't7', 't5', 't4', 't3', 't2', 't1'])
    closeProtection(db)
    expect(readDraftOutlook(db)!.room!.next).toMatchObject({ originalTeamId: 't8', number: 1, ownerTeamId: 't1' })
  })

  it('is null for a league without the card-swap draft', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    expect(readDraftOutlook(db)).toBeNull()
  })
})

describe('draftWatch', () => {
  it('finds a school short of cards for its star, and one sitting on others’ cards', () => {
    const db = league()
    sellCards(db, 't8', 't1', [1, 2, 3])
    // Before a game the table means nothing: no storyline yet.
    expect(draftWatch(readDraftOutlook(db)!)).toEqual([])
    playAll(db, (s) => s === 'regular', 4)
    const o = readDraftOutlook(db)!
    expect([...leagueStars(o.values)].sort()).toEqual(['p1', 'p13', 'p37', 'p43', 'p7'])
    const watch = draftWatch(o)
    // 아람고 (its star p43) has no card left; 가람고 holds three of 아람고's.
    expect(watch.find((w) => w.teamId === 't8')).toMatchObject({ kind: 'crunch', stars: ['p43'], projected: o.schools.find((s) => s.teamId === 't8')!.projected })
    expect(watch.find((w) => w.teamId === 't1')).toMatchObject({ kind: 'hoard', others: 3 })
    // Nobody else: holding their own cards, every other school can protect its star.
    expect(watch.map((w) => w.teamId).sort()).toEqual(['t1', 't8'])
  })

  it('finds nothing when every school holds its own cards, nor once the draft is on', () => {
    const db = league()
    playAll(db, (s) => s === 'regular')
    expect(draftWatch(readDraftOutlook(db)!)).toEqual([])
    sellCards(db, 't8', 't1', [1, 2, 3])
    expect(draftWatch(readDraftOutlook(db)!).length).toBe(2)
    startPlayoffs(db)
    playAll(db, (s) => s !== 'regular')
    finishPlayoffs(db)
    expect(draftWatch(readDraftOutlook(db)!)).toEqual([])
  })
})
