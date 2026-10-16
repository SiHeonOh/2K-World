import { belonging, replayFeelings, wantingOut, type FeelingFact, type Feelings } from '@core/feelings'
import { hash32 } from '@core/random'
import { playerValue } from '@core/value'
import type { Db } from '@data/db'
import { listPlayers } from '@data/league'
import type { DealView } from '@shared/gm'
import { loreOf, relationTarget } from './mood'
import type { League } from './context'

/**
 * Every player's lasting feelings, from one pass over the league's whole
 * history: who was on which school when, each game's result as it stands
 * now (corrections included), moves that weren't vetoed, friends sent away,
 * requests that outlived a window, leaked talks, awards still standing, and
 * public jabs. The engine (src/core/feelings.ts) replays each player's facts.
 */

export interface PlayerFeelings extends Feelings {
  /** 0..100: how much he wants out now. */
  wantingOut: number
  /** The ninth mood part these make (소속감). */
  belonging: number
}

/** A team's value change in a deal (points) that counts as clearly stronger or weaker (OVR-led values sit closer together than the old average of every rating: 8 then). */
const DEAL_GAIN = 6
/** Mood snapshots that count for wanting out (his latest at his school this season). */
const RECENT_SNAPSHOTS = 10
const FRIENDLY = new Set(['friend', 'family', 'mentor'])

type Ev = { id: number; type: string; season_id: number | null; payload: string; created_at: string }

const memo = new WeakMap<Db, { key: string; result: Map<string, PlayerFeelings> }>()

/** Every player's feelings now. Remembered until the league's facts, words, moods, talks or lore change. */
export function leagueFeelings(league: League): Map<string, PlayerFeelings> {
  const { db } = league
  // Talks' steps are in the key only as a safety margin: a leaked negotiation is closed, so its steps
  // can't change after the leak event (which moves the events part anyway). It costs a replay per step.
  const facts = (
    db
      .prepare(
        `SELECT (SELECT COALESCE(MAX(id), 0) FROM events) || ':' || (SELECT COALESCE(MAX(id), 0) FROM player_quotes) || ':' ||
                (SELECT COALESCE(MAX(id), 0) FROM player_mood) || ':' || (SELECT COUNT(*) FROM awards) || ':' ||
                (SELECT COALESCE(MAX(id), 0) FROM negotiation_steps) AS k`,
      )
      .get() as { k: string }
  ).k
  const lore = hash32(
    [...league.lore.player]
      .map(([id, e]) => (e.kind === 'player' ? `${id}:${JSON.stringify(e.settings.traits)}:${JSON.stringify(e.settings.relationships)}` : id))
      .join('|'),
  )
  const key = `${facts}:${lore}`
  const hit = memo.get(db)
  if (hit?.key === key) return hit.result
  const result = compute(league)
  memo.set(db, { key, result })
  return result
}

function compute(league: League): Map<string, PlayerFeelings> {
  const { db, config } = league
  const players = listPlayers(db)
  const value = new Map(players.map((p) => [p.id, playerValue(config, p.ratings)]))
  const lore = new Map(players.map((p) => [p.id, loreOf(league, p.id)]))
  // Friends (family and mentors too) as each player sees them, by strength; secret ties stay marked.
  const friendsOf = new Map<string, Map<string, { strength: number; secret: boolean }>>()
  for (const p of players) {
    const mine = new Map<string, { strength: number; secret: boolean }>()
    for (const r of lore.get(p.id)!.relationships) {
      if (!FRIENDLY.has(r.type)) continue
      const id = relationTarget(league, r.with)
      const had = id ? mine.get(id) : undefined
      if (id && id !== p.id && (!had || had.strength < r.strength)) mine.set(id, { strength: r.strength, secret: r.visibility === 'secret' })
    }
    friendsOf.set(p.id, mine)
  }

  // Where everyone started, and the rosters as the replay moves them.
  const team = new Map(players.map((p) => [p.id, league.players.get(p.id)?.firstTeamId ?? p.teamId]))
  const rosters = new Map<string, Set<string>>()
  for (const [id, t] of team) rosters.set(t, (rosters.get(t) ?? new Set()).add(id))
  const facts = new Map<string, FeelingFact[]>(players.map((p) => [p.id, [{ kind: 'arrive', teamId: team.get(p.id)!, how: 'start' }]]))
  const arrivedAt = new Map<string, string>()
  const push = (id: string, f: FeelingFact) => facts.get(id)?.push(f)

  const vetoedTrades = new Set((db.prepare("SELECT id FROM trades WHERE status = 'vetoed'").all() as { id: number }[]).map((r) => r.id))
  const vetoedSwaps = new Set((db.prepare('SELECT id FROM draft_actions WHERE vetoed_at IS NOT NULL').all() as { id: number }[]).map((r) => r.id))
  const tradeItems = new Map<number, { player_id: string; from_team_id: string; to_team_id: string }[]>()
  for (const r of db.prepare("SELECT trade_id, player_id, from_team_id, to_team_id FROM trade_items WHERE kind = 'player'").all() as {
    trade_id: number
    player_id: string
    from_team_id: string
    to_team_id: string
  }[]) {
    const list = tradeItems.get(r.trade_id)
    if (list) list.push(r)
    else tradeItems.set(r.trade_id, [r])
  }
  const games = new Map(
    (db.prepare('SELECT id, home_id, away_id, home_score, away_score, status FROM games').all() as {
      id: number
      home_id: string
      away_id: string
      home_score: number | null
      away_score: number | null
      status: string
    }[]).map((g) => [g.id, g]),
  )
  const windowOpened = new Map((db.prepare('SELECT id, opened_at FROM trade_windows').all() as { id: number; opened_at: string }[]).map((w) => [w.id, w.opened_at]))
  // Who put whom on the table in some talks: each school's own players, in an offer or a counter it made.
  // A player the other school only asked for wasn't offered by his own.
  const offerSteps = db.prepare("SELECT team_id, deal FROM negotiation_steps WHERE negotiation_id = ? AND action IN ('offer', 'counter') ORDER BY id")
  const offeredBy = (negotiationId: number) => {
    const by = new Map<string, string>()
    for (const s of offerSteps.all(negotiationId) as { team_id: string; deal: string | null }[]) {
      if (!s.deal) continue
      const d = JSON.parse(s.deal) as DealView
      for (const id of s.team_id === d.a ? d.aGives : s.team_id === d.b ? d.bGives : []) by.set(id, s.team_id)
    }
    return by
  }
  // Awards still standing, by how many times (given, taken back and given again counts once).
  const standing = new Map<string, number>()
  for (const a of db.prepare('SELECT season_id, award_id, period, team_rank, player_id FROM awards').all() as {
    season_id: number
    award_id: string
    period: string
    team_rank: number
    player_id: string
  }[]) {
    const k = `${a.season_id}:${a.award_id}:${a.period}:${a.team_rank}:${a.player_id}`
    standing.set(k, (standing.get(k) ?? 0) + 1)
  }
  // Series winners as they stand now (a corrected series changes hands).
  const seriesWinner = new Map((db.prepare('SELECT id, winner_id FROM series').all() as { id: number; winner_id: string | null }[]).map((s) => [s.id, s.winner_id]))
  const seriesCounted = new Set<number>()
  const awardName = new Map([...config.awards.season, ...config.awards.periodic].map((a) => [a.id, a.name]))
  // His mood snapshots, oldest first: whether he was benched before a game, his band, and how he's felt lately.
  const snaps = new Map<string, { at: string; overall: number; band: string; role: number }[]>()
  for (const s of db.prepare("SELECT player_id, overall, band, COALESCE(json_extract(parts, '$.role'), 0) AS role, created_at FROM player_mood ORDER BY id").all() as {
    player_id: string
    overall: number
    band: string
    role: number
    created_at: string
  }[]) {
    const row = { at: s.created_at, overall: s.overall, band: s.band, role: s.role }
    const list = snaps.get(s.player_id)
    if (list) list.push(row)
    else snaps.set(s.player_id, [row])
  }
  /** His latest snapshot strictly before a moment (a snapshot taken right after a game isn't its cause). */
  const latestBefore = (playerId: string, at: string) => {
    const list = snaps.get(playerId) ?? []
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.at < at) lo = mid + 1
      else hi = mid
    }
    return lo > 0 ? list[lo - 1] : undefined
  }
  // Benched against expectations: the role part goes well below zero only then.
  const benchedAt = (playerId: string, at: string) => (latestBefore(playerId, at)?.role ?? 0) < -20
  const bandAt = (playerId: string, at: string) => latestBefore(playerId, at)?.band
  // Trade requests, oldest first, with the same rule as tradeRequests (src/story/reactions.ts): one stands
  // at the school he asked to leave, in its season, until a window that opened after it closes, or he's
  // happy again. Each counts as outlived once.
  const requests = (
    db.prepare("SELECT player_id, action, team_id, season_id, created_at FROM player_quotes WHERE action IN ('private_request', 'public_request') ORDER BY id").all() as {
      player_id: string
      action: string
      team_id: string
      season_id: number
      created_at: string
    }[]
  ).map((r) => ({ ...r, done: false }))
  const asking = (playerId: string, teamId: string, at: string, season: number | null) =>
    !['happy', 'content'].includes(bandAt(playerId, at) ?? '') &&
    requests.some((r) => !r.done && r.player_id === playerId && r.team_id === teamId && r.season_id === season && r.created_at < at)

  /** Players changing schools at once (a trade, a swap): friends left behind or joined, and the deal's weight for those who stay. */
  const move = (moves: { id: string; from: string; to: string; how: 'requested' | 'drafted' | 'moved'; taken?: boolean }[], at: string) => {
    const movers = new Set(moves.map((m) => m.id))
    const gain = new Map<string, number>()
    for (const m of moves) {
      gain.set(m.to, (gain.get(m.to) ?? 0) + (value.get(m.id) ?? 0))
      gain.set(m.from, (gain.get(m.from) ?? 0) - (value.get(m.id) ?? 0))
      for (const [where, joined] of [
        [m.from, false],
        [m.to, true],
      ] as const) {
        for (const f of rosters.get(where) ?? []) {
          const tie = movers.has(f) ? undefined : friendsOf.get(f)?.get(m.id)
          if (tie) push(f, { kind: 'friend', name: league.players.get(m.id)?.name ?? '', strength: tie.strength, joined, secret: tie.secret })
        }
      }
    }
    for (const m of moves) {
      push(m.id, { kind: 'leave', teamId: m.from, asked: m.how === 'requested', taken: m.taken })
      push(m.id, { kind: 'arrive', teamId: m.to, how: m.how })
      rosters.get(m.from)?.delete(m.id)
      rosters.set(m.to, (rosters.get(m.to) ?? new Set()).add(m.id))
      team.set(m.id, m.to)
      arrivedAt.set(m.id, at)
    }
    for (const [t, g] of gain) {
      if (Math.abs(g) < DEAL_GAIN) continue
      for (const id of rosters.get(t) ?? []) if (!movers.has(id)) push(id, { kind: 'deal', gain: g })
    }
  }

  const events = db
    .prepare(
      `SELECT id, type, season_id, payload, created_at FROM events
       WHERE type IN ('season_created', 'game_recorded', 'trade_applied', 'draft_swap', 'trade_window_closed', 'trade_talks', 'series_won', 'award_given', 'player_said')
       ORDER BY id`,
    )
    .all() as Ev[]
  // Of each award's givings, only the latest ones still standing count (given, taken back and given again: the last).
  const givings = new Map<string, number[]>()
  for (const e of events) {
    if (e.type !== 'award_given') continue
    const x = JSON.parse(e.payload) as Record<string, unknown>
    const k = `${e.season_id}:${x.awardId as string}:${(x.period as string) ?? ''}:${(x.teamRank as number) ?? 1}:${x.playerId as string}`
    givings.set(k, [...(givings.get(k) ?? []), e.id])
  }
  const creditedAwards = new Set([...givings].flatMap(([k, ids]) => ids.slice(ids.length - Math.min(ids.length, standing.get(k) ?? 0))))
  // A game recorded, taken back (기록 취소) and recorded again counts once, at its latest recording.
  const lastRecording = new Map<number, number>()
  for (const e of events) if (e.type === 'game_recorded') lastRecording.set((JSON.parse(e.payload) as { gameId: number }).gameId, e.id)
  for (const e of events) {
    const x = JSON.parse(e.payload) as Record<string, unknown>
    switch (e.type) {
      case 'season_created':
        for (const list of facts.values()) list.push({ kind: 'season' })
        // Last season's requests lapse with it (they weren't ignored; the season ended). Later ones stand.
        for (const r of requests) if (r.created_at < e.created_at) r.done = true
        break
      case 'game_recorded': {
        // The score as it stands now, so a correction changes the replay (and a game taken back drops out).
        const g = games.get(x.gameId as number)
        if (!g || g.status !== 'final' || g.home_score === null || g.away_score === null) break
        if (lastRecording.get(x.gameId as number) !== e.id) break
        for (const [t, won] of [
          [g.home_id, g.home_score > g.away_score],
          [g.away_id, g.away_score > g.home_score],
        ] as const)
          for (const id of rosters.get(t) ?? []) push(id, { kind: 'game', won, benched: benchedAt(id, e.created_at) })
        break
      }
      case 'trade_applied': {
        if (vetoedTrades.has(x.tradeId as number)) break
        const items = tradeItems.get(x.tradeId as number) ?? []
        move(
          items.map((i) => ({ id: i.player_id, from: i.from_team_id, to: i.to_team_id, how: asking(i.player_id, i.from_team_id, e.created_at, e.season_id) ? 'requested' : 'moved' })),
          e.created_at,
        )
        break
      }
      case 'draft_swap': {
        if (vetoedSwaps.has(x.actionId as number)) break
        const own = x.playerId as string
        move(
          [
            { id: x.targetPlayerId as string, from: x.targetTeamId as string, to: x.teamId as string, how: 'drafted', taken: true },
            { id: own, from: x.teamId as string, to: x.targetTeamId as string, how: asking(own, x.teamId as string, e.created_at, e.season_id) ? 'requested' : 'moved' },
          ],
          e.created_at,
        )
        break
      }
      case 'trade_window_closed': {
        const opened = windowOpened.get(x.windowId as number)
        if (!opened) break
        // A request made before this window opened, still at that school: the window came and went.
        const outlived = new Map<string, boolean>()
        for (const r of requests) {
          if (r.done || r.created_at >= opened || r.season_id !== e.season_id) continue
          r.done = true
          // Moved since, or happy again by the time the window opened: nothing was ignored.
          if (team.get(r.player_id) !== r.team_id || ['happy', 'content'].includes(bandAt(r.player_id, opened) ?? '')) continue
          outlived.set(r.player_id, (outlived.get(r.player_id) ?? false) || r.action === 'public_request')
        }
        for (const [id, pub] of outlived) push(id, { kind: 'ignored', public: pub })
        break
      }
      case 'trade_talks': {
        // Shopped by the school that offered him, whoever he's with now: the engine drops it if he's left that school since.
        const by = offeredBy(x.negotiationId as number)
        for (const id of (x.players as string[]) ?? []) {
          const school = by.get(id)
          if (school) push(id, { kind: 'shopped', teamId: school })
        }
        break
      }
      case 'series_won':
        // Only the winner as it stands now (a corrected series' old result doesn't count).
        if (seriesWinner.get(x.seriesId as number) !== x.winner || seriesCounted.has(x.seriesId as number)) break
        seriesCounted.add(x.seriesId as number)
        for (const id of rosters.get(x.winner as string) ?? []) push(id, { kind: 'series' })
        break
      case 'award_given':
        // Only awards still standing (one taken back never happened).
        if (creditedAwards.has(e.id)) {
          push(x.playerId as string, { kind: 'award', season: !(x.period as string), name: awardName.get(x.awardId as string) ?? (x.awardId as string) })
        }
        break
      case 'player_said':
        if (x.action === 'call_out_rival' && x.targetId && x.targetId !== x.playerId) push(x.targetId as string, { kind: 'called_out', byId: x.playerId as string })
        break
    }
  }

  const out = new Map<string, PlayerFeelings>()
  for (const p of players) {
    const list = facts.get(p.id)!
    // The replay should end where the roster is; if it doesn't (an odd history), he starts over where he is.
    if (team.get(p.id) !== p.teamId) list.push({ kind: 'arrive', teamId: p.teamId, how: 'moved' })
    const f = replayFeelings(lore.get(p.id)!.traits, list)
    // His last few snapshots at this school, across seasons: wanting out lasts through the offseason.
    const since = arrivedAt.get(p.id) ?? ''
    const recent = (snaps.get(p.id) ?? []).filter((s) => s.at >= since).slice(-RECENT_SNAPSHOTS)
    out.set(p.id, { ...f, wantingOut: wantingOut(recent.map((s) => s.overall), f.trust, f.attachment), belonging: belonging(f.trust, f.attachment) })
  }
  return out
}
