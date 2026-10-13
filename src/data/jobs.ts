import type { JobErrorKind } from '@ai/adapter'
import { MANUAL_RETRY_OF, type JobRow, type JobStatus, type JobStore } from '@ai/queue'
import { AI_JOB_OF_KIND, IN_QUEUE_SHOWN, type RecentJob, type RunUsage, type TokenCounts } from '@shared/ai'
import { jsonField, transaction, type Db } from './db'

interface Row {
  id: number
  kind: string
  status: JobStatus
  priority: number
  input: string
  output: string | null
  error: string | null
  error_kind: JobErrorKind | null
  attempts: number
  folder: string | null
  cost_usd: number | null
  asked_model: string | null
  asked_effort: string | null
  model: string | null
  tokens: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/** The `tokens` column: tokens per exact model and the total (the main model has its own column). */
type StoredTokens = Pick<RunUsage, 'models' | 'total'>

/** A stored usage, or null when there's none (or it can't be read: it's only ever a record). */
function usageOf(model: string | null, tokens: string | null): RunUsage | null {
  if (tokens === null) return null
  try {
    const t = JSON.parse(tokens) as StoredTokens
    return t && typeof t === 'object' && t.total && typeof t.total === 'object' ? { model, models: t.models ?? {}, total: t.total } : null
  } catch {
    return null
  }
}

/** A stored JSON column; a row that can't be read says why instead of throwing, so one bad row never stops the queue. */
function readJson(text: string | null, what: string, bad: string[]): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch (e) {
    bad.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

function toJob(r: Row): JobRow {
  const bad: string[] = []
  const job: JobRow = {
    id: r.id,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    input: readJson(r.input, 'input', bad),
    output: readJson(r.output, 'output', bad),
    error: r.error,
    errorKind: r.error_kind,
    attempts: r.attempts,
    folder: r.folder,
    costUsd: r.cost_usd,
    askedModel: r.asked_model,
    askedEffort: r.asked_effort,
    usage: usageOf(r.model, r.tokens),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
  return bad.length ? { ...job, unreadable: bad.join('; ') } : job
}

const COLUMNS: Record<string, string> = {
  status: 'status',
  output: 'output',
  error: 'error',
  errorKind: 'error_kind',
  attempts: 'attempts',
  costUsd: 'cost_usd',
  askedModel: 'asked_model',
  askedEffort: 'asked_effort',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
}

/** The AI job queue's storage, in the league database. */
export function sqliteJobStore(db: Db): JobStore {
  return {
    insert(kind, input, priority, folder) {
      const r = db
        .prepare("INSERT INTO jobs (kind, status, priority, input, folder, created_at) VALUES (?, 'queued', ?, ?, ?, ?)")
        .run(kind, priority, JSON.stringify(input), folder, new Date().toISOString())
      return Number(r.lastInsertRowid)
    },
    get(id) {
      const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
      return r ? toJob(r) : null
    },
    next(skip = []) {
      const but = skip.length > 0 ? ` AND id NOT IN (${skip.map(() => '?').join(',')})` : ''
      const r = db.prepare(`SELECT * FROM jobs WHERE status = 'queued'${but} ORDER BY priority DESC, id LIMIT 1`).get(...skip) as Row | undefined
      return r ? toJob(r) : null
    },
    update(id, change) {
      const sets: string[] = []
      const values: (string | number | null)[] = []
      for (const [key, value] of Object.entries(change)) {
        if (key === 'usage') {
          // Two columns: the main model on its own (to look jobs up by it), the token counts as JSON.
          const usage = (value ?? null) as RunUsage | null
          sets.push('model = ?', 'tokens = ?')
          values.push(usage?.model ?? null, usage ? JSON.stringify({ models: usage.models, total: usage.total } satisfies StoredTokens) : null)
          continue
        }
        const col = COLUMNS[key]
        if (!col) continue
        sets.push(`${col} = ?`)
        values.push(key === 'output' ? (value === undefined || value === null ? null : JSON.stringify(value)) : ((value ?? null) as string | number | null))
      }
      if (sets.length > 0) db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    },
    requeueRunning() {
      db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run()
    },
    queuedOf(kind) {
      return (db.prepare("SELECT id FROM jobs WHERE status = 'queued' AND kind = ? ORDER BY priority DESC, id").all(kind) as { id: number }[]).map((r) => r.id)
    },
    atomically(fn) {
      return transaction(db, fn)
    },
    liveRetryOf(id) {
      return retryChains(db, [id]).get(id)?.live ?? null
    },
  }
}

/** Statuses that mean a 다시 시도 took: it waits, runs or got done (a failed or cancelled one doesn't count). */
const LIVE = new Set<JobStatus>(['queued', 'running', 'done'])

interface RetryChain {
  /** The newest job in the chain: the only one 최근 작업 offers 다시 시도 on. */
  newest: number
  /** A retry in the chain that's waiting, running or done, if any. */
  live: number | null
  /** The latest 다시 시도 of this job itself. */
  retriedBy: number | null
}

/**
 * Each job's 다시 시도 chain: back through `manualRetryOf` to the job it all
 * started from, then every retry queued from there on (a retry of a retry
 * too, or a second retry of the first job). One live retry anywhere in it
 * means the work is under way again, whichever job's button was pressed.
 */
function retryChains(db: Db, ids: readonly number[]): Map<number, RetryChain> {
  const out = new Map<number, RetryChain>()
  if (ids.length === 0) return out
  const parentOf = db.prepare(`SELECT CASE WHEN json_valid(input) THEN json_extract(input, '$.${MANUAL_RETRY_OF}') END AS of FROM jobs WHERE id = ?`)
  const rootOf = new Map<number, number>()
  for (const id of ids) {
    let at = id
    for (;;) {
      const of = (parentOf.get(at) as { of: unknown } | undefined)?.of
      // A retry is always newer than the job it retries, which also rules out loops.
      if (typeof of !== 'number' || !Number.isInteger(of) || of >= at) break
      at = of
    }
    rootOf.set(id, at)
  }
  const retries = db
    .prepare(
      `SELECT id, status, ${jsonField('input', `$.${MANUAL_RETRY_OF}`)} AS of FROM jobs
       WHERE id > ? AND json_valid(input) AND json_type(input, '$.${MANUAL_RETRY_OF}') = 'integer' ORDER BY id`,
    )
    .all(Math.min(...rootOf.values())) as { id: number; status: JobStatus; of: number }[]
  const children = new Map<number, { id: number; status: JobStatus }[]>()
  for (const r of retries) if (r.of < r.id) children.set(r.of, [...(children.get(r.of) ?? []), r])
  for (const id of ids) {
    const root = rootOf.get(id)!
    let newest = root
    let live: number | null = null
    const todo = [root]
    while (todo.length > 0) {
      for (const c of children.get(todo.pop()!) ?? []) {
        newest = Math.max(newest, c.id)
        if (live === null && LIVE.has(c.status)) live = c.id
        todo.push(c.id)
      }
    }
    out.set(id, { newest, live, retriedBy: children.get(id)?.at(-1)?.id ?? null })
  }
  return out
}

/**
 * A job's error text, for the 자세히 panel in 최근 작업 (asked for one job at
 * a time, so the list itself never carries it; it can quote league lore).
 */
export function jobError(db: Db, id: number): { error: string | null } | null {
  const r = db.prepare('SELECT error FROM jobs WHERE id = ?').get(id) as { error: string | null } | undefined
  return r ? { error: r.error } : null
}

/** Cancels queued jobs of a kind for one game (e.g. a thread built before the score was corrected). */
export function cancelQueuedForGame(db: Db, kind: string, gameId: number, reason: string): number {
  return Number(
    db
      .prepare(`UPDATE jobs SET status = 'cancelled', error = ? WHERE status = 'queued' AND kind = ? AND ${jsonField('input', '$.gameId')} = ?`)
      .run(reason, kind, gameId).changes,
  )
}

export function listJobs(db: Db, limit = 50): JobRow[] {
  return (db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as Row[]).map(toJob)
}

/** What the list reads of a job: never its input, output or error text. */
const RECENT_COLUMNS = `id, kind, status, error_kind, cost_usd, model, tokens, created_at, started_at,
  COALESCE(asked_model, CASE WHEN json_valid(input) THEN json_extract(input, '$.model') END) AS asked_model,
  COALESCE(asked_effort, CASE WHEN json_valid(input) THEN json_extract(input, '$.effort') END) AS asked_effort,
  CASE WHEN json_valid(input) THEN json_type(input, '$.numberRetry') IS NOT NULL ELSE 0 END AS number_retry,
  CASE WHEN json_valid(input) THEN json_extract(input, '$.retryOf') END AS retry_of,
  CASE WHEN json_valid(input) AND input <> '{}' THEN 1 ELSE 0 END AS input_kept`

type RecentRow = Pick<Row, 'id' | 'kind' | 'error_kind' | 'cost_usd' | 'model' | 'tokens' | 'created_at' | 'started_at' | 'asked_model' | 'asked_effort'> & {
  status: JobStatus
  finished_at: string
  number_retry: number
  retry_of: number | null
  input_kept: number
}

/**
 * For 편집실 → AI 모델 → 최근 작업: first the jobs still in the queue (대기
 * 중: the running one, then the rest in the order they'd run, each with when
 * it was queued and when its last try started), then the latest finished jobs
 * (done or failed), newest first.
 * `+status` keeps SQLite off the status index, so it walks `jobs_by_finish`
 * in order instead of sorting every finished job.
 * Only what the list shows is read: never the input, output or error text.
 * Jobs from before migration 14 fall back to the model saved in their input,
 * and a number-check redo is told by its input's numberRetry and retryOf.
 * `retryable` says which kinds 다시 시도 can queue again (JobQueue.canRetry).
 */
export function recentJobs(db: Db, limit = 30, retryable: (kind: string) => boolean = () => true): RecentJob[] {
  const waiting = db
    .prepare(
      `SELECT ${RECENT_COLUMNS}, COALESCE(started_at, created_at) AS finished_at
       FROM jobs WHERE status IN ('running', 'queued') ORDER BY status = 'running' DESC, priority DESC, id LIMIT ?`,
    )
    .all(IN_QUEUE_SHOWN) as unknown as RecentRow[]
  const finished = db
    .prepare(
      `SELECT ${RECENT_COLUMNS}, finished_at
       FROM jobs WHERE finished_at IS NOT NULL AND +status IN ('done', 'failed')
       ORDER BY finished_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as unknown as RecentRow[]
  const rows = [...waiting, ...finished]
  // The number check's redo of a job in the list, once it has finished (a redo is always queued after its first try),
  // and 다시 시도's chains: only a chain's newest job offers it, and none once a retry in it waits, runs or got done.
  const redone = new Map<number, number>()
  const chains = retryChains(db, rows.map((r) => r.id))
  if (finished.length) {
    const first = Math.min(...finished.map((r) => r.id))
    const redos = db
      .prepare(
        `SELECT id, ${jsonField('input', '$.retryOf')} AS retry_of FROM jobs
         WHERE id > ? AND finished_at IS NOT NULL AND +status IN ('done', 'failed') AND json_valid(input) AND ${jsonField('input', '$.retryOf')} >= ?`,
      )
      .all(first, first) as { id: number; retry_of: number }[]
    for (const r of redos) if (!redone.has(r.retry_of)) redone.set(r.retry_of, r.id)
  }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return rows.map((r) => {
    // In the queue: running, waiting its turn, or waiting to try again after a failed try.
    const status = r.status === 'done' || r.status === 'failed' || r.status === 'running' ? r.status : r.error_kind !== null ? 'waiting' : 'queued'
    const took = r.started_at === null || (status !== 'done' && status !== 'failed') ? NaN : Date.parse(r.finished_at) - Date.parse(r.started_at)
    const tokens: TokenCounts | null = usageOf(r.model, r.tokens)?.total ?? null
    const chain = chains.get(r.id)
    return {
      id: r.id,
      kind: r.kind,
      job: Object.hasOwn(AI_JOB_OF_KIND, r.kind) ? AI_JOB_OF_KIND[r.kind]! : null,
      status,
      errorKind: r.error_kind,
      canRetry: status === 'failed' && r.input_kept === 1 && chain?.newest === r.id && chain.live === null && retryable(r.kind),
      retriedBy: chain?.retriedBy ?? null,
      askedModel: text(r.asked_model),
      askedEffort: text(r.asked_effort),
      model: r.model,
      tokens,
      costUsd: r.cost_usd,
      queuedAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: Number.isFinite(took) && took >= 0 ? took : null,
      numberRetry: r.number_retry === 1,
      retryOf: typeof r.retry_of === 'number' ? r.retry_of : null,
      redoneBy: redone.get(r.id) ?? null,
    }
  })
}

/**
 * Jobs of one kind whose input has `field` set to `value` (e.g. the
 * read_box_score jobs for one game), latest first.
 */
export function listJobsByInput(db: Db, kind: string, field: string, value: string | number, limit = 20): JobRow[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`bad input field ${field}`)
  return (
    db
      .prepare(`SELECT * FROM jobs WHERE kind = ? AND ${jsonField('input', `$.${field}`)} = ? ORDER BY id DESC LIMIT ?`)
      .all(kind, value, limit) as unknown as Row[]
  ).map(toJob)
}
