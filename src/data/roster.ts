import { parseHeightCm } from '@shared/height'
import { folderKey, isFolderSafe } from '@shared/setup'
import type { RatingValue } from '@shared/setup'
import type { RuleIssue } from '@shared/season'
import type { PlayerEdit, RosterChange } from '@shared/roster'
import type { Db } from './db'
import { appendEvent, currentSeason, listPlayers, listTeams, loadConfig } from './league'
import { RuleError } from './rules'

/** The importer's limits (playerSchema in setup.ts). */
const LIMITS = { name: 80, height: 20, nickname: 60, nicknames: 20, notes: 4000 }

/**
 * Edits roster facts (name, height, nicknames, notes, ratings) for any number
 * of players at once: everything is checked first, and either every edit
 * applies or none does. Each edited player gets a `player_edited` event.
 * Only the fields an edit names change.
 */
export function updatePlayers(db: Db, edits: PlayerEdit[]): RosterChange[] {
  const { config } = loadConfig(db)
  const players = listPlayers(db)
  const byId = new Map(players.map((p) => [p.id, p]))
  const columns = new Map(config.ratings.columns.map((c) => [c.id, c]))
  const grades = new Set(config.ratings.gradeScale.map((g) => g.label))
  const issues: RuleIssue[] = []
  const issue = (code: string, params: RuleIssue['params']) => issues.push({ code, params })
  // School and GM file names: a player called that would take their lore file's place.
  const reserved = new Set(listTeams(db).flatMap((t) => [folderKey(t.shortName), folderKey(`${t.shortName} 단장`)]))
  const ids = edits.map((e) => e.playerId)
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) issue('roster-duplicate-edit', { player: byId.get(id)?.name ?? id })

  // The roster after every edit, to check names against each other.
  const after = new Map(players.map((p) => [p.id, { teamId: p.teamId, name: p.name }]))
  for (const e of edits) {
    const p = byId.get(e.playerId)
    if (!p) {
      issue('roster-unknown-player', { player: e.playerId })
      continue
    }
    if (e.name !== undefined) {
      const name = e.name.trim()
      if (name === '') issue('roster-name-empty', { player: p.name })
      else if (name === p.name) {
        // Unchanged (even if the import let in a name we'd refuse today).
      } else if (name.length > LIMITS.name || !isFolderSafe(name) || /[()]/.test(name) || /^[_.]/.test(name)) issue('roster-name-bad', { player: p.name, name })
      else if (reserved.has(folderKey(name))) issue('roster-name-reserved', { player: p.name, name })
      else after.set(p.id, { teamId: p.teamId, name })
    }
    if (e.height !== undefined && e.height.trim().length > LIMITS.height) issue('roster-too-long', { player: p.name, field: 'height' })
    if (e.notes !== undefined && e.notes.length > LIMITS.notes) issue('roster-too-long', { player: p.name, field: 'notes' })
    if (e.nicknames !== undefined) {
      const clean = e.nicknames.map((n) => n.trim()).filter(Boolean)
      if (clean.length > LIMITS.nicknames || clean.some((n) => n.length > LIMITS.nickname)) issue('roster-too-long', { player: p.name, field: 'nicknames' })
    }
    for (const [columnId, value] of Object.entries(e.ratings ?? {})) {
      const c = columns.get(columnId)
      if (!c) issue('roster-rating-unknown', { player: p.name, column: columnId })
      else if (value === null) continue
      else if (c.kind === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < c.min || value > c.max) {
          issue('roster-rating-range', { player: p.name, column: c.name, min: c.min, max: c.max })
        }
      } else if (typeof value !== 'string' || !grades.has(value)) issue('roster-rating-grade', { player: p.name, column: c.name, value: String(value) })
    }
  }
  // Two players with one name on one team can't be told apart anywhere (box scores, lore, the wiki).
  // Only a name being changed is checked: a pair the import let in doesn't block other edits.
  const renamed = new Set([...after].filter(([id, a]) => a.name !== byId.get(id)!.name).map(([id]) => id))
  for (const id of renamed) {
    const a = after.get(id)!
    const clash = [...after].some(([other, b]) => other !== id && b.teamId === a.teamId && folderKey(b.name) === folderKey(a.name))
    if (clash) issue('roster-name-taken', { name: a.name })
  }
  if (issues.length > 0) throw new RuleError(issues)

  const season = currentSeason(db)
  const changes: RosterChange[] = []
  const setPlayer = db.prepare('UPDATE players SET name = ?, height = ?, height_cm = ?, nicknames = ?, notes = ? WHERE id = ?')
  const dropRating = db.prepare('DELETE FROM ratings WHERE player_id = ? AND column_id = ?')
  const putRating = db.prepare('INSERT OR REPLACE INTO ratings (player_id, column_id, num, grade) VALUES (?, ?, ?, ?)')
  for (const e of edits) {
    const p = byId.get(e.playerId)!
    const name = e.name !== undefined ? e.name.trim() : p.name
    const height = e.height !== undefined ? e.height.trim() : p.height
    const nicknames = e.nicknames !== undefined ? e.nicknames.map((n) => n.trim()).filter(Boolean) : p.nicknames
    const notes = e.notes !== undefined ? e.notes : p.notes
    const fields: string[] = []
    if (name !== p.name) fields.push('name')
    if (height !== p.height) fields.push('height')
    if (JSON.stringify(nicknames) !== JSON.stringify(p.nicknames)) fields.push('nicknames')
    if (notes !== p.notes) fields.push('notes')
    const ratings = Object.entries(e.ratings ?? {}).filter(([id, v]) => (p.ratings[id] ?? null) !== v)
    for (const [id] of ratings) fields.push(`ratings.${id}`)
    if (fields.length === 0) continue
    setPlayer.run(name, height, height === p.height ? p.heightCm : parseHeightCm(height), JSON.stringify(nicknames), notes, p.id)
    for (const [id, v] of ratings) {
      if (v === null) dropRating.run(p.id, id)
      else if (columns.get(id)!.kind === 'number') putRating.run(p.id, id, v as number, null)
      else putRating.run(p.id, id, null, String(v as RatingValue))
    }
    const renamedFrom = name !== p.name ? p.name : null
    appendEvent(db, 'player_edited', { playerId: p.id, teamId: p.teamId, fields, ...(renamedFrom ? { renamedFrom } : {}) }, season.id)
    changes.push({ playerId: p.id, teamId: p.teamId, fields, renamedFrom })
  }
  return changes
}
