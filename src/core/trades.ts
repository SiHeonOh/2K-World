import type { LeagueConfig, Phase, TeamControl } from '@shared/config/schema'
import type { TradeCheck, TradeIssue, TradeIssueCode, TradeItem } from '@shared/season'

export type { TradeCheck, TradeIssue, TradeIssueCode, TradeItem }

/**
 * Trade rules. Pure: given the league's state, says whether a proposed trade
 * is legal and what the rosters look like afterwards. Used the same way for
 * your own proposals and (later) AI GMs'.
 */

export interface TradeTeam {
  id: string
  control: TeamControl
}
export interface TradePlayer {
  id: string
  teamId: string
  slotId: string | null
}
export interface TradeCard {
  id: number
  ownerTeamId: string
  status: 'held' | 'used' | 'expired'
}

export interface TradeContext {
  config: LeagueConfig
  phase: Phase
  teams: readonly TradeTeam[]
  players: readonly TradePlayer[]
  cards: readonly TradeCard[]
  /** Players already traded since the once-per-season lock last reset. */
  lockedPlayers: ReadonlySet<string>
  /** Card trades so far this season, per team (for the in-season cap). */
  cardTradeCounts: ReadonlyMap<string, { given: number; received: number; trades: number }>
  /**
   * Players who changed teams within this draft (swapped either way, or traded
   * during it). League rule 21 protects them for the rest of it: no team, his
   * own included, can trade him on. Only read in the draft phase.
   */
  draftMoved: ReadonlySet<string>
}

/** Phases in which the in-season card cap counts. */
const IN_SEASON: Phase[] = ['preseason', 'regular']

/**
 * Player trades are open now: the league trades in this phase, and it isn't
 * the playoffs (every player is locked then, whatever phases the league
 * ticked). Your trades, the AI GMs' deals and their trade windows all go by it.
 */
export function playerTradesOpen(config: LeagueConfig, phase: Phase): boolean {
  return config.trades.enabled && phase !== 'playoffs' && config.trades.phases.includes(phase)
}

export function checkTrade(items: readonly TradeItem[], ctx: TradeContext): TradeCheck {
  const issues: TradeIssue[] = []
  const add = (code: TradeIssueCode, params: TradeIssue['params'] = {}) => issues.push({ code, params })
  const { config } = ctx
  const fail = (): TradeCheck => ({ ok: false, issues, moves: [] })

  if (items.length === 0) {
    add('empty-trade')
    return fail()
  }
  const playerItems = items.filter((i): i is Extract<TradeItem, { kind: 'player' }> => i.kind === 'player')
  const cardItems = items.filter((i): i is Extract<TradeItem, { kind: 'card' }> => i.kind === 'card')

  // Who may trade, and when.
  if (playerItems.length > 0) {
    if (!config.trades.enabled) add('trades-disabled')
    else if (!playerTradesOpen(config, ctx.phase)) add('wrong-phase', { phase: ctx.phase })
  }
  const draft = config.draft.kind === 'card-swap' ? config.draft : null
  if (cardItems.length > 0) {
    if (!draft || !draft.cardTrades.enabled) add('card-trades-disabled')
    // Everything is locked during the playoffs.
    else if (ctx.phase === 'playoffs') add('wrong-phase', { phase: ctx.phase })
  }

  const teamIds = [...new Set(items.flatMap((i) => [i.from, i.to]))]
  const teams = new Map(ctx.teams.map((t) => [t.id, t]))
  if (teamIds.length !== 2 || items.some((i) => i.from === i.to)) add('two-teams')
  for (const id of teamIds) {
    const team = teams.get(id)
    if (!team) add('unknown-team', { team: id })
    else if (team.control === 'frozen') add('team-frozen', { team: id })
  }
  if (issues.length > 0) return fail()
  const [a, b] = teamIds as [string, string]

  // Players
  const players = new Map(ctx.players.map((p) => [p.id, p]))
  const seen = new Set<string>()
  for (const item of playerItems) {
    const p = players.get(item.playerId)
    if (seen.has(item.playerId)) add('duplicate-item', { player: item.playerId })
    seen.add(item.playerId)
    if (!p) add('unknown-player', { player: item.playerId })
    else if (p.teamId !== item.from) add('player-not-on-team', { player: item.playerId, team: item.from })
    if (config.trades.oncePerSeason.enabled && ctx.lockedPlayers.has(item.playerId)) {
      add('player-locked', { player: item.playerId })
    }
    // Rule 21 is a rule, not a setting: a player moved within the draft stays put until it ends.
    if (ctx.phase === 'draft' && ctx.draftMoved.has(item.playerId)) add('player-moved-in-draft', { player: item.playerId })
  }
  const out = (team: string) => playerItems.filter((i) => i.from === team)
  if (config.trades.equalPlayerCount && out(a).length !== out(b).length) {
    add('player-count-mismatch', { a: out(a).length, b: out(b).length })
  }
  if (playerItems.length > 0 && cardItems.length > 0 && !config.trades.cardsWithPlayers) add('cards-with-players')

  // Cards
  const cards = new Map(ctx.cards.map((c) => [c.id, c]))
  const seenCards = new Set<number>()
  for (const item of cardItems) {
    const c = cards.get(item.cardId)
    if (seenCards.has(item.cardId)) add('duplicate-item', { card: item.cardId })
    seenCards.add(item.cardId)
    if (!c) add('unknown-card', { card: item.cardId })
    else if (c.ownerTeamId !== item.from) add('card-not-owned', { card: item.cardId, team: item.from })
    else if (c.status !== 'held') add('card-used', { card: item.cardId })
  }
  if (draft && cardItems.length > 0) {
    const given = (team: string) => cardItems.filter((i) => i.from === team).length
    if (!draft.cardTrades.unbalanced && playerItems.length === 0 && given(a) !== given(b)) {
      add('card-count-mismatch', { a: given(a), b: given(b) })
    }
    const cap = draft.cardTrades.inSeasonCap
    if (cap !== null && IN_SEASON.includes(ctx.phase)) {
      for (const team of [a, b]) {
        const so = ctx.cardTradeCounts.get(team) ?? { given: 0, received: 0, trades: 0 }
        const other = team === a ? b : a
        const next =
          draft.cardTrades.capCounts === 'given'
            ? so.given + given(team)
            : draft.cardTrades.capCounts === 'received'
              ? so.received + given(other)
              : so.trades + 1
        const counts = draft.cardTrades.capCounts === 'trades' || given(team) > 0 || given(other) > 0
        if (counts && next > cap) add('card-cap', { team, cap, count: next })
      }
    }
  }
  if (issues.length > 0) return fail()

  // Rosters afterwards. An incoming player takes the slot the trade names;
  // otherwise a slot the outgoing players free up, his own slot first.
  const slots = new Set(config.roster.slots.map((s) => s.id))
  const moves: TradeCheck['moves'] = []
  for (const team of [a, b]) {
    const incoming = playerItems.filter((i) => i.to === team)
    const freed = out(team).map((i) => players.get(i.playerId)?.slotId ?? null)
    const take = (slot: string | null) => {
      const at = freed.indexOf(slot)
      if (at >= 0) freed.splice(at, 1)
    }
    for (const item of incoming) if (item.toSlotId) take(item.toSlotId)
    for (const item of incoming) {
      const p = players.get(item.playerId)!
      let toSlotId: string | null
      if (item.toSlotId) toSlotId = item.toSlotId
      else if (freed.includes(p.slotId)) toSlotId = p.slotId
      else toSlotId = freed[0] ?? p.slotId
      if (!item.toSlotId) take(toSlotId)
      if (toSlotId !== null && !slots.has(toSlotId)) add('unknown-slot', { slot: toSlotId })
      moves.push({ playerId: p.id, from: item.from, to: team, fromSlotId: p.slotId, toSlotId })
    }
  }
  const after = new Map<string, (string | null)[]>()
  const moved = new Map(moves.map((m) => [m.playerId, m]))
  for (const p of ctx.players) {
    const m = moved.get(p.id)
    const team = m ? m.to : p.teamId
    if (team !== a && team !== b) continue
    const list = after.get(team) ?? []
    list.push(m ? m.toSlotId : p.slotId)
    after.set(team, list)
  }
  const { roster } = config
  for (const team of [a, b]) {
    const list = after.get(team) ?? []
    if (list.length < roster.minPlayers || list.length > roster.maxPlayers) {
      add('roster-size', { team, count: list.length })
    }
    if (roster.slotMode === 'one-per-slot') {
      for (const s of roster.slots) {
        const n = list.filter((x) => x === s.id).length
        if (n !== 1) add('roster-slot', { team, slot: s.name, count: n })
      }
    }
  }
  return { ok: issues.length === 0, issues, moves: issues.length === 0 ? moves : [] }
}
