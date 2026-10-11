import type { LearnedName } from '@ingest/namemap'
import { normalizeSource } from '@ingest/namemap'
import { transaction, type Db } from './db'

/** Learned 2K names for a team. */
export function learnedNames(db: Db, teamId: string): LearnedName[] {
  return (
    db.prepare('SELECT source, player_id, row_order FROM name_map WHERE team_id = ? ORDER BY row_order').all(teamId) as {
      source: string
      player_id: string
      row_order: number | null
    }[]
  ).map((r) => ({ source: r.source, playerId: r.player_id, rowOrder: r.row_order }))
}

/**
 * Remembers confirmed matches. Each confirmed player's earlier entries on
 * that team are replaced by what was confirmed now (his 2K name and row).
 * Entries for players who weren't in this game stay: when only one of a
 * same-name pair plays, the other one is still known by that name. (A wrong
 * match that was corrected therefore stays as a second player for the name
 * until that player turns up under his own name; the confirm screen shows
 * such names as same-name warnings, so nothing is matched silently.)
 */
export function learnNames(db: Db, names: { teamId: string; source: string; playerId: string; row: number }[]): void {
  if (names.length === 0) return
  // One entry per player and team; a later one wins.
  const latest = new Map(names.map((n) => [`${n.teamId}\u0000${n.playerId}`, n]))
  const now = new Date().toISOString()
  transaction(db, () => {
    const forget = db.prepare('DELETE FROM name_map WHERE team_id = ? AND player_id = ?')
    const insert = db.prepare('INSERT INTO name_map (team_id, source, player_id, row_order, confirmed_at) VALUES (?, ?, ?, ?, ?)')
    for (const n of latest.values()) {
      forget.run(n.teamId, n.playerId)
      insert.run(n.teamId, normalizeSource(n.source), n.playerId, n.row, now)
    }
  })
}
