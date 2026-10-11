import type { DealView, GmPlanView, NegotiationStatus, StepAction, ValueReport, WindowStatus } from '@shared/gm'
import type { Db } from './db'

/**
 * Storage for the AI GMs: trade windows, each GM's turn in them, the
 * negotiations with every step, and what each GM remembers. Trades
 * themselves are recorded by the League engine (src/data/moves.ts).
 */

export interface WindowRow {
  id: number
  seasonId: number
  round: number | null
  status: WindowStatus
  reason: 'scheduled' | 'manual'
  openedAt: string
  closedAt: string | null
}

export interface NegotiationRow {
  id: number
  windowId: number
  fromTeam: string
  toTeam: string
  status: NegotiationStatus
  deal: DealView
  tradeId: number | null
  valueGap: number | null
  lopsided: boolean
  leaked: boolean
  reason: string | null
  createdAt: string
  closedAt: string | null
}

export interface StepRow {
  id: number
  negotiationId: number
  round: number
  teamId: string
  action: StepAction
  deal: DealView | null
  message: string
  note: string
  report: ValueReport | null
  trust: number | null
  jobId: number | null
  createdAt: string
}

export interface GmMemory {
  plan: (GmPlanView & { windowId: number | null }) | null
  /** Trust toward other GMs by team id, -100..100 (0 when unknown). */
  trust: Record<string, number>
  /** Recent decisions, one line each, newest last. */
  notes: string[]
}

const iso = (ms: number) => new Date(ms).toISOString()
const json = <T>(text: string | null, fallback: T): T => (text === null ? fallback : (JSON.parse(text) as T))

// ── Windows ──────────────────────────────────────────────────────────────

interface WindowDb {
  id: number
  season_id: number
  round: number | null
  status: WindowStatus
  reason: 'scheduled' | 'manual'
  opened_at: string
  closed_at: string | null
}
const toWindow = (r: WindowDb): WindowRow => ({
  id: r.id,
  seasonId: r.season_id,
  round: r.round,
  status: r.status,
  reason: r.reason,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
})

/** The window open now, if any (at most one is). */
export function openWindowRow(db: Db): WindowRow | null {
  const r = db.prepare("SELECT * FROM trade_windows WHERE status = 'open'").get() as WindowDb | undefined
  return r ? toWindow(r) : null
}

export function getWindow(db: Db, id: number): WindowRow | null {
  const r = db.prepare('SELECT * FROM trade_windows WHERE id = ?').get(id) as WindowDb | undefined
  return r ? toWindow(r) : null
}

export function insertWindow(db: Db, seasonId: number, phase: string, round: number | null, reason: 'scheduled' | 'manual', nowMs: number): number {
  return Number(
    db
      .prepare('INSERT INTO trade_windows (season_id, phase, round, reason, opened_at) VALUES (?, ?, ?, ?, ?)')
      .run(seasonId, phase, round, reason, iso(nowMs)).lastInsertRowid,
  )
}

export function closeWindowRow(db: Db, id: number, nowMs: number): boolean {
  return Number(db.prepare("UPDATE trade_windows SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(iso(nowMs), id).changes) > 0
}

/** A season's windows, newest first. */
export function listWindows(db: Db, seasonId: number): WindowRow[] {
  return (db.prepare('SELECT * FROM trade_windows WHERE season_id = ? ORDER BY id DESC').all(seasonId) as unknown as WindowDb[]).map(toWindow)
}

/** Whether a scheduled window already followed this round. */
export function windowAfterRound(db: Db, seasonId: number, round: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM trade_windows WHERE season_id = ? AND round = ? AND reason = 'scheduled'").get(seasonId, round))
}

// ── Turns ────────────────────────────────────────────────────────────────

export function addTurn(db: Db, windowId: number, teamId: string, output: unknown, jobId: number | null, nowMs: number): void {
  db.prepare('INSERT INTO gm_turns (window_id, team_id, output, job_id, created_at) VALUES (?, ?, ?, ?, ?)').run(windowId, teamId, JSON.stringify(output), jobId, iso(nowMs))
}

export function turnsSaved(db: Db, jobId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM gm_turns WHERE job_id = ? LIMIT 1').get(jobId))
}

/** Teams that had a turn in a window. */
export function teamsWithTurns(db: Db, windowId: number): Set<string> {
  return new Set((db.prepare('SELECT team_id FROM gm_turns WHERE window_id = ?').all(windowId) as { team_id: string }[]).map((r) => r.team_id))
}

// ── Negotiations ─────────────────────────────────────────────────────────

interface NegotiationDb {
  id: number
  window_id: number
  from_team: string
  to_team: string
  status: NegotiationStatus
  deal: string
  trade_id: number | null
  value_gap: number | null
  lopsided: number
  leaked: number
  reason: string | null
  created_at: string
  closed_at: string | null
}
const toNegotiation = (r: NegotiationDb): NegotiationRow => ({
  id: r.id,
  windowId: r.window_id,
  fromTeam: r.from_team,
  toTeam: r.to_team,
  status: r.status,
  deal: JSON.parse(r.deal) as DealView,
  tradeId: r.trade_id,
  valueGap: r.value_gap,
  lopsided: r.lopsided === 1,
  leaked: r.leaked === 1,
  reason: r.reason,
  createdAt: r.created_at,
  closedAt: r.closed_at,
})

export function createNegotiation(db: Db, windowId: number, deal: DealView, nowMs: number): number {
  return Number(
    db
      .prepare('INSERT INTO negotiations (window_id, from_team, to_team, deal, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(windowId, deal.a, deal.b, JSON.stringify(deal), iso(nowMs)).lastInsertRowid,
  )
}

export function getNegotiation(db: Db, id: number): NegotiationRow | null {
  const r = db.prepare('SELECT * FROM negotiations WHERE id = ?').get(id) as NegotiationDb | undefined
  return r ? toNegotiation(r) : null
}

export function listNegotiations(db: Db, windowId: number): NegotiationRow[] {
  return (db.prepare('SELECT * FROM negotiations WHERE window_id = ? ORDER BY id').all(windowId) as unknown as NegotiationDb[]).map(toNegotiation)
}

/** Deals both GMs agreed to, waiting for your approval (any window). */
export function agreedNegotiations(db: Db): NegotiationRow[] {
  return (db.prepare("SELECT * FROM negotiations WHERE status = 'agreed' ORDER BY id").all() as unknown as NegotiationDb[]).map(toNegotiation)
}

export function negotiationOfTrade(db: Db, tradeId: number): NegotiationRow | null {
  const r = db.prepare('SELECT * FROM negotiations WHERE trade_id = ?').get(tradeId) as NegotiationDb | undefined
  return r ? toNegotiation(r) : null
}

export function updateNegotiation(
  db: Db,
  id: number,
  change: Partial<{ status: NegotiationStatus; deal: DealView; tradeId: number | null; valueGap: number | null; lopsided: boolean; leaked: boolean; reason: string | null; closedAt: string | null }>,
): void {
  const cols: Record<string, string> = {
    status: 'status',
    deal: 'deal',
    tradeId: 'trade_id',
    valueGap: 'value_gap',
    lopsided: 'lopsided',
    leaked: 'leaked',
    reason: 'reason',
    closedAt: 'closed_at',
  }
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined) continue
    sets.push(`${cols[k]} = ?`)
    values.push(k === 'deal' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null))
  }
  if (sets.length) db.prepare(`UPDATE negotiations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
}

// ── Steps ────────────────────────────────────────────────────────────────

interface StepDb {
  id: number
  negotiation_id: number
  round: number
  team_id: string
  action: StepAction
  deal: string | null
  message: string
  private_note: string
  report: string | null
  trust: number | null
  job_id: number | null
  created_at: string
}

export function addStep(
  db: Db,
  s: { negotiationId: number; round: number; teamId: string; action: StepAction; deal: DealView | null; message: string; note: string; report: ValueReport | null; trust: number | null; jobId: number | null },
  nowMs: number,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO negotiation_steps (negotiation_id, round, team_id, action, deal, message, private_note, report, trust, job_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.negotiationId, s.round, s.teamId, s.action, s.deal ? JSON.stringify(s.deal) : null, s.message, s.note, s.report ? JSON.stringify(s.report) : null, s.trust, s.jobId, iso(nowMs))
      .lastInsertRowid,
  )
}

export function listSteps(db: Db, negotiationId: number): StepRow[] {
  return (db.prepare('SELECT * FROM negotiation_steps WHERE negotiation_id = ? ORDER BY id').all(negotiationId) as unknown as StepDb[]).map((r) => ({
    id: r.id,
    negotiationId: r.negotiation_id,
    round: r.round,
    teamId: r.team_id,
    action: r.action,
    deal: json<DealView | null>(r.deal, null),
    message: r.message,
    note: r.private_note,
    report: json<ValueReport | null>(r.report, null),
    trust: r.trust,
    jobId: r.job_id,
    createdAt: r.created_at,
  }))
}

export function stepSaved(db: Db, jobId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM negotiation_steps WHERE job_id = ? LIMIT 1').get(jobId))
}

// ── Memory ───────────────────────────────────────────────────────────────

export function memoryOf(db: Db, teamId: string): GmMemory {
  const r = db.prepare('SELECT plan, trust, notes FROM gm_memory WHERE team_id = ?').get(teamId) as { plan: string; trust: string; notes: string } | undefined
  if (!r) return { plan: null, trust: {}, notes: [] }
  const plan = JSON.parse(r.plan) as Partial<NonNullable<GmMemory['plan']>>
  return {
    plan: plan && 'stance' in plan ? (plan as NonNullable<GmMemory['plan']>) : null,
    trust: JSON.parse(r.trust) as Record<string, number>,
    notes: JSON.parse(r.notes) as string[],
  }
}

/** Notes kept per GM. */
const NOTES_KEPT = 8

export function saveMemory(db: Db, teamId: string, change: Partial<GmMemory>, nowMs: number): void {
  const m = { ...memoryOf(db, teamId), ...change }
  db.prepare(
    `INSERT INTO gm_memory (team_id, plan, trust, notes, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (team_id) DO UPDATE SET plan = excluded.plan, trust = excluded.trust, notes = excluded.notes, updated_at = excluded.updated_at`,
  ).run(teamId, JSON.stringify(m.plan ?? {}), JSON.stringify(m.trust), JSON.stringify(m.notes.slice(-NOTES_KEPT)), iso(nowMs))
}

/** Moves one GM's trust toward another, kept within -100..100. */
export function adjustTrust(db: Db, teamId: string, otherId: string, delta: number, nowMs: number): void {
  const m = memoryOf(db, teamId)
  const next = Math.max(-100, Math.min(100, Math.round((m.trust[otherId] ?? 0) + delta)))
  saveMemory(db, teamId, { trust: { ...m.trust, [otherId]: next } }, nowMs)
}

export function addNote(db: Db, teamId: string, note: string, nowMs: number): void {
  const m = memoryOf(db, teamId)
  saveMemory(db, teamId, { notes: [...m.notes, note.slice(0, 200)] }, nowMs)
}
