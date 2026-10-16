import { randomBytes } from 'node:crypto'
import type { Phase } from '@shared/config/schema'
import type { EventPayloads } from '@shared/events'
import type { AwardRow, CardRow, ChecklistRow, DraftActionRow, DraftView, TradeRow } from '@shared/season'
import {
  cardSequence,
  checkDraftAction,
  nextCard,
  pickOrder,
  protectionCard,
  swapResult,
  type DraftAction,
} from '@core/draft'
import { checkTrade, type TradeContext, type TradeItem } from '@core/trades'
import { jsonField, transaction, type Db } from './db'
import { appendEvent, currentSeason, listTeams, loadConfig, seasonFor } from './league'
import { refuse, RuleError } from './rules'
import { setPhase } from './season'

const now = () => new Date().toISOString()

// ── Cards ────────────────────────────────────────────────────────────────

/**
 * A season's cards: those in its draft. Unplayed cards carry over one season
 * at a time (season_id moves on, issued_season_id stays), so a card was in
 * every season's draft from the one that issued it to the one it's in now.
 * A past season lists the ones that carried on too, with who held them when
 * it ended (card trades since are undone).
 */
export function listCards(db: Db, seasonId: number): CardRow[] {
  const next = db.prepare('SELECT MIN(id) AS id FROM seasons WHERE id > ?').get(seasonId) as { id: number | null }
  const rows = db
    .prepare(
      `SELECT c.id, c.original_team_id, c.number, c.status, c.issued_season_id, c.season_id,
        CASE WHEN c.season_id > :season THEN COALESCE(
          (SELECT i.to_team_id FROM trade_items i JOIN trades t ON t.id = i.trade_id
           WHERE i.card_id = c.id AND i.kind = 'card' AND t.status = 'applied' AND t.season_id <= :season ORDER BY t.id DESC LIMIT 1),
          c.original_team_id) ELSE c.owner_team_id END AS owner
       FROM cards c WHERE c.issued_season_id <= :season AND c.season_id >= :season
       ORDER BY c.original_team_id, c.number, c.issued_season_id, c.id`,
    )
    .all({ season: seasonId }) as {
    id: number
    original_team_id: string
    number: number
    status: CardRow['status']
    issued_season_id: number
    season_id: number
    owner: string
  }[]
  return rows.map((r) => {
    const carried = r.season_id > seasonId
    return {
      id: r.id,
      originalTeamId: r.original_team_id,
      ownerTeamId: r.owner,
      number: r.number,
      status: carried ? 'held' : r.status,
      issuedSeasonId: r.issued_season_id,
      carriedTo: carried ? next.id : null,
    }
  })
}

// ── Trades ───────────────────────────────────────────────────────────────

const LOCK_PHASES: Phase[] = ['preseason', 'regular', 'playoffs']

/** Everything checkTrade needs, read from the database. */
export function tradeContext(db: Db): TradeContext {
  const season = currentSeason(db)
  const { config } = loadConfig(db)
  const players = db.prepare('SELECT id, team_id, slot_id FROM players').all() as { id: string; team_id: string; slot_id: string | null }[]
  // 'draft': locks reset when the draft starts. 'season-end': they last until the next season.
  const lockNow = config.trades.oncePerSeason.until === 'draft' ? LOCK_PHASES.includes(season.phase) : true
  const locked = lockNow
    ? (db
        .prepare(
          `SELECT DISTINCT i.player_id FROM trade_items i JOIN trades t ON t.id = i.trade_id
           WHERE t.season_id = ? AND t.status = 'applied' AND i.kind = 'player'
            AND (? = 'season-end' OR t.phase IN ('preseason', 'regular', 'playoffs'))`,
        )
        .all(season.id, config.trades.oncePerSeason.until) as { player_id: string }[])
    : []
  const counts = new Map<string, { given: number; received: number; trades: number }>()
  const cardTrades = db
    .prepare(
      `SELECT t.id, i.from_team_id, i.to_team_id FROM trade_items i JOIN trades t ON t.id = i.trade_id
       WHERE t.season_id = ? AND t.status = 'applied' AND i.kind = 'card' AND t.phase IN ('preseason', 'regular')`,
    )
    .all(season.id) as { id: number; from_team_id: string; to_team_id: string }[]
  const tradesBy = new Map<string, Set<number>>()
  for (const c of cardTrades) {
    const from = counts.get(c.from_team_id) ?? { given: 0, received: 0, trades: 0 }
    from.given++
    counts.set(c.from_team_id, from)
    const to = counts.get(c.to_team_id) ?? { given: 0, received: 0, trades: 0 }
    to.received++
    counts.set(c.to_team_id, to)
    for (const team of [c.from_team_id, c.to_team_id]) {
      const set = tradesBy.get(team) ?? new Set<number>()
      set.add(c.id)
      tradesBy.set(team, set)
    }
  }
  for (const [team, set] of tradesBy) counts.get(team)!.trades = set.size
  return {
    config,
    phase: season.phase,
    teams: listTeams(db).map((t) => ({ id: t.id, control: t.control })),
    players: players.map((p) => ({ id: p.id, teamId: p.team_id, slotId: p.slot_id })),
    cards: listCards(db, season.id).map((c) => ({ id: c.id, ownerTeamId: c.ownerTeamId, status: c.status })),
    lockedPlayers: new Set(locked.map((l) => l.player_id)),
    cardTradeCounts: counts,
    draftMoved: season.phase === 'draft' ? draftMovedPlayers(db, season.id) : new Set(),
  }
}

/** Checks a trade without recording it. */
export function previewTrade(db: Db, items: TradeItem[]) {
  return checkTrade(items, tradeContext(db))
}

/**
 * Records a legal trade: players move (with their new slots), cards change
 * hands, and player moves go on the 2K checklist. Throws RuleError if illegal.
 * `tags` go into the trade_applied event: a GM deal's negotiation, gap and
 * lopsided tag, and (any trade's) the blockbuster tag.
 */
export function applyTrade(
  db: Db,
  items: TradeItem[],
  source: 'user' | 'gm' = 'user',
  note = '',
  tags?: { negotiationId?: number; valueGap?: number; lopsided?: boolean; blockbuster?: boolean },
): number {
  const season = currentSeason(db)
  const check = checkTrade(items, tradeContext(db))
  if (!check.ok) throw new RuleError(check.issues)
  return transaction(db, () => {
    const tradeId = Number(
      db
        .prepare("INSERT INTO trades (season_id, phase, status, source, note, created_at) VALUES (?, ?, 'applied', ?, ?, ?)")
        .run(season.id, season.phase, source, note, now()).lastInsertRowid,
    )
    const insertItem = db.prepare(
      'INSERT INTO trade_items (trade_id, kind, from_team_id, to_team_id, player_id, card_id, from_slot_id, to_slot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const m of check.moves) {
      insertItem.run(tradeId, 'player', m.from, m.to, m.playerId, null, m.fromSlotId, m.toSlotId)
      db.prepare('UPDATE players SET team_id = ?, slot_id = ? WHERE id = ?').run(m.to, m.toSlotId, m.playerId)
    }
    const cards = items.filter((i): i is Extract<TradeItem, { kind: 'card' }> => i.kind === 'card')
    for (const c of cards) {
      insertItem.run(tradeId, 'card', c.from, c.to, null, c.cardId, null, null)
      db.prepare('UPDATE cards SET owner_team_id = ? WHERE id = ?').run(c.to, c.cardId)
    }
    const teams = [...new Set(items.flatMap((i) => [i.from, i.to]))]
    if (check.moves.length > 0) {
      db.prepare("INSERT INTO checklist (season_id, kind, ref_id, team_ids, created_at) VALUES (?, 'trade', ?, ?, ?)").run(
        season.id,
        tradeId,
        JSON.stringify(teams),
        now(),
      )
    }
    appendEvent(
      db,
      'trade_applied',
      { tradeId, teams, players: check.moves.map((m) => m.playerId), cards: cards.map((c) => c.cardId), ...(tags ?? {}) },
      season.id,
    )
    return tradeId
  })
}

/**
 * The players each of a season's blockbuster trades moved (vetoed ones
 * left out), oldest first: what a new trade must outdo to be one past the
 * season's first few (isBlockbuster).
 */
export function seasonBlockbusters(db: Db, seasonId = currentSeason(db).id): string[][] {
  const rows = db
    .prepare(
      `SELECT e.payload FROM events e JOIN trades t ON t.id = ${jsonField('e.payload', '$.tradeId')}
       WHERE e.type = 'trade_applied' AND e.season_id = ? AND t.status = 'applied' AND ${jsonField('e.payload', '$.blockbuster')} = 1
       ORDER BY e.id`,
    )
    .all(seasonId) as { payload: string }[]
  return rows.map((r) => (JSON.parse(r.payload) as EventPayloads['trade_applied']).players)
}

/**
 * Reverses a trade that hasn't been made in 2K yet. History stays: the trade
 * is marked vetoed and a `move_vetoed` event is written.
 */
export function vetoTrade(db: Db, tradeId: number): void {
  const trade = db.prepare('SELECT season_id, status, phase, created_at FROM trades WHERE id = ?').get(tradeId) as
    | { season_id: number; status: string; phase: string; created_at: string }
    | undefined
  if (!trade) refuse('unknown-trade', { trade: tradeId })
  if (trade.status !== 'applied') refuse('already-vetoed')
  const item = db.prepare("SELECT applied_at FROM checklist WHERE kind = 'trade' AND ref_id = ?").get(tradeId) as { applied_at: string | null } | undefined
  if (item?.applied_at) refuse('already-in-2k')
  // A card-only trade has nothing to make in 2K; it can be vetoed only in the phase it was made.
  const season = currentSeason(db)
  if (!item && (trade.season_id !== season.id || trade.phase !== season.phase)) refuse('veto-window-closed')
  const items = db
    .prepare('SELECT kind, from_team_id, to_team_id, player_id, card_id, from_slot_id, to_slot_id FROM trade_items WHERE trade_id = ?')
    .all(tradeId) as {
    kind: string
    from_team_id: string
    to_team_id: string
    player_id: string | null
    card_id: number | null
    from_slot_id: string | null
    to_slot_id: string | null
  }[]
  // Only reversible while nothing has moved since.
  for (const i of items) {
    if (i.kind === 'player') {
      const p = db.prepare('SELECT team_id, slot_id FROM players WHERE id = ?').get(i.player_id) as { team_id: string; slot_id: string | null }
      if (p.team_id !== i.to_team_id) refuse('moved-since', { player: i.player_id! })
      // …nor moved to another slot in 로스터 편집: his team's lineup was rearranged around him, so the
      // players coming back to their old slots would leave one slot empty and another doubled.
      if (p.slot_id !== i.to_slot_id) refuse('veto-slot-changed', { player: i.player_id! })
    } else {
      const c = db.prepare('SELECT owner_team_id, status FROM cards WHERE id = ?').get(i.card_id) as { owner_team_id: string; status: string }
      if (c.owner_team_id !== i.to_team_id || c.status !== 'held') refuse('moved-since', { card: i.card_id! })
    }
  }
  // …not even there and back, nor protected by his new team in the draft: later moves stand on this one.
  const applied = db.prepare(`SELECT id FROM events WHERE type = 'trade_applied' AND ${jsonField('payload', '$.tradeId')} = ?`).get(tradeId) as { id: number } | undefined
  const since = movedSince(
    db,
    applied?.id ?? 0,
    items.flatMap((i) => (i.kind === 'player' && i.player_id ? [i.player_id] : [])),
    items.flatMap((i) => (i.kind === 'card' && i.card_id !== null ? [i.card_id] : [])),
  )
  if (since?.how === 'protect') refuse('veto-protected', { player: since.player! })
  if (since) refuse('moved-since', since.player ? { player: since.player } : { card: since.card! })
  transaction(db, () => {
    for (const i of items) {
      if (i.kind === 'player') {
        db.prepare('UPDATE players SET team_id = ?, slot_id = ? WHERE id = ?').run(i.from_team_id, i.from_slot_id, i.player_id)
        // An award he won while the trade stood was won for the school he never really left.
        db.prepare('UPDATE awards SET team_id = ? WHERE season_id = ? AND player_id = ? AND team_id = ? AND created_at >= ?').run(
          i.from_team_id,
          trade.season_id,
          i.player_id,
          i.to_team_id,
          trade.created_at,
        )
      } else db.prepare('UPDATE cards SET owner_team_id = ? WHERE id = ?').run(i.from_team_id, i.card_id)
    }
    db.prepare("UPDATE trades SET status = 'vetoed', vetoed_at = ? WHERE id = ?").run(now(), tradeId)
    db.prepare("UPDATE checklist SET cancelled_at = ? WHERE kind = 'trade' AND ref_id = ? AND applied_at IS NULL").run(now(), tradeId)
    appendEvent(db, 'move_vetoed', { kind: 'trade', refId: tradeId }, trade.season_id)
  })
}

/**
 * The first move after event `after` that still stands and touched one of
 * these players or cards: a trade, a draft swap, or (players only) a draft
 * protection. Vetoed trades and undone swaps don't count. It finds a player
 * sent away and back again, who is where he was, yet was moved since.
 */
function movedSince(
  db: Db,
  after: number,
  players: readonly string[],
  cards: readonly number[],
): { how: 'trade' | 'swap' | 'protect'; player?: string; card?: number } | null {
  const traded = db
    .prepare(
      `SELECT i.player_id, i.card_id FROM events e JOIN trade_items i ON i.trade_id = ${jsonField('e.payload', '$.tradeId')} JOIN trades t ON t.id = i.trade_id
       WHERE e.type = 'trade_applied' AND e.id > ? AND t.status = 'applied'
        AND ((i.kind = 'player' AND i.player_id IN (SELECT value FROM json_each(?))) OR (i.kind = 'card' AND i.card_id IN (SELECT value FROM json_each(?))))
       ORDER BY e.id LIMIT 1`,
    )
    .get(after, JSON.stringify(players), JSON.stringify(cards)) as { player_id: string | null; card_id: number | null } | undefined
  if (traded) return traded.player_id !== null ? { how: 'trade', player: traded.player_id } : { how: 'trade', card: traded.card_id! }
  const drafted = db
    .prepare(
      `SELECT e.type, ${jsonField('e.payload', '$.playerId')} AS a, ${jsonField('e.payload', '$.targetPlayerId')} AS b
       FROM events e JOIN draft_actions d ON d.id = ${jsonField('e.payload', '$.actionId')}
       WHERE e.type IN ('draft_swap', 'draft_protect') AND e.id > ? AND d.vetoed_at IS NULL
        AND (${jsonField('e.payload', '$.playerId')} IN (SELECT value FROM json_each(?)) OR ${jsonField('e.payload', '$.targetPlayerId')} IN (SELECT value FROM json_each(?)))
       ORDER BY e.id LIMIT 1`,
    )
    .get(after, JSON.stringify(players), JSON.stringify(players)) as { type: 'draft_swap' | 'draft_protect'; a: string | null; b: string | null } | undefined
  if (!drafted) return null
  const player = drafted.a !== null && players.includes(drafted.a) ? drafted.a : drafted.b!
  return { how: drafted.type === 'draft_swap' ? 'swap' : 'protect', player }
}

export function listTrades(db: Db, seasonId: number): TradeRow[] {
  const trades = db
    .prepare('SELECT id, phase, status, source, note, created_at FROM trades WHERE season_id = ? ORDER BY id DESC')
    .all(seasonId) as { id: number; phase: Phase; status: TradeRow['status']; source: TradeRow['source']; note: string; created_at: string }[]
  return trades.map((t) => {
    const items = db
      .prepare(
        `SELECT i.kind, i.from_team_id, i.to_team_id, i.player_id, i.card_id, i.from_slot_id, i.to_slot_id, c.original_team_id, c.number, c.issued_season_id
         FROM trade_items i LEFT JOIN cards c ON c.id = i.card_id WHERE i.trade_id = ?`,
      )
      .all(t.id) as {
      kind: 'player' | 'card'
      from_team_id: string
      to_team_id: string
      player_id: string | null
      card_id: number | null
      from_slot_id: string | null
      to_slot_id: string | null
      original_team_id: string | null
      number: number | null
      issued_season_id: number | null
    }[]
    const check = db.prepare("SELECT applied_at, cancelled_at FROM checklist WHERE kind = 'trade' AND ref_id = ?").get(t.id) as
      | { applied_at: string | null; cancelled_at: string | null }
      | undefined
    return {
      id: t.id,
      phase: t.phase,
      status: t.status,
      source: t.source,
      note: t.note,
      createdAt: t.created_at,
      pendingIn2k: t.status === 'applied' && check !== undefined && check.applied_at === null,
      items: items.map((i) => ({
        kind: i.kind,
        from: i.from_team_id,
        to: i.to_team_id,
        playerId: i.player_id,
        cardId: i.card_id,
        card:
          i.original_team_id !== null && i.number !== null && i.issued_season_id !== null
            ? { originalTeamId: i.original_team_id, number: i.number, issuedSeasonId: i.issued_season_id }
            : null,
        fromSlotId: i.from_slot_id,
        toSlotId: i.to_slot_id,
      })),
    }
  })
}

/**
 * Where each moved player has been, from trades and draft swaps in the order
 * they happened (vetoed ones included: a veto only sends him back). `first`
 * is his team before his first move; `teams` every team he's been on. Players
 * never moved aren't listed: their current team is all there is.
 */
export function rosterHistory(db: Db): Map<string, { first: string; teams: string[] }> {
  const out = new Map<string, { first: string; teams: string[] }>()
  const visit = (playerId: string, from: string, to: string) => {
    const h = out.get(playerId) ?? { first: from, teams: [] }
    for (const t of [from, to]) if (!h.teams.includes(t)) h.teams.push(t)
    out.set(playerId, h)
  }
  const items = db.prepare("SELECT player_id, from_team_id, to_team_id FROM trade_items WHERE trade_id = ? AND kind = 'player'")
  // The event log's order, not the clock's: it's the order the moves were made in.
  const moves = db.prepare("SELECT type, payload FROM events WHERE type IN ('trade_applied', 'draft_swap') ORDER BY id").all() as {
    type: 'trade_applied' | 'draft_swap'
    payload: string
  }[]
  for (const m of moves) {
    if (m.type === 'trade_applied') {
      const { tradeId } = JSON.parse(m.payload) as EventPayloads['trade_applied']
      for (const i of items.all(tradeId) as { player_id: string; from_team_id: string; to_team_id: string }[]) visit(i.player_id, i.from_team_id, i.to_team_id)
    } else {
      const s = JSON.parse(m.payload) as EventPayloads['draft_swap']
      visit(s.playerId, s.teamId, s.targetTeamId)
      visit(s.targetPlayerId, s.targetTeamId, s.teamId)
    }
  }
  return out
}

// ── The 2K checklist ─────────────────────────────────────────────────────

/** Waiting moves from any season, plus this season's done ones. */
export function listChecklist(db: Db): ChecklistRow[] {
  const rows = db
    .prepare(
      `SELECT id, kind, ref_id, team_ids, created_at, applied_at FROM checklist
       WHERE cancelled_at IS NULL AND (applied_at IS NULL OR season_id = ?) ORDER BY applied_at IS NOT NULL, id DESC`,
    )
    .all(currentSeason(db).id) as { id: number; kind: ChecklistRow['kind']; ref_id: number; team_ids: string; created_at: string; applied_at: string | null }[]
  return rows.map((r) => {
    let moves: ChecklistRow['moves'] = []
    if (r.kind === 'trade') {
      moves = (
        db.prepare("SELECT player_id, to_team_id, to_slot_id FROM trade_items WHERE trade_id = ? AND kind = 'player'").all(r.ref_id) as {
          player_id: string
          to_team_id: string
          to_slot_id: string | null
        }[]
      ).map((m) => ({ playerId: m.player_id, toTeamId: m.to_team_id, toSlotId: m.to_slot_id }))
    } else {
      const a = db
        .prepare('SELECT team_id, player_id, target_player_id, target_team_id, own_slot_id, target_slot_id FROM draft_actions WHERE id = ?')
        .get(r.ref_id) as
        | { team_id: string; player_id: string; target_player_id: string; target_team_id: string; own_slot_id: string | null; target_slot_id: string | null }
        | undefined
      if (a) {
        moves = [
          { playerId: a.player_id, toTeamId: a.target_team_id, toSlotId: a.own_slot_id },
          { playerId: a.target_player_id, toTeamId: a.team_id, toSlotId: a.target_slot_id },
        ]
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      refId: r.ref_id,
      teamIds: JSON.parse(r.team_ids) as string[],
      createdAt: r.created_at,
      appliedAt: r.applied_at,
      moves,
    }
  })
}

/** Ticks a move off: it's been made in 2K, so games for those teams can be recorded again. */
export function markApplied(db: Db, checklistId: number): void {
  const row = db.prepare('SELECT kind, ref_id, applied_at, cancelled_at FROM checklist WHERE id = ?').get(checklistId) as
    | { kind: string; ref_id: number; applied_at: string | null; cancelled_at: string | null }
    | undefined
  if (!row || row.cancelled_at) refuse('unknown-checklist', { id: checklistId })
  if (row.applied_at) return
  transaction(db, () => {
    db.prepare('UPDATE checklist SET applied_at = ? WHERE id = ?').run(now(), checklistId)
    appendEvent(db, 'checklist_applied', { checklistId, kind: row.kind, refId: row.ref_id }, currentSeason(db).id)
  })
}

// ── Draft ────────────────────────────────────────────────────────────────

/** The draft of a season, the current one by default (moves only ever use the current one). */
function draftState(db: Db, seasonId?: number) {
  const season = seasonFor(db, seasonId)
  const { config } = loadConfig(db)
  if (config.draft.kind !== 'card-swap') refuse('no-card-draft')
  const row = db.prepare('SELECT final_ranking, protection_closed FROM seasons WHERE id = ?').get(season.id) as {
    final_ranking: string | null
    protection_closed: number
  }
  const ranking = JSON.parse(row.final_ranking ?? '[]') as string[]
  const teams = listTeams(db)
  const frozen = new Set(teams.filter((t) => t.control === 'frozen').map((t) => t.id))
  const cards = listCards(db, season.id)
  const actions = listDraftActions(db, season.id)
  const protectedPlayers = new Set<string>()
  const movedPlayers = draftMovedPlayers(db, season.id, actions)
  for (const a of actions) if (a.kind === 'protect' && a.playerId) protectedPlayers.add(a.playerId)
  // League rule: a player already moved within the draft is protected for the rest of it (whatever
  // an old config's swappedProtected says), so no other team can take him and he can't be sent on.
  for (const id of movedPlayers) protectedPlayers.add(id)
  const players = (db.prepare('SELECT id, team_id, slot_id FROM players').all() as { id: string; team_id: string; slot_id: string | null }[]).map(
    (p) => ({ id: p.id, teamId: p.team_id, slotId: p.slot_id }),
  )
  return {
    season,
    draft: config.draft,
    ranking,
    frozen,
    cards,
    actions,
    players,
    protectedPlayers,
    movedPlayers,
    protectionOpen: config.draft.protection && row.protection_closed === 0,
    order: pickOrder(ranking, frozen),
  }
}

/**
 * Players who changed teams within a season's draft: swapped either way (a
 * vetoed swap doesn't count), or traded during it (a vetoed trade doesn't).
 */
function draftMovedPlayers(db: Db, seasonId: number, actions: DraftActionRow[] = listDraftActions(db, seasonId)): Set<string> {
  const moved = new Set<string>()
  for (const a of actions) {
    if (a.kind !== 'swap') continue
    if (a.playerId) moved.add(a.playerId)
    if (a.targetPlayerId) moved.add(a.targetPlayerId)
  }
  // A trade made during the draft moves a player within it too.
  const traded = db
    .prepare(
      `SELECT DISTINCT i.player_id FROM trade_items i JOIN trades t ON t.id = i.trade_id
       WHERE t.season_id = ? AND t.status = 'applied' AND t.phase = 'draft' AND i.kind = 'player'`,
    )
    .all(seasonId) as { player_id: string }[]
  for (const t of traded) moved.add(t.player_id)
  return moved
}

export function listDraftActions(db: Db, seasonId: number): DraftActionRow[] {
  return (
    db
      .prepare(
        `SELECT d.id, d.seq, d.team_id, d.kind, d.card_id, d.player_id, d.target_player_id, d.target_team_id AS target_team, d.created_at
         FROM draft_actions d WHERE d.season_id = ? AND d.vetoed_at IS NULL ORDER BY d.seq`,
      )
      .all(seasonId) as {
      id: number
      seq: number
      team_id: string
      kind: DraftActionRow['kind']
      card_id: number | null
      player_id: string | null
      target_player_id: string | null
      created_at: string
      target_team: string | null
    }[]
  ).map((r) => ({
    id: r.id,
    seq: r.seq,
    teamId: r.team_id,
    kind: r.kind,
    cardId: r.card_id,
    playerId: r.player_id,
    targetPlayerId: r.target_player_id,
    targetTeamId: r.target_team,
    createdAt: r.created_at,
  }))
}

/**
 * A season's draft room, the current one by default. A past season's draft
 * is over: nothing is open and no card is on the clock. Its pick order uses
 * today's frozen teams.
 */
export function draftView(db: Db, seasonId?: number): DraftView {
  const s = draftState(db, seasonId)
  const past = s.season.id !== currentSeason(db).id
  const next = past ? undefined : nextCard(cardSequence(s.cards, s.order, s.draft.turns))
  return {
    order: s.order,
    cards: s.cards,
    actions: s.actions,
    protectedPlayers: [...s.protectedPlayers],
    movedPlayers: [...s.movedPlayers],
    protectionOpen: s.protectionOpen && !past,
    next: next ?? null,
  }
}

/** Ends the protection phase so swap turns can begin. */
export function closeProtection(db: Db): void {
  const s = draftState(db)
  if (s.season.phase !== 'draft') refuse('wrong-phase', { phase: s.season.phase })
  if (!s.protectionOpen) return
  transaction(db, () => {
    db.prepare('UPDATE seasons SET protection_closed = 1 WHERE id = ?').run(s.season.id)
    appendEvent(db, 'draft_protection_closed', {}, s.season.id)
  })
}

/** A draft move as the screens send it: protection picks its own card (the team's last). */
export type DraftMoveRequest =
  | { kind: 'protect'; teamId: string; playerId: string }
  | Exclude<DraftAction, { kind: 'protect' }>

/** Records one draft move (protect, swap or pass) after checking it. */
export function draftMove(db: Db, request: DraftMoveRequest): number {
  const s = draftState(db)
  if (s.season.phase !== 'draft') refuse('wrong-phase', { phase: s.season.phase })
  let action: DraftAction
  if (request.kind === 'protect') {
    const card = protectionCard(s, request.teamId)
    if (!card) refuse('no-cards-left', { team: request.teamId })
    action = { ...request, cardId: card.id }
  } else {
    action = request
  }
  const issues = checkDraftAction(action, { ...s, draft: s.draft })
  if (issues.length > 0) throw new RuleError(issues.map((code) => ({ code, params: {} })))
  return transaction(db, () => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM draft_actions WHERE season_id = ?').get(s.season.id) as { n: number }).n
    const insert = db.prepare(
      `INSERT INTO draft_actions (season_id, seq, team_id, kind, card_id, player_id, target_player_id, target_team_id, own_slot_id, target_slot_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    db.prepare("UPDATE cards SET status = 'used' WHERE id = ?").run(action.cardId)
    if (action.kind === 'protect') {
      const id = Number(
        insert.run(s.season.id, seq, action.teamId, 'protect', action.cardId, action.playerId, null, null, null, null, now()).lastInsertRowid,
      )
      appendEvent(db, 'draft_protect', { actionId: id, teamId: action.teamId, playerId: action.playerId, cardId: action.cardId }, s.season.id)
      return id
    }
    if (action.kind === 'pass') {
      const id = Number(insert.run(s.season.id, seq, action.teamId, 'pass', action.cardId, null, null, null, null, null, now()).lastInsertRowid)
      appendEvent(db, 'draft_pass', { actionId: id, teamId: action.teamId, cardId: action.cardId }, s.season.id)
      return id
    }
    const own = s.players.find((p) => p.id === action.playerId)!
    const target = s.players.find((p) => p.id === action.targetPlayerId)!
    const result = swapResult(s.draft, own, target)
    const id = Number(
      insert.run(
        s.season.id,
        seq,
        action.teamId,
        'swap',
        action.cardId,
        action.playerId,
        action.targetPlayerId,
        target.teamId,
        result.ownTo.slotId,
        result.targetTo.slotId,
        now(),
      ).lastInsertRowid,
    )
    db.prepare('UPDATE players SET team_id = ?, slot_id = ? WHERE id = ?').run(result.ownTo.teamId, result.ownTo.slotId, own.id)
    db.prepare('UPDATE players SET team_id = ?, slot_id = ? WHERE id = ?').run(result.targetTo.teamId, result.targetTo.slotId, target.id)
    db.prepare("INSERT INTO checklist (season_id, kind, ref_id, team_ids, created_at) VALUES (?, 'draft-swap', ?, ?, ?)").run(
      s.season.id,
      id,
      JSON.stringify([own.teamId, target.teamId]),
      now(),
    )
    appendEvent(
      db,
      'draft_swap',
      {
        actionId: id,
        teamId: action.teamId,
        playerId: own.id,
        targetPlayerId: target.id,
        targetTeamId: target.teamId,
        cardId: action.cardId,
        ownSlot: result.ownTo.slotId,
        targetSlot: result.targetTo.slotId,
      },
      s.season.id,
    )
    return id
  })
}

/**
 * Undoes the latest draft swap while it hasn't been made in 2K: players go
 * back to their teams and slots, the card is playable again. The action stays
 * in the history, marked vetoed, with a `move_vetoed` event. Refused once
 * either player has moved since (a trade during the draft, even one that
 * brought him back): that move stands on this one, so it goes first.
 */
export function vetoDraftSwap(db: Db, actionId: number): void {
  const s = draftState(db)
  if (s.season.phase !== 'draft') refuse('wrong-phase', { phase: s.season.phase })
  // Later turns were played knowing this swap happened (passes too), so only the latest can go.
  const last = s.actions.filter((a) => a.kind !== 'protect').at(-1)
  if (!last || last.id !== actionId || last.kind !== 'swap') refuse('veto-latest-only')
  const item = db.prepare("SELECT id, applied_at FROM checklist WHERE kind = 'draft-swap' AND ref_id = ?").get(actionId) as
    | { id: number; applied_at: string | null }
    | undefined
  if (item?.applied_at) refuse('already-in-2k')
  const swap = db
    .prepare('SELECT team_id, player_id, target_player_id, target_team_id, own_slot_id, target_slot_id FROM draft_actions WHERE id = ?')
    .get(actionId) as { team_id: string; player_id: string; target_player_id: string; target_team_id: string; own_slot_id: string | null; target_slot_id: string | null }
  // Both must still be where the swap put them, in the slots it gave them…
  const where = (id: string) => db.prepare('SELECT team_id, slot_id FROM players WHERE id = ?').get(id) as { team_id: string; slot_id: string | null }
  const own = where(swap.player_id)
  const target = where(swap.target_player_id)
  if (own.team_id !== swap.target_team_id || own.slot_id !== swap.own_slot_id) refuse('swap-moved-since', { player: swap.player_id })
  if (target.team_id !== swap.team_id || target.slot_id !== swap.target_slot_id) refuse('swap-moved-since', { player: swap.target_player_id })
  // …and not traded since, there and back: that trade was made with them where they are.
  const swapped = db.prepare(`SELECT id FROM events WHERE type = 'draft_swap' AND ${jsonField('payload', '$.actionId')} = ?`).get(actionId) as { id: number } | undefined
  // (Rule 21 refuses such trades now; a league from before may hold one.)
  const since = movedSince(db, swapped?.id ?? 0, [swap.player_id, swap.target_player_id], [])
  if (since) refuse('swap-moved-since', { player: since.player! })
  // Their slots before the swap: each took the other's, unless slots were kept.
  const keep = s.draft.incomingSlot === 'own'
  const back = { ownSlot: keep ? swap.own_slot_id : swap.target_slot_id, targetSlot: keep ? swap.target_slot_id : swap.own_slot_id }
  transaction(db, () => {
    db.prepare('UPDATE players SET team_id = ?, slot_id = ? WHERE id = ?').run(swap.team_id, back.ownSlot, swap.player_id)
    db.prepare('UPDATE players SET team_id = ?, slot_id = ? WHERE id = ?').run(swap.target_team_id, back.targetSlot, swap.target_player_id)
    db.prepare("UPDATE cards SET status = 'held' WHERE id = ?").run(last.cardId)
    db.prepare('UPDATE draft_actions SET vetoed_at = ? WHERE id = ?').run(now(), actionId)
    if (item) db.prepare('UPDATE checklist SET cancelled_at = ? WHERE id = ?').run(now(), item.id)
    appendEvent(db, 'move_vetoed', { kind: 'draft-swap', refId: actionId }, s.season.id)
  })
}

/** Closes the draft: cards nobody played expire (or carry over), and the offseason begins. */
export function finishDraft(db: Db): void {
  const s = draftState(db)
  if (s.season.phase !== 'draft') refuse('wrong-phase', { phase: s.season.phase })
  transaction(db, () => {
    if (s.draft.unusedCards === 'expire') {
      db.prepare("UPDATE cards SET status = 'expired' WHERE season_id = ? AND status = 'held'").run(s.season.id)
    }
    setPhase(db, s.season, 'offseason')
  })
}

/** offseason → a new season in preseason. Rosters carry over; locks and records reset. */
export function startNextSeason(db: Db, label: string): number {
  const season = currentSeason(db)
  if (season.phase !== 'offseason') refuse('wrong-phase', { phase: season.phase })
  const name = label.trim()
  if (name === '') refuse('bad-label')
  // Pickers, the export's season column and carried cards' names tell seasons apart by label.
  const labels = db.prepare('SELECT label FROM seasons').all() as { label: string }[]
  const key = (l: string) => l.replace(/\s+/g, ' ').trim().toLowerCase()
  if (labels.some((s) => key(s.label) === key(name))) refuse('season-label-taken', { label: name })
  const waiting = db.prepare('SELECT COUNT(*) AS n FROM checklist WHERE applied_at IS NULL AND cancelled_at IS NULL').get() as { n: number }
  if (waiting.n > 0) refuse('pending-2k-moves', { count: waiting.n })
  return transaction(db, () => {
    const seed = randomBytes(8).toString('hex')
    const id = Number(db.prepare("INSERT INTO seasons (label, phase, started_at, seed) VALUES (?, 'preseason', ?, ?)").run(name, now(), seed).lastInsertRowid)
    // Carried-over cards move to the new season's draft, keeping their owner.
    db.prepare("UPDATE cards SET season_id = ? WHERE season_id = ? AND status = 'held'").run(id, season.id)
    appendEvent(db, 'season_created', { label: name }, id)
    appendEvent(db, 'phase_changed', { from: 'offseason', to: 'preseason' }, id)
    return id
  })
}

// ── Awards ───────────────────────────────────────────────────────────────

export function listAwards(db: Db, seasonId: number): AwardRow[] {
  // Past rosters aren't stored: each award keeps the team he was on when it was given.
  const rows = db
    .prepare(
      `SELECT a.id, a.award_id, a.period, a.team_rank, a.player_id, COALESCE(a.team_id, p.team_id) AS team_id
       FROM awards a LEFT JOIN players p ON p.id = a.player_id
       WHERE a.season_id = ? ORDER BY a.award_id, a.period, a.team_rank, a.id`,
    )
    .all(seasonId) as { id: number; award_id: string; period: string; team_rank: number; player_id: string; team_id: string | null }[]
  return rows.map((r) => ({
    id: r.id,
    awardId: r.award_id,
    period: r.period,
    teamRank: r.team_rank,
    playerId: r.player_id,
    teamId: r.team_id ?? '',
  }))
}

export function giveAward(db: Db, input: { awardId: string; period: string; teamRank: number; playerId: string }): number {
  const season = currentSeason(db)
  const { config } = loadConfig(db)
  const seasonAward = config.awards.season.find((a) => a.id === input.awardId)
  const periodic = config.awards.periodic.find((a) => a.id === input.awardId)
  if (!seasonAward && !periodic) refuse('unknown-award', { award: input.awardId })
  if (seasonAward && input.period !== '') refuse('bad-period')
  if (periodic) {
    // w1, w2… for weekly awards; m1, m2… for monthly ones.
    const m = input.period.match(/^([wm])(\d{1,3})$/)
    if (!m || m[1] !== (periodic.period === 'week' ? 'w' : 'm') || Number(m[2]) < 1) refuse('bad-period')
  }
  if (seasonAward && season.phase === 'preseason') refuse('wrong-phase', { phase: season.phase })
  if (seasonAward?.timing === 'finals' && !['draft', 'offseason'].includes(season.phase)) refuse('award-too-early')
  const maxRank = seasonAward?.kind === 'selection' ? seasonAward.teams : 1
  if (!Number.isInteger(input.teamRank) || input.teamRank < 1 || input.teamRank > maxRank) refuse('bad-rank')
  const player = db.prepare('SELECT team_id FROM players WHERE id = ?').get(input.playerId) as { team_id: string } | undefined
  if (!player) refuse('unknown-player', { player: input.playerId })
  const limit = seasonAward ? (seasonAward.kind === 'selection' ? seasonAward.perTeam : 1) : periodic!.winners
  const already = db
    .prepare('SELECT COUNT(*) AS n FROM awards WHERE season_id = ? AND award_id = ? AND period = ? AND team_rank = ?')
    .get(season.id, input.awardId, input.period, input.teamRank) as { n: number }
  if (already.n >= limit) refuse('award-full', { limit })
  // One place per player per award and period (no 1st and 2nd team both).
  const twice = db
    .prepare('SELECT COUNT(*) AS n FROM awards WHERE season_id = ? AND award_id = ? AND period = ? AND player_id = ?')
    .get(season.id, input.awardId, input.period, input.playerId) as { n: number }
  if (twice.n > 0) refuse('award-duplicate')
  // Kept with the award, so a trade or a draft swap later doesn't change whom he won it for.
  const teamId = ['draft', 'offseason'].includes(season.phase) ? teamWhenGamesEnded(db, season.id, input.playerId, player.team_id) : player.team_id
  return transaction(db, () => {
    const id = Number(
      db
        .prepare('INSERT INTO awards (season_id, award_id, period, team_rank, player_id, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(season.id, input.awardId, input.period, input.teamRank, input.playerId, teamId, now()).lastInsertRowid,
    )
    appendEvent(db, 'award_given', input, season.id)
    return id
  })
}

/**
 * A player's team when the season's games ended. An award given in the draft
 * or the offseason is for the season just played, so moves made since (draft
 * swaps, offseason trades) don't count: his first move after the games ended
 * says where he was, even one later undone.
 */
function teamWhenGamesEnded(db: Db, seasonId: number, playerId: string, teamNow: string): string {
  const ended = db
    .prepare(
      `SELECT id FROM events WHERE season_id = ? AND type = 'phase_changed' AND ${jsonField('payload', '$.to')} IN ('draft', 'offseason')
       ORDER BY id LIMIT 1`,
    )
    .get(seasonId) as { id: number } | undefined
  if (!ended) return teamNow
  const moves = db
    .prepare("SELECT type, payload FROM events WHERE season_id = ? AND id > ? AND type IN ('trade_applied', 'draft_swap') ORDER BY id")
    .all(seasonId, ended.id) as { type: 'trade_applied' | 'draft_swap'; payload: string }[]
  const item = db.prepare("SELECT from_team_id FROM trade_items WHERE trade_id = ? AND kind = 'player' AND player_id = ?")
  for (const m of moves) {
    if (m.type === 'trade_applied') {
      const { tradeId } = JSON.parse(m.payload) as EventPayloads['trade_applied']
      const moved = item.get(tradeId, playerId) as { from_team_id: string } | undefined
      if (moved) return moved.from_team_id
    } else {
      const s = JSON.parse(m.payload) as EventPayloads['draft_swap']
      if (s.playerId === playerId) return s.teamId
      if (s.targetPlayerId === playerId) return s.targetTeamId
    }
  }
  return teamNow
}

export function removeAward(db: Db, id: number): void {
  const row = db.prepare('SELECT season_id, award_id, period, team_rank, player_id FROM awards WHERE id = ?').get(id) as
    | { season_id: number; award_id: string; period: string; team_rank: number; player_id: string }
    | undefined
  if (!row) refuse('unknown-award', { award: id })
  // A past season is over, like its results.
  if (row.season_id !== currentSeason(db).id) refuse('past-season-award')
  transaction(db, () => {
    db.prepare('DELETE FROM awards WHERE id = ?').run(id)
    appendEvent(db, 'award_removed', { awardId: row.award_id, period: row.period, teamRank: row.team_rank, playerId: row.player_id }, row.season_id)
  })
}
