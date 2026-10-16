import type { CardTier, Phase } from '@shared/config/schema'
import type { CardRow, DraftActionRow } from '@shared/season'
import type { RatingValue } from '@shared/setup'
import { peckingOrder, playerValue } from '@core/value'
import type { Db } from './db'
import { currentSeason, listPlayers, listTeams, loadConfig } from './league'
import { draftView, listCards, tradeContext } from './moves'
import { standings } from './season'

/**
 * Each school's card-swap draft situation, read from the league: the cards
 * it holds (its own and others'), the cards it traded away, what the
 * in-season cap has left it, the cards it's on track to have when the draft
 * comes, and its best players (whom it would want to protect). During the
 * draft, the draft room too. The writers' card tables (story/draftCards.ts)
 * and the wiki's school infobox read it.
 */

/** Cards a place in the final ranking earns by the tiers (1 = first); 0 past the last tier. */
export function tierCards(allocation: readonly CardTier[], rank: number): number {
  return allocation.find((t) => rank >= t.fromRank && rank <= t.toRank)?.cards ?? 0
}

/**
 * The cards a school is on track to have at the draft: the unused cards it
 * holds now (`held`), plus what its place in the table (`rankIndex`, 0 =
 * first) would earn by the tiers beyond the cards this season already
 * issued it (`issuedPerTeam`: the lowest tier from the season's start, none
 * before it, its whole count once the playoffs end). Cards aren't taken back,
 * so a place worth less than what was issued adds nothing. Frozen schools
 * get no cards at all: the reader leaves them out of this.
 */
export function projectedDraftCards(allocation: readonly CardTier[], rankIndex: number, issuedPerTeam: number, held: number): number {
  return held + Math.max(0, tierCards(allocation, rankIndex + 1) - issuedPerTeam)
}

export interface SchoolCards {
  teamId: string
  frozen: boolean
  /** Its place (1 = first): the table now, or the final ranking once the regular season has ended. */
  rank: number
  /** Unused cards it holds now: its own first, then others' (by school, then number). */
  held: CardRow[]
  /** Cards it sent away in trades this season, oldest first, and to whom. */
  sent: { card: CardRow; to: string }[]
  /** Card trades this season in the phases the in-season cap counts (preseason, regular season). */
  inSeason: { given: number; received: number; trades: number }
  /** This season's cards issued to it so far (numbered 1..n). */
  issued: number
  /** What its place would still bring when the playoffs end (0 once they're handed out, and for a frozen school). */
  toCome: number
  /** What it would have at the draft: held + toCome (projectedDraftCards). */
  projected: number
  /** Its players, most valuable first (value, then id), with the headline rating (OVR) when the league has one. */
  roster: { playerId: string; value: number; overall: RatingValue | null }[]
}

export interface DraftRoom {
  /** Pick order: worst record first, frozen schools left out. */
  order: string[]
  protectionOpen: boolean
  /** The card on the clock, or null when the swap turns are done. */
  next: CardRow | null
  actions: DraftActionRow[]
  /** Players who moved in this draft (swapped either way, or traded during it): protected for the rest of it. */
  moved: string[]
}

export interface DraftOutlook {
  phase: Phase
  seasonId: number
  /** The places are the final ranking, fixed when the regular season ended (not today's table). */
  final: boolean
  /** Regular-season games played: with none, the table's order means nothing yet. */
  played: number
  /** The in-season card cap and what it counts (null: no cap). */
  cap: { limit: number; counts: 'given' | 'received' | 'trades' } | null
  /** The lowest tier: what every school (not frozen) gets when the season starts. */
  guaranteed: number
  /** Every school, by place. */
  schools: SchoolCards[]
  /** Every player's value (the ratings' weighted 0–100, as GMs see it). */
  values: Map<string, number>
  /** The draft room, while the draft is on. */
  room: DraftRoom | null
}

/** Each school's cards and outlook, or null when the league has no card-swap draft. */
export function readDraftOutlook(db: Db): DraftOutlook | null {
  const { config } = loadConfig(db)
  if (config.draft.kind !== 'card-swap') return null
  const draft = config.draft
  const season = currentSeason(db)
  const teams = listTeams(db)
  const frozen = new Set(teams.filter((t) => t.control === 'frozen').map((t) => t.id))
  const table = standings(db)
  // Once the regular season ended, its final ranking decides the cards (afterPlayoffs uses it).
  const row = db.prepare('SELECT final_ranking FROM seasons WHERE id = ?').get(season.id) as { final_ranking: string | null }
  const fixed = row.final_ranking ? (JSON.parse(row.final_ranking) as string[]) : null
  const today = table.overall.map((s) => s.teamId)
  const ranking = fixed ? [...fixed, ...today.filter((id) => !fixed.includes(id))] : today
  const cards = listCards(db, season.id)
  const issued = new Map(
    (
      db.prepare('SELECT original_team_id, MAX(number) AS n FROM cards WHERE issued_season_id = ? GROUP BY original_team_id').all(season.id) as {
        original_team_id: string
        n: number
      }[]
    ).map((r) => [r.original_team_id, r.n]),
  )
  const sent = db
    .prepare(
      `SELECT i.card_id, i.from_team_id, i.to_team_id FROM trade_items i JOIN trades t ON t.id = i.trade_id
       WHERE t.season_id = ? AND t.status = 'applied' AND i.kind = 'card' ORDER BY t.id, i.rowid`,
    )
    .all(season.id) as { card_id: number; from_team_id: string; to_team_id: string }[]
  const counts = tradeContext(db).cardTradeCounts
  const players = listPlayers(db)
  const overallId = config.ratings.overallColumnId
  const values = new Map(players.map((p) => [p.id, playerValue(config, p.ratings)]))
  const ratings = new Map(players.map((p) => [p.id, p.ratings]))
  const order = new Map(teams.map((t, i) => [t.id, i]))
  const byCard = new Map(cards.map((c) => [c.id, c]))
  const schools: SchoolCards[] = ranking.map((teamId, i) => {
    const isFrozen = frozen.has(teamId)
    const held = cards
      .filter((c) => c.ownerTeamId === teamId && c.status === 'held')
      .sort(
        (a, b) =>
          Number(a.originalTeamId !== teamId) - Number(b.originalTeamId !== teamId) ||
          (order.get(a.originalTeamId) ?? 0) - (order.get(b.originalTeamId) ?? 0) ||
          a.issuedSeasonId - b.issuedSeasonId ||
          a.number - b.number,
      )
    const mine = issued.get(teamId) ?? 0
    const projected = isFrozen ? held.length : projectedDraftCards(draft.allocation, i, mine, held.length)
    const roster = peckingOrder(players.filter((p) => p.teamId === teamId).map((p) => ({ id: p.id, teamId, slotId: p.slotId, value: values.get(p.id) ?? 0 }))).map((p) => {
      const v = overallId ? ratings.get(p.id)?.[overallId] : undefined
      return { playerId: p.id, value: p.value, overall: v === undefined || v === '' ? null : v }
    })
    return {
      teamId,
      frozen: isFrozen,
      rank: i + 1,
      held,
      sent: sent.flatMap((s) => {
        const card = byCard.get(s.card_id)
        return s.from_team_id === teamId && card ? [{ card, to: s.to_team_id }] : []
      }),
      inSeason: counts.get(teamId) ?? { given: 0, received: 0, trades: 0 },
      issued: mine,
      toCome: projected - held.length,
      projected,
      roster,
    }
  })
  const cap = draft.cardTrades.enabled && draft.cardTrades.inSeasonCap !== null ? { limit: draft.cardTrades.inSeasonCap, counts: draft.cardTrades.capCounts } : null
  const lowest = draft.allocation.filter((t) => t.fromRank <= teams.length).map((t) => t.cards)
  let room: DraftRoom | null = null
  if (season.phase === 'draft') {
    const view = draftView(db)
    room = { order: view.order, protectionOpen: view.protectionOpen, next: view.next, actions: view.actions, moved: view.movedPlayers }
  }
  return {
    phase: season.phase,
    seasonId: season.id,
    final: fixed !== null,
    played: table.played,
    cap,
    guaranteed: lowest.length ? Math.min(...lowest) : 0,
    schools,
    values,
    room,
  }
}

/** The league's stars: its most valuable tenth of players (ties included), at least its best one. */
export function leagueStars(values: ReadonlyMap<string, number>): Set<string> {
  const sorted = [...values.values()].sort((a, b) => b - a)
  if (sorted.length === 0) return new Set()
  const line = sorted[Math.max(0, Math.ceil(sorted.length / 10) - 1)]!
  return new Set([...values].filter(([, v]) => v >= line).map(([id]) => id))
}

/** A school worth a draft storyline: short of cards for the stars it would protect, or sitting on others' cards. */
export interface DraftWatch {
  teamId: string
  /** 'crunch': fewer cards on the way than its stars (or a star and at most one card). 'hoard': two or more other schools' cards in hand. */
  kind: 'crunch' | 'hoard'
  /** Its stars (the league's top tenth), best first. */
  stars: string[]
  projected: number
  /** Other schools' cards it holds. */
  others: number
}

/**
 * Schools in a draft storyline ("드래프트 보호 위기"): a school whose cards on
 * the way are fewer than its stars it would want to protect (or that has a
 * star and at most one card), and one hoarding other schools' cards. Only
 * once the table means something (regular-season games played, or the final
 * ranking fixed) and before the draft; frozen schools sit the draft out.
 */
export function draftWatch(o: DraftOutlook): DraftWatch[] {
  if (!((o.phase === 'regular' && o.played > 0) || o.phase === 'playoffs')) return []
  const stars = leagueStars(o.values)
  const out: DraftWatch[] = []
  for (const s of o.schools) {
    if (s.frozen) continue
    const own = s.roster.filter((p) => stars.has(p.playerId)).map((p) => p.playerId)
    const others = s.held.filter((c) => c.originalTeamId !== s.teamId).length
    if (own.length > 0 && (s.projected < own.length || s.projected <= 1)) out.push({ teamId: s.teamId, kind: 'crunch', stars: own, projected: s.projected, others })
    else if (others >= 2) out.push({ teamId: s.teamId, kind: 'hoard', stars: own, projected: s.projected, others })
  }
  return out
}
