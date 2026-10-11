import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeCliAdapter, ReplayAdapter, type AiAdapter, type JobResult } from '@ai/adapter'
import { billsPerUse, checkClaude, findClaude, usesSubscription } from '@ai/checks'
import { JobQueue, RetryRefused, type JobKind, type JobRow } from '@ai/queue'
import { AI_JOB_OF_KIND, type AiStatus, type ClaudeStatus } from '@shared/ai'
import { aiFor } from '@shared/config/schema'
import { slugKey } from '@shared/league'
import { sqliteJobStore } from '@data/jobs'
import type { Db } from '@data/db'
import { loadConfig } from '@data/league'
import { refuse } from '@data/rules'
import { readBoxScoreJob } from '@ingest/boxscore'

/** In demo mode the stand-in answers with the file the service left in the job folder. */
export const FAKE_OUTPUT_FILE = 'fake-output.json'
/** @deprecated the game-day name for FAKE_OUTPUT_FILE */
export const FAKE_READ_FILE = FAKE_OUTPUT_FILE

/** A demo answer for a job kind, or null when the kind has none. */
export type DemoWriter = (kind: string, input: unknown) => unknown

function fakeAdapter(demos: DemoWriter[]): AiAdapter {
  return new ReplayAdapter((req): JobResult => {
    const file = join(req.workdir, FAKE_OUTPUT_FILE)
    if (existsSync(file)) return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) as unknown, costUsd: 0, durationMs: 1, raw: '' }
    for (const demo of demos) {
      const data = req.kind ? demo(req.kind, req.input) : null
      if (data !== null && data !== undefined) return { ok: true, data, costUsd: 0, durationMs: 1, raw: '' }
    }
    // This job's own problem: the queue fails it and goes on.
    return { ok: false, error: 'job', message: `demo mode: no ${FAKE_OUTPUT_FILE} in the job folder and no demo for ${req.kind ?? 'this job'}` }
  })
}

/** Job kinds that need the league's database (to store their results), built per open league. */
/** `slug`: the league's name, for kinds whose results call for more work in its queue. */
export type KindFactory = (db: Db, leagueFolder: string, slug: string) => JobKind<any, any>[]

/**
 * Claude Code on this PC, and one job queue per open league. Checks run at
 * start and on demand; jobs never run while sign-in is missing or would bill
 * per use. A league's queue lives exactly as long as its open database.
 */
export class AiService {
  readonly fake = process.env.TWOK_FAKE_AI === '1'
  /** TWOK_NO_AI=1: behave as if Claude Code weren't installed (tests that must never spend a real subscription). */
  readonly off = process.env.TWOK_NO_AI === '1' && process.env.TWOK_FAKE_AI !== '1'
  private status: ClaudeStatus = { installed: false, command: null, version: null, loggedIn: false, authMethod: null }
  /** Every CLI adapter made so far; a re-check never cuts off runs in progress, closing ends them all. */
  private clis: ClaudeCliAdapter[] = []
  private demos: DemoWriter[] = []
  private adapter: AiAdapter | null = this.fake ? fakeAdapter(this.demos) : null
  private queues = new Map<string, { db: Db; queue: JobQueue }>()
  private checking: Promise<AiStatus> | null = null
  private followUp: Promise<AiStatus> | null = null
  private checked = false
  private factories: KindFactory[] = []
  private jobListeners: ((slug: string, db: Db, folder: string, jobId: number) => void)[] = []
  private stateListeners: ((slug: string) => void)[] = []

  /** Called whenever a job in any league's queue changes (queued, started, finished), for follow-up work. */
  onJobChange(listener: (slug: string, db: Db, folder: string, jobId: number) => void): void {
    this.jobListeners.push(listener)
  }

  /** Called when a league's queue pauses, resumes, or is blocked or unblocked (not for every job it runs). */
  onQueueState(listener: (slug: string) => void): void {
    this.stateListeners.push(listener)
  }

  /** Registers job kinds for league queues made from now on, and a demo writer for them (TWOK_FAKE_AI=1). */
  addKinds(factory: KindFactory, demo?: DemoWriter): void {
    this.factories.push(factory)
    if (demo) this.demos.push(demo)
  }

  /**
   * Looks for Claude Code again. While a check is running, one more follows
   * it (you may have just signed in), shared by everyone who asks meanwhile.
   * Every queue gets another go afterwards.
   */
  refresh(): Promise<AiStatus> {
    if (!this.checking) {
      this.checking = this.check().finally(() => {
        this.checking = null
      })
      return this.checking
    }
    if (!this.followUp) {
      this.followUp = this.checking
        .catch(() => undefined)
        .then(() => {
          this.followUp = null
          return this.refresh()
        })
    }
    return this.followUp
  }

  private async check(): Promise<AiStatus> {
    if (this.fake) {
      this.status = { installed: true, command: 'demo', version: 'demo', loggedIn: true, authMethod: 'claude.ai' }
    } else if (this.off) {
      this.status = { installed: false, command: null, version: null, loggedIn: false, authMethod: null }
      this.adapter = null
    } else {
      const { status, launch } = await checkClaude(await findClaude())
      this.status = status
      const cli = launch ? new ClaudeCliAdapter(launch) : null
      if (cli) this.clis.push(cli)
      this.adapter = cli
    }
    this.checked = true
    // Unblock even if still not ready: the next job finds out again, cheaply, without calling Claude.
    for (const { queue } of this.queues.values()) queue.unblock()
    return this.view()
  }

  /** A finished check found Claude Code unusable (not installed, not signed in, or not the subscription). */
  unavailable(): boolean {
    return !this.fake && this.checked && !this.ready()
  }

  ready(): boolean {
    return this.status.installed && this.status.loggedIn && usesSubscription(this.status) && this.adapter !== null
  }

  /** The status, after any check in progress (so the first screen never sees "not installed" too early). */
  async settledView(slug?: string): Promise<AiStatus> {
    if (this.checking) await this.checking.catch(() => undefined)
    return this.view(slug)
  }

  view(slug?: string): AiStatus {
    const entry = slug ? this.queues.get(slugKey(slug)) : undefined
    return { claude: this.status, fake: this.fake, billing: billsPerUse(this.status), queue: entry ? entry.queue.status() : null }
  }

  /** The league's queue, created on first use (or when the league opens). */
  queueFor(slug: string, db: Db, leagueFolder: string): JobQueue {
    const key = slugKey(slug)
    const existing = this.queues.get(key)
    if (existing && existing.db === db) return existing.queue
    existing?.queue.stop()
    const scratch = join(leagueFolder, 'jobs')
    const queue = new JobQueue(
      sqliteJobStore(db),
      { run: (req) => (this.ready() && this.adapter ? this.adapter.run(req) : Promise.resolve(this.notReady())) },
      (job) => {
        const dir = join(scratch, String(job.id))
        mkdirSync(dir, { recursive: true })
        return dir
      },
    ).register(readBoxScoreJob)
    for (const factory of this.factories) for (const kind of factory(db, leagueFolder, slug)) queue.register(kind)
    // A pause or block starting or ending is news for every screen (the queue banner).
    let shown = JSON.stringify([null, null, null])
    queue.onChange((state) => {
      const now = JSON.stringify([state.pausedUntil, state.pauseReason, state.blocked])
      if (now === shown) return
      shown = now
      for (const l of this.stateListeners) {
        try {
          l(slug)
        } catch (e) {
          console.warn('[ai] a queue listener failed', e)
        }
      }
    })
    queue.onChange((_state, jobId) => {
      if (jobId === null) return
      for (const l of this.jobListeners) {
        try {
          l(slug, db, leagueFolder, jobId)
        } catch (e) {
          console.warn('[ai] a job listener failed', e)
        }
      }
    })
    this.queues.set(key, { db, queue })
    // Jobs left from an earlier session carry on.
    void queue.kick()
    return queue
  }

  /**
   * 지금 다시 시도 for a league's queue: a block (sign-in, a missing claude)
   * gets a fresh check first; a pause ends now. Returns the status after.
   */
  async resume(slug: string, db: Db, leagueFolder: string): Promise<AiStatus> {
    const queue = this.queueFor(slug, db, leagueFolder)
    if (queue.status().blocked) await this.refresh()
    queue.resume()
    return this.view(slug)
  }

  /**
   * 다시 시도 for a failed job: the same job again (see JobQueue.retry), on
   * the model and effort its AI 모델 row has now, since a stronger choice may
   * be why you're trying again (as 경기일's reread does).
   */
  retry(slug: string, db: Db, leagueFolder: string, jobId: number): { jobId: number } {
    const queue = this.queueFor(slug, db, leagueFolder)
    const adjust = (input: Record<string, unknown>, job: JobRow) => {
      const row = Object.hasOwn(AI_JOB_OF_KIND, job.kind) ? AI_JOB_OF_KIND[job.kind]! : null
      if (!row || typeof input.model !== 'string') return input
      const { model: _model, effort: _effort, ...rest } = input
      return { ...rest, ...aiFor(loadConfig(db).config, row) }
    }
    try {
      return { jobId: queue.retry(jobId, adjust) }
    } catch (e) {
      if (e instanceof RetryRefused) refuse(e.code)
      throw e
    }
  }

  /**
   * Whether 다시 시도 can queue a failed job of this kind again (for the 최근
   * 작업 list). Only asks the league's queue when it's running, so listing
   * never starts one; without it every kind may try (retry still checks).
   */
  retryable(slug: string): (kind: string) => boolean {
    const entry = this.queues.get(slugKey(slug))
    return (kind) => (entry ? entry.queue.canRetry(kind) : true)
  }

  /** Before a league's database closes: its queue stops, and a running job goes back to waiting. */
  closeQueue(slug: string): void {
    const entry = this.queues.get(slugKey(slug))
    if (!entry) return
    entry.queue.stop()
    this.queues.delete(slugKey(slug))
  }

  private notReady(): JobResult {
    if (!this.status.installed || !this.adapter) return { ok: false, error: 'missing', message: 'claude is not installed' }
    if (!this.status.loggedIn) return { ok: false, error: 'auth', message: 'claude is not signed in' }
    return { ok: false, error: 'auth', message: `claude is signed in with ${this.status.authMethod ?? 'an unknown method'}, not the subscription` }
  }

  closeAll(): void {
    for (const { queue } of this.queues.values()) queue.stop()
    this.queues.clear()
    for (const cli of this.clis) cli.abortAll()
  }
}
