import type { LeagueConfig } from '@shared/config/schema'
import { teamStrength } from './value'

/**
 * The trade market, in code. Given player values and each GM's leanings, it
 * measures what a deal does to both teams, lists the deals a GM could
 * sensibly offer, and the counter-offers a receiver could ask for. The AI GMs
 * only choose among these; they never do the math. Pure, no I/O.
 *
 * Stars move the ways they do in real leagues: for one good player, in a
 * consolidation (a team's best and its weakest for two of the other team's
 * middle players), or with a package of cards on top (the proposer's to win
 * the partner over, or the partner's when the proposer asks for them).
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
  /** Cards it may still give this season (what the in-season cap leaves); left out: no cap. */
  cardRoom?: number
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
/** Cards one side may put into a deal, at most (fewer when the in-season cap leaves less room). */
export const MAX_CARDS = 3
/** A deal a GM would offer is worth more than this to it… */
const WORTH = 0.15
/** …and not so bad for the partner that a yes is out of the question. */
const HOPELESS = -0.5
/**
 * Stars, by league rank (value), as shares of the players: in a 36-school
 * league of 216, the ten best are stars, the twenty best are when the trade
 * makes them its headline. Smaller leagues get fewer.
 */
const STAR_SHARE = 10 / 216
const NEAR_SHARE = 20 / 216
/** Blockbusters a season before only a bigger star (one of the ten best, above any they moved) makes another. */
export const BLOCKBUSTERS_A_SEASON = 1

const level = (t: GmLeaning, name: string) => t.traits[name] ?? 3
/** How much strength now counts for a GM, and how much cards do: win-now wants the first, developers the second. */
const nowWeight = (l: GmLeaning) => (l.philosophy === 'win-now' ? 1.4 : l.philosophy === 'development' ? 0.7 : 1)
const cardWeight = (l: GmLeaning) => (l.philosophy === 'win-now' ? 0.6 : l.philosophy === 'development' ? 1.4 : 1)

/** One or more of a team's cards that could go into a deal together, and their worth. */
interface Pack {
  ids: number[]
  worth: number
}

/** Lookups built once per market (a window scores tens of thousands of deals). */
interface Index {
  byId: Map<string, MarketPlayer>
  roster: Map<string, MarketPlayer[]>
  team: Map<string, MarketTeam>
  cards: Map<number, MarketCard>
  strength: Map<string, number>
  /** Each team's players who can be traded, best first (filled as asked). */
  free: Map<string, MarketPlayer[]>
  /** Each team's card packages, cheapest first (filled as asked). */
  packs: Map<string, Pack[]>
  /** Every player's place in the league by value, 0 the best (made when first asked). */
  rank: Map<string, number> | null
}
const indexes = new WeakMap<Market, Index>()
function index(m: Market): Index {
  let i = indexes.get(m)
  if (!i) {
    const roster = new Map<string, MarketPlayer[]>()
    for (const p of m.players) roster.set(p.teamId, [...(roster.get(p.teamId) ?? []), p])
    i = {
      byId: new Map(m.players.map((p) => [p.id, p])),
      roster,
      team: new Map(m.teams.map((t) => [t.id, t])),
      cards: new Map(m.cards.map((c) => [c.id, c])),
      strength: new Map(),
      free: new Map(),
      packs: new Map(),
      rank: null,
    }
    indexes.set(m, i)
  }
  return i
}

const bestFirst = (x: MarketPlayer, y: MarketPlayer) => y.value - x.value || x.id.localeCompare(y.id)

/** A team's players who can be traded now, best first. */
function freeOf(m: Market, teamId: string): MarketPlayer[] {
  const i = index(m)
  let list = i.free.get(teamId)
  if (!list) {
    list = (i.roster.get(teamId) ?? []).filter((p) => !p.locked).sort(bestFirst)
    i.free.set(teamId, list)
  }
  return list
}

/** How many cards a team may put into one deal: three, or what the in-season cap leaves it. */
function cardRoom(m: Market, teamId: string): number {
  return Math.max(0, Math.min(MAX_CARDS, index(m).team.get(teamId)?.cardRoom ?? MAX_CARDS))
}

/**
 * A team's card packages: every set of one to three of its tradable cards
 * (fewer when the cap leaves less room), cheapest first, and fewer cards
 * first when two cost the same.
 */
function packsOf(m: Market, teamId: string): Pack[] {
  const i = index(m)
  let list = i.packs.get(teamId)
  if (!list) {
    const room = cardRoom(m, teamId)
    const own = m.cards.filter((c) => c.tradable && c.ownerTeamId === teamId).map((c) => ({ id: c.id, worth: cardValue(m, c) }))
    const out: Pack[] = []
    const walk = (from: number, ids: number[], worth: number) => {
      if (ids.length > 0) out.push({ ids, worth })
      if (ids.length >= room) return
      for (let k = from; k < own.length; k++) walk(k + 1, [...ids, own[k]!.id], worth + own[k]!.worth)
    }
    walk(0, [], 0)
    list = out.sort((x, y) => x.worth - y.worth || x.ids.length - y.ids.length || x.ids.join().localeCompare(y.ids.join()))
    i.packs.set(teamId, list)
  }
  return list
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
  const all = [...out, ...incoming].map((id) => byId.get(id)!)
  const best = all.reduce<MarketPlayer | null>((x, p) => (x === null || p.value > x.value ? p : x), null)
  const star = best ? (incoming.includes(best.id) ? 1 : -1) : 0
  const divisionOf = (pid: string) => teams.get(byId.get(pid)?.teamId ?? '')?.divisionId
  const local = incoming.filter((pid) => divisionOf(pid) === team.divisionId).length
  let u = nowWeight(l) * (e.after - e.before)
  u += (cardWeight(l) * (e.cardsIn - e.cardsOut)) / 5
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
 * The two ways a star moves for two players between two teams (a
 * consolidation): the proposer's best and weakest tradable players for two of
 * the partner's middle ones (its 2nd–4th best tradable, each pair), and the
 * other way round: the partner's best and weakest for two of the proposer's.
 * Their single legs are rarely good on their own, so the 2-for-2s built from
 * the best legs would miss them.
 */
function consolidations(m: Market, a: string, b: string): Deal[] {
  const out: Deal[] = []
  const shape = (seller: string, buyer: string) => {
    const s = freeOf(m, seller)
    const middle = freeOf(m, buyer).slice(1, 4)
    if (s.length < 2) return
    const sent = [s[0]!.id, s.at(-1)!.id]
    for (const [x, y] of pairs(middle)) {
      const back = [x.id, y.id]
      out.push(seller === a ? { a, b, aGives: sent, bGives: back, aCards: [], bCards: [] } : { a, b, aGives: back, bGives: sent, aCards: [], bCards: [] })
    }
  }
  shape(a, b)
  shape(b, a)
  return out
}

const key = (d: Deal) => `${d.b}|${[...d.aGives].sort()}|${[...d.bGives].sort()}|${[...d.aCards].sort()}|${[...d.bCards].sort()}`

/**
 * The deals worth scoring between two teams, cheaply: every 1-for-1 swap,
 * 2-for-2 swaps built only from the best 1-for-1 legs (by how much both
 * sides like them), and the consolidations. Scoring every 2-for-2 would be
 * 15 × 15 per pair of teams.
 */
function dealsWorthScoring(m: Market, a: string, b: string): Scored[] {
  const ones = swapsBetween(m, a, b, false).map((d) => scoreDeal(m, d))
  const legs = [...ones].sort((x, y) => y.ua + y.ub - (x.ua + x.ub)).slice(0, 6)
  const twos: Scored[] = []
  const seen = new Set<string>()
  for (const [x, y] of pairs(legs)) {
    if (x.deal.aGives[0] === y.deal.aGives[0] || x.deal.bGives[0] === y.deal.bGives[0]) continue
    const d = { a, b, aGives: [x.deal.aGives[0]!, y.deal.aGives[0]!], bGives: [x.deal.bGives[0]!, y.deal.bGives[0]!], aCards: [], bCards: [] }
    // Crossed legs (A for B and C for D, A for D and C for B) make the same deal.
    if (seen.has(key(d))) continue
    seen.add(key(d))
    twos.push(scoreDeal(m, d))
  }
  for (const d of consolidations(m, a, b)) if (!seen.has(key(d))) twos.push(scoreDeal(m, d))
  return [...ones, ...twos]
}

/**
 * A deal with the cheapest package of cards (fewest cards on a tie) that
 * brings the receiving side's utility to `got` or more while the side paying
 * keeps `left` or more: the proposer's cards (`from` 'a', to win the partner
 * over) or the partner's (`from` 'b', when the proposer asks for them), never
 * both. Never more cards than the payer has room for. Cards top up a player
 * trade rather than replace one: the players alone within twice LOPSIDED_GAP
 * of each other, and the deal with its cards fair (a gap under it); otherwise
 * a rebuilding GM, who counts cards high, would sell a star for a bench player
 * and three cheap cards. Null when no package does.
 */
function withPackage(m: Market, s: Scored, from: 'a' | 'b', got: number, left: number): Scored | null {
  const d = s.deal
  const { team, byId } = index(m)
  const value = (ids: string[]) => ids.reduce((sum, id) => sum + (byId.get(id)?.value ?? 0), 0)
  if (Math.abs(value(d.bGives) - value(d.aGives)) >= 2 * LOPSIDED_GAP) return null
  const payer = from === 'a' ? d.a : d.b
  const taker = from === 'a' ? d.b : d.a
  const has = from === 'a' ? d.aCards : d.bCards
  const room = cardRoom(m, payer) - has.length
  // Cards go one way: a deal already asking the other side for cards gets no package back.
  if (room <= 0 || (from === 'a' ? d.bCards : d.aCards).length > 0) return null
  const used = new Set([...d.aCards, ...d.bCards])
  const takerNow = from === 'a' ? s.ub : s.ua
  const payerNow = from === 'a' ? s.ua : s.ub
  const wIn = cardWeight(team.get(taker)!.leaning) / 5
  const wOut = cardWeight(team.get(payer)!.leaning) / 5
  for (const p of packsOf(m, payer)) {
    if (p.ids.length > room || p.ids.some((id) => used.has(id))) continue
    // Utilities move with the cards' worth alone (rounding aside): too little for the taker, look on;
    // too much for the payer, and every package after this one costs more still.
    if (takerNow + wIn * p.worth < got - 0.02) continue
    if (payerNow - wOut * p.worth < left - 0.02) return null
    const next = scoreDeal(m, from === 'a' ? { ...d, aCards: [...d.aCards, ...p.ids] } : { ...d, bCards: [...d.bCards, ...p.ids] })
    // The payer's raw gain: still lopsided its way, a bigger package may even it out; the other way, any bigger overpays more.
    const payerGain = from === 'a' ? -next.gap : next.gap
    if (payerGain <= -LOPSIDED_GAP) return null
    if (payerGain >= LOPSIDED_GAP) continue
    if ((from === 'a' ? next.ub : next.ua) >= got && (from === 'a' ? next.ua : next.ub) >= left) return next
  }
  return null
}

/**
 * Deals one GM could sensibly offer: good for it, and not so bad for the
 * partner that a yes is out of the question. When the partner wouldn't, the
 * proposer may add its cheapest package of cards that wins it over; when the
 * deal does more for the partner than for the proposer, the proposer may ask
 * for the partner's cheapest package that makes it worth its while. At most
 * two per partner, so the options are varied. A star chaser also gets its
 * boldest try: the best player it could bring in, whatever the partner
 * thinks, with a package on top when that wins the partner over.
 */
export function candidates(m: Market, proposer: string, limit = 6): Scored[] {
  const me = m.teams.find((t) => t.id === proposer)
  if (!me) return []
  const scored: Scored[] = []
  for (const partner of m.teams) {
    if (partner.id === proposer || !partner.tradable) continue
    for (const s of dealsWorthScoring(m, proposer, partner.id)) {
      const pick = s.ua > WORTH ? (s.ub >= HOPELESS ? s : withPackage(m, s, 'a', 0, WORTH + 0.01)) : s.ub > HOPELESS ? withPackage(m, s, 'b', WORTH + 0.01, HOPELESS) : null
      if (pick) scored.push(pick)
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
    const tries = m.teams
      .filter((t) => t.id !== proposer && t.tradable)
      .flatMap((t) => swapsBetween(m, proposer, t.id, false))
      .map((d) => ({ d, star: byId.get(d.bGives[0]!)!.value }))
      .sort((x, y) => y.star - x.star)
      .slice(0, 40)
      .map((x) => scoreDeal(m, x.d))
      .filter((s) => s.ua > 0)
      .sort((x, y) => y.ua - x.ua)
    const top = tries[0]
    // A package of its cards may win the partner over: for the same star, whatever it sends with them.
    const packed =
      top && top.ub < 0
        ? tries
            .filter((s) => s.deal.bGives[0] === top.deal.bGives[0])
            .map((s) => (s.ub >= 0 ? s : withPackage(m, s, 'a', 0, 0.01)))
            .find((s): s is Scored => s !== null)
        : undefined
    const bold = packed ?? top
    if (bold && !out.some((s) => key(s.deal) === key(bold.deal))) out.push(bold)
  }
  return out
}

/**
 * Counter-offers the receiver of `offer` could make: deals between the same
 * two teams that are clearly better for the receiver and that the proposer
 * might still take. The receiver may also ask for cards: a deal it would
 * refuse comes back with the proposer's cheapest package that makes it a yes,
 * the offer itself first ("the same, with cards on top"). Each is written
 * from the original proposer's side.
 */
export function counters(m: Market, offer: Deal, limit = 4): Scored[] {
  const base = scoreDeal(m, offer)
  const options: Scored[] = []
  const seen = new Set([key(offer)])
  // What a yes takes: liking it, and clearly more than the offer.
  const yes = Math.max(0, Math.round((base.ub + 0.21) * 100) / 100)
  const consider = (s: Scored | null) => {
    if (!s || seen.has(key(s.deal))) return null
    seen.add(key(s.deal))
    if (!(s.ub > base.ub + 0.2 && s.ua > -0.3)) return null
    options.push(s)
    return s
  }
  const asked = consider(withPackage(m, base, 'a', yes, -0.29))
  for (const d of swapsBetween(m, offer.a, offer.b)) {
    const s = scoreDeal(m, d)
    consider(s)
    if (s.ub < yes) consider(withPackage(m, s, 'a', yes, -0.29))
  }
  options.sort((x, y) => (y === asked ? 1 : 0) - (x === asked ? 1 : 0) || y.ub - x.ub)
  const out: Scored[] = []
  for (const s of options) {
    if (out.length >= limit) break
    if (out.some((o) => o.deal.bGives.join() === s.deal.bGives.join() && o.deal.aGives.join() === s.deal.aGives.join())) continue
    out.push(s)
  }
  return out
}

/**
 * The team sending its star in a consolidation: a 2-for-2 in which one side
 * sends its best and its weakest tradable players. Null when the deal isn't one.
 */
export function consolidationBy(m: Market, d: Deal): string | null {
  if (d.aGives.length !== 2 || d.bGives.length !== 2) return null
  const sends = (team: string, ids: string[]) => {
    // Its players as they are before the deal: the ones it sends count as tradable.
    const free = (index(m).roster.get(team) ?? []).filter((p) => !p.locked || ids.includes(p.id)).sort(bestFirst)
    return free.length > 2 && ids.includes(free[0]!.id) && ids.includes(free.at(-1)!.id)
  }
  return sends(d.a, d.aGives) ? d.a : sends(d.b, d.bGives) ? d.b : null
}

/** A player's place in the league by value: 0 for the best. */
function leagueRank(m: Market, playerId: string): number {
  const i = index(m)
  i.rank ??= new Map([...m.players].sort(bestFirst).map((p, at) => [p.id, at]))
  return i.rank.get(playerId) ?? Infinity
}

/** Whether he's his team's best player (by value; ties go by id). */
function bestOnTeam(m: Market, p: MarketPlayer): boolean {
  const team = index(m).roster.get(p.teamId) ?? []
  return team.every((x) => x === p || bestFirst(p, x) < 0)
}

/**
 * Whether a deal moves a star, so the story engine covers it as a
 * blockbuster. A star is one of the league's ten best players (in a league
 * of 216; the same share in others), or one of its twenty best when the
 * trade makes him its headline: he's his school's franchise player, his team
 * sends him as its best player in a consolidation, or two cards or more go
 * with him. `earlier`: the players this season's blockbusters so far moved.
 * The season's first star trade is one; after it, only one of the ten best
 * who outranks every player they moved, so the big coverage stays rare
 * (one or two a season).
 */
export function isBlockbuster(m: Market, d: Deal, earlier: readonly string[][] = []): boolean {
  const { byId } = index(m)
  const top = Math.max(1, Math.round(m.players.length * STAR_SHARE))
  const near = Math.max(2, Math.round(m.players.length * NEAR_SHARE))
  const moved = [...d.aGives, ...d.bGives].map((id) => byId.get(id)).filter((p): p is MarketPlayer => p !== undefined)
  const seller = consolidationBy(m, d)
  const headline = (p: MarketPlayer) => p.franchise || (p.teamId === seller && bestOnTeam(m, p)) || d.aCards.length + d.bCards.length >= 2
  const star = (p: MarketPlayer) => leagueRank(m, p.id) < top || (leagueRank(m, p.id) < near && headline(p))
  if (!moved.some(star)) return false
  if (earlier.length < BLOCKBUSTERS_A_SEASON) return true
  const record = Math.min(top, ...earlier.flatMap((ids) => ids.map((id) => leagueRank(m, id))))
  return moved.some((p) => leagueRank(m, p.id) < record)
}

/**
 * Whether a deal can still be made as it was offered: its players on the
 * teams sending them and free to move, its cards held by the teams sending
 * them, tradable, and within their room under the cap.
 */
export function dealStillOpen(m: Market, d: Deal): boolean {
  const { byId, cards } = index(m)
  const players = (team: string, ids: string[]) => ids.every((id) => byId.get(id)?.teamId === team && !byId.get(id)!.locked)
  const own = (team: string, ids: number[]) => ids.length <= cardRoom(m, team) && ids.every((id) => cards.get(id)?.ownerTeamId === team && cards.get(id)!.tradable)
  return players(d.a, d.aGives) && players(d.b, d.bGives) && own(d.a, d.aCards) && own(d.b, d.bCards)
}
