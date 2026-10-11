import type { LeagueConfig } from '@shared/config/schema'
import { teamStrength } from './value'

/**
 * The trade market, in code. Given player values and each GM's leanings, it
 * measures what a deal does to both teams, lists the deals a GM could
 * sensibly offer, and the counter-offers a receiver could ask for. The AI GMs
 * only choose among these; they never do the math. Pure, no I/O.
 */

export interface MarketPlayer {
  id: string
  teamId: string
  slotId: string | null
  /** Player value, 0–100 (src/core/value.ts). */
  value: number
  /** Visibly unhappy (mood band 불만 or worse): his team is keener to move him. */
  unhappy: boolean
  /** 0..1, how keen his team is to move him (wanting out, a request); unhappy counts as 1 without it. */
  moveWish?: number
  /** Deeply attached to his school: a loyal GM is slow to sell him. */
  franchise?: boolean
  /** Can't be traded now (the once-per-season lock). */
  locked: boolean
}

export interface MarketCard {
  id: number
  ownerTeamId: string
  originalTeamId: string
  /** Held, owned by its team, and inside the in-season cap: it can go into a deal. */
  tradable: boolean
}

export interface GmLeaning {
  philosophy: 'win-now' | 'balanced' | 'development'
  /** 1–5: risk, patience, loyalty, star_chasing, defense_first, regional_pride, ego. */
  traits: Record<string, number>
}

export interface MarketTeam {
  id: string
  divisionId: string
  leaning: GmLeaning
  /** AI-run and not frozen: it can be offered deals. */
  tradable: boolean
}

export interface Market {
  config: LeagueConfig
  teams: MarketTeam[]
  players: MarketPlayer[]
  cards: MarketCard[]
  /** Team ids, best first: the final ranking, or the standings while the season runs. */
  ranking: string[]
}

/** A deal as the proposer (a) sees it: what each side sends. */
export interface Deal {
  a: string
  b: string
  aGives: string[]
  bGives: string[]
  aCards: number[]
  bCards: number[]
}

export interface SideEffect {
  /** Team strength before and after (0–100). */
  before: number
  after: number
  /** Value points of cards coming in and going out. */
  cardsIn: number
  cardsOut: number
}

export interface Scored {
  deal: Deal
  a: SideEffect
  b: SideEffect
  /** How much each GM likes it, by its own leanings (0 = indifferent). */
  ua: number
  ub: number
  /** Raw value the proposer gains (players and cards in minus out); big either way = lopsided. */
  gap: number
}

/** A gap this big (in value points, about one good starter) gets the deal tagged as lopsided. */
export const LOPSIDED_GAP = 15

const level = (t: GmLeaning, name: string) => t.traits[name] ?? 3

/** Lookups built once per market (a window scores tens of thousands of deals). */
interface Index {
  byId: Map<string, MarketPlayer>
  roster: Map<string, MarketPlayer[]>
  team: Map<string, MarketTeam>
  cards: Map<number, MarketCard>
  strength: Map<string, number>
}
const indexes = new WeakMap<Market, Index>()
function index(m: Market): Index {
  let i = indexes.get(m)
  if (!i) {
    const roster = new Map<string, MarketPlayer[]>()
    for (const p of m.players) roster.set(p.teamId, [...(roster.get(p.teamId) ?? []), p])
    i = { byId: new Map(m.players.map((p) => [p.id, p])), roster, team: new Map(m.teams.map((t) => [t.id, t])), cards: new Map(m.cards.map((c) => [c.id, c])), strength: new Map() }
    indexes.set(m, i)
  }
  return i
}

/** A team's strength now. */
export function strengthNow(m: Market, teamId: string): number {
  const i = index(m)
  if (!i.strength.has(teamId)) i.strength.set(teamId, strengthOf(m, teamId, i.roster.get(teamId) ?? []))
  return i.strength.get(teamId)!
}

/**
 * A card's worth in value points. It's a chance to swap one player for
 * another in the draft, and an earlier pick (a worse original team) is worth
 * more: from 4 (the best team's) to 12 (the worst team's).
 */
export function cardValue(m: Market, card: { originalTeamId: string }): number {
  const n = m.ranking.length
  const i = m.ranking.indexOf(card.originalTeamId)
  if (n < 2 || i < 0) return 8
  return 4 + 8 * (i / (n - 1))
}

function strengthOf(m: Market, teamId: string, roster: MarketPlayer[]): number {
  return teamStrength(
    m.config,
    roster.map((p) => ({ id: p.id, teamId, slotId: p.slotId, value: p.value })),
  )
}

/** What a deal does to each team's strength, and the cards' worth either way. */
export function dealEffect(m: Market, d: Deal): { a: SideEffect; b: SideEffect } {
  const { byId, roster, cards } = index(m)
  const of = (team: string) => roster.get(team) ?? []
  const aAfter = [...of(d.a).filter((p) => !d.aGives.includes(p.id)), ...d.bGives.map((id) => byId.get(id)!)]
  const bAfter = [...of(d.b).filter((p) => !d.bGives.includes(p.id)), ...d.aGives.map((id) => byId.get(id)!)]
  const worth = (ids: number[]) => ids.reduce((s, id) => s + (cards.has(id) ? cardValue(m, cards.get(id)!) : 0), 0)
  return {
    a: { before: strengthNow(m, d.a), after: strengthOf(m, d.a, aAfter), cardsIn: worth(d.bCards), cardsOut: worth(d.aCards) },
    b: { before: strengthNow(m, d.b), after: strengthOf(m, d.b, bAfter), cardsIn: worth(d.aCards), cardsOut: worth(d.bCards) },
  }
}

/** Raw value the proposer gains: players and cards in, minus out. */
export function dealGap(m: Market, d: Deal, e: { a: SideEffect }): number {
  const { byId } = index(m)
  const value = (ids: string[]) => ids.reduce((s, id) => s + (byId.get(id)?.value ?? 0), 0)
  return value(d.bGives) - value(d.aGives) + e.a.cardsIn - e.a.cardsOut
}

/**
 * How much one GM likes its side of a deal. Strength now matters most to a
 * win-now GM and least to a developer, who values cards more. A loyal GM is
 * slow to send players away; moving an unhappy one is a plus; a star chaser
 * wants the best player in the deal; regional pride likes players from the
 * same division; a cautious GM dislikes big shake-ups. The AI weighs the rest.
 */
export function utility(m: Market, side: 'a' | 'b', d: Deal, e: SideEffect): number {
  const teamId = side === 'a' ? d.a : d.b
  const { byId, team: teams } = index(m)
  const team = teams.get(teamId)!
  const out = side === 'a' ? d.aGives : d.bGives
  const incoming = side === 'a' ? d.bGives : d.aGives
  const l = team.leaning
  const wNow = l.philosophy === 'win-now' ? 1.4 : l.philosophy === 'development' ? 0.7 : 1
  const wCard = l.philosophy === 'win-now' ? 0.6 : l.philosophy === 'development' ? 1.4 : 1
  const all = [...out, ...incoming].map((id) => byId.get(id)!)
  const best = all.reduce<MarketPlayer | null>((x, p) => (x === null || p.value > x.value ? p : x), null)
  const star = best ? (incoming.includes(best.id) ? 1 : -1) : 0
  const divisionOf = (pid: string) => teams.get(byId.get(pid)?.teamId ?? '')?.divisionId
  const local = incoming.filter((pid) => divisionOf(pid) === team.divisionId).length
  let u = wNow * (e.after - e.before)
  u += (wCard * (e.cardsIn - e.cardsOut)) / 5
  u -= (level(l, 'loyalty') - 3) * 0.3 * out.length
  u += 0.8 * out.reduce((s, id) => s + moveWish(byId.get(id)), 0)
  u -= (level(l, 'loyalty') - 1) * 0.15 * out.filter((id) => byId.get(id)?.franchise).length
  u += (level(l, 'star_chasing') - 3) * 0.25 * star
  u += (level(l, 'regional_pride') - 3) * 0.2 * local
  u -= (3 - level(l, 'risk')) * 0.15 * (out.length + incoming.length)
  return Math.round(u * 100) / 100
}

/** How keen his team is to move him, 0..1. */
export function moveWish(p: MarketPlayer | undefined): number {
  if (!p) return 0
  return p.moveWish ?? (p.unhappy ? 1 : 0)
}

export function scoreDeal(m: Market, d: Deal): Scored {
  const e = dealEffect(m, d)
  return { deal: d, a: e.a, b: e.b, ua: utility(m, 'a', d, e.a), ub: utility(m, 'b', d, e.b), gap: Math.round(dealGap(m, d, e) * 10) / 10 }
}

function pairs<T>(list: T[]): [T, T][] {
  const out: [T, T][] = []
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i]!, list[j]!])
  return out
}

/** Every 1-for-1 swap between two teams, and (with `twos`) every 2-for-2, among players who can be traded. */
function swapsBetween(m: Market, a: string, b: string, twos = true): Deal[] {
  const { roster } = index(m)
  const free = (team: string) => (roster.get(team) ?? []).filter((p) => !p.locked).map((p) => p.id)
  const fa = free(a)
  const fb = free(b)
  const out: Deal[] = []
  for (const x of fa) for (const y of fb) out.push({ a, b, aGives: [x], bGives: [y], aCards: [], bCards: [] })
  if (twos) for (const xs of pairs(fa)) for (const ys of pairs(fb)) out.push({ a, b, aGives: [...xs], bGives: [...ys], aCards: [], bCards: [] })
  return out
}

/**
 * The deals worth scoring between two teams, cheaply: every 1-for-1 swap,
 * and 2-for-2 swaps built only from the best 1-for-1 legs (by how much both
 * sides like them). Scoring every 2-for-2 would be 15 × 15 per pair of teams.
 */
function dealsWorthScoring(m: Market, a: string, b: string): Scored[] {
  const ones = swapsBetween(m, a, b, false).map((d) => scoreDeal(m, d))
  const legs = [...ones].sort((x, y) => y.ua + y.ub - (x.ua + x.ub)).slice(0, 6)
  const twos: Scored[] = []
  for (const [x, y] of pairs(legs)) {
    if (x.deal.aGives[0] === y.deal.aGives[0] || x.deal.bGives[0] === y.deal.bGives[0]) continue
    twos.push(scoreDeal(m, { a, b, aGives: [x.deal.aGives[0]!, y.deal.aGives[0]!], bGives: [x.deal.bGives[0]!, y.deal.bGives[0]!], aCards: [], bCards: [] }))
  }
  return [...ones, ...twos]
}

/** The proposer's cheapest card that makes the partner like the deal, as a sweetener. */
function sweetened(m: Market, s: Scored): Scored | null {
  const own = m.cards.filter((c) => c.tradable && c.ownerTeamId === s.deal.a).sort((x, y) => cardValue(m, x) - cardValue(m, y))
  for (const c of own) {
    const next = scoreDeal(m, { ...s.deal, aCards: [c.id] })
    if (next.ub >= 0) return next
  }
  return null
}

const key = (d: Deal) => `${d.b}|${[...d.aGives].sort()}|${[...d.bGives].sort()}|${[...d.aCards].sort()}|${[...d.bCards].sort()}`

/**
 * Deals one GM could sensibly offer: good for it, and not so bad for the
 * partner that a yes is out of the question (a card is added when that tips
 * it). At most two per partner, so the options are varied. A star chaser also
 * gets its boldest try: the best player it could bring in, whatever the
 * partner thinks.
 */
export function candidates(m: Market, proposer: string, limit = 6): Scored[] {
  const me = m.teams.find((t) => t.id === proposer)
  if (!me) return []
  const scored: Scored[] = []
  for (const partner of m.teams) {
    if (partner.id === proposer || !partner.tradable) continue
    for (const s of dealsWorthScoring(m, proposer, partner.id)) {
      if (s.ua <= 0.15) continue
      if (s.ub >= -0.5) scored.push(s)
      else {
        const sweet = sweetened(m, s)
        if (sweet && sweet.ua > 0.15) scored.push(sweet)
      }
    }
  }
  scored.sort((x, y) => y.ua + 0.5 * Math.min(0, y.ub) - (x.ua + 0.5 * Math.min(0, x.ub)))
  const out: Scored[] = []
  const perPartner = new Map<string, number>()
  const usedPlayers = new Set<string>()
  for (const s of scored) {
    if (out.length >= limit) break
    if ((perPartner.get(s.deal.b) ?? 0) >= 2) continue
    if (s.deal.aGives.some((p) => usedPlayers.has(p)) && s.deal.bGives.some((p) => usedPlayers.has(p))) continue
    out.push(s)
    perPartner.set(s.deal.b, (perPartner.get(s.deal.b) ?? 0) + 1)
    for (const p of [...s.deal.aGives, ...s.deal.bGives]) usedPlayers.add(p)
  }
  if (level(me.leaning, 'star_chasing') >= 4) {
    const { byId } = index(m)
    const bold = m.teams
      .filter((t) => t.id !== proposer && t.tradable)
      .flatMap((t) => swapsBetween(m, proposer, t.id, false))
      .map((d) => ({ d, star: byId.get(d.bGives[0]!)!.value }))
      .sort((x, y) => y.star - x.star)
      .slice(0, 40)
      .map((x) => scoreDeal(m, x.d))
      .filter((s) => s.ua > 0)
      .sort((x, y) => y.ua - x.ua)[0]
    if (bold && !out.some((s) => key(s.deal) === key(bold.deal))) out.push(bold)
  }
  return out
}

/**
 * Counter-offers the receiver of `offer` could make: deals between the same
 * two teams that are clearly better for the receiver and that the proposer
 * might still take. Each is written from the original proposer's side.
 */
export function counters(m: Market, offer: Deal, limit = 4): Scored[] {
  const base = scoreDeal(m, offer)
  const options: Scored[] = []
  for (const d of swapsBetween(m, offer.a, offer.b)) {
    for (const variant of [d, ...m.cards.filter((c) => c.tradable && c.ownerTeamId === offer.a).map((c) => ({ ...d, aCards: [c.id] }))]) {
      if (key(variant) === key(offer)) continue
      const s = scoreDeal(m, variant)
      if (s.ub > base.ub + 0.2 && s.ua > -0.3) options.push(s)
    }
  }
  options.sort((x, y) => y.ub - x.ub)
  const out: Scored[] = []
  for (const s of options) {
    if (out.length >= limit) break
    if (out.some((o) => o.deal.bGives.join() === s.deal.bGives.join() && o.deal.aGives.join() === s.deal.aGives.join())) continue
    out.push(s)
  }
  return out
}
