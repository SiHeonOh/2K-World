import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AI_ERROR_KINDS, type RunUsage } from '@shared/ai'
import { openDb } from '@data/db'
import { recentJobs, sqliteJobStore } from '@data/jobs'
import { DEFAULT_TIMEOUT_MS, ReplayAdapter, type JobResult } from './adapter'
import {
  backoffMs,
  CANCELLED_BY_YOU,
  CancelRefused,
  DEFAULT_LIMIT_PAUSE_MS,
  errorPolicy,
  JobQueue,
  MAX_TIMEOUT_MS,
  mergeUsage,
  RETRY_NEVER,
  RetryRefused,
  timeoutFor,
  type JobKind,
} from './queue'

const echo: JobKind<{ n: number }, { doubled: number }> = {
  kind: 'echo',
  model: 'haiku',
  tools: [],
  output: z.object({ doubled: z.number() }),
  systemPrompt: () => 'system',
  prompt: (i) => `double ${i.n}`,
  stdin: (i) => JSON.stringify(i),
}

function setup(answers: (JobResult | ((n: number) => JobResult))[], now = () => Date.parse('2026-10-10T00:00:00Z')) {
  const db = openDb(':memory:')
  const store = sqliteJobStore(db)
  let call = 0
  const adapter = new ReplayAdapter(() => {
    const a = answers[Math.min(call, answers.length - 1)]!
    call++
    return typeof a === 'function' ? a(call) : a
  })
  const queue = new JobQueue(store, adapter, () => 'C:/tmp', now).register(echo)
  return { db, store, adapter, queue }
}

const ok = (data: unknown): JobResult => ({ ok: true, data, costUsd: 0.01, durationMs: 10, raw: '' })

describe('JobQueue', () => {
  it('runs a job and stores checked output', async () => {
    const { queue, store, adapter } = setup([ok({ doubled: 4 })])
    const id = queue.enqueue('echo', { n: 2 })
    await queue.kick()
    expect(store.get(id)).toMatchObject({ status: 'done', output: { doubled: 4 }, attempts: 1, costUsd: 0.01 })
    expect(adapter.calls[0]).toMatchObject({ prompt: 'double 2', stdin: '{"n":2}', model: 'haiku', tools: [] })
    // The schema goes to Claude as JSON Schema.
    expect(adapter.calls[0]!.schema).toMatchObject({ type: 'object', properties: { doubled: { type: 'number' } } })
  })

  it('retries once when the output does not match, then fails', async () => {
    const { queue, store } = setup([ok({ wrong: true }), ok({ wrong: true })])
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(store.get(id)).toMatchObject({ status: 'failed', errorKind: 'invalid', attempts: 2 })
  })

  it('recovers on the retry', async () => {
    const { queue, store } = setup([ok({ wrong: true }), ok({ doubled: 2 })])
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(store.get(id)).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('pauses on a usage limit until the reset, without spending an attempt', async () => {
    let t = Date.parse('2026-10-10T00:00:00Z')
    const { queue, store } = setup(
      [{ ok: false, error: 'limit', message: 'limit', retryAt: '2026-10-10T01:00:00.000Z' }, ok({ doubled: 2 })],
      () => t,
    )
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0, errorKind: 'limit' })
    expect(queue.status()).toMatchObject({ pausedUntil: '2026-10-10T01:00:00.000Z', pauseReason: 'limit', detail: 'limit', failures: 0 })
    await queue.kick()
    expect(store.get(id)!.status).toBe('queued')
    t = Date.parse('2026-10-10T01:00:01Z')
    await queue.kick()
    expect(store.get(id)!.status).toBe('done')
    queue.dispose()
  })

  it('waits a default time when the limit gives no reset time', async () => {
    const t0 = Date.parse('2026-10-10T00:00:00Z')
    const { queue } = setup([{ ok: false, error: 'limit', message: 'rate limit' }], () => t0)
    queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(Date.parse(queue.status().pausedUntil!) - t0).toBe(DEFAULT_LIMIT_PAUSE_MS)
    queue.dispose()
  })

  it('blocks on sign-in problems until unblocked', async () => {
    const { queue, store } = setup([{ ok: false, error: 'auth', message: 'Not logged in' }, ok({ doubled: 2 })])
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(queue.status()).toMatchObject({ blocked: 'auth', detail: 'Not logged in' })
    expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 })
    queue.unblock()
    await queue.kick()
    expect(store.get(id)!.status).toBe('done')
  })

  it('runs higher priority first and requeues jobs left running by a crash', async () => {
    const { db, store, queue } = setup([(n) => ok({ doubled: n })])
    // Insert both before the queue looks, so priority decides the order.
    const low = store.insert('echo', { n: 1 }, 0, null)
    const high = store.insert('echo', { n: 2 }, 10, null)
    await queue.kick()
    expect((store.get(high)!.output as { doubled: number }).doubled).toBeLessThan((store.get(low)!.output as { doubled: number }).doubled)
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(low)
    new JobQueue(store, new ReplayAdapter(() => ok({ doubled: 0 })), () => '')
    expect(store.get(low)!.status).toBe('queued')
  })
})

describe('JobQueue: models and tokens', () => {
  const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })
  const sonnet = (output: number): RunUsage => ({ model: 'claude-sonnet-4-6', models: { 'claude-sonnet-4-6': tokens(10, output, 500, 50) }, total: tokens(10, output, 500, 50) })
  const picky: JobKind<{ n: number; model: string; effort?: 'high' }, { doubled: number }> = { ...echo, kind: 'picky', model: (i) => i.model, effort: (i) => i.effort }

  it('stores what it asked for, the exact model that answered and its tokens', async () => {
    const { queue, store } = setup([{ ...ok({ doubled: 2 }), usage: sonnet(80) }, ok({ doubled: 4 })])
    queue.register(picky)
    const a = queue.enqueue('picky', { n: 1, model: 'sonnet', effort: 'high' })
    const b = queue.enqueue('picky', { n: 2, model: 'haiku' })
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'done', askedModel: 'sonnet', askedEffort: 'high', costUsd: 0.01, usage: sonnet(80) })
    // Claude Code said nothing about tokens: still done, usage unknown.
    expect(store.get(b)).toMatchObject({ status: 'done', askedModel: 'haiku', askedEffort: null, costUsd: 0.01, usage: null })
  })

  it('adds up a retried job: both tries used tokens', async () => {
    const haiku: RunUsage = { model: 'claude-haiku-4-5', models: { 'claude-haiku-4-5': tokens(300, 5) }, total: tokens(300, 5) }
    const { queue, store } = setup([
      { ...ok({ wrong: true }), usage: sonnet(40) },
      { ...ok({ doubled: 2 }), costUsd: 0.02, usage: { model: 'claude-sonnet-4-6', models: { ...sonnet(60).models, ...haiku.models }, total: tokens(310, 65, 500, 50) } },
    ])
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    const job = store.get(id)!
    expect(job).toMatchObject({ status: 'done', attempts: 2, askedModel: 'haiku' })
    expect(job.costUsd).toBeCloseTo(0.03)
    expect(job.usage).toEqual({
      model: 'claude-sonnet-4-6',
      models: { 'claude-sonnet-4-6': tokens(20, 100, 1000, 100), 'claude-haiku-4-5': tokens(300, 5) },
      total: tokens(320, 105, 1000, 100),
    })
  })

  it('a failed job keeps what was spent when the result says, and nothing when it does not', async () => {
    const { queue, store } = setup([
      { ok: false, error: 'job', message: 'stopped', costUsd: 0.004, usage: sonnet(7) },
      { ok: false, error: 'job', message: 'crashed' },
    ])
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    // Failing works as before; what the first try spent stays.
    expect(store.get(id)).toMatchObject({ status: 'failed', error: 'crashed', errorKind: 'job', attempts: 2, costUsd: 0.004, usage: sonnet(7) })
    const again = setup([{ ok: false, error: 'model', message: 'no such model' }])
    const other = again.queue.enqueue('echo', { n: 1 })
    await again.queue.kick()
    expect(again.store.get(other)).toMatchObject({ status: 'failed', costUsd: null, usage: null, askedModel: 'haiku' })
  })

  it('an unreadable stored record reads as unknown', async () => {
    const { db, store } = setup([])
    const id = store.insert('echo', { n: 1 }, 0, null)
    db.prepare("UPDATE jobs SET model = 'claude-x', tokens = '{oops' WHERE id = ?").run(id)
    expect(store.get(id)!.usage).toBeNull()
    store.update(id, { usage: sonnet(3) })
    expect(db.prepare('SELECT model FROM jobs WHERE id = ?').get(id)).toEqual({ model: 'claude-sonnet-4-6' })
    store.update(id, { usage: null })
    expect(db.prepare('SELECT model, tokens FROM jobs WHERE id = ?').get(id)).toEqual({ model: null, tokens: null })
  })
})

describe('mergeUsage', () => {
  it("adds two runs' tokens per model; an inherited name like constructor is just a model", () => {
    const t = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
    const a: RunUsage = { model: 'constructor', models: { constructor: t(1, 2) }, total: t(1, 2) }
    const b: RunUsage = { model: 'toString', models: { toString: t(3, 4), constructor: t(5, 6) }, total: t(8, 10) }
    expect(mergeUsage(a, b)).toEqual({ model: 'constructor', models: { constructor: t(6, 8), toString: t(3, 4) }, total: t(9, 12) })
  })
})

describe('JobQueue timing', () => {
  it('runs a job enqueued while an empty pass is finishing', async () => {
    const { queue, store } = setup([ok({ doubled: 2 })])
    void queue.kick()
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(store.get(id)!.status).toBe('done')
  })

  it('stop() puts the running job back, ends the run and drops its result', async () => {
    const db = openDb(':memory:')
    const store = sqliteJobStore(db)
    let release: (r: JobResult) => void = () => {}
    let aborted = false
    const adapter = new ReplayAdapter(
      (req) =>
        new Promise<JobResult>((resolve) => {
          release = resolve
          req.signal?.addEventListener('abort', () => {
            aborted = true
            resolve({ ok: false, error: 'failed', message: 'aborted' })
          })
        }),
    )
    const queue = new JobQueue(store, adapter, () => 'C:/tmp').register(echo)
    const id = queue.enqueue('echo', { n: 1 })
    const pass = queue.kick()
    await Promise.resolve()
    expect(store.get(id)!.status).toBe('running')
    queue.stop()
    expect(aborted).toBe(true)
    release(ok({ doubled: 2 }))
    await pass
    expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(() => queue.enqueue('echo', { n: 2 })).toThrow(/stopped/)
  })

  it('survives a request that throws and a closed store', async () => {
    const bad: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'bad', stdin: () => { throw new Error('no context') } }
    const { queue, store, db } = setup([ok({ doubled: 2 })])
    queue.register(bad)
    const id = queue.enqueue('bad', { n: 1 })
    await queue.kick()
    // The job's own problem: one retry in the same pass, then it fails for good (the queue doesn't pause).
    expect(store.get(id)).toMatchObject({ status: 'failed', error: 'no context', errorKind: 'job', attempts: 2 })
    expect(queue.status().pausedUntil).toBeNull()
    expect(queue.status().running).toBeNull()
    queue.enqueue('echo', { n: 1 })
    db.close()
    // The pass fails quietly instead of an unhandled rejection.
    await expect(queue.kick()).resolves.toBeUndefined()
  })

  it('stores results through accept, and fails the job when accept throws', async () => {
    const saved: number[] = []
    const keep: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'keep', accept: (o) => void saved.push(o.doubled) }
    const refuse: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'refuse', accept: () => { throw new Error('full') } }
    const { queue, store } = setup([ok({ doubled: 6 })])
    queue.register(keep).register(refuse)
    const a = queue.enqueue('keep', { n: 3 })
    const b = queue.enqueue('refuse', { n: 3 })
    await queue.kick()
    expect(saved).toEqual([6])
    expect(store.get(a)!.status).toBe('done')
    expect(store.get(b)).toMatchObject({ status: 'failed', errorKind: 'job', error: expect.stringContaining('full') })
  })
})

describe('JobQueue: problems that should pass never burn the backlog', () => {
  const T0 = Date.parse('2026-10-10T00:00:00Z')
  const clock = () => {
    let t = T0
    return { now: () => t, advance: (ms: number) => void (t += ms) }
  }
  const offline: JobResult = { ok: false, error: 'offline', message: 'API Error: Connection error.' }

  it('sorts every kind of failure into what the queue does', () => {
    expect(Object.fromEntries(AI_ERROR_KINDS.map((k) => [k, errorPolicy(k)]))).toEqual({
      limit: 'limit',
      auth: 'block',
      missing: 'block',
      cli: 'block',
      offline: 'wait',
      overloaded: 'wait',
      timeout: 'unsure',
      failed: 'unsure',
      invalid: 'retry',
      job: 'retry',
      model: 'fail',
    })
    expect([0, 1, 2, 3, 4, 5, 6, 99].map(backoffMs)).toEqual([60_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 1_800_000, 1_800_000])
  })

  it('offline: the same job waits with its tries untouched, the queue pauses a minute, and nothing behind it runs', async () => {
    const c = clock()
    const { queue, store, adapter } = setup([offline, ok({ doubled: 2 }), ok({ doubled: 4 })], c.now)
    const changes: (string | null)[] = []
    queue.onChange((s) => changes.push(s.pauseReason))
    const a = queue.enqueue('echo', { n: 1 })
    const b = queue.enqueue('echo', { n: 2 })
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 0, errorKind: 'offline', error: 'API Error: Connection error.' })
    expect(store.get(b)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(queue.status()).toMatchObject({ pausedUntil: new Date(T0 + 60_000).toISOString(), pauseReason: 'offline', detail: 'API Error: Connection error.', failures: 1, blocked: null })
    expect(changes).toContain('offline')
    expect(adapter.calls).toHaveLength(1)
    // Still paused a moment before the minute is up.
    c.advance(59_000)
    await queue.kick()
    expect(adapter.calls).toHaveLength(1)
    c.advance(1_000)
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'done', attempts: 1, errorKind: null })
    expect(store.get(b)!.status).toBe('done')
    // A job got through: the next problem starts again from a minute.
    expect(queue.status()).toMatchObject({ pausedUntil: null, pauseReason: null, detail: null, failures: 0 })
    queue.dispose()
  })

  it('waits longer each time in a row: 1, 2, 5, 10, then 30 minutes', async () => {
    const c = clock()
    const { queue, store } = setup([{ ok: false, error: 'overloaded', message: 'API Error: 529 Overloaded' }], c.now)
    const id = queue.enqueue('echo', { n: 1 })
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      await queue.kick()
      const until = Date.parse(queue.status().pausedUntil!)
      waits.push((until - c.now()) / 60_000)
      c.advance(until - c.now())
    }
    expect(waits).toEqual([1, 2, 5, 10, 30, 30])
    expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0, errorKind: 'overloaded' })
    queue.dispose()
  })

  it('a long outage leaves every waiting job waiting', async () => {
    const c = clock()
    const { queue, store } = setup([offline], c.now)
    const ids = [1, 2, 3, 4, 5].map((n) => queue.enqueue('echo', { n }))
    for (let i = 0; i < 20; i++) {
      await queue.kick()
      c.advance(30 * 60_000)
    }
    expect(ids.map((id) => store.get(id)!.status)).toEqual(['queued', 'queued', 'queued', 'queued', 'queued'])
    expect(ids.map((id) => store.get(id)!.attempts)).toEqual([0, 0, 0, 0, 0])
    queue.dispose()
  })

  it('an unknown error or a timeout counts as a try: the job fails after three, each after a pause, and the next one still waits its turn', async () => {
    const c = clock()
    const { queue, store, adapter } = setup(
      [
        { ok: false, error: 'failed', message: 'something odd' },
        { ok: false, error: 'timeout', message: 'timed out after 300000 ms' },
        { ok: false, error: 'failed', message: 'still odd' },
        ok({ doubled: 4 }),
      ],
      c.now,
    )
    const a = queue.enqueue('echo', { n: 1 })
    const b = queue.enqueue('echo', { n: 2 })
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 1, errorKind: 'failed' })
    c.advance(60_000)
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 2, errorKind: 'timeout' })
    expect(queue.status().pauseReason).toBe('timeout')
    c.advance(120_000)
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'failed', attempts: 3, errorKind: 'failed', error: 'still odd' })
    // Paused even so: if it wasn't the job, the next one would only meet the same problem.
    expect(store.get(b)!.status).toBe('queued')
    expect(queue.status()).toMatchObject({ pauseReason: 'failed', failures: 3 })
    expect(adapter.calls).toHaveLength(3)
    c.advance(300_000)
    await queue.kick()
    expect(store.get(b)!.status).toBe('done')
    queue.dispose()
  })

  it("a model that can't be used fails just that job, at once, and the queue goes on", async () => {
    const { queue, store } = setup([{ ok: false, error: 'model', message: "There's an issue with the selected model (fable)." }, ok({ doubled: 4 })])
    const a = queue.enqueue('echo', { n: 1 })
    const b = queue.enqueue('echo', { n: 2 })
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'failed', attempts: 1, errorKind: 'model' })
    expect(store.get(b)!.status).toBe('done')
    expect(queue.status().pausedUntil).toBeNull()
  })

  it('지금 다시 시도 ends a pause at once; the backoff step stays, so failing again waits longer', async () => {
    const c = clock()
    const { queue, store } = setup([offline, offline, ok({ doubled: 2 })], c.now)
    const id = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(queue.status()).toMatchObject({ failures: 1, pauseReason: 'offline' })
    queue.resume()
    await queue.kick()
    expect(queue.status()).toMatchObject({ failures: 2, pausedUntil: new Date(T0 + 120_000).toISOString() })
    queue.resume()
    await queue.kick()
    expect(store.get(id)!.status).toBe('done')
    expect(queue.status()).toMatchObject({ failures: 0, pausedUntil: null, pauseReason: null })
    queue.dispose()
  })

  it('an outdated or blocked Claude Code blocks the queue until a re-check, and spends no tries', async () => {
    const { queue, store, adapter } = setup([
      { ok: false, error: 'cli', message: "error: unknown option '--safe-mode'" },
      { ok: false, error: 'cli', message: 'spawn EPERM' },
      ok({ doubled: 2 }),
    ])
    const a = queue.enqueue('echo', { n: 1 })
    const b = queue.enqueue('echo', { n: 2 })
    await queue.kick()
    expect(queue.status()).toMatchObject({ blocked: 'cli', pausedUntil: null, detail: "error: unknown option '--safe-mode'" })
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 0, errorKind: 'cli' })
    // Nothing else runs meanwhile.
    await queue.kick()
    expect(adapter.calls).toHaveLength(1)
    queue.unblock()
    await queue.kick()
    expect(queue.status()).toMatchObject({ blocked: 'cli', detail: 'spawn EPERM' })
    queue.unblock()
    await queue.kick()
    expect(store.get(a)).toMatchObject({ status: 'done', attempts: 1 })
    expect(store.get(b)!.status).toBe('done')
  })

  it('an answer that was no use still shows Claude is up: the backoff starts again from a minute', async () => {
    for (const kind of ['invalid', 'model', 'job'] as const) {
      const c = clock()
      const { queue } = setup([offline, offline, { ok: false, error: kind, message: 'no use' }, offline], c.now)
      queue.enqueue('echo', { n: 1 })
      queue.enqueue('echo', { n: 2 })
      await queue.kick()
      c.advance(60_000)
      await queue.kick()
      expect(queue.status().failures).toBe(2)
      c.advance(120_000)
      await queue.kick()
      // The 'no use' answer reset the step; the next outage waits a minute, not five.
      expect(queue.status()).toMatchObject({ failures: 1, pausedUntil: new Date(c.now() + 60_000).toISOString() })
      queue.dispose()
    }
  })

  /** Job n = 1 fails as if offline whatever happens (a long run the API times out); every other job is fine unless `down`. */
  const stuck = (c: ReturnType<typeof clock>, isDown: () => boolean = () => false) => {
    const timedOut: JobResult = { ok: false, error: 'offline', message: 'API Error (Request timed out.)' }
    const db = openDb(':memory:')
    const store = sqliteJobStore(db)
    const adapter = new ReplayAdapter((req) => ((req.input as { n: number }).n === 1 || isDown() ? timedOut : ok({ doubled: 2 })))
    const queue = new JobQueue(store, adapter, () => 'C:/tmp', c.now).register(echo)
    /** As the timer would, once each pause is over. */
    const rounds = async (n: number) => {
      for (let i = 0; i < n; i++) {
        c.advance(31 * 60_000)
        queue.resume()
        await queue.kick()
      }
    }
    return { store, adapter, queue, rounds }
  }

  it('one job that keeps failing like a network problem can’t hold the queue forever: the rest go first, then its tries count', async () => {
    const c = clock()
    const { store, adapter, queue, rounds } = stuck(c)
    const a = queue.enqueue('echo', { n: 1 }, 10)
    const b = queue.enqueue('echo', { n: 2 }, 10)
    await queue.kick()
    await rounds(2)
    // Three waits in a row, its tries untouched, and nothing behind it ran.
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(store.get(b)!.status).toBe('queued')
    await rounds(1)
    // Set aside: b ran and got an answer, so the network is fine and a's next failure was its own.
    expect(store.get(b)!.status).toBe('done')
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 1 })
    await rounds(5)
    expect(store.get(a)).toMatchObject({ status: 'failed', attempts: 3, errorKind: 'offline' })
    expect(adapter.calls).toHaveLength(7)
    queue.dispose()
  })

  it('a real outage after that still spends nobody’s tries', async () => {
    const c = clock()
    let down = false
    const { store, queue, rounds } = stuck(c, () => down)
    const a = queue.enqueue('echo', { n: 1 }, 10)
    await queue.kick()
    await rounds(2)
    // a is set aside; the network goes down before anything else gets an answer.
    down = true
    const ids = [2, 3, 4].map((n) => queue.enqueue('echo', { n }))
    await rounds(30)
    expect([a, ...ids].map((id) => store.get(id)).map((j) => [j!.status, j!.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0],
      ['queued', 0],
      ['queued', 0],
    ])
    // And once it's back, they all go through but a, whose tries then count.
    down = false
    await rounds(6)
    expect(ids.map((id) => store.get(id)!.status)).toEqual(['done', 'done', 'done'])
    expect(store.get(a)).toMatchObject({ status: 'failed', attempts: 3 })
    queue.dispose()
  })

  it('a job set aside that a healthy job meets an outage behind is no longer suspected', async () => {
    const c = clock()
    let down = false
    const { store, queue, rounds } = stuck(c, () => down)
    const a = queue.enqueue('echo', { n: 1 }, 10)
    await queue.kick()
    await rounds(2)
    // b gets an answer: a is suspected.
    const b = queue.enqueue('echo', { n: 2 })
    await rounds(1)
    expect(store.get(b)!.status).toBe('done')
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 1 })
    // Then the network goes; c, run before a, meets it: a's failures stop counting.
    down = true
    const cJob = queue.enqueue('echo', { n: 3 })
    await rounds(1)
    expect(store.get(cJob)).toMatchObject({ status: 'queued', attempts: 0 })
    await rounds(12)
    expect(store.get(a)).toMatchObject({ status: 'queued', attempts: 1 })
    queue.dispose()
  })
})

describe('JobQueue: unreadable jobs', () => {
  it('fails a row whose input is not JSON, or whose kind is unknown, and runs the rest', async () => {
    const { queue, store, db } = setup([ok({ doubled: 2 })])
    const broken = store.insert('echo', { n: 1 }, 10, null)
    db.prepare("UPDATE jobs SET input = '{oops' WHERE id = ?").run(broken)
    const stray = store.insert('retired_kind', { n: 1 }, 5, null)
    const fine = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    expect(store.get(broken)).toMatchObject({ status: 'failed', errorKind: 'job', input: null, error: expect.stringContaining('could not be read') })
    expect(store.get(broken)!.unreadable).toMatch(/^input: /)
    expect(store.get(stray)).toMatchObject({ status: 'failed', errorKind: 'job', error: 'unknown job kind retired_kind' })
    expect(store.get(fine)!.status).toBe('done')
    expect(queue.status().pausedUntil).toBeNull()
  })
})

describe('timeouts', () => {
  it("grow with effort and for the bigger models; Claude Code's default effort on Sonnet or Haiku keeps the kind's own", () => {
    expect(timeoutFor(360_000, undefined, 'sonnet')).toBe(360_000)
    expect(timeoutFor(360_000, undefined, 'haiku')).toBe(360_000)
    expect(timeoutFor(360_000, 'low', 'sonnet')).toBe(360_000)
    expect(timeoutFor(360_000, 'medium', 'sonnet')).toBe(360_000)
    expect(timeoutFor(360_000, 'high', 'sonnet')).toBe(540_000)
    expect(timeoutFor(360_000, 'xhigh', 'haiku')).toBe(720_000)
    expect(timeoutFor(360_000, 'max', 'sonnet')).toBe(1_080_000)
    expect(timeoutFor(360_000, undefined, 'opus')).toBe(540_000)
    expect(timeoutFor(300_000, 'high', 'fable')).toBe(675_000)
    // Capped at 30 minutes, unless a kind asks for more at its default.
    expect(timeoutFor(600_000, 'max', 'opus')).toBe(MAX_TIMEOUT_MS)
    expect(timeoutFor(40 * 60_000, 'max', 'opus')).toBe(40 * 60_000)
  })

  it('each run gets its scaled timeout from the queue', async () => {
    const { queue, adapter } = setup([ok({ doubled: 2 })])
    const slow: JobKind<{ n: number; model: string; effort?: 'max' }, { doubled: number }> = { ...echo, kind: 'slow', model: (i) => i.model, effort: (i) => i.effort, timeoutMs: 360_000 }
    queue.register(slow)
    queue.enqueue('slow', { n: 1, model: 'sonnet' })
    queue.enqueue('slow', { n: 2, model: 'sonnet', effort: 'max' })
    queue.enqueue('echo', { n: 3 })
    await queue.kick()
    expect(adapter.calls.map((c) => c.timeoutMs)).toEqual([360_000, 1_080_000, DEFAULT_TIMEOUT_MS])
  })
})

describe('JobQueue: 다시 시도', () => {
  const refusal = (fn: () => unknown): string | null => {
    try {
      fn()
    } catch (e) {
      return e instanceof RetryRefused ? e.code : `not a refusal: ${String(e)}`
    }
    return null
  }
  const unusable: JobResult = { ok: false, error: 'model', message: 'no such model' }

  it('queues a failed job again: same kind, priority, folder and input (number-check fields too), marked with the job it retries', async () => {
    const { queue, store } = setup([unusable, ok({ doubled: 2 })])
    const id = store.insert('echo', { n: 1, numberRetry: ['47점'], retryOf: 3 }, 7, 'C:/shots')
    await queue.kick()
    expect(store.get(id)!.status).toBe('failed')
    const again = queue.retry(id, (input) => ({ ...input, model: 'opus' }))
    expect(store.get(again)).toMatchObject({ kind: 'echo', priority: 7, folder: 'C:/shots', input: { n: 1, numberRetry: ['47점'], retryOf: 3, model: 'opus', manualRetryOf: id } })
    await queue.kick()
    expect(store.get(again)!.status).toBe('done')
    // Retried (and that one didn't fail): not twice.
    expect(refusal(() => queue.retry(id))).toBe('job-retried')
  })

  it('refuses what a retry cannot help, and lets a kind adjust what it queues', async () => {
    const { queue, store, db } = setup([unusable])
    const never: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'never', retryInput: RETRY_NEVER }
    const stale: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'stale', stillWanted: (i) => i.n > 1 }
    const trimmed: JobKind<{ n: number; held?: number[] }, { doubled: number }> = { ...echo, kind: 'trimmed', retryInput: ({ held: _held, ...rest }) => rest }
    queue.register(never).register(stale).register(trimmed)
    const a = queue.enqueue('echo', { n: 1 })
    const b = queue.enqueue('never', { n: 1 })
    const c = queue.enqueue('stale', { n: 2 })
    const d = queue.enqueue('trimmed', { n: 1, held: [1, 2] })
    await queue.kick()
    expect([a, b, c, d].map((id) => store.get(id)!.status)).toEqual(['failed', 'failed', 'failed', 'failed'])
    const pruned = store.insert('echo', { n: 1 }, 0, null)
    store.update(pruned, { status: 'failed' })
    db.prepare("UPDATE jobs SET input = '{}' WHERE id = ?").run(pruned)

    expect(refusal(() => queue.retry(999))).toBe('job-not-found')
    expect(refusal(() => queue.retry(b))).toBe('job-not-retryable')
    expect([queue.canRetry('never'), queue.canRetry('echo'), queue.canRetry('retired_kind')]).toEqual([false, true, false])
    expect(refusal(() => queue.retry(pruned))).toBe('job-input-gone')
    // Its moment has passed: refused, rather than queued and cancelled unrun.
    expect(refusal(() => queue.retry(c, (i) => ({ ...i, n: 1 })))).toBe('job-not-wanted')
    const t = queue.retry(d)
    expect(store.get(t)!.input).toEqual({ n: 1, manualRetryOf: d })
    expect(refusal(() => queue.retry(t))).toBe('job-not-failed')
    await queue.kick()
    // That retry failed too: the first job (or the retry) can be retried again.
    expect(store.get(t)!.status).toBe('failed')
    expect(refusal(() => queue.retry(d))).toBeNull()
    expect(refusal(() => queue.retry(a))).toBeNull()
  })

  it('judges a retry’s moment from the job it retries, back to the first one', async () => {
    const { queue, store, db } = setup([unusable])
    const hour: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'hour', stillWanted: (_i, job) => Date.now() - Date.parse(job.createdAt) < 3600_000 }
    queue.register(hour)
    const first = queue.enqueue('hour', { n: 1 })
    await queue.kick()
    const again = queue.retry(first)
    await queue.kick()
    expect([first, again].map((id) => store.get(id)!.status)).toEqual(['failed', 'failed'])
    // The first was queued two hours ago: a retry of either is too late now, though the retry itself is new.
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3600_000).toISOString(), first)
    expect(refusal(() => queue.retry(again))).toBe('job-not-wanted')
    expect(refusal(() => queue.retry(first))).toBe('job-not-wanted')
  })

  it('one failed job is retried once at a time, whichever job of its chain the button is on', async () => {
    let fail = true
    const { queue, store, db, adapter } = setup([(n) => (fail ? unusable : ok({ doubled: n }))])
    const listed = () => recentJobs(db, 30).map((j) => [j.id, j.canRetry, j.retriedBy])
    const a = queue.enqueue('echo', { n: 1 })
    await queue.kick()
    const b = queue.retry(a)
    await queue.kick()
    expect([store.get(a)!.status, store.get(b)!.status]).toEqual(['failed', 'failed'])
    // Only the newest of the chain offers 다시 시도.
    expect(listed()).toEqual([
      [b, true, null],
      [a, false, b],
    ])
    fail = false
    const c = queue.retry(b)
    // c waits (at the top of the list, in the queue): neither a nor b can queue another.
    expect(refusal(() => queue.retry(a))).toBe('job-retried')
    expect(refusal(() => queue.retry(b))).toBe('job-retried')
    expect(listed()).toEqual([
      [c, false, null],
      [b, false, c],
      [a, false, b],
    ])
    await queue.kick()
    expect(store.get(c)!.status).toBe('done')
    expect(adapter.calls).toHaveLength(3)
    // Done: still not twice.
    expect(refusal(() => queue.retry(a))).toBe('job-retried')
    expect(refusal(() => queue.retry(b))).toBe('job-retried')
  })
})

describe('JobQueue: 취소', () => {
  const refusal = (fn: () => unknown): string | null => {
    try {
      fn()
    } catch (e) {
      return e instanceof CancelRefused ? e.code : `not a refusal: ${String(e)}`
    }
    return null
  }
  const tick = () => new Promise((r) => setImmediate(r))

  /** A queue whose runs wait for `release` (or end when aborted, with `endOnAbort`), as a long Claude Code run does. */
  function slow(endOnAbort: boolean) {
    const db = openDb(':memory:')
    const store = sqliteJobStore(db)
    const runs: { input: unknown; release: (r: JobResult) => void; aborted: boolean }[] = []
    const adapter = new ReplayAdapter(
      (req) =>
        new Promise<JobResult>((resolve) => {
          const run = { input: req.input, release: resolve, aborted: false }
          runs.push(run)
          req.signal?.addEventListener('abort', () => {
            run.aborted = true
            if (endOnAbort) resolve({ ok: false, error: 'failed', message: 'aborted' })
          })
        }),
    )
    const saved: number[] = []
    const keep: JobKind<{ n: number }, { doubled: number }> = { ...echo, kind: 'keep', accept: (o) => void saved.push(o.doubled) }
    const queue = new JobQueue(store, adapter, () => 'C:/tmp').register(echo).register(keep)
    const changed: (number | null)[] = []
    queue.onChange((_s, id) => changed.push(id))
    return { db, store, queue, runs, saved, changed }
  }

  it('a waiting job leaves the queue unrun, marked as one you cancelled; the jobs around it still run', async () => {
    const { queue, store, adapter } = setup([(n) => ok({ doubled: n })])
    // Inserted without a kick, so all three wait.
    const a = store.insert('echo', { n: 1 }, 0, null)
    const b = store.insert('echo', { n: 2 }, 0, null)
    const c = store.insert('echo', { n: 3 }, 0, null)
    const seen: (number | null)[] = []
    queue.onChange((_s, id) => seen.push(id))
    queue.cancel(b)
    expect(store.get(b)).toMatchObject({ status: 'cancelled', error: CANCELLED_BY_YOU, errorKind: null, attempts: 0 })
    expect(store.get(b)!.finishedAt).not.toBeNull()
    // Listeners hear of it, as of any change (held words, the draft, the 대기 중 list).
    expect(seen).toEqual([b])
    await queue.kick()
    expect([a, b, c].map((id) => store.get(id)!.status)).toEqual(['done', 'cancelled', 'done'])
    expect(adapter.calls.map((r) => r.input)).toEqual([{ n: 1 }, { n: 3 }])
    expect(queue.status()).toMatchObject({ pausedUntil: null, failures: 0 })
  })

  it('a running job: its run is ended, a late answer is dropped, nothing pauses, and it never goes back in the queue', async () => {
    const { queue, store, runs, saved, changed } = slow(false)
    const a = queue.enqueue('keep', { n: 1 })
    const b = queue.enqueue('keep', { n: 2 })
    expect(store.get(a)!.status).toBe('running')
    queue.cancel(a)
    expect(runs[0]!.aborted).toBe(true)
    expect(store.get(a)).toMatchObject({ status: 'cancelled', error: CANCELLED_BY_YOU })
    expect(changed.at(-1)).toBe(a)
    // Claude's answer lands anyway, before the run had really ended: it isn't stored, only what it used is kept.
    runs[0]!.release({ ...ok({ doubled: 2 }), costUsd: 0.05 })
    await tick()
    expect(saved).toEqual([])
    expect(store.get(a)).toMatchObject({ status: 'cancelled', output: null, attempts: 1, costUsd: 0.05 })
    // The next job runs at once: no pause, no backoff.
    expect(queue.status()).toMatchObject({ pausedUntil: null, pauseReason: null, failures: 0 })
    expect(store.get(b)!.status).toBe('running')
    runs[1]!.release(ok({ doubled: 4 }))
    await queue.kick()
    expect(saved).toEqual([4])
    expect(store.get(a)!.status).toBe('cancelled')
    queue.stop()
  })

  it('the failure its own ending causes counts for nothing: no try, no pause', async () => {
    const { queue, store, runs } = slow(true)
    const a = queue.enqueue('echo', { n: 1 })
    queue.cancel(a)
    await tick()
    expect(store.get(a)).toMatchObject({ status: 'cancelled', errorKind: null, error: CANCELLED_BY_YOU })
    expect(queue.status()).toMatchObject({ pausedUntil: null, pauseReason: null, failures: 0, running: null })
    expect(runs).toHaveLength(1)
    queue.stop()
  })

  it('closing the league while a cancelled run is still ending leaves it cancelled', async () => {
    const { queue, store, runs } = slow(false)
    const a = queue.enqueue('echo', { n: 1 })
    queue.cancel(a)
    queue.stop()
    runs[0]!.release({ ok: false, error: 'failed', message: 'aborted' })
    await tick()
    expect(store.get(a)!.status).toBe('cancelled')
    // The next open's queue leaves it be too.
    new JobQueue(store, new ReplayAdapter(() => ok({ doubled: 0 })), () => '')
    expect(store.get(a)!.status).toBe('cancelled')
  })

  it('refuses a job that is done, failed or cancelled already, and one that isn’t there', async () => {
    const { queue, store } = setup([ok({ doubled: 2 }), { ok: false, error: 'model', message: 'no such model' }])
    const done = queue.enqueue('echo', { n: 1 })
    const failed = queue.enqueue('echo', { n: 2 })
    await queue.kick()
    const cancelled = store.insert('echo', { n: 3 }, 0, null)
    queue.cancel(cancelled)
    expect([done, failed, cancelled].map((id) => [store.get(id)!.status, refusal(() => queue.cancel(id))])).toEqual([
      ['done', 'job-not-waiting'],
      ['failed', 'job-not-waiting'],
      ['cancelled', 'job-not-waiting'],
    ])
    expect(refusal(() => queue.cancel(999))).toBe('job-not-found')
    // The refusals changed nothing.
    expect(store.get(done)).toMatchObject({ status: 'done', error: null })
    expect(store.get(failed)).toMatchObject({ status: 'failed', error: 'no such model' })
  })

  it('cancels every waiting job of one kind at once, not the one running nor other kinds', async () => {
    const { queue, store, runs, changed } = slow(true)
    const running = queue.enqueue('keep', { n: 1 })
    const waiting = [2, 3, 4].map((n) => queue.enqueue('keep', { n }))
    const other = queue.enqueue('echo', { n: 5 })
    expect(queue.cancelWaiting('keep')).toBe(3)
    expect(waiting.map((id) => store.get(id))).toMatchObject(waiting.map(() => ({ status: 'cancelled', error: CANCELLED_BY_YOU })))
    expect(changed.slice(-3)).toEqual(waiting)
    expect(store.get(running)!.status).toBe('running')
    expect(store.get(other)!.status).toBe('queued')
    expect(queue.cancelWaiting('keep')).toBe(0)
    expect(queue.cancelWaiting('no_such_kind')).toBe(0)
    runs[0]!.release(ok({ doubled: 2 }))
    await tick()
    expect(store.get(running)!.status).toBe('done')
    expect(runs.map((r) => r.input)).toEqual([{ n: 1 }, { n: 5 }])
    queue.stop()
  })

  it('최근 작업 lists running and waiting jobs first, never their input; a cancelled one leaves the list', async () => {
    const { queue, store, db } = slow(true)
    const a = queue.enqueue('echo', { n: 1, context: '비밀 전학' })
    const b = queue.enqueue('echo', { n: 2, model: 'opus', effort: 'max', context: '비밀 전학' }, 5)
    const c = queue.enqueue('keep', { n: 3, context: '비밀 전학' })
    const listed = () => recentJobs(db).map((j) => [j.id, j.status])
    // The running one, then the rest in the order they'd run (priority first).
    expect(listed()).toEqual([
      [a, 'running'],
      [b, 'queued'],
      [c, 'queued'],
    ])
    expect(recentJobs(db)[1]).toMatchObject({ askedModel: 'opus', askedEffort: 'max', startedAt: null, durationMs: null, queuedAt: store.get(b)!.createdAt })
    expect(recentJobs(db)[0]!.startedAt).toBe(store.get(a)!.startedAt)
    expect(JSON.stringify(recentJobs(db))).not.toContain('비밀')
    queue.cancel(b)
    queue.cancel(a)
    expect(listed()).toEqual([[c, 'queued']])
    await tick()
    expect(store.get(c)!.status).toBe('running')
    queue.stop()
  })
})
