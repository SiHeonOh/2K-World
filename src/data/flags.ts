import type { Db } from './db'

/**
 * Marks on AI text (migration 18): numbers a writer used that its job's facts
 * don't hold, kept after the one retry also had them. Only the user sees
 * them, as a marker on the number; writers never read them. One row per
 * marked post, comment, wiki revision, 토론 line or player quote.
 */

export type FlagTarget = 'post' | 'comment' | 'wiki_revision' | 'wiki_talk' | 'player_quote'

/** Marks these numbers on one saved text (nothing when there are none). */
export function flagNumbers(db: Db, target: FlagTarget, id: number, numbers: readonly string[] | undefined, jobId: number | null): void {
  if (!numbers?.length) return
  db.prepare(
    `INSERT INTO ai_flags (target_kind, target_id, numbers, job_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (target_kind, target_id) DO UPDATE SET numbers = excluded.numbers, job_id = excluded.job_id`,
  ).run(target, id, JSON.stringify([...new Set(numbers)]), jobId, new Date().toISOString())
}

/** The marked numbers of some texts, by id (texts with none are left out). */
export function flagsFor(db: Db, target: FlagTarget, ids: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (ids.length === 0) return out
  // In chunks: SQLite caps the number of parameters in one statement.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const rows = db
      .prepare(`SELECT target_id, numbers FROM ai_flags WHERE target_kind = ? AND target_id IN (${chunk.map(() => '?').join(',')})`)
      .all(target, ...chunk) as { target_id: number; numbers: string }[]
    for (const r of rows) out.set(r.target_id, parseFlags(r.numbers))
  }
  return out
}

/** One text's marked numbers ([] when none). */
export function flagsOf(db: Db, target: FlagTarget, id: number): string[] {
  return flagsFor(db, target, [id]).get(id) ?? []
}

/** The numbers column as stored (JSON), read leniently: anything odd counts as none. */
export function parseFlags(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}
