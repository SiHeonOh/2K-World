import type { MoodBand, MoodPartName, PlayerStateView, PlayerTimelineItem } from '@shared/mood'
import { flagsFor } from '@data/flags'
import { currentSeason, listPlayers } from '@data/league'
import { refuse } from '@data/rules'
import { lockerRoom, loreOf, relationTarget } from './mood'
import { tradeRequests } from './reactions'
import type { League } from './context'

/**
 * One player's state over a season, for the 선수 상태 page: his mood after
 * each of his team's games or moves, everything that happened to him, what
 * he said (with his 속마음), and where his trade request stands. Nothing
 * here is new data: it reads the snapshots, events and quotes already kept.
 */
export function playerState(league: League, playerId: string, seasonId?: number): PlayerStateView {
  const { db, config } = league
  const p = league.players.get(playerId)
  if (!p) refuse('unknown-player', { player: playerId })
  const current = currentSeason(db)
  const seasons = db.prepare('SELECT id, label FROM seasons ORDER BY id').all() as { id: number; label: string }[]
  const season = seasons.find((s) => s.id === seasonId)?.id ?? current.id
  const row = listPlayers(db).find((x) => x.id === playerId)
  const overallId = config.ratings.overallColumnId
  const ovr = overallId ? row?.ratings[overallId] : undefined
  const lore = loreOf(league, playerId)
  const entry = league.lore.player.get(playerId)

  const history = (
    db.prepare('SELECT overall, band, parts, feelings, created_at FROM player_mood WHERE player_id = ? AND season_id = ? ORDER BY id').all(playerId, season) as {
      overall: number
      band: MoodBand
      parts: string
      feelings: string | null
      created_at: string
    }[]
  ).map((r) => ({
    at: r.created_at,
    overall: r.overall,
    band: r.band,
    parts: JSON.parse(r.parts) as Record<MoodPartName, number>,
    feelings: r.feelings ? (JSON.parse(r.feelings) as { trust: number; attachment: number; wantingOut: number }) : null,
  }))

  // Everything that happened to him this season, from the event log.
  const events = (
    db
      .prepare(
        "SELECT id, type, payload, created_at FROM events WHERE season_id = ? AND type IN ('trade_applied', 'draft_swap', 'award_given', 'award_removed', 'mood_changed', 'wanting_out', 'move_vetoed') ORDER BY id",
      )
      .all(season) as { id: number; type: string; payload: string; created_at: string }[]
  ).map((e) => ({ ...e, payload: JSON.parse(e.payload) as Record<string, unknown> }))
  const vetoed = new Set(events.filter((e) => e.type === 'move_vetoed').map((e) => `${e.payload.kind as string}:${e.payload.refId as number}`))
  const awardName = new Map([...config.awards.season, ...config.awards.periodic].map((a) => [a.id, a.name]))
  const itemOf = db.prepare("SELECT from_team_id, to_team_id FROM trade_items WHERE trade_id = ? AND kind = 'player' AND player_id = ?")
  const timeline: PlayerTimelineItem[] = []
  for (const e of events) {
    const x = e.payload
    if (e.type === 'trade_applied' && (x.players as string[] | undefined)?.includes(playerId)) {
      const item = itemOf.get(x.tradeId as number, playerId) as { from_team_id: string; to_team_id: string } | undefined
      if (item) timeline.push({ kind: 'trade', at: e.created_at, from: item.from_team_id, to: item.to_team_id, vetoed: vetoed.has(`trade:${x.tradeId as number}`) })
    } else if (e.type === 'draft_swap' && (x.playerId === playerId || x.targetPlayerId === playerId)) {
      // He was either sent away (his team's player) or taken (the target).
      const sent = x.playerId === playerId
      timeline.push({
        kind: 'draft',
        at: e.created_at,
        from: (sent ? x.teamId : x.targetTeamId) as string,
        to: (sent ? x.targetTeamId : x.teamId) as string,
        vetoed: vetoed.has(`draft-swap:${x.actionId as number}`),
      })
    } else if (e.type === 'award_given' && x.playerId === playerId) {
      timeline.push({
        kind: 'award',
        at: e.created_at,
        award: awardName.get(x.awardId as string) ?? (x.awardId as string),
        period: (x.period as string) ?? '',
        teamRank: (x.teamRank as number) ?? 1,
        removed: false,
      })
    } else if (e.type === 'award_removed' && x.playerId === playerId) {
      // Taking an award back marks the award it took back (the latest matching one still standing).
      const name = awardName.get(x.awardId as string) ?? (x.awardId as string)
      const given = timeline.findLast(
        (t): t is Extract<PlayerTimelineItem, { kind: 'award' }> =>
          t.kind === 'award' && !t.removed && t.award === name && t.period === ((x.period as string) ?? '') && t.teamRank === ((x.teamRank as number) ?? 1),
      )
      if (given) given.removed = true
    } else if (e.type === 'wanting_out' && x.playerId === playerId) {
      timeline.push({ kind: 'wanting', at: e.created_at, value: x.value as number })
    } else if (e.type === 'mood_changed' && x.playerId === playerId) {
      timeline.push({ kind: 'mood', at: e.created_at, from: x.from as MoodBand, to: x.to as MoodBand, reasons: (x.reasons as MoodPartName[]) ?? [] })
    }
  }
  // His words, private ones and his 속마음 included (this page is for the commissioner).
  const quotes = db
    .prepare('SELECT id, channel, quote, action, target_id, note, cause, created_at FROM player_quotes WHERE player_id = ? AND season_id = ? ORDER BY id')
    .all(playerId, season) as { id: number; channel: string; quote: string; action: string; target_id: string | null; note: string; cause: string; created_at: string }[]
  // Numbers in his words that his facts didn't hold, marked for you.
  const flags = flagsFor(db, 'player_quote', quotes.map((q) => q.id))
  for (const q of quotes) {
    timeline.push({
      kind: 'said',
      at: q.created_at,
      words: {
        channel: q.channel,
        quote: q.quote,
        action: q.action,
        targetName: q.target_id ? (league.players.get(q.target_id)?.name ?? null) : null,
        note: q.note,
        cause: q.cause,
        flags: flags.get(q.id) ?? [],
      },
    })
  }
  // Newest first; a stable sort keeps same-moment items in the order they happened.
  timeline.reverse().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  const request = tradeRequests(db, season, playerId).at(-1)
  return {
    playerId,
    name: p.name,
    teamId: p.teamId,
    slot: config.roster.slots.find((s) => s.id === row?.slotId)?.name ?? null,
    ovr: typeof ovr === 'number' ? ovr : null,
    seasonId: season,
    seasons,
    current: season === current.id,
    now: season === current.id ? (lockerRoom(league, p.teamId).players.find((x) => x.playerId === playerId) ?? null) : null,
    traits: { ...lore.traits },
    media: entry?.kind === 'player' ? entry.settings.media : null,
    fromLore: lore.fromLore,
    relationships: lore.relationships.map((r) => ({ name: r.with, playerId: relationTarget(league, r.with), type: r.type, strength: r.strength, visibility: r.visibility })),
    history,
    timeline,
    // A past season's request no longer stands, whatever happened since.
    request: request ? { action: request.action, at: request.at, active: request.active && season === current.id } : null,
  }
}
