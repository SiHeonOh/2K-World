import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { openDb } from '@data/db'
import { sqliteJobStore } from '@data/jobs'
import { claudeArgs, ReplayAdapter } from '@ai/adapter'
import { CANCELLED_BY_YOU, JobQueue, type JobKind } from '@ai/queue'
import { currentSeason, listEvents } from '@data/league'
import { ko } from '../renderer/i18n/ko'
import { AI_JOB_OF_KIND, type RecentJob, type RunUsage } from '@shared/ai'
import { sampleConfig, sampleSetup } from '@shared/testing/fixtures'
import { migrateConfig } from '@shared/config/migrations'
import { AI_JOBS, aiFor, CONFIG_VERSION, leagueConfigSchema } from '@shared/config/schema'
import { createContext, type AppContext } from './context'
import { AppError } from './errors'
import { createHandlers } from './handlers'

describe('AI models and effort per job', () => {
  it("a v3 league's model choices carry over; jobs that borrowed a setting start from it; effort starts at the default", () => {
    const v3 = structuredClone(sampleConfig()) as unknown as Record<string, unknown>
    v3.version = 3
    const ai = v3.ai
    delete v3.ai
    expect(ai).toBeDefined()
    ;(v3.community as Record<string, unknown>).models = { thread: 'opus', reply: 'sonnet', chatter: 'haiku', article: 'opus' }
    ;(v3.gm as Record<string, unknown>).models = { intent: 'opus', respond: 'haiku' }
    // A v3 config saved before the lore section existed: its jobs get the defaults.
    delete v3.lore
    const v4 = leagueConfigSchema.parse(migrateConfig(v3))
    expect(v4.version).toBe(CONFIG_VERSION)
    expect(v4.ai.jobs).toMatchObject({
      gameThread: { model: 'opus', effort: 'default' },
      article: { model: 'opus' },
      reply: { model: 'sonnet' },
      live: { model: 'sonnet' },
      chatter: { model: 'haiku' },
      wiki: { model: 'opus' },
      player: { model: 'opus' },
      gmIntent: { model: 'opus' },
      gmRespond: { model: 'haiku' },
      gmDraft: { model: 'haiku' },
      loreDraft: { model: 'sonnet' },
      loreSweep: { model: 'sonnet' },
      screenshot: { model: 'sonnet' },
    })
    expect(Object.keys(v4.ai.jobs).sort()).toEqual([...AI_JOBS].sort())
    // The old per-section fields are gone.
    expect('models' in v4.community).toBe(false)
    expect('models' in v4.gm).toBe(false)
  })

  it("the lore section's choices carry over too, and a config naming only some jobs gets the rest", () => {
    const v3 = structuredClone(sampleConfig()) as unknown as Record<string, unknown>
    v3.version = 3
    delete v3.ai
    v3.lore = { roundSweep: true, suggest: {}, models: { draft: 'opus', suggest: 'haiku' } }
    const v4 = leagueConfigSchema.parse(migrateConfig(v3))
    expect(v4.ai.jobs.loreDraft.model).toBe('opus')
    expect(v4.ai.jobs.loreSweep.model).toBe('haiku')
    const partial = leagueConfigSchema.parse({ ...sampleConfig(), ai: { jobs: { wiki: { model: 'opus' } } } })
    expect(partial.ai.jobs.wiki).toEqual({ model: 'opus', effort: 'default' })
    expect(partial.ai.jobs.reply).toEqual({ model: 'haiku', effort: 'default' })
    // Jobs added later (the wiki's 토론 and wars) start from 위키 편집 until they're set themselves.
    expect(partial.ai.jobs.wikiTalk).toEqual({ model: 'opus', effort: 'default' })
    expect(partial.ai.jobs.wikiWar).toEqual({ model: 'opus', effort: 'default' })
    const own = leagueConfigSchema.parse({ ...sampleConfig(), ai: { jobs: { wiki: { model: 'opus', effort: 'max' }, wikiWar: { model: 'haiku' } } } })
    expect([own.ai.jobs.wikiTalk, own.ai.jobs.wikiWar]).toEqual([
      { model: 'opus', effort: 'max' },
      { model: 'haiku', effort: 'default' },
    ])
    // An older config with no wiki settings reads as the defaults.
    const { wiki: _drop, ...noWiki } = sampleConfig()
    expect(leagueConfigSchema.parse(noWiki).wiki).toEqual({ editWars: 'sometimes' })
    // Defaults are fresh objects: changing one parsed config never changes the next.
    const a = leagueConfigSchema.parse({ ...sampleConfig(), ai: undefined })
    a.ai.jobs.wiki.model = 'fable'
    expect(leagueConfigSchema.parse({ ...sampleConfig(), ai: undefined }).ai.jobs.wiki.model).toBe('sonnet')
  })

  it('every job can run on Fable at any effort; "default" passes no effort at all', () => {
    const config = leagueConfigSchema.parse({ ...sampleConfig(), ai: { jobs: { ...sampleConfig().ai.jobs, wiki: { model: 'fable', effort: 'max' } } } })
    expect(aiFor(config, 'wiki')).toEqual({ model: 'fable', effort: 'max' })
    expect(aiFor(config, 'reply')).toEqual({ model: 'haiku' })
    expect(() => leagueConfigSchema.parse({ ...sampleConfig(), ai: { jobs: { ...sampleConfig().ai.jobs, wiki: { model: 'gpt', effort: 'max' } } } })).toThrow()
  })

  it("a job's effort reaches Claude Code as --effort; none when left to its default", async () => {
    const kind: JobKind<{ effort?: 'high' }, { ok: boolean }> = {
      kind: 'probe',
      model: 'sonnet',
      effort: (i) => i.effort,
      tools: [],
      output: z.object({ ok: z.boolean() }),
      systemPrompt: () => 's',
      prompt: () => 'p',
      stdin: () => '',
    }
    const adapter = new ReplayAdapter(() => ({ ok: true, data: { ok: true }, costUsd: null, durationMs: 1, raw: '' }))
    const queue = new JobQueue(sqliteJobStore(openDb(':memory:')), adapter, () => 'C:/tmp').register(kind)
    queue.enqueue('probe', { effort: 'high' })
    queue.enqueue('probe', {})
    await queue.kick()
    expect(adapter.calls.map((c) => c.effort)).toEqual(['high', undefined])
    const args = (effort?: 'high') => claudeArgs({ ...adapter.calls[0]!, ...(effort ? { effort } : { effort: undefined }) }, 'sys.txt')
    expect(args('high').join(' ')).toContain('--effort high')
    expect(args()).not.toContain('--effort')
  })
})

describe('recent AI jobs (편집실 → AI 모델)', () => {
  let root: string
  let ctx: AppContext
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '2kw-recent-'))
    mkdirSync(join(root, 'defaults', 'templates'), { recursive: true })
    ctx = createContext(join(root, 'data'), join(root, 'defaults'), '0.0.0-test')
    ctx.leagues.create({ slug: 'test-league', setup: sampleSetup(), saveTemplate: null, importMapping: null })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    ctx.ai.closeAll()
    ctx.leagues.closeAll()
    rmSync(root, { recursive: true, force: true })
  })
  const handlers = () =>
    createHandlers({
      context: () => ctx,
      appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
      pickFile: async () => null,
      pickFolder: async () => null,
      openFolder: () => {},
      showItem: () => {},
      switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
    })

  it('every job kind the app runs is listed under its AI 모델 row', () => {
    const register = vi.spyOn(JobQueue.prototype, 'register')
    ctx.ai.queueFor('test-league', ctx.leagues.dbFor('test-league'), ctx.leagues.folderOf('test-league'))
    const kinds = register.mock.calls.map(([k]) => k.kind)
    expect(kinds).toContain('read_box_score')
    expect(kinds.filter((k) => !Object.hasOwn(AI_JOB_OF_KIND, k))).toEqual([])
    // And every row has a kind that runs under it.
    expect(new Set(Object.values(AI_JOB_OF_KIND))).toEqual(new Set(AI_JOBS))
  })

  it('lists the latest finished jobs, newest first, with what they asked for and used, and never their inputs', async () => {
    const db = ctx.leagues.dbFor('test-league')
    const store = sqliteJobStore(db)
    const secret = '비밀: 가람고 에이스는 시즌이 끝나면 전학을 간다'
    const finished = (kind: string, input: object, change: Parameters<typeof store.update>[1]) => {
      const id = store.insert(kind, input, 0, null)
      store.update(id, change)
      return id
    }
    const usage: RunUsage = {
      model: 'claude-sonnet-4-6',
      models: { 'claude-sonnet-4-6': { input: 12, output: 800, cacheRead: 11000, cacheWrite: 988 }, 'claude-haiku-4-5': { input: 300, output: 4, cacheRead: 0, cacheWrite: 0 } },
      total: { input: 312, output: 804, cacheRead: 11000, cacheWrite: 988 },
    }
    const thread = finished('post_game_thread', { model: 'sonnet', context: secret }, {
      status: 'done',
      output: { posts: [{ body: secret }] },
      askedModel: 'sonnet',
      askedEffort: 'high',
      costUsd: 0.0123,
      usage,
      startedAt: '2026-10-10T10:00:00.000Z',
      finishedAt: '2026-10-10T10:00:42.500Z',
    })
    const pushback = finished('wiki_pushback', { model: 'opus', context: secret }, {
      status: 'failed',
      error: `Claude said: ${secret}`,
      errorKind: 'invalid',
      askedModel: 'opus',
      startedAt: '2026-10-10T11:00:00.000Z',
      finishedAt: '2026-10-10T11:02:05.000Z',
    })
    // Finished before the app recorded what it asked for: that comes from its input.
    const swap = finished('gm_swap', { model: 'haiku', effort: 'low', context: secret }, { status: 'done', finishedAt: '2026-10-09T09:00:00.000Z' })
    const odd = finished('mystery_kind', {}, { status: 'done', startedAt: '2026-10-08T00:00:05.000Z', finishedAt: '2026-10-08T00:00:00.000Z' })
    // Cancelled: left out. Never run yet: still in the queue, so it leads the list (대기 중).
    finished('chatter_batch', { context: secret }, { status: 'cancelled', finishedAt: '2026-10-11T00:00:00.000Z' })
    const reply = store.insert('reply_to_user', { context: secret }, 60, null)
    const queuedAt = (id: number) => store.get(id)!.createdAt

    const list = await handlers()['ai.recentJobs']('test-league')
    const first = { numberRetry: false, retryOf: null, redoneBy: null, canRetry: false, retriedBy: null }
    const none = { costUsd: null, model: null, tokens: null, errorKind: null, ...first }
    expect(list).toEqual<RecentJob[]>([
      {
        id: reply,
        kind: 'reply_to_user',
        job: 'reply',
        status: 'queued',
        ...none,
        askedModel: null,
        askedEffort: null,
        queuedAt: queuedAt(reply),
        startedAt: null,
        finishedAt: queuedAt(reply),
        durationMs: null,
      },
      {
        id: pushback,
        kind: 'wiki_pushback',
        job: 'wikiTalk',
        status: 'failed',
        ...none,
        errorKind: 'invalid',
        // Its input is still kept: 다시 시도 can queue it again.
        canRetry: true,
        askedModel: 'opus',
        askedEffort: null,
        queuedAt: queuedAt(pushback),
        startedAt: '2026-10-10T11:00:00.000Z',
        finishedAt: '2026-10-10T11:02:05.000Z',
        durationMs: 125_000,
      },
      {
        id: thread,
        kind: 'post_game_thread',
        job: 'gameThread',
        status: 'done',
        errorKind: null,
        askedModel: 'sonnet',
        askedEffort: 'high',
        model: 'claude-sonnet-4-6',
        tokens: usage.total,
        costUsd: 0.0123,
        queuedAt: queuedAt(thread),
        startedAt: '2026-10-10T10:00:00.000Z',
        finishedAt: '2026-10-10T10:00:42.500Z',
        durationMs: 42_500,
        ...first,
      },
      {
        id: swap,
        kind: 'gm_swap',
        job: 'gmDraft',
        status: 'done',
        ...none,
        askedModel: 'haiku',
        askedEffort: 'low',
        queuedAt: queuedAt(swap),
        startedAt: null,
        finishedAt: '2026-10-09T09:00:00.000Z',
        durationMs: null,
      },
      // An unknown kind keeps its raw name; a clock that ran backwards gives no time.
      {
        id: odd,
        kind: 'mystery_kind',
        job: null,
        status: 'done',
        ...none,
        askedModel: null,
        askedEffort: null,
        queuedAt: queuedAt(odd),
        startedAt: '2026-10-08T00:00:05.000Z',
        finishedAt: '2026-10-08T00:00:00.000Z',
        durationMs: null,
      },
    ])
    expect(JSON.stringify(list)).not.toContain('비밀')
    for (const row of list) expect(row).not.toHaveProperty('input')

    // The number check's redo, and the job it redid: each points at the other.
    const redid = finished('chatter_batch', { model: 'sonnet', context: secret }, { status: 'done', finishedAt: '2026-10-10T12:00:00.000Z' })
    const redo = finished('chatter_batch', { model: 'sonnet', context: secret, numberRetry: ['47점'], retryOf: redid }, { status: 'done', finishedAt: '2026-10-10T12:05:00.000Z' })
    const pair = (await handlers()['ai.recentJobs']('test-league')).filter((j) => j.id === redid || j.id === redo)
    expect(pair).toMatchObject([
      { id: redo, numberRetry: true, retryOf: redid, redoneBy: null },
      { id: redid, numberRetry: false, retryOf: null, redoneBy: redo },
    ])

    // About 30 finished at most, after the job still waiting.
    for (let i = 0; i < 35; i++) finished('wiki_edits', { model: 'sonnet' }, { status: 'done', finishedAt: `2026-10-11T01:${String(i).padStart(2, '0')}:00.000Z` })
    const capped = await handlers()['ai.recentJobs']('test-league')
    expect(capped).toHaveLength(31)
    expect(capped[0]).toMatchObject({ id: reply, status: 'queued' })
    expect(capped[1]).toMatchObject({ kind: 'wiki_edits', job: 'wiki', finishedAt: '2026-10-11T01:34:00.000Z' })

    await expect(Promise.resolve().then(() => handlers()['ai.recentJobs'](42))).rejects.toMatchObject({ code: 'invalid-input' })
  })

  const rejection = async (fn: () => unknown) => {
    try {
      await fn()
    } catch (e) {
      return e instanceof AppError ? e.toShape() : e
    }
    return null
  }
  const failedJob = (kind: string, input: object, priority = 0) => {
    const store = sqliteJobStore(ctx.leagues.dbFor('test-league'))
    const id = store.insert(kind, input, priority, null)
    store.update(id, { status: 'failed', error: 'boom', errorKind: 'model', attempts: 1, startedAt: '2026-10-10T09:59:00.000Z', finishedAt: '2026-10-10T10:00:00.000Z' })
    return id
  }

  it('puts the jobs still in the queue first (running, then in the order they’d run), and reads one job’s error only when asked', async () => {
    const store = sqliteJobStore(ctx.leagues.dbFor('test-league'))
    const done = store.insert('wiki_edits', { model: 'sonnet' }, 0, null)
    store.update(done, { status: 'done', startedAt: '2026-10-10T09:59:00.000Z', finishedAt: '2026-10-10T10:00:00.000Z' })
    const waiting = store.insert('chatter_batch', { model: 'sonnet', context: '비밀' }, 0, null)
    store.update(waiting, { status: 'queued', error: 'API Error: Connection error.', errorKind: 'offline', startedAt: '2026-10-10T11:00:00.000Z' })
    // Never tried yet: waiting its turn, ahead of the chatter (a higher priority).
    const reply = store.insert('reply_to_user', { model: 'haiku', effort: 'low', context: '비밀' }, 60, null)
    const running = store.insert('lore_draft', { model: 'opus', effort: 'max', context: '비밀' }, 20, null)
    store.update(running, { status: 'running', startedAt: '2026-10-10T12:00:00.000Z' })
    const list = await handlers()['ai.recentJobs']('test-league')
    expect(list.map((j) => [j.id, j.status, j.errorKind, j.canRetry, j.startedAt, j.durationMs, j.askedModel, j.askedEffort])).toEqual([
      [running, 'running', null, false, '2026-10-10T12:00:00.000Z', null, 'opus', 'max'],
      [reply, 'queued', null, false, null, null, 'haiku', 'low'],
      [waiting, 'waiting', 'offline', false, '2026-10-10T11:00:00.000Z', null, 'sonnet', null],
      [done, 'done', null, false, '2026-10-10T09:59:00.000Z', 60_000, 'sonnet', null],
    ])
    expect(list.find((j) => j.id === waiting)!.finishedAt).toBe('2026-10-10T11:00:00.000Z')
    expect(list.find((j) => j.id === reply)!.queuedAt).toBe(store.get(reply)!.createdAt)
    // Never a job's input (its context holds lore).
    expect(JSON.stringify(list)).not.toContain('비밀')
    expect(JSON.stringify(list)).not.toContain('Connection error')
    expect(await handlers()['ai.jobError']('test-league', waiting)).toEqual({ error: 'API Error: Connection error.' })
    expect(await handlers()['ai.jobError']('test-league', done)).toEqual({ error: null })
    expect(await rejection(() => handlers()['ai.jobError']('test-league', 9999))).toMatchObject({ code: 'not-found' })
  })

  it('다시 시도 queues a failed job again with its input, on its AI 모델 row as set now; the list then says so', async () => {
    const h = handlers()
    const input = { model: 'opus', effort: 'max', context: '자료', instructions: '', gameId: 1, numberRetry: ['47점'], retryOf: 3 }
    const failed = failedJob('post_game_thread', input, 30)
    expect((await h['ai.recentJobs']('test-league')).find((j) => j.id === failed)).toMatchObject({ status: 'failed', canRetry: true, retriedBy: null })
    const { jobId } = await h['ai.retryJob']('test-league', failed)
    // Game threads run on Sonnet at Claude Code's default effort (the setting now); the rest, number-check fields too, as it was.
    const { model: _model, effort: _effort, ...rest } = input
    const store = sqliteJobStore(ctx.leagues.dbFor('test-league'))
    expect(store.get(jobId)).toMatchObject({ kind: 'post_game_thread', priority: 30, input: { ...rest, model: 'sonnet', manualRetryOf: failed } })
    expect(store.get(jobId)!.input).not.toHaveProperty('effort')
    expect((await h['ai.recentJobs']('test-league')).find((j) => j.id === failed)).toMatchObject({ canRetry: false, retriedBy: jobId })
    expect(await rejection(() => h['ai.retryJob']('test-league', failed))).toMatchObject({ code: 'rule', rules: [{ code: 'job-retried' }] })
    expect(await rejection(() => h['ai.retryJob']('test-league', jobId))).toMatchObject({ code: 'rule', rules: [{ code: 'job-not-failed' }] })
  })

  it('다시 시도 refuses draft jobs (code plays their turns), pruned inputs and jobs whose moment has passed; screenshot reads go through 경기일', async () => {
    const h = handlers()
    const swap = failedJob('gm_swap', { model: 'haiku', seasonId: 1, cards: [{ cardId: 1, teamId: 't1' }], context: '' })
    expect(await rejection(() => h['ai.retryJob']('test-league', swap))).toMatchObject({ code: 'rule', rules: [{ code: 'job-not-retryable' }] })
    // With the league's queue running, the list knows it too.
    expect((await h['ai.recentJobs']('test-league')).find((j) => j.id === swap)).toMatchObject({ canRetry: false })
    const pruned = failedJob('chatter_batch', {})
    expect((await h['ai.recentJobs']('test-league')).find((j) => j.id === pruned)).toMatchObject({ canRetry: false })
    expect(await rejection(() => h['ai.retryJob']('test-league', pruned))).toMatchObject({ code: 'rule', rules: [{ code: 'job-input-gone' }] })
    // A 토론 answer for a thread that's gone (or closed) would be cancelled unrun.
    const talk = failedJob('wiki_talk', { model: 'sonnet', threadId: 999, context: '' })
    expect(await rejection(() => h['ai.retryJob']('test-league', talk))).toMatchObject({ code: 'rule', rules: [{ code: 'job-not-wanted' }] })
    const read = failedJob('read_box_score', { images: ['1.png'], teams: ['가', '나'], gameId: 9999, model: 'sonnet' }, 50)
    expect(await rejection(() => h['ai.retryJob']('test-league', read))).toMatchObject({ code: 'rule', rules: [{ code: 'unknown-game' }] })
    expect(await rejection(() => h['ai.retryJob']('test-league', 9999))).toMatchObject({ code: 'rule', rules: [{ code: 'job-not-found' }] })
  })

  it('취소 takes a waiting job out of the queue, or every waiting one of a kind; a finished one is refused', async () => {
    const h = handlers()
    const store = sqliteJobStore(ctx.leagues.dbFor('test-league'))
    // Inserted without a kick: they wait.
    const drafts = [1, 2, 3].map(() => store.insert('lore_draft', { model: 'opus', effort: 'max', context: '' }, 20, null))
    const reply = store.insert('reply_to_user', { model: 'haiku', context: '' }, 60, null)
    await h['ai.cancelJob']('test-league', drafts[0]!)
    expect(store.get(drafts[0]!)).toMatchObject({ status: 'cancelled', error: CANCELLED_BY_YOU })
    expect(await h['ai.cancelWaiting']('test-league', 'lore_draft')).toEqual({ cancelled: 2 })
    expect(drafts.map((id) => store.get(id)!.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    // Only the reply is left in the queue (waiting: this PC has no Claude Code), and cancelled jobs aren't listed.
    expect((await h['ai.recentJobs']('test-league')).map((j) => j.id)).toEqual([reply])
    expect(await rejection(() => h['ai.cancelJob']('test-league', drafts[0]!))).toMatchObject({ code: 'rule', rules: [{ code: 'job-not-waiting' }] })
    expect(await rejection(() => h['ai.cancelJob']('test-league', 9999))).toMatchObject({ code: 'rule', rules: [{ code: 'job-not-found' }] })
    expect(await rejection(() => h['ai.cancelWaiting']('test-league', "lore_draft' OR 1"))).toMatchObject({ code: 'invalid-input' })
    expect(store.get(reply)!.status).toBe('queued')
    expect(store.get(reply)!.error).not.toBe(CANCELLED_BY_YOU)
  })

  it('취소 of a players’ words retry puts the words it held out as news, as a failure does', async () => {
    const db = ctx.leagues.dbFor('test-league')
    // The league's queue is running (and finds nothing); the retry is put in without a kick, so it waits.
    ctx.ai.queueFor('test-league', db, ctx.leagues.folderOf('test-league'))
    const seasonId = currentSeason(db).id
    const held = { quoteId: 901, playerId: 'p2', teamId: 't1', channel: 'interview', quote: '열심히 하겠습니다', action: 'none', targetId: null }
    const players = [{ key: 'P1', playerId: 'p1', teamId: 't1', causes: ['트레이드'], weight: 3 }]
    const retry = sqliteJobStore(db).insert('player_reaction', { model: 'sonnet', seasonId, context: '', players, retry: true, only: ['P1'], held: [held] }, 22, null)
    expect(listEvents(db, 'player_said')).toEqual([])
    await handlers()['ai.cancelJob']('test-league', retry)
    expect(listEvents(db, 'player_said').map((e) => e.payload)).toEqual([held])
  })

  it('explains every refusal of 다시 시도 and 취소', () => {
    const source = readFileSync(join(__dirname, '../ai/queue.ts'), 'utf8')
    const codes = [...source.matchAll(/new (?:Retry|Cancel)Refused\('([a-z-]+)'\)/g)].map((m) => m[1]!)
    expect(codes).toEqual(expect.arrayContaining(['job-not-failed', 'job-not-wanted', 'job-not-waiting', 'job-not-found']))
    for (const code of codes) expect((ko.rules as Record<string, unknown>)[code], code).toBeDefined()
  })
})

describe('지금 다시 시도', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '2kw-resume-'))
    mkdirSync(join(root, 'defaults', 'templates'), { recursive: true })
    // Claude Code counts as not installed: a re-check runs nothing.
    process.env.TWOK_NO_AI = '1'
  })
  afterEach(() => {
    delete process.env.TWOK_NO_AI
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('looks for Claude Code again when the queue is blocked, then lets it run', async () => {
    const ctx = createContext(join(root, 'data'), join(root, 'defaults'), '0')
    try {
      ctx.leagues.create({ slug: 'off', setup: sampleSetup(), saveTemplate: null, importMapping: null })
      const db = ctx.leagues.dbFor('off')
      const queue = ctx.ai.queueFor('off', db, ctx.leagues.folderOf('off'))
      sqliteJobStore(db).insert('reply_to_user', { model: 'haiku', context: '' }, 60, null)
      await queue.kick()
      expect(queue.status()).toMatchObject({ blocked: 'missing', detail: 'claude is not installed' })
      const refresh = vi.spyOn(ctx.ai, 'refresh')
      const h = createHandlers({
        context: () => ctx,
        appInfo: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
        pickFile: async () => null,
        pickFolder: async () => null,
        openFolder: () => {},
        showItem: () => {},
        switchDataDir: () => ({ version: '0', dataDir: ctx.dataDir, isPackaged: false }),
      })
      const status = await h['ai.resume']('off')
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(status.queue).toMatchObject({ pausedUntil: null, pauseReason: null })
    } finally {
      ctx.ai.closeAll()
      ctx.leagues.closeAll()
    }
  })
})
