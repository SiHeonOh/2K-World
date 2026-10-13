import type { ZodType } from 'zod'
import { z } from 'zod'
import type { QueueState, RunUsage } from '@shared/ai'
import { addTokens, DEFAULT_TIMEOUT_MS, mainModel, type AiAdapter, type JobErrorKind, type JobRequest } from './adapter'

/**
 * The job queue. It knows nothing about basketball: a job kind is a prompt,
 * a schema and a model, and the store is whatever persists rows. Jobs run one
 * at a time; output is checked against the schema with one retry; a usage
 * limit pauses everything until the reset time, and a problem that should
 * pass (offline, Claude busy) pauses it for a while, so the waiting jobs are
 * never burned through.
 */

export interface JobKind<I = unknown, O = unknown> {
  kind: string
  /** A model name, or picked per job (e.g. from a setting saved in the input). */
  model: string | ((input: I) => string)
  /** Claude Code's --effort, or picked per job (left out: Claude Code's default). */
  effort?: JobRequest['effort'] | ((input: I) => JobRequest['effort'] | undefined)
  tools: string[]
  output: ZodType<O>
  systemPrompt: (input: I) => string
  prompt: (input: I) => string
  stdin: (input: I) => string
  /** At Claude Code's default effort; higher effort and the bigger models get longer (timeoutFor). */
  timeoutMs?: number
  /**
   * Stores a checked result (posts, comments…) before the job is marked done.
   * If it throws, the job fails with that message.
   */
  accept?: (output: O, job: JobRow) => void
  /** Checked just before a run: false cancels the job without calling Claude (e.g. it went stale while waiting). */
  stillWanted?: (input: I, job: JobRow) => boolean
  /**
   * The input a 다시 시도 of a failed job queues (left out: the same input).
   * Null when retrying can't help, e.g. the app already did the job's work another way.
   */
  retryInput?: (input: I, job: JobRow) => object | null
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobRow {
  id: number
  kind: string
  status: JobStatus
  priority: number
  input: unknown
  output: unknown
  error: string | null
  errorKind: JobErrorKind | null
  attempts: number
  folder: string | null
  /** Claude Code's cost estimate, over every attempt that reported one. */
  costUsd: number | null
  /** What the last run asked Claude Code for: --model (e.g. 'sonnet') and --effort (null: Claude Code's default). */
  askedModel: string | null
  askedEffort: string | null
  /** Which exact models answered and their tokens, over every attempt; null when Claude Code didn't say. */
  usage: RunUsage | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Set when the stored row can't be read (its input or output isn't JSON); such a job fails without running. */
  unreadable?: string
}

/** Persistence for jobs; the data layer implements it over SQLite. */
export interface JobStore {
  insert(kind: string, input: unknown, priority: number, folder: string | null): number
  get(id: number): JobRow | null
  /** The next queued job, highest priority first, leaving out `skip`. */
  next(skip?: readonly number[]): JobRow | null
  update(
    id: number,
    change: Partial<Pick<JobRow, 'status' | 'output' | 'error' | 'errorKind' | 'attempts' | 'costUsd' | 'askedModel' | 'askedEffort' | 'usage' | 'startedAt' | 'finishedAt'>>,
  ): void
  /** Running jobs left over from a crash go back to the queue. */
  requeueRunning(): void
  /** The queued jobs of one kind (not one running now), in the order they'd run. */
  queuedOf(kind: string): number[]
  /** Runs `fn` in one transaction, so a stored result and "done" land together or not at all. */
  atomically?<T>(fn: () => T): T
  /**
   * A 다시 시도 in this job's chain (back to the job it started from, and every
   * retry queued from there) that's waiting, running or done; one that failed
   * or was cancelled doesn't count.
   */
  liveRetryOf?(id: number): number | null
}

/** Two runs' usage as one: a retried job used both. */
export function mergeUsage(a: RunUsage | null, b: RunUsage | null | undefined): RunUsage | null {
  if (!b) return a
  if (!a) return b
  const models = { ...a.models }
  for (const [id, tokens] of Object.entries(b.models)) models[id] = Object.hasOwn(models, id) ? addTokens(models[id]!, tokens) : tokens
  return { model: mainModel(models) ?? b.model ?? a.model, models, total: addTokens(a.total, b.total) }
}

const addCost = (a: number | null, b: number | null | undefined): number | null => (b === null || b === undefined ? a : (a ?? 0) + b)

/** Tries for a job whose answer didn't fit, or whose own input is the problem. */
export const MAX_ATTEMPTS = 2
/** Tries for a job that timed out, met an unknown error or a broken Claude Code: maybe the job, maybe not. */
export const MAX_UNSURE_ATTEMPTS = 3
/** How long to wait after a usage limit when Claude doesn't say when it resets. */
export const DEFAULT_LIMIT_PAUSE_MS = 30 * 60 * 1000
/** The shortest pause after a usage limit. */
export const MIN_LIMIT_PAUSE_MS = 60 * 1000
/** Pauses after problems that should pass, growing with each one in a row: 1, 2, 5, 10, then 30 minutes. */
export const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000] as const
/** The input field a 다시 시도 adds: the failed job it retries. */
export const MANUAL_RETRY_OF = 'manualRetryOf'
/** Waits in a row on one job, with no answer for any job in between, before the jobs behind it go first. */
export const WAITS_BEFORE_ASIDE = 3

export const backoffMs = (failures: number): number => BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1]!

/**
 * What the queue does after each kind of failure:
 * - limit: pause until the reset; block: wait for a re-check (sign-in, a missing,
 *   outdated or blocked claude);
 * - wait: pause with backoff and run the same job again, its tries untouched
 *   (but see JobQueue's set-aside jobs: one job can't hold the rest forever);
 * - unsure: pause with backoff too, but count the try, failing the job after MAX_UNSURE_ATTEMPTS;
 * - retry: try again at once, failing the job after MAX_ATTEMPTS; fail: fail the job now.
 */
export type ErrorPolicy = 'limit' | 'block' | 'wait' | 'unsure' | 'retry' | 'fail'

export function errorPolicy(kind: JobErrorKind): ErrorPolicy {
  switch (kind) {
    case 'limit':
      return 'limit'
    case 'auth':
    case 'missing':
    case 'cli':
      return 'block'
    case 'offline':
    case 'overloaded':
      return 'wait'
    case 'timeout':
    case 'failed':
      return 'unsure'
    case 'invalid':
    case 'job':
      return 'retry'
    case 'model':
      return 'fail'
  }
}

/** More thinking takes longer: how much a job's timeout grows with its effort, and for the slower models. */
const EFFORT_TIME: Record<NonNullable<JobRequest['effort']>, number> = { low: 1, medium: 1, high: 1.5, xhigh: 2, max: 3 }
const SLOW_MODEL = /opus|fable/i
const SLOW_MODEL_TIME = 1.5
export const MAX_TIMEOUT_MS = 30 * 60_000

/** A run's timeout: the kind's own at Claude Code's default effort on Haiku or Sonnet, longer for more effort or a bigger model. */
export function timeoutFor(baseMs: number, effort: JobRequest['effort'] | undefined, model: string): number {
  const scale = (effort ? EFFORT_TIME[effort] : 1) * (SLOW_MODEL.test(model) ? SLOW_MODEL_TIME : 1)
  return Math.min(Math.round(baseMs * scale), Math.max(baseMs, MAX_TIMEOUT_MS))
}

/** A kind's `retryInput` that says never: the app does the job's work another way once it fails. */
export const RETRY_NEVER = (): null => null

/** Failures that prove Claude answered (so the network and Claude are up): the job's own answer or setting was the problem. */
const ANSWERED: ReadonlySet<JobErrorKind> = new Set<JobErrorKind>(['invalid', 'model', 'job'])

/** Why a failed job can't be queued again; the code is shown to the user as a refusal. */
export class RetryRefused extends Error {
  constructor(readonly code: 'job-not-found' | 'job-not-failed' | 'job-not-retryable' | 'job-input-gone' | 'job-retried' | 'job-not-wanted') {
    super(`retry refused: ${code}`)
  }
}

/** Why a job can't be cancelled (it's done, failed or cancelled already); shown to the user as a refusal. */
export class CancelRefused extends Error {
  constructor(readonly code: 'job-not-found' | 'job-not-waiting') {
    super(`cancel refused: ${code}`)
  }
}

/**
 * The error a job you cancelled carries (취소 in 최근 작업, 대기 중인 초안
 * 취소 in 제안함). Code that plays a turn whose job failed reads it, so a job
 * you cancelled counts as one that didn't answer (the AI draft).
 */
export const CANCELLED_BY_YOU = '사용자가 취소함'

export type { QueueState }

const idleState = (): QueueState => ({ running: null, pausedUntil: null, pauseReason: null, blocked: null, detail: null, failures: 0 })

export class JobQueue {
  private kinds = new Map<string, JobKind<any, any>>()
  private state: QueueState = idleState()
  private listeners = new Set<(s: QueueState, changedJob: number | null) => void>()
  private pump: Promise<void> | null = null
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private current: { job: JobRow; controller: AbortController } | null = null
  /** The running job when you cancelled it: its run is ended and whatever it answers is dropped. */
  private dropped: number | null = null
  /**
   * One job whose own run fails like a network problem (a long run the API
   * times out, say) would otherwise wait at the head of the queue forever.
   * `waits`: such failures in a row per job since Claude last answered any.
   * `aside`: jobs with WAITS_BEFORE_ASIDE of them; the others run first.
   * `suspect`: jobs set aside while another job got an answer, so the network
   * is fine: their next such failures count as tries. A job not set aside
   * meeting a network problem clears every suspicion (it may be real after all).
   */
  private waits = new Map<number, number>()
  private aside = new Set<number>()
  private suspect = new Set<number>()

  constructor(
    private readonly store: JobStore,
    private readonly adapter: AiAdapter,
    /** Where a job without its own folder runs (an empty scratch folder per job). */
    private readonly workdirFor: (job: JobRow) => string,
    private readonly now: () => number = Date.now,
  ) {
    store.requeueRunning()
  }

  register<I, O>(kind: JobKind<I, O>): this {
    this.kinds.set(kind.kind, kind as JobKind<any, any>)
    return this
  }

  onChange(listener: (s: QueueState, changedJob: number | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(): QueueState {
    return { ...this.state }
  }

  enqueue(kind: string, input: unknown, priority = 0, folder: string | null = null): number {
    if (this.stopped) throw new Error('the job queue is stopped')
    if (!this.kinds.has(kind)) throw new Error(`unknown job kind ${kind}`)
    const id = this.store.insert(kind, input, priority, folder)
    this.emit(id)
    this.kick()
    return id
  }

  /** Clears a sign-in/missing block (after the user fixes it) and starts again. */
  unblock(): void {
    this.state.blocked = null
    if (this.state.pausedUntil === null) this.state.detail = null
    this.emit(null)
    this.kick()
  }

  /**
   * 지금 다시 시도: ends a pause early and clears a block, then looks for work.
   * The backoff step stays, so failing again waits longer than before.
   */
  resume(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.state = { ...this.state, pausedUntil: null, pauseReason: null, blocked: null, detail: null }
    this.emit(null)
    void this.kick()
  }

  /** Whether a failed job of this kind can be queued again at all (its own row may still say no). */
  canRetry(kind: string): boolean {
    const k = this.kinds.get(kind)
    return k !== undefined && k.retryInput !== RETRY_NEVER
  }

  /**
   * 다시 시도 for a failed job: a new job of the same kind, priority and
   * folder, with the same input (as the kind's `retryInput` and `adjust`
   * leave it) marked with the job it retries. It goes through `stillWanted`
   * first, so a job whose moment has passed is refused instead of being
   * cancelled unrun. Throws RetryRefused.
   */
  retry(id: number, adjust: (input: Record<string, unknown>, job: JobRow) => Record<string, unknown> = (i) => i): number {
    if (this.stopped) throw new Error('the job queue is stopped')
    const job = this.store.get(id)
    if (!job) throw new RetryRefused('job-not-found')
    if (job.status !== 'failed') throw new RetryRefused('job-not-failed')
    const kind = this.kinds.get(job.kind)
    if (!kind || job.unreadable !== undefined) throw new RetryRefused('job-not-retryable')
    // Finished jobs that held lore drop their input after a few days.
    const stored = job.input
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored) || Object.keys(stored).length === 0) throw new RetryRefused('job-input-gone')
    if (this.store.liveRetryOf?.(id) != null) throw new RetryRefused('job-retried')
    const base = kind.retryInput ? (kind.retryInput(stored, job) as Record<string, unknown> | null) : (stored as Record<string, unknown>)
    if (base === null) throw new RetryRefused('job-not-retryable')
    const input = { ...adjust(base, job), [MANUAL_RETRY_OF]: id }
    // As the new row will be: queued just now (its age counts from the job it retries; see firstAsked).
    const fresh: JobRow = { ...job, status: 'queued', input, output: null, error: null, errorKind: null, attempts: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null }
    let wanted = true
    try {
      wanted = kind.stillWanted ? kind.stillWanted(input, this.firstAsked(fresh)) : true
    } catch {
      wanted = true
    }
    if (!wanted) throw new RetryRefused('job-not-wanted')
    return this.enqueue(job.kind, input, job.priority, job.folder)
  }

  /**
   * A job as `stillWanted` judges it: a 다시 시도 is as old as the job it
   * retries, back to the first one (a retry made a day later must not pass
   * an age check its moment has failed).
   */
  private firstAsked(job: JobRow): JobRow {
    const retried = (input: unknown) =>
      input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>)[MANUAL_RETRY_OF] : undefined
    let createdAt = job.createdAt
    let of = retried(job.input)
    for (let hops = 0; typeof of === 'number' && hops < 100; hops++) {
      const earlier = this.store.get(of)
      if (!earlier) break
      createdAt = earlier.createdAt
      of = retried(earlier.input)
    }
    return createdAt === job.createdAt ? job : { ...job, createdAt }
  }

  /**
   * 취소: a waiting job leaves the queue unrun. A running one has its Claude
   * Code run ended as stop() ends it, and whatever it answers is dropped.
   * Either way it's marked cancelled, as a job `stillWanted` turns away is:
   * never put back, no try counted, no pause. The change goes to the
   * listeners like any other, so work that waits on the job carries on as it
   * would after a failure (held words, the draft). Throws CancelRefused for a
   * job that's done, failed or cancelled already.
   */
  cancel(id: number): void {
    if (this.stopped) throw new Error('the job queue is stopped')
    const job = this.store.get(id)
    if (!job) throw new CancelRefused('job-not-found')
    if (job.status !== 'queued' && job.status !== 'running') throw new CancelRefused('job-not-waiting')
    this.store.update(id, { status: 'cancelled', error: CANCELLED_BY_YOU, finishedAt: new Date(this.now()).toISOString() })
    this.forget(id)
    const current = this.current
    if (current?.job.id === id) {
      this.dropped = id
      current.controller.abort()
    }
    this.emit(id)
  }

  /** Cancels every waiting job of one kind at once (not one running now; see cancel). Returns how many. */
  cancelWaiting(kind: string): number {
    if (this.stopped) throw new Error('the job queue is stopped')
    const ids = this.store.queuedOf(kind)
    if (ids.length === 0) return 0
    const finishedAt = new Date(this.now()).toISOString()
    const mark = () => {
      for (const id of ids) this.store.update(id, { status: 'cancelled', error: CANCELLED_BY_YOU, finishedAt })
    }
    if (this.store.atomically) this.store.atomically(mark)
    else mark()
    for (const id of ids) {
      this.forget(id)
      this.emit(id)
    }
    return ids.length
  }

  /**
   * Runs queued jobs until none are left (or the queue is paused). Resolves
   * when idle. A kick during a pass makes the pass look again before it ends;
   * the pass clears itself in the same step it finishes, so no kick is lost.
   */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.dirty = true
    if (!this.pump) {
      this.pump = (async () => {
        try {
          while (this.dirty && !this.stopped) {
            this.dirty = false
            await this.drain()
          }
        } catch (e) {
          // A store failure (e.g. the database closed underneath): stop this pass; the next kick tries again.
          console.error('[queue] pass failed', e)
        } finally {
          this.pump = null
        }
      })()
    }
    return this.pump
  }

  /**
   * Stops for good, before the league's database closes: the running job goes
   * back to the queue (its Claude run is ended, its result dropped), and
   * nothing touches the store afterwards.
   */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const current = this.current
    // One you cancelled stays cancelled, though its run is still ending.
    if (current && this.dropped !== current.job.id) {
      try {
        this.store.update(current.job.id, { status: 'queued', attempts: current.job.attempts })
      } catch {
        // The next open requeues it anyway (requeueRunning).
      }
      current.controller.abort()
    }
    this.listeners.clear()
  }

  dispose(): void {
    this.stop()
  }

  private emit(job: number | null) {
    for (const l of this.listeners) l(this.status(), job)
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped || this.state.blocked) return
      if (this.state.pausedUntil) {
        const wait = Date.parse(this.state.pausedUntil) - this.now()
        if (wait > 0) {
          this.schedule(wait)
          return
        }
        this.state = { ...this.state, pausedUntil: null, pauseReason: null, detail: null }
        this.emit(null)
      }
      const job = this.aside.size > 0 ? (this.store.next([...this.aside]) ?? this.nextAside()) : this.store.next()
      if (!job) return
      await this.runOne(job)
    }
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.kick()
    }, Math.min(ms, 2 ** 31 - 1))
  }

  /** Claude answered a job (whatever it said): the network and Claude are up. */
  private answered(jobId: number) {
    this.state.failures = 0
    for (const id of this.aside) if (id !== jobId) this.suspect.add(id)
    this.waits.clear()
  }

  /**
   * Jobs set aside go after every other waiting job, and take turns among
   * themselves, the one tried longest ago first (one that fails again goes
   * to the back), so none of them holds the others either.
   */
  private nextAside(): JobRow | null {
    for (const id of this.aside) {
      const job = this.store.get(id)
      if (job?.status === 'queued') return job
      // Cancelled or finished elsewhere.
      this.forget(id)
    }
    return null
  }

  /** A job that's done, failed or cancelled leaves the set-aside bookkeeping. */
  private forget(jobId: number) {
    this.waits.delete(jobId)
    this.aside.delete(jobId)
    this.suspect.delete(jobId)
  }

  /** A problem that should pass: wait a while (longer each time in a row), then try again. */
  private pauseFor(reason: JobErrorKind, detail: string) {
    const failures = this.state.failures + 1
    this.state = { ...this.state, failures, pausedUntil: new Date(this.now() + backoffMs(failures)).toISOString(), pauseReason: reason, detail }
  }

  private async runOne(job: JobRow): Promise<void> {
    const kind = this.kinds.get(job.kind)
    const stamp = () => new Date(this.now()).toISOString()
    // A row that can't be read, or of a kind no longer known, fails by itself; the jobs behind it still run.
    if (job.unreadable !== undefined || !kind) {
      const error = job.unreadable !== undefined ? `the stored job could not be read: ${job.unreadable}` : `unknown job kind ${job.kind}`
      this.store.update(job.id, { status: 'failed', error: error.slice(0, 2000), errorKind: 'job', finishedAt: stamp() })
      this.emit(job.id)
      return
    }
    let wanted = true
    try {
      wanted = kind.stillWanted ? kind.stillWanted(job.input, this.firstAsked(job)) : true
    } catch {
      wanted = true
    }
    if (!wanted) {
      this.store.update(job.id, { status: 'cancelled', error: 'no longer needed', finishedAt: stamp() })
      this.forget(job.id)
      this.emit(job.id)
      return
    }
    const attempts = job.attempts + 1
    this.store.update(job.id, { status: 'running', attempts, startedAt: stamp() })
    const controller = new AbortController()
    this.current = { job, controller }
    this.state.running = job.id
    this.emit(job.id)

    let result: Awaited<ReturnType<AiAdapter['run']>>
    let asked: Pick<JobRow, 'askedModel' | 'askedEffort'> | null = null
    try {
      const effort = typeof kind.effort === 'function' ? kind.effort(job.input) : kind.effort
      const model = typeof kind.model === 'function' ? kind.model(job.input) : kind.model
      const request: JobRequest = {
        systemPrompt: kind.systemPrompt(job.input),
        prompt: kind.prompt(job.input),
        stdin: kind.stdin(job.input),
        schema: z.toJSONSchema(kind.output, { target: 'draft-7' }) as object,
        model,
        kind: job.kind,
        input: job.input,
        ...(effort ? { effort } : {}),
        tools: kind.tools,
        workdir: job.folder ?? this.workdirFor(job),
        timeoutMs: timeoutFor(kind.timeoutMs ?? DEFAULT_TIMEOUT_MS, effort, model),
        signal: controller.signal,
      }
      asked = { askedModel: request.model || null, askedEffort: request.effort ?? null }
      result = await this.adapter.run(request)
    } catch (e) {
      // A bug in building the request (bad input, missing folder): the job can't run as it is.
      result = { ok: false, error: 'job', message: e instanceof Error ? e.message : String(e) }
    } finally {
      this.current = null
      this.state.running = null
    }
    // Stopped while running: stop() already put the job back.
    if (this.stopped) return

    // What this run asked for and used, kept whatever the outcome (a retry adds to the first try).
    const spent = { ...asked, costUsd: addCost(job.costUsd, result.costUsd), usage: mergeUsage(job.usage, result.usage) }

    // Cancelled while running: cancel() already marked it. Its answer (or the failure its ending caused) is dropped:
    // nothing is stored, nothing counts against the queue; only what the run used is kept on the row.
    if (this.dropped === job.id) {
      this.dropped = null
      this.store.update(job.id, spent)
      return
    }

    if (result.ok) {
      // Claude answered, so whatever paused the queue before has passed.
      this.answered(job.id)
      const parsed = kind.output.safeParse(result.data)
      let acceptError: string | null = null
      if (parsed.success) {
        // The stored result and "done" land together: a crash in between can't make Claude run again.
        const finish = () => {
          kind.accept?.(parsed.data, job)
          this.store.update(job.id, { status: 'done', output: parsed.data, error: null, errorKind: null, ...spent, finishedAt: stamp() })
        }
        try {
          if (this.store.atomically) this.store.atomically(finish)
          else finish()
        } catch (e) {
          acceptError = e instanceof Error ? e.message : String(e)
        }
      }
      if (parsed.success && acceptError !== null) {
        this.store.update(job.id, { status: 'failed', error: `could not save the result: ${acceptError}`.slice(0, 2000), errorKind: 'job', ...spent, finishedAt: stamp() })
      } else if (parsed.success) {
        // Stored and marked done above.
      } else if (attempts < MAX_ATTEMPTS) {
        this.store.update(job.id, { status: 'queued', error: 'output did not match the schema; retrying', errorKind: 'invalid', ...spent })
      } else {
        this.store.update(job.id, { status: 'failed', error: parsed.error.message.slice(0, 2000), errorKind: 'invalid', ...spent, finishedAt: stamp() })
      }
      if (parsed.success || attempts >= MAX_ATTEMPTS) this.forget(job.id)
      this.emit(job.id)
      return
    }

    const message = result.message.slice(0, 2000)
    // Claude answered, only not with something this job can use: the backoff starts again from a minute.
    if (ANSWERED.has(result.error)) this.answered(job.id)
    const failed = () => {
      this.store.update(job.id, { status: 'failed', error: message, errorKind: result.error, ...spent, finishedAt: stamp() })
      this.forget(job.id)
    }
    // Waiting for another try: the job's tries count, unless it's not the job's fault at all.
    const requeue = (spend: boolean) =>
      this.store.update(job.id, { status: 'queued', ...(spend ? {} : { attempts: job.attempts }), error: message, errorKind: result.error, ...spent })
    switch (errorPolicy(result.error)) {
      case 'limit': {
        // Not the job's fault: put it back and wait for the reset.
        requeue(false)
        // At least a minute, even if the reset time given is already past (or wrong).
        const until = result.retryAt ? Date.parse(result.retryAt) : this.now() + DEFAULT_LIMIT_PAUSE_MS
        const pausedUntil = new Date(Math.max(Number.isNaN(until) ? 0 : until, this.now() + MIN_LIMIT_PAUSE_MS)).toISOString()
        this.state = { ...this.state, pausedUntil, pauseReason: 'limit', detail: message }
        break
      }
      case 'block':
        requeue(false)
        this.state = { ...this.state, blocked: result.error, detail: message }
        break
      case 'wait':
        if (this.suspect.has(job.id)) {
          // Other jobs got answers while this one waited behind them: it's this job's own failure, so it counts.
          if (attempts >= MAX_UNSURE_ATTEMPTS) failed()
          else requeue(true)
        } else {
          requeue(false)
          const wasAside = this.aside.delete(job.id)
          if (!wasAside) this.suspect.clear()
          const waits = (this.waits.get(job.id) ?? 0) + 1
          this.waits.set(job.id, waits)
          // Set aside, or to the back of those set aside.
          if (wasAside || waits >= WAITS_BEFORE_ASIDE) this.aside.add(job.id)
        }
        this.pauseFor(result.error, message)
        break
      case 'unsure':
        // Paused either way: if it isn't the job, the next one would only meet the same problem.
        if (attempts >= MAX_UNSURE_ATTEMPTS) failed()
        else requeue(true)
        this.pauseFor(result.error, message)
        break
      case 'retry':
        if (attempts < MAX_ATTEMPTS) requeue(true)
        else failed()
        break
      case 'fail':
        failed()
    }
    this.emit(job.id)
  }
}
