import type { CardSwapDraft } from '@shared/config/schema'

/**
 * The card-swap draft. Pure functions over the season's cards and the
 * actions taken so far; the data layer stores both and asks these what's
 * next and whether a move is legal.
 */

export interface DraftCard {
  id: number
  originalTeamId: string
  ownerTeamId: string
  /** 1-based: the original team's n-th card. */
  number: number
  status: 'held' | 'used' | 'expired'
}

export interface DraftPlayer {
  id: string
  teamId: string
  slotId: string | null
}

export type DraftAction =
  | { kind: 'protect'; teamId: string; cardId: number; playerId: string }
  | { kind: 'swap'; teamId: string; cardId: number; playerId: string; targetPlayerId: string }
  | { kind: 'pass'; teamId: string; cardId: number }

/** Cards per team from the final overall ranking (1 = best). Frozen teams sit out. */
export function allocateCards(
  draft: CardSwapDraft,
  ranking: readonly string[],
  frozen: ReadonlySet<string>,
): { teamId: string; count: number }[] {
  return ranking.map((teamId, i) => {
    const rank = i + 1
    const tier = draft.allocation.find((t) => rank >= t.fromRank && rank <= t.toRank)
    return { teamId, count: frozen.has(teamId) ? 0 : (tier?.cards ?? 0) }
  })
}

/** Pick order: worst record first, frozen teams left out. */
export function pickOrder(ranking: readonly string[], frozen: ReadonlySet<string>): string[] {
  return [...ranking].reverse().filter((id) => !frozen.has(id))
}

/**
 * The order cards are played in the swap phase. A card keeps its original
 * team's pick slot wherever it goes. 'one': round n plays every team's n-th
 * card in pick order. 'all': each pick slot plays all of its cards in turn.
 */
export function cardSequence<C extends DraftCard>(cards: readonly C[], order: readonly string[], turns: CardSwapDraft['turns']): C[] {
  const slot = new Map(order.map((id, i) => [id, i]))
  const inDraft = cards.filter((c) => slot.has(c.originalTeamId))
  return [...inDraft].sort((x, y) => {
    const sx = slot.get(x.originalTeamId)!
    const sy = slot.get(y.originalTeamId)!
    return turns === 'one' ? x.number - y.number || sx - sy : sx - sy || x.number - y.number
  })
}

/** The card whose turn it is in the swap phase, or null when the draft is over. */
export function nextCard<C extends DraftCard>(sequence: readonly C[]): C | null {
  return sequence.find((c) => c.status === 'held') ?? null
}

export type DraftIssueCode =
  | 'protection-open'
  | 'team-frozen'
  | 'player-already-moved'
  | 'target-already-moved'
  | 'use-last-card'
  | 'not-your-card'
  | 'card-not-held'
  | 'not-your-turn'
  | 'protection-closed'
  | 'player-not-yours'
  | 'already-protected'
  | 'target-protected'
  | 'target-own-team'
  | 'target-frozen'
  | 'slot-mismatch'
  | 'unknown-player'

export interface DraftState {
  draft: CardSwapDraft
  cards: readonly DraftCard[]
  players: readonly DraftPlayer[]
  frozen: ReadonlySet<string>
  /** Players their team protected with a card (moved players are protected too, below). */
  protectedPlayers: ReadonlySet<string>
  /**
   * Players who already changed teams in this draft (swapped either way, or
   * traded during it). They're protected for the rest of it: they can't be
   * sent away again, and no other team can take them.
   */
  movedPlayers: ReadonlySet<string>
  /** True while teams are still protecting; swaps wait until it closes. */
  protectionOpen: boolean
  order: readonly string[]
}

/**
 * The card a team spends to protect a player: its held card that would be
 * played last. Protecting gives up a team's latest turn, never its first.
 */
export function protectionCard(state: Pick<DraftState, 'cards' | 'order' | 'draft'>, teamId: string): DraftCard | null {
  const mine = cardSequence(state.cards, state.order, state.draft.turns).filter((c) => c.ownerTeamId === teamId && c.status === 'held')
  return mine.at(-1) ?? null
}

/** Players a team may swap for with its card: unprotected, not moved this draft, on other teams that aren't frozen. */
export function legalTargets(state: DraftState, teamId: string, ownPlayerId?: string): DraftPlayer[] {
  const own = ownPlayerId === undefined ? undefined : state.players.find((p) => p.id === ownPlayerId)
  return state.players.filter(
    (p) =>
      p.teamId !== teamId &&
      !state.frozen.has(p.teamId) &&
      !state.protectedPlayers.has(p.id) &&
      !state.movedPlayers.has(p.id) &&
      (state.draft.slotRule !== 'same-slot' || own === undefined || own.slotId === p.slotId),
  )
}

/** Checks one draft move. Returns the problems; empty means legal. */
export function checkDraftAction(action: DraftAction, state: DraftState): DraftIssueCode[] {
  const issues: DraftIssueCode[] = []
  if (state.frozen.has(action.teamId)) return ['team-frozen']
  const card = state.cards.find((c) => c.id === action.cardId)
  if (!card || card.ownerTeamId !== action.teamId) return ['not-your-card']
  if (card.status !== 'held') return ['card-not-held']
  const players = new Map(state.players.map((p) => [p.id, p]))

  if (action.kind === 'protect') {
    if (!state.protectionOpen) issues.push('protection-closed')
    const p = players.get(action.playerId)
    if (!p) return [...issues, 'unknown-player']
    if (p.teamId !== action.teamId) issues.push('player-not-yours')
    if (state.protectedPlayers.has(p.id) || state.movedPlayers.has(p.id)) issues.push('already-protected')
    if (protectionCard(state, action.teamId)?.id !== card.id) issues.push('use-last-card')
    return issues
  }

  // Swaps and passes wait for protection to close, then go in turn order.
  if (state.protectionOpen) return ['protection-open']
  const next = nextCard(cardSequence(state.cards, state.order, state.draft.turns))
  if (!next || next.id !== card.id) issues.push('not-your-turn')
  if (action.kind === 'pass') return issues

  const own = players.get(action.playerId)
  const target = players.get(action.targetPlayerId)
  if (!own || !target) return [...issues, 'unknown-player']
  if (own.teamId !== action.teamId) issues.push('player-not-yours')
  // A player moves at most once per draft: one already moved is protected for the rest of it, both ways.
  if (state.movedPlayers.has(own.id)) issues.push('player-already-moved')
  if (target.teamId === action.teamId) issues.push('target-own-team')
  if (state.frozen.has(target.teamId)) issues.push('target-frozen')
  if (state.movedPlayers.has(target.id)) issues.push('target-already-moved')
  else if (state.protectedPlayers.has(target.id)) issues.push('target-protected')
  if (state.draft.slotRule === 'same-slot' && own.slotId !== target.slotId) issues.push('slot-mismatch')
  return issues
}

/** Where the two players go after a legal swap. */
export function swapResult(
  draft: CardSwapDraft,
  own: DraftPlayer,
  target: DraftPlayer,
): { ownTo: { teamId: string; slotId: string | null }; targetTo: { teamId: string; slotId: string | null } } {
  const keep = draft.incomingSlot === 'own'
  return {
    ownTo: { teamId: target.teamId, slotId: keep ? own.slotId : target.slotId },
    targetTo: { teamId: own.teamId, slotId: keep ? target.slotId : own.slotId },
  }
}
