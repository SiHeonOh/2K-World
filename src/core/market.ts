import type { CardTier, LeagueConfig, Phase } from '@shared/config/schema'
import { coverOf, fitValue, knownRoles, roleChanges, type Cover, type Role } from './roles'
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
 *
 * A GM weighs what a front office would, past the raw numbers: a draft card
 * also protects its own best players at the card-swap draft (giving the last
 * ones away can leave a star for anyone to take); a lineup needs its core
 * roles (roles.ts); where the team stands (contender, bubble or rebuilding)
 * moves win-now and development GMs alike as the season goes; early in the
 * regular season every GM is cautious; and an unhappy player is worth a
 * little less to whoever has him.
 */

export interface MarketPlayer {
  id: string
  teamId: string
  slotId: string | null
  /** Player value, 0–100 (src/core/value.ts), with his season form. */
  value: number
  /** Visibly unhappy (mood band 불만 or worse): his team is keener to move him. */
  unhappy: boolean
  /** 0..1, how keen his team is to move him (wanting out, a request); unhappy counts as 1 without it. */
  moveWish?: number
  /** Deeply attached to his school: a loyal GM is slow to sell him. */
  franchise?: boolean
  /** Can't be traded now (the once-per-season lock). */
  locked: boolean
  /** The core roles he covers (src/core/roles.ts); left out: roles aren't read. */
  roles?: readonly Role[]
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
  /** Its regular-season record so far; left out: none (where it stands goes by strength). */
  record?: { wins: number; losses: number }
  /** Cards this season already issued it (the guaranteed tier at the season's start); left out: the lowest tier's count. */
  issued?: number
}

export interface Market {
  config: LeagueConfig
  teams: MarketTeam[]
  players: MarketPlayer[]
  cards: MarketCard[]
  /** Team ids, best first: the final ranking, or the standings while the season runs. */
  ranking: string[]
  /**
   * The season so far: its phase, and the regular season's games played of
   * its total (league-wide). Left out: unknown, so there's no early-season
   * caution and where a team stands doesn't move its GM.
   */
  season?: { phase: Phase; played: number; total: number }
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

/** A side's draft protection after a deal (card-swap drafts). */
export interface DraftSide {
  /** Projected draft cards now and after the deal (projectedCards). */
  cards: number
  cardsAfter: number
  /** The players it would protect after the deal, best first, and those its cards would leave unprotected. */
  need: string[]
  exposed: string[]
  /** What the deal's cards do to that, in value points: more players exposed is a cost (+), fewer a saving (−). */
  premium: number
}

export interface SideEffect {
  /** Team strength before and after (0–100). */
  before: number
  after: number
  /** Value points of cards coming in and going out. */
  cardsIn: number
  cardsOut: number
  /** Its lineup's roles before and after; left out when the league's ratings tell none. */
  roles?: { before: Cover; after: Cover }
  /** Draft protection, when cards change hands in a card-swap league. */
  draft?: DraftSide
  /** Strength as its GM judges it: the deal's unhappy players worth a little less to whoever has them (only when one is in it). */
  perceived?: { before: number; after: number }
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

/**
 * A gap this big (in value points: about what a good starter gives over a
 * replacement) gets the deal tagged as lopsided. OVR-led values sit closer
 * together than the old average of every rating, so it's 10 where it was 15.
 */
export const LOPSIDED_GAP = 10
/** Cards one side may put into a deal unless 단장 설정 says otherwise (fewer when the in-season cap leaves less room). */
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
/** Players a team would spend draft cards protecting: its best, up to this many, among the league's best 30% (PROTECT_LINE). */
export const PROTECT_MAX = 2
const PROTECT_LINE = 0.7
/**
 * What leaving one of them unprotected costs (value points): a share of his
 * value, half of it at the line and all of it for the league's best 5%, as
 * drafting teams take the best players left unprotected first.
 */
const PROTECT_SHARE = 0.25
/** An unhappy player is worth this share of his value less (at full wish to move) to whoever has him: buyers pay less, sellers take less. */
const UNHAPPY_DISCOUNT = 0.05
/** How far where a team stands moves its GM's weights (strength now against cards), late in the season. */
const LEAN = 0.4
/** Early-season caution: full until this share of the regular season's games is played, gone by this one… */
const CAUTION_FULL = 0.2
const CAUTION_END = 0.35
/** …and how much more a deal must be worth to either side at full caution (utility). */
const CAUTION_BAR = 0.6

const level = (t: GmLeaning, name: string) => t.traits[name] ?? 3
/** How much strength now counts for a GM, and how much cards do: win-now wants the first, developers the second. */
const nowWeight = (l: GmLeaning) => (l.philosophy === 'win-now' ? 1.4 : l.philosophy === 'development' ? 0.7 : 1)
const cardWeight = (l: GmLeaning) => (l.philosophy === 'win-now' ? 0.6 : l.philosophy === 'development' ? 1.4 : 1)
const round1 = (n: number) => Math.round(n * 10) / 10

/** One or more of a team's cards that could go into a deal together, and their worth. */
interface Pack {
  ids: number[]
  worth: number
}

/** Where a team stands: contender, bubble or rebuilding (standingOf). */
export type Stance = 'contender' | 'bubble' | 'rebuilding'

export interface Standing {
  stance: Stance
  /** Its place in its playoff group (its conference, or the league) by the table, and by strength. */
  rank: number
  strengthRank: number
  size: number
  /** The last direct playoff seed and the last play-in seed of the group. */
  line: number
  playIn: number
  /** −1..1: how far it moves its GM (a rebuilding team sells, a contender buys), more as the season goes. */
  lean: number
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
  starters: number
  /** The roles the league's ratings tell (none when players carry no roles). */
  known: Set<Role>
  /** Each team's lineup roles now, the players it would protect now, its projected draft cards, where it stands and its GM's weights (filled as asked). */
  cover: Map<string, Cover>
  need: Map<string, MarketPlayer[]>
  projected: Map<string, number>
  standing: Map<string, Standing>
  weights: Map<string, { now: number; cards: number }>
  /** The league's protection line (70th percentile value) and its best 5% (made when first asked). */
  lines: { p70: number; p95: number } | null
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
      starters: m.config.roster.slots.filter((s) => s.starter).length || 5,
      known: new Set(m.players.some((p) => p.roles !== undefined) ? knownRoles(m.config) : []),
      cover: new Map(),
      need: new Map(),
      projected: new Map(),
      standing: new Map(),
      weights: new Map(),
      lines: null,
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

/**
 * How many cards a team may put into one deal: the league's setting (three
 * unless changed; none set means as many as it holds), or what the in-season
 * cap leaves it, whichever is less.
 */
function cardRoom(m: Market, teamId: string): number {
  const setting = m.config.gm.dealCards === undefined ? MAX_CARDS : m.config.gm.dealCards
  const most = setting === null ? Number.POSITIVE_INFINITY : setting
  return Math.max(0, Math.min(most, index(m).team.get(teamId)?.cardRoom ?? most))
}

/**
 * A team's card packages: every set of its tradable cards up to its room
 * (see cardRoom), cheapest first, and fewer cards first when two cost the same.
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
 * more: from 4 (the best team's) to 12 (the worst team's). What it does for
 * the holder's own protection is counted apart (DraftSide).
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

/**
 * teamStrength from the values alone, best first (the same sums in the same
 * order, so the same number): deals are scored by the ten thousand, and
 * sorting numbers is cheaper than sorting players.
 */
function strengthOfValues(m: Market, values: number[]): number {
  const n = index(m).starters
  // Best first, by insertion (a roster is a handful of numbers: quicker than sort with a comparator).
  for (let a = 1; a < values.length; a++) {
    const v = values[a]!
    let b = a - 1
    while (b >= 0 && values[b]! < v) {
      values[b + 1] = values[b]!
      b--
    }
    values[b + 1] = v
  }
  let top = 0
  let bench = 0
  for (let k = 0; k < values.length; k++) {
    if (k < n) top += values[k]!
    else bench += values[k]! * 0.25
  }
  const weight = Math.min(n, values.length) + Math.max(0, values.length - n) * 0.25
  return weight > 0 ? Math.round(((top + bench) / weight) * 10) / 10 : 0
}

/** The roles a team's lineup (its top five by value) covers now. */
function coverNow(m: Market, teamId: string): Cover {
  const i = index(m)
  let c = i.cover.get(teamId)
  if (!c) {
    c = coverOf([...(i.roster.get(teamId) ?? [])].sort(bestFirst).slice(0, i.starters))
    i.cover.set(teamId, c)
  }
  return c
}

/** The roles a deal costs a side's lineup or fills in it (none when the league's ratings tell no roles). */
export function roleNews(m: Market, e: SideEffect): { lost: Role[]; filled: Role[] } {
  return e.roles ? roleChanges(e.roles.before, e.roles.after, index(m).known) : { lost: [], filled: [] }
}

// ── The draft: cards that protect a team's best players ─────────────────

/** The card-swap draft whose protections cards still decide: none once the draft itself is on (protections are made with the cards in hand). */
const cardDraft = (m: Market) => (m.config.draft.kind === 'card-swap' && m.season?.phase !== 'draft' ? m.config.draft : null)

/**
 * The draft cards a team can expect to hold when the draft opens:
 *
 *   projected = the unused cards it holds now
 *             + (the cards its current standings rank would earn from
 *                draft.allocation − the guaranteed tier already issued to it
 *                at the season's start)
 *
 * The second part is never below 0 (a rank that earns less takes nothing
 * back). `rank` is 1 for the best team; `issued` is this season's cards
 * already handed out to it (all of them once the playoffs end, so then
 * nothing more comes).
 */
export function projectedCards(allocation: readonly CardTier[], rank: number, held: number, issued: number): number {
  const tier = allocation.find((t) => rank >= t.fromRank && rank <= t.toRank)
  return held + Math.max(0, (tier?.cards ?? 0) - issued)
}

/** A team's projected draft cards now (projectedCards, from the market's cards and ranking). */
export function projectedNow(m: Market, teamId: string): number {
  const i = index(m)
  let n = i.projected.get(teamId)
  if (n === undefined) {
    const draft = cardDraft(m)
    const held = m.cards.filter((c) => c.ownerTeamId === teamId).length
    if (!draft) n = held
    else {
      const at = m.ranking.indexOf(teamId)
      const counts = draft.allocation.filter((t) => t.fromRank <= m.teams.length).map((t) => t.cards)
      const lowest = counts.length > 0 ? Math.min(...counts) : 0
      n = projectedCards(draft.allocation, at >= 0 ? at + 1 : m.ranking.length + 1, held, i.team.get(teamId)?.issued ?? lowest)
    }
    i.projected.set(teamId, n)
  }
  return n
}

function protectionLines(m: Market): { p70: number; p95: number } {
  const i = index(m)
  if (!i.lines) {
    const v = m.players.map((p) => p.value).sort((a, b) => a - b)
    const at = (q: number) => v[Math.max(0, Math.floor(q * (v.length - 1)))] ?? 0
    i.lines = { p70: at(PROTECT_LINE), p95: at(0.95) }
  }
  return i.lines
}

/** The players a team would protect, from its roster best first: its best (up to PROTECT_MAX) among the league's best 30%. */
function needOf(m: Market, ordered: readonly MarketPlayer[]): MarketPlayer[] {
  const { p70 } = protectionLines(m)
  return ordered.filter((p) => p.value >= p70).slice(0, PROTECT_MAX)
}

/**
 * The players a team would protect after a deal. The same as now unless the
 * deal sends one of them away or brings in someone good enough to be one,
 * so most deals need no new look at the roster.
 */
function needAfter(m: Market, d: Deal, team: string): MarketPlayer[] {
  const i = index(m)
  let now = i.need.get(team)
  if (!now) {
    now = needOf(m, [...(i.roster.get(team) ?? [])].sort(bestFirst))
    i.need.set(team, now)
  }
  const [out, incoming] = team === d.a ? [d.aGives, d.bGives] : [d.bGives, d.aGives]
  const { p70 } = protectionLines(m)
  if (!now.some((p) => out.includes(p.id)) && !incoming.some((id) => (i.byId.get(id)?.value ?? 0) >= p70)) return now
  return needOf(m, rosterAfter(m, d, team))
}

/** What leaving the needed players beyond `cards` unprotected would cost, in value points. */
function exposure(m: Market, need: readonly MarketPlayer[], cards: number): number {
  const { p70, p95 } = protectionLines(m)
  let cost = 0
  for (let k = Math.max(0, cards); k < need.length; k++) {
    const v = need[k]!.value
    const taken = 0.5 + 0.5 * Math.min(1, Math.max(0, p95 > p70 ? (v - p70) / (p95 - p70) : 1))
    cost += PROTECT_SHARE * v * taken
  }
  return cost
}

/** A team's roster after a deal, best first. */
function rosterAfter(m: Market, d: Deal, team: string): MarketPlayer[] {
  const { byId, roster } = index(m)
  const [out, incoming] = team === d.a ? [d.aGives, d.bGives] : [d.bGives, d.aGives]
  return [...(roster.get(team) ?? []).filter((p) => !out.includes(p.id)), ...incoming.map((id) => byId.get(id)!)].sort(bestFirst)
}

/** A team's projected draft cards after a deal: its own now, less those it gives, plus those it gets. */
function cardsAfter(m: Market, d: Deal, team: string): number {
  const given = team === d.a ? d.aCards.length : d.bCards.length
  const got = team === d.a ? d.bCards.length : d.aCards.length
  return Math.max(0, projectedNow(m, team) - given + got)
}

function draftSide(m: Market, d: Deal, team: string): DraftSide {
  const cards = projectedNow(m, team)
  const after = cardsAfter(m, d, team)
  const need = needAfter(m, d, team)
  return {
    cards,
    cardsAfter: after,
    need: need.map((p) => p.id),
    exposed: need.slice(after).map((p) => p.id),
    // Only the cards' part, on the roster as the deal leaves it: a player trade alone costs no protection.
    premium: exposure(m, need, after) - exposure(m, need, cards),
  }
}

/** A team's draft protection after a deal (as before it, for the deal with no players or cards); null without a card-swap draft. */
export function draftAfter(m: Market, d: Deal, team: string): DraftSide | null {
  return cardDraft(m) ? draftSide(m, d, team) : null
}

/** A team's draft protection as it stands: its projected cards, the players it would protect and those it couldn't. */
export function draftOutlook(m: Market, teamId: string): DraftSide | null {
  return draftAfter(m, { a: teamId, b: '', aGives: [], bGives: [], aCards: [], bCards: [] }, teamId)
}

/**
 * What k more of the payer's cards on top of a deal (k = 0…most) cost the
 * payer and save the taker in draft protection, in utility (cards move
 * nothing else).
 */
function protectionSteps(m: Market, d: Deal, payer: string, taker: string, most: number): { cost: number[]; gain: number[] } {
  const zero = new Array<number>(most + 1).fill(0)
  if (!cardDraft(m)) return { cost: zero, gain: zero }
  const pNeed = needAfter(m, d, payer)
  const tNeed = needAfter(m, d, taker)
  if (pNeed.length === 0 && tNeed.length === 0) return { cost: zero, gain: zero }
  const pCards = cardsAfter(m, d, payer)
  const tCards = cardsAfter(m, d, taker)
  const p0 = exposure(m, pNeed, pCards)
  const t0 = exposure(m, tNeed, tCards)
  return { cost: zero.map((_, k) => (exposure(m, pNeed, pCards - k) - p0) / 5), gain: zero.map((_, k) => (t0 - exposure(m, tNeed, tCards + k)) / 5) }
}

// ── Where a team stands, and how cautious GMs are ────────────────────────

/** How far the regular season is, 0..1 (1 when the market doesn't say: the table is what it is). */
function progress(m: Market): number {
  if (!m.season) return 1
  return m.season.total > 0 ? Math.min(1, m.season.played / m.season.total) : 0
}

/**
 * Where a team stands in its playoff group (its conference when the bracket
 * goes by conference, else the league): contender (in a direct playoff
 * seed), bubble (around the play-in line) or rebuilding (below it). Early on
 * its strength rank says it; the table takes over as its games mount (all
 * of it by half a season's games). The lean it gives its GM grows as the
 * season goes; with no season known, none.
 */
export function standingOf(m: Market, teamId: string): Standing {
  const i = index(m)
  let s = i.standing.get(teamId)
  if (!s) {
    const conference = (t: MarketTeam | undefined) => m.config.structure.divisions.find((d) => d.id === t?.divisionId)?.conferenceId ?? null
    const po = m.config.season.playoffs
    const me = i.team.get(teamId)
    const byConference = po.bracket === 'conference' && m.config.structure.conferences.length > 0
    const group = m.teams.filter((t) => !byConference || conference(t) === conference(me))
    const ids = new Set(group.map((t) => t.id))
    const size = group.length
    const rank = m.ranking.filter((id) => ids.has(id)).indexOf(teamId) + 1 || size
    const mine = strengthNow(m, teamId)
    const strengthRank = 1 + group.filter((t) => t.id !== teamId && (strengthNow(m, t.id) > mine || (strengthNow(m, t.id) === mine && t.id < teamId))).length
    const line = po.enabled ? Math.min(size, po.directSeeds) : Math.max(1, Math.round(size / 4))
    const playIn = po.enabled && po.playIn.enabled ? Math.min(size, line + 4) : line
    const games = (me?.record?.wins ?? 0) + (me?.record?.losses ?? 0)
    const seasonGames = m.season && m.teams.length > 0 ? (2 * m.season.total) / m.teams.length : 0
    const table = !m.season ? 1 : seasonGames > 0 ? Math.min(1, games / (0.5 * seasonGames)) : 0
    const at = table * rank + (1 - table) * strengthRank
    const stance: Stance = at <= line + 0.5 ? 'contender' : at <= playIn + 1.5 ? 'bubble' : 'rebuilding'
    // Only while the season is on: in the draft and the offseason every GM looks to the next season.
    const inSeason = m.season?.phase === 'preseason' || m.season?.phase === 'regular'
    const lean = !inSeason ? 0 : (stance === 'contender' ? 1 : stance === 'rebuilding' ? -1 : 0) * (0.25 + 0.75 * Math.min(1, progress(m) / 0.6))
    s = { stance, rank, strengthRank, size, line, playIn, lean }
    i.standing.set(teamId, s)
  }
  return s
}

/** How much strength now and cards count for a GM: its philosophy, moved by where the team stands (a losing win-now GM eases off, a contending developer buys). */
function weightsOf(m: Market, teamId: string): { now: number; cards: number } {
  const i = index(m)
  let w = i.weights.get(teamId)
  if (!w) {
    const l = i.team.get(teamId)!.leaning
    const lean = LEAN * standingOf(m, teamId).lean
    const clamp = (v: number) => Math.min(1.8, Math.max(0.4, v))
    w = { now: clamp(nowWeight(l) + lean), cards: clamp(cardWeight(l) - lean) }
    i.weights.set(teamId, w)
  }
  return w
}

/**
 * Early-season caution, 0..1: full until 20% of the regular season's games
 * are played, gone by 35%, in between in a straight line. Only in the
 * regular season (games played against the season's total, rounds or 2K
 * 일정대로 sessions alike), and only while 단장 설정 has it on.
 */
export function caution(m: Market): number {
  if (!m.season || m.season.phase !== 'regular' || m.config.gm.earlyCaution === false) return 0
  const p = progress(m)
  return p <= CAUTION_FULL ? 1 : p >= CAUTION_END ? 0 : (CAUTION_END - p) / (CAUTION_END - CAUTION_FULL)
}

/** How much more a deal must be worth to a GM now (utility): the early-season caution's bar. */
export function cautionBar(m: Market): number {
  return Math.round(CAUTION_BAR * caution(m) * 100) / 100
}

// ── Scoring a deal ───────────────────────────────────────────────────────

/** What a deal does to each team: strength, the cards' worth either way, its lineup's roles, draft protection and, with unhappy players in it, strength as its GM sees it. */
export function dealEffect(m: Market, d: Deal): { a: SideEffect; b: SideEffect } {
  const { cards } = index(m)
  const worth = (ids: number[]) => ids.reduce((s, id) => s + (cards.has(id) ? cardValue(m, cards.get(id)!) : 0), 0)
  return {
    a: sideEffect(m, d, d.a, worth(d.bCards), worth(d.aCards)),
    b: sideEffect(m, d, d.b, worth(d.aCards), worth(d.bCards)),
  }
}

function sideEffect(m: Market, d: Deal, team: string, cardsIn: number, cardsOut: number): SideEffect {
  const i = index(m)
  const [out, incoming] = team === d.a ? [d.aGives, d.bGives] : [d.bGives, d.aGives]
  const roster = i.roster.get(team) ?? []
  const less = (p: MarketPlayer) => p.value * (1 - UNHAPPY_DISCOUNT * moveWish(p))
  // The values after the deal (and as its GM sees them, with the deal's unhappy players worth less): built by hand, as this runs by the ten thousand.
  const after: number[] = []
  const seen: number[] = []
  const was: number[] = []
  let sold = false
  let bought = false
  for (const p of roster) {
    if (out.includes(p.id)) {
      const wish = moveWish(p) > 0
      sold ||= wish
      was.push(wish ? less(p) : p.value)
      continue
    }
    after.push(p.value)
    seen.push(p.value)
    was.push(p.value)
  }
  for (const id of incoming) {
    const p = i.byId.get(id)!
    after.push(p.value)
    const wish = moveWish(p) > 0
    bought ||= wish
    seen.push(wish ? less(p) : p.value)
  }
  const e: SideEffect = { before: strengthNow(m, team), after: strengthOfValues(m, after), cardsIn, cardsOut }
  if (i.known.size > 0) {
    const lineup = [...roster.filter((p) => !out.includes(p.id)), ...incoming.map((id) => i.byId.get(id)!)].sort(bestFirst).slice(0, i.starters)
    e.roles = { before: coverNow(m, team), after: coverOf(lineup) }
  }
  if (d.aCards.length + d.bCards.length > 0 && cardDraft(m)) e.draft = draftSide(m, d, team)
  if (sold || bought) e.perceived = { before: sold ? strengthOfValues(m, was) : e.before, after: bought ? strengthOfValues(m, seen) : e.after }
  return e
}

/** Raw value the proposer gains: players and cards in, minus out. */
export function dealGap(m: Market, d: Deal, e: { a: SideEffect }): number {
  const { byId } = index(m)
  const value = (ids: string[]) => ids.reduce((s, id) => s + (byId.get(id)?.value ?? 0), 0)
  return value(d.bGives) - value(d.aGives) + e.a.cardsIn - e.a.cardsOut
}

/**
 * How much one GM likes its side of a deal. Strength now matters most to a
 * win-now GM and least to a developer, who values cards more, and where the
 * team stands moves both as the season goes. A card also protects the
 * team's best players at the draft (DraftSide's premium, the same to every
 * GM). Losing the only player in a core role hurts and filling one helps
 * (roles.ts; a defense-first GM minds the big and the stopper more). A loyal
 * GM is slow to send players away; moving an unhappy one is a plus (and he
 * counts for less on either side: perceived strength); a star chaser wants
 * the best player in the deal; regional pride likes players from the same
 * division; a cautious GM dislikes big shake-ups. The AI weighs the rest.
 */
export function utility(m: Market, side: 'a' | 'b', d: Deal, e: SideEffect): number {
  const teamId = side === 'a' ? d.a : d.b
  const { byId, team: teams, known } = index(m)
  const team = teams.get(teamId)!
  const out = side === 'a' ? d.aGives : d.bGives
  const incoming = side === 'a' ? d.bGives : d.aGives
  const l = team.leaning
  const w = weightsOf(m, teamId)
  const all = [...out, ...incoming].map((id) => byId.get(id)!)
  const best = all.reduce<MarketPlayer | null>((x, p) => (x === null || p.value > x.value ? p : x), null)
  const star = best ? (incoming.includes(best.id) ? 1 : -1) : 0
  const divisionOf = (pid: string) => teams.get(byId.get(pid)?.teamId ?? '')?.divisionId
  const local = incoming.filter((pid) => divisionOf(pid) === team.divisionId).length
  let u = w.now * (e.perceived ? e.perceived.after - e.perceived.before : e.after - e.before)
  u += (w.cards * (e.cardsIn - e.cardsOut)) / 5
  if (e.draft) u -= e.draft.premium / 5
  if (e.roles) u += fitValue(e.roles.before, e.roles.after, known, level(l, 'defense_first'))
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
 * and three cheap cards. Each card also counts for both sides' draft
 * protection (the payer's last ones may leave its star unprotected). Null
 * when no package does.
 */
function withPackage(m: Market, s: Scored, from: 'a' | 'b', got: number, left: number): Scored | null {
  const d = s.deal
  const { byId } = index(m)
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
  const wIn = weightsOf(m, taker).cards / 5
  const wOut = weightsOf(m, payer).cards / 5
  const packs = packsOf(m, payer)
  // Not even the cheapest package leaves the payer enough (protection only adds to what it costs): none will.
  if (packs.length === 0 || payerNow - wOut * packs[0]!.worth < left - 0.02) return null
  const steps = protectionSteps(m, d, payer, taker, Math.min(room, packs.reduce((n, p) => Math.max(n, p.ids.length), 0)))
  const least = steps.cost[1] ?? 0
  for (const p of packs) {
    const k = p.ids.length
    if (k > room || p.ids.some((id) => used.has(id))) continue
    // Utilities move with the cards' worth and count alone (rounding aside): too little for the taker, look on;
    // too much for the payer, and every package after this one costs more still (at least one card's protection).
    if (takerNow + wIn * p.worth + steps.gain[k]! < got - 0.02) continue
    if (payerNow - wOut * p.worth - least < left - 0.02) return null
    if (payerNow - wOut * p.worth - steps.cost[k]! < left - 0.02) continue
    const next = scoreDeal(m, from === 'a' ? { ...d, aCards: [...d.aCards, ...p.ids] } : { ...d, bCards: [...d.bCards, ...p.ids] })
    // The payer's raw gain (the gap is the proposer's): still lopsided its way, a bigger package may even it out; the other way, any bigger overpays more.
    const payerGain = from === 'a' ? next.gap : -next.gap
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
 * thinks, with a package on top when that wins the partner over. Early in
 * the season (cautionBar) every bar is that much higher, for both sides.
 */
export function candidates(m: Market, proposer: string, limit = 6): Scored[] {
  const me = m.teams.find((t) => t.id === proposer)
  if (!me) return []
  const bar = cautionBar(m)
  const worth = WORTH + bar
  const scored: Scored[] = []
  for (const partner of m.teams) {
    if (partner.id === proposer || !partner.tradable) continue
    for (const s of dealsWorthScoring(m, proposer, partner.id)) {
      const pick = s.ua > worth ? (s.ub >= HOPELESS + bar ? s : withPackage(m, s, 'a', bar, worth + 0.01)) : s.ub > HOPELESS + bar ? withPackage(m, s, 'b', worth + 0.01, HOPELESS + bar) : null
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
      .filter((s) => s.ua > bar)
      .sort((x, y) => y.ua - x.ua)
    const top = tries[0]
    // A package of its cards may win the partner over: for the same star, whatever it sends with them.
    const packed =
      top && top.ub < bar
        ? tries
            .filter((s) => s.deal.bGives[0] === top.deal.bGives[0])
            .map((s) => (s.ub >= bar ? s : withPackage(m, s, 'a', bar, bar + 0.01)))
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
 * from the original proposer's side. Early in the season both sides want
 * that much more (cautionBar).
 */
export function counters(m: Market, offer: Deal, limit = 4): Scored[] {
  const base = scoreDeal(m, offer)
  const bar = cautionBar(m)
  const options: Scored[] = []
  const seen = new Set([key(offer)])
  // What a yes takes: liking it, and clearly more than the offer.
  const yes = Math.max(bar, Math.round((base.ub + 0.21) * 100) / 100)
  const consider = (s: Scored | null) => {
    if (!s || seen.has(key(s.deal))) return null
    seen.add(key(s.deal))
    if (!(s.ub > base.ub + 0.2 && s.ua > bar - 0.3)) return null
    options.push(s)
    return s
  }
  const asked = consider(withPackage(m, base, 'a', yes, bar - 0.29))
  for (const d of swapsBetween(m, offer.a, offer.b)) {
    const s = scoreDeal(m, d)
    consider(s)
    if (s.ub < yes) consider(withPackage(m, s, 'a', yes, bar - 0.29))
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

/** How a counter compares with what the proposer first asked for, from the proposer's side. */
export interface AskDiff {
  /** Players it asked for that the counter leaves out, and those it gets instead. */
  dropped: string[]
  added: string[]
  /** Players it offered that the counter spares, and those it must send instead. */
  spared: string[]
  extra: string[]
  /** Raw value it gains (players and cards), strength after and its utility: the counter's less the ask's. */
  value: number
  strength: number
  utility: number
  /** Roles its lineup would keep with the ask but loses with the counter. */
  roles: Role[]
  /** Its players the counter leaves unprotected at the draft that the ask didn't. */
  exposed: string[]
}

export function versusAsk(m: Market, asked: Deal, counter: Deal): AskDiff {
  const a = scoreDeal(m, asked)
  const c = scoreDeal(m, counter)
  const lost = a.a.roles && c.a.roles ? roleChanges(a.a.roles.after, c.a.roles.after, index(m).known).lost : []
  const was = new Set(draftAfter(m, asked, asked.a)?.exposed ?? [])
  return {
    dropped: asked.bGives.filter((id) => !counter.bGives.includes(id)),
    added: counter.bGives.filter((id) => !asked.bGives.includes(id)),
    spared: asked.aGives.filter((id) => !counter.aGives.includes(id)),
    extra: counter.aGives.filter((id) => !asked.aGives.includes(id)),
    value: round1(c.gap - a.gap),
    strength: round1(c.a.after - a.a.after),
    utility: Math.round((c.ua - a.ua) * 100) / 100,
    roles: lost,
    exposed: (draftAfter(m, counter, counter.a)?.exposed ?? []).filter((id) => !was.has(id)),
  }
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
