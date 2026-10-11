import type { LorePatch, SuggestionCardKind, SuggestionStatus, SuggestionTarget, SuggestionView } from '@shared/suggestions'
import type { Db } from './db'

/**
 * The lore suggestion inbox's storage. A suggestion is only a patch waiting
 * for you; the lore files and the roster change when one is approved
 * (src/main/suggestions.ts), never here.
 */

export interface SuggestionRow {
  id: number
  kind: SuggestionCardKind
  status: SuggestionStatus
  target: SuggestionTarget
  patch: LorePatch
  reason: string
  source: SuggestionView['source']
  dedupe: string
  times: number
  seasonId: number | null
  round: number | null
  jobId: number | null
  file: string | null
  auto: boolean
  error: string | null
  createdAt: string
  updatedAt: string
  decidedAt: string | null
}

export interface NewSuggestion {
  kind: SuggestionCardKind
  target: SuggestionTarget
  patch: LorePatch
  reason: string
  source?: SuggestionView['source']
  /** The same key while one is waiting merges into it ("suggested 3 times"). */
  dedupe: string
  seasonId: number | null
  round: number | null
  jobId: number | null
}

interface Row {
  id: number
  kind: SuggestionCardKind
  status: SuggestionStatus
  target_kind: 'player' | 'team' | 'gm'
  target_id: string
  patch: string
  reason: string
  source: string
  dedupe: string
  times: number
  season_id: number | null
  round: number | null
  job_id: number | null
  file: string | null
  auto: number
  error: string | null
  created_at: string
  updated_at: string
  decided_at: string | null
}

const toRow = (r: Row): SuggestionRow => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  target: r.target_kind === 'player' ? { kind: 'player', playerId: r.target_id } : { kind: r.target_kind, teamId: r.target_id },
  patch: JSON.parse(r.patch) as LorePatch,
  reason: r.reason,
  source: JSON.parse(r.source) as SuggestionView['source'],
  dedupe: r.dedupe,
  times: r.times,
  seasonId: r.season_id,
  round: r.round,
  jobId: r.job_id,
  file: r.file,
  auto: r.auto === 1,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  decidedAt: r.decided_at,
})

export const targetId = (t: SuggestionTarget) => (t.kind === 'player' ? t.playerId : t.teamId)
export const targetKey = (t: SuggestionTarget) => `${t.kind}:${targetId(t)}`

/**
 * Stores a suggestion, or merges it into the waiting one with the same key:
 * a draft or a trait change takes the newer patch, anything else keeps the
 * first. The newest reason always comes with its own source (the thread or
 * game it cites). A failed approval stays on the card until you approve or
 * turn it down, unless a newer patch replaces the one it was about, or (a
 * reveal) the check just found its secret in the file again, which proves a
 * stale one wrong. A round suggestion you already approved or turned down
 * isn't asked again (a draft you ask for again is).
 */
export function addSuggestion(db: Db, s: NewSuggestion, nowMs: number): { id: number; merged: boolean } | null {
  const now = new Date(nowMs).toISOString()
  const waiting = db.prepare("SELECT id FROM suggestions WHERE dedupe = ? AND status = 'pending'").get(s.dedupe) as { id: number } | undefined
  if (waiting) {
    const newer = s.kind === 'draft' || s.kind === 'trait'
    // A reveal's key is the secret as the file has it now, so "it's gone from the file" no longer holds; other failures stay.
    const found = s.kind === 'reveal' ? ", error = CASE WHEN error = 'stale' OR error LIKE 'stale:%' THEN NULL ELSE error END" : ''
    db.prepare(
      `UPDATE suggestions SET times = ${s.kind === 'draft' ? '1' : 'times + 1'}, reason = ?, source = ?, updated_at = ?${newer ? ', error = NULL, patch = ?, job_id = ?' : found} WHERE id = ?`,
    ).run(...([s.reason, JSON.stringify(s.source ?? {}), now, ...(newer ? [JSON.stringify(s.patch), s.jobId] : []), waiting.id] as (string | number | null)[]))
    return { id: waiting.id, merged: true }
  }
  if (s.kind !== 'draft' && db.prepare("SELECT 1 FROM suggestions WHERE dedupe = ? AND status IN ('approved', 'rejected') LIMIT 1").get(s.dedupe)) return null
  const r = db
    .prepare(
      `INSERT INTO suggestions (kind, target_kind, target_id, patch, reason, source, dedupe, season_id, round, job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.kind, s.target.kind, targetId(s.target), JSON.stringify(s.patch), s.reason, JSON.stringify(s.source ?? {}), s.dedupe, s.seasonId, s.round, s.jobId, now, now)
  return { id: Number(r.lastInsertRowid), merged: false }
}

export function getSuggestion(db: Db, id: number): SuggestionRow | null {
  const r = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Row | undefined
  return r ? toRow(r) : null
}

/** Waiting cards, newest first; or decided ones (approved, turned down, expired), newest decision first. */
export function listSuggestions(db: Db, which: 'pending' | 'decided', limit = 300): SuggestionRow[] {
  const rows =
    which === 'pending'
      ? db.prepare("SELECT * FROM suggestions WHERE status = 'pending' ORDER BY id DESC LIMIT ?").all(limit)
      : db.prepare("SELECT * FROM suggestions WHERE status <> 'pending' ORDER BY COALESCE(decided_at, updated_at) DESC, id DESC LIMIT ?").all(limit)
  return (rows as unknown as Row[]).map(toRow)
}

/** Waiting cards for one player, school or GM. */
export function pendingFor(db: Db, target: SuggestionTarget): SuggestionRow[] {
  const rows = db
    .prepare("SELECT * FROM suggestions WHERE status = 'pending' AND target_kind = ? AND target_id = ? ORDER BY id DESC")
    .all(target.kind, targetId(target)) as unknown as Row[]
  return rows.map(toRow)
}

export function pendingCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'").get() as { n: number }).n
}

/** Approved (with what was finally applied) or turned down. Only a waiting card can be decided. */
export function decideSuggestion(
  db: Db,
  id: number,
  status: 'approved' | 'rejected',
  nowMs: number,
  applied?: { patch: LorePatch; file: string | null; auto: boolean },
): boolean {
  const now = new Date(nowMs).toISOString()
  const r = applied
    ? db
        .prepare("UPDATE suggestions SET status = ?, patch = ?, file = ?, auto = ?, error = NULL, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(status, JSON.stringify(applied.patch), applied.file, applied.auto ? 1 : 0, now, now, id)
    : db.prepare("UPDATE suggestions SET status = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(status, now, now, id)
  return Number(r.changes) > 0
}

/** Why approving didn't work; the card stays waiting. */
export function setSuggestionError(db: Db, id: number, error: string | null): void {
  db.prepare('UPDATE suggestions SET error = ? WHERE id = ?').run(error, id)
}

/** Round suggestions still waiting from `rounds` or more rounds ago (or an earlier season) expire. Drafts never do. */
export function expireOld(db: Db, seasonId: number, round: number, rounds: number, nowMs: number): number {
  const now = new Date(nowMs).toISOString()
  const r = db
    .prepare(
      `UPDATE suggestions SET status = 'expired', decided_at = ?, updated_at = ?
       WHERE status = 'pending' AND kind <> 'draft' AND round IS NOT NULL AND (season_id <> ? OR round <= ?)`,
    )
    .run(now, now, seasonId, round - rounds)
  return Number(r.changes)
}

/**
 * Waiting cards a newer suggestion replaces: a trait change asking for another
 * value, or a whispered secret that's now confirmed (same key up to `dedupePrefix`).
 */
export function supersede(db: Db, dedupePrefix: string, except: string, nowMs: number): void {
  const now = new Date(nowMs).toISOString()
  // instr, not substr with a JS length: SQLite counts characters and JS counts UTF-16 units, so a name with an emoji would never match.
  db.prepare(
    `UPDATE suggestions SET status = 'expired', decided_at = ?, updated_at = ?
     WHERE status = 'pending' AND instr(dedupe, ?) = 1 AND dedupe <> ?`,
  ).run(now, now, dedupePrefix, except)
}

/**
 * Whether a card whose key starts with `dedupePrefix` was decided that way: a
 * secret you turned down (as a whisper or a confirmation) isn't asked again
 * either way, and one you approved isn't asked about as a whisper (what you
 * kept in 비밀 may still hold it).
 */
export function decidedLike(db: Db, dedupePrefix: string, status: 'approved' | 'rejected'): boolean {
  return Boolean(db.prepare('SELECT 1 FROM suggestions WHERE status = ? AND instr(dedupe, ?) = 1 LIMIT 1').get(status, dedupePrefix))
}

/** Whether a job's suggestions were stored already (a re-run after a crash must not add them twice). */
export function suggestionsSaved(db: Db, jobId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM suggestions WHERE job_id = ? LIMIT 1').get(jobId))
}
