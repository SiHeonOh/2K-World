import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import type { CardSwapDraft } from '@shared/config/schema'
import {
  allocateCards,
  cardSequence,
  checkDraftAction,
  nextCard,
  legalTargets,
  pickOrder,
  protectionCard,
  swapResult,
  type DraftCard,
  type DraftState,
} from './draft'

const draft = (over: Partial<CardSwapDraft> = {}): CardSwapDraft => ({
  ...defaultCardSwap(6),
  allocation: [
    { fromRank: 1, toRank: 1, cards: 3 },
    { fromRank: 2, toRank: 3, cards: 2 },
    { fromRank: 4, toRank: 6, cards: 1 },
  ],
  ...over,
})
const ranking = ['a', 'b', 'c', 'd', 'e', 'f']

describe('allocation and order', () => {
  it('hands out cards by rank and leaves frozen teams out', () => {
    expect(allocateCards(draft(), ranking, new Set(['e']))).toEqual([
      { teamId: 'a', count: 3 },
      { teamId: 'b', count: 2 },
      { teamId: 'c', count: 2 },
      { teamId: 'd', count: 1 },
      { teamId: 'e', count: 0 },
      { teamId: 'f', count: 1 },
    ])
    expect(pickOrder(ranking, new Set(['e']))).toEqual(['f', 'd', 'c', 'b', 'a'])
  })
})

function cards(): DraftCard[] {
  const out: DraftCard[] = []
  let id = 1
  for (const { teamId, count } of allocateCards(draft(), ranking, new Set())) {
    for (let n = 1; n <= count; n++) out.push({ id: id++, originalTeamId: teamId, ownerTeamId: teamId, number: n, status: 'held' })
  }
  return out
}

describe('cardSequence', () => {
  const order = pickOrder(ranking, new Set())
  const label = (c: DraftCard) => `${c.originalTeamId}${c.number}`

  it('one card per turn: round by round in pick order', () => {
    expect(cardSequence(cards(), order, 'one').map(label)).toEqual(['f1', 'e1', 'd1', 'c1', 'b1', 'a1', 'c2', 'b2', 'a2', 'a3'])
  })

  it('all cards per turn: each slot plays all of its cards', () => {
    expect(cardSequence(cards(), order, 'all').map(label)).toEqual(['f1', 'e1', 'd1', 'c1', 'c2', 'b1', 'b2', 'a1', 'a2', 'a3'])
  })

  it('a traded card keeps its original pick slot', () => {
    const list = cards()
    const a1 = list.find((c) => c.originalTeamId === 'a' && c.number === 1)!
    a1.ownerTeamId = 'f'
    const seq = cardSequence(list, order, 'one')
    expect(seq.map(label).indexOf('a1')).toBe(5)
    expect(seq[5]!.ownerTeamId).toBe('f')
  })

  it('skips used cards to find the next turn', () => {
    const list = cards()
    list[list.length - 1]!.status = 'used' // f1 (worst team, picks first)
    expect(nextCard(cardSequence(list, order, 'one'))?.originalTeamId).toBe('e')
  })
})

describe('checkDraftAction', () => {
  const players = [
    { id: 'pa', teamId: 'a', slotId: 'pg' },
    { id: 'pb', teamId: 'b', slotId: 'c' },
    { id: 'pf', teamId: 'f', slotId: 'pg' },
    { id: 'pe', teamId: 'e', slotId: 'pg' },
  ]
  const state = (over: Partial<DraftState> = {}): DraftState => ({
    draft: draft(),
    cards: cards(),
    players,
    frozen: new Set(),
    protectedPlayers: new Set(),
    movedPlayers: new Set(),
    protectionOpen: false,
    order: pickOrder(ranking, new Set()),
    ...over,
  })
  const fCard = () => cards().find((c) => c.originalTeamId === 'f')!.id
  const aCard = () => cards().find((c) => c.originalTeamId === 'a')!.id

  it('lets the team on the clock swap for an unprotected player', () => {
    expect(checkDraftAction({ kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pa' }, state())).toEqual([])
  })

  it('refuses out-of-turn swaps, protected targets and own-team targets', () => {
    expect(checkDraftAction({ kind: 'swap', teamId: 'a', cardId: aCard(), playerId: 'pa', targetPlayerId: 'pf' }, state())).toEqual([
      'not-your-turn',
    ])
    expect(
      checkDraftAction(
        { kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pa' },
        state({ protectedPlayers: new Set(['pa']) }),
      ),
    ).toEqual(['target-protected'])
    expect(checkDraftAction({ kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pf' }, state())).toContain(
      'target-own-team',
    )
    expect(checkDraftAction({ kind: 'swap', teamId: 'a', cardId: fCard(), playerId: 'pa', targetPlayerId: 'pb' }, state())).toEqual([
      'not-your-card',
    ])
  })

  it('applies the same-slot rule and frozen teams', () => {
    const s = state({ draft: draft({ slotRule: 'same-slot' }), frozen: new Set(['e']) })
    expect(checkDraftAction({ kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pb' }, s)).toEqual([
      'slot-mismatch',
    ])
    expect(checkDraftAction({ kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pe' }, s)).toEqual([
      'target-frozen',
    ])
  })

  it('protects only own players, with the last card, while protection is open', () => {
    const open = state({ protectionOpen: true })
    const last = protectionCard(open, 'a')!
    // a's three cards play in rounds 1, 2 and 3; protection spends the round-3 one.
    expect(last.number).toBe(3)
    expect(checkDraftAction({ kind: 'protect', teamId: 'a', cardId: last.id, playerId: 'pa' }, open)).toEqual([])
    expect(checkDraftAction({ kind: 'protect', teamId: 'a', cardId: aCard(), playerId: 'pa' }, open)).toEqual(['use-last-card'])
    expect(checkDraftAction({ kind: 'protect', teamId: 'a', cardId: last.id, playerId: 'pb' }, open)).toEqual(['player-not-yours'])
    expect(checkDraftAction({ kind: 'protect', teamId: 'a', cardId: last.id, playerId: 'pa' }, state())).toEqual(['protection-closed'])
  })

  it('holds swaps until protection closes', () => {
    expect(
      checkDraftAction({ kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pa' }, state({ protectionOpen: true })),
    ).toEqual(['protection-open'])
  })

  it('moves a player at most once per draft', () => {
    expect(
      checkDraftAction(
        { kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pa' },
        state({ movedPlayers: new Set(['pf']) }),
      ),
    ).toEqual(['player-already-moved'])
  })

  // League rule: a player already traded once within the draft is protected for the rest of it,
  // even when the league didn't protect swapped players (old configs).
  it('never lets another team take a player who already moved this draft', () => {
    const s = state({ draft: draft({ swappedProtected: false }), movedPlayers: new Set(['pa']) })
    expect(checkDraftAction({ kind: 'swap', teamId: 'f', cardId: fCard(), playerId: 'pf', targetPlayerId: 'pa' }, s)).toEqual([
      'target-already-moved',
    ])
    expect(legalTargets(s, 'f').map((p) => p.id)).toEqual(['pb', 'pe'])
    // Nor can his new team spend a protection on him: he's protected already.
    const open = state({ protectionOpen: true, movedPlayers: new Set(['pa']) })
    expect(checkDraftAction({ kind: 'protect', teamId: 'a', cardId: protectionCard(open, 'a')!.id, playerId: 'pa' }, open)).toEqual([
      'already-protected',
    ])
  })

  it('keeps frozen teams out and lists legal targets', () => {
    expect(checkDraftAction({ kind: 'pass', teamId: 'f', cardId: fCard() }, state({ frozen: new Set(['f']) }))).toEqual(['team-frozen'])
    const s = state({ protectedPlayers: new Set(['pa']), frozen: new Set(['e']) })
    expect(legalTargets(s, 'f').map((p) => p.id)).toEqual(['pb'])
  })
})

describe('swapResult', () => {
  it('moves each player into the other’s slot, or keeps slots', () => {
    const own = { id: 'x', teamId: 't1', slotId: 'pg' }
    const target = { id: 'y', teamId: 't2', slotId: 'c' }
    expect(swapResult(draft(), own, target)).toEqual({
      ownTo: { teamId: 't2', slotId: 'c' },
      targetTo: { teamId: 't1', slotId: 'pg' },
    })
    expect(swapResult(draft({ incomingSlot: 'own' }), own, target).ownTo).toEqual({ teamId: 't2', slotId: 'pg' })
  })
})
