import type { EventPayloads } from '@shared/events'
import { parseHeightCm } from '@shared/height'
import { folderKey, isFolderSafe } from '@shared/setup'
import type { RatingValue } from '@shared/setup'
import type { RuleIssue } from '@shared/season'
import { rosterProblems, rotationMove, type PlayerEdit, type RosterChange } from '@shared/roster'
import type { Db } from './db'
import { appendEvent, currentSeason, listPlayers, listTeams, loadConfig } from './league'
import { RuleError } from './rules'

/** The importer's limits (playerSchema in setup.ts). */
const LIMITS = { name: 80, height: 20, nickname: 60, nicknames: 20, notes: 4000 }

/**
 * Edits roster facts (name, height, nicknames, notes, ratings, slot) for any
 * number of players at once: everything is checked first, and either every
 * edit applies or none does. Each edited player gets a `player_edited` event;
 * each team whose lineup changed gets one `slots_changed`. Only the fields
 * an edit names change.
 */
export function updatePlayers(db: Db, edits: PlayerEdit[]): RosterChange[] {
  const { config } = loadConfig(db)
  const season = currentSeason(db)
  const players = listPlayers(db)
  const teams = listTeams(db)
  const byId = new Map(players.map((p) => [p.id, p]))
  const columns = new Map(config.ratings.columns.map((c) => [c.id, c]))
  const grades = new Set(config.ratings.gradeScale.map((g) => g.label))
  const slotIds = new Set(config.roster.slots.map((s) => s.id))
  const issues: RuleIssue[] = []
  const issue = (code: string, params: RuleIssue['params']) => issues.push({ code, params })
  // School and GM file names: a player called that would take their lore file's place.
  const reserved = new Set(teams.flatMap((t) => [folderKey(t.shortName), folderKey(`${t.shortName} 단장`)]))
  const ids = edits.map((e) => e.playerId)
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) issue('roster-duplicate-edit', { player: byId.get(id)?.name ?? id })
  // Draft swaps go by slots (same-slot swaps, the slot a player comes in at), so the lineup waits for the draft to end.
  const reslotting = edits.some((e) => byId.has(e.playerId) && e.slotId !== undefined && e.slotId !== byId.get(e.playerId)!.slotId)
  if (reslotting && season.phase === 'draft') issue('roster-slot-draft', {})

  // The roster after every edit, to check names against each other and each team's lineup as a whole.
  const after = new Map(players.map((p) => [p.id, { teamId: p.teamId, name: p.name }]))
  const slotAfter = new Map(players.map((p) => [p.id, p.slotId]))
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
    // A slot on his own team: nobody changes teams here.
    if (e.slotId !== undefined && e.slotId !== p.slotId) {
      if (e.slotId !== null && !slotIds.has(e.slotId)) issue('roster-slot-unknown', { player: p.name, slot: e.slotId })
      else slotAfter.set(p.id, e.slotId)
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
  // A team whose lineup changes must fit the league's roster rules (as trades check them) once every
  // edit is in, so two teammates swap slots in one save. Sizes can't change here: only the slots can be wrong.
  const reslotted = players.filter((p) => slotAfter.get(p.id) !== p.slotId)
  for (const t of season.phase === 'draft' ? [] : teams) {
    if (!reslotted.some((p) => p.teamId === t.id)) continue
    const lineup = players.filter((p) => p.teamId === t.id).map((p) => slotAfter.get(p.id) ?? null)
    for (const x of rosterProblems(config.roster, lineup)) {
      if (x.kind === 'slot') issue(x.count === 0 ? 'roster-slot-empty' : 'roster-slot-doubled', { team: t.shortName, slot: x.slot, count: x.count })
    }
  }
  if (issues.length > 0) throw new RuleError(issues)

  const changes: RosterChange[] = []
  const setPlayer = db.prepare('UPDATE players SET name = ?, height = ?, height_cm = ?, nicknames = ?, notes = ? WHERE id = ?')
  const setSlot = db.prepare('UPDATE players SET slot_id = ? WHERE id = ?')
  const dropRating = db.prepare('DELETE FROM ratings WHERE player_id = ? AND column_id = ?')
  const putRating = db.prepare('INSERT OR REPLACE INTO ratings (player_id, column_id, num, grade) VALUES (?, ?, ?, ?)')
  for (const e of edits) {
    const p = byId.get(e.playerId)!
    const name = e.name !== undefined ? e.name.trim() : p.name
    const height = e.height !== undefined ? e.height.trim() : p.height
    const nicknames = e.nicknames !== undefined ? e.nicknames.map((n) => n.trim()).filter(Boolean) : p.nicknames
    const notes = e.notes !== undefined ? e.notes : p.notes
    const slot = slotAfter.get(p.id) ?? null
    const fields: string[] = []
    if (name !== p.name) fields.push('name')
    if (height !== p.height) fields.push('height')
    if (JSON.stringify(nicknames) !== JSON.stringify(p.nicknames)) fields.push('nicknames')
    if (notes !== p.notes) fields.push('notes')
    const ratings = Object.entries(e.ratings ?? {}).filter(([id, v]) => (p.ratings[id] ?? null) !== v)
    for (const [id] of ratings) fields.push(`ratings.${id}`)
    if (slot !== p.slotId) {
      fields.push('slot')
      setSlot.run(slot, p.id)
    }
    if (fields.length === 0) continue
    changes.push({ playerId: p.id, teamId: p.teamId, fields, renamedFrom: name !== p.name ? p.name : null })
    // The slot has its team's event (below).
    const facts = fields.filter((f) => f !== 'slot')
    if (facts.length === 0) continue
    setPlayer.run(name, height, height === p.height ? p.heightCm : parseHeightCm(height), JSON.stringify(nicknames), notes, p.id)
    for (const [id, v] of ratings) {
      if (v === null) dropRating.run(p.id, id)
      else if (columns.get(id)!.kind === 'number') putRating.run(p.id, id, v as number, null)
      else putRating.run(p.id, id, null, String(v as RatingValue))
    }
    const renamedFrom = name !== p.name ? p.name : null
    appendEvent(db, 'player_edited', { playerId: p.id, teamId: p.teamId, fields: facts, ...(renamedFrom ? { renamedFrom } : {}) }, season.id)
  }
  for (const t of teams) {
    const moved: EventPayloads['slots_changed']['changes'] = reslotted
      .filter((p) => p.teamId === t.id)
      .map((p) => ({ playerId: p.id, from: p.slotId, to: slotAfter.get(p.id) ?? null }))
    if (moved.length === 0) continue
    const rotation = moved.some((m) => rotationMove(config.roster, m.from, m.to) !== null)
    appendEvent(db, 'slots_changed', { teamId: t.id, changes: moved, rotation }, season.id)
  }
  return changes
}
