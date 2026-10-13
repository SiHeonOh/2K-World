import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { lastEventId, setStoryValue, storyValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { currentSeason, listEvents, loadConfig, seedLeague, updateConfig } from '@data/league'
import { closeProtection, draftMove, draftView, vetoDraftSwap } from '@data/moves'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from '@data/season'
import { storyDemo, storyKinds } from '@story/jobs'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { draftDemo, draftKinds, readDraft, swapOptions } from '@sim/draft'
import { gmDemo, gmKinds, type GmHooks } from '@sim/gm'
import { AiService } from './ai'
import { GmService } from './gm'
import { syncLoreFolder } from './lore'
import { StoryService } from './story'

let dir: string
let db: Db
let ai: AiService
let gm: GmService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-draft-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 4, cards: 2 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
  }
  seedLeague(db, setup)
  ai = new AiService()
  const hooks = (slug: string, d: Db, f: string): GmHooks => ({
    queue: (kind, input, priority) => void ai.queueFor(slug, d, f).enqueue(kind, input, priority),
    changed: () => {
      syncLoreFolder(d, f)
      story.afterChange(slug, d, f)
    },
  })
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f, slug) => gmKinds(d, f, hooks(slug, d, f)), gmDemo)
  ai.addKinds((d, f, slug) => draftKinds(d, f, hooks(slug, d, f)), draftDemo)
  await ai.refresh()
  gm = new GmService(ai, hooks)
  ai.onJobChange((slug, d, f, jobId) => gm.onJobChange(slug, d, f, jobId))
  story = new StoryService(ai, { afterEvents: (slug, d, f) => gm.reconcileDraft(slug, d, f) })
  // A whole season to reach the draft (t1 best … t8 worst). The forum starts listening only now.
  startSeason(db)
  const play = (filter: (stage: string) => boolean) => {
    for (;;) {
      const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && filter(g.stage))
      if (open.length === 0) return
      for (const g of open) {
        const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
        recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
      }
    }
  }
  play((s) => s === 'regular')
  startPlayoffs(db)
  play((s) => s !== 'regular')
  finishPlayoffs(db)
  setStoryValue(db, 'events-handled', String(lastEventId(db)))
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    await ai.queueFor('test', db, dir).kick()
    await new Promise((r) => setImmediate(r))
  }
}
const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]

describe('what the review found', () => {
  it('closing protection before the AI protected doesn’t stall the draft', async () => {
    story.afterChange('test', db, dir)
    expect(jobs('gm_protect').length).toBeGreaterThan(0)
    // You close protection while the protect jobs still wait behind other work.
    closeProtection(db)
    story.afterChange('test', db, dir)
    await drain(40)
    expect(jobs('gm_protect').every((j) => j.status === 'cancelled')).toBe(true)
    expect(draftView(db).next).toBeNull()
  })

  it('a turn you play for the AI, or a veto, makes the waiting batch give way to a fresh one', async () => {
    story.afterChange('test', db, dir)
    await drain()
    closeProtection(db)
    story.afterChange('test', db, dir)
    expect(jobs('gm_swap').filter((j) => ['queued', 'running'].includes(j.status))).toHaveLength(1)
    // You play the first card yourself (as commissioner) before the batch's answer lands.
    const next = draftView(db).next!
    const passed = draftMove(db, { kind: 'pass', teamId: next.ownerTeamId, cardId: next.id })
    story.afterChange('test', db, dir)
    await drain(40)
    // The stale batch made no move; fresh ones finished the draft, and your pass stands.
    expect(draftView(db).next).toBeNull()
    expect(draftView(db).actions.filter((a) => a.cardId === next.id).map((a) => a.id)).toEqual([passed])
  })

  it('a vetoed AI pick isn’t made again with that card', async () => {
    story.afterChange('test', db, dir)
    await drain()
    closeProtection(db)
    // Only the first batch: then veto its last swap.
    story.afterChange('test', db, dir)
    await ai.queueFor('test', db, dir).kick()
    const swaps = draftView(db).actions.filter((a) => a.kind === 'swap')
    const last = swaps.at(-1)!
    vetoDraftSwap(db, last.id)
    story.afterChange('test', db, dir)
    await drain(40)
    const redo = draftView(db).actions.find((a) => a.kind !== 'protect' && a.cardId === last.cardId)
    expect(redo?.targetPlayerId ?? null).not.toBe(last.targetPlayerId)
  })

  const failedBatch = (cardIds: number[]) =>
    db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('gm_swap', 'failed', 19, ?, ?)").run(
      JSON.stringify({ seasonId: currentSeason(db).id, cards: cardIds.map((cardId) => ({ cardId })) }),
      new Date().toISOString(),
    )

  it('the turns a failed batch covered are played by code; then Claude gets the next turn', () => {
    story.afterChange('test', db, dir)
    closeProtection(db)
    db.prepare("UPDATE jobs SET status = 'cancelled' WHERE kind IN ('gm_protect', 'gm_swap') AND status IN ('queued', 'running')").run()
    const next = draftView(db).next!
    failedBatch([next.id])
    gm.reconcileDraft('test', db, dir)
    expect(draftView(db).next?.id).not.toBe(next.id)
    expect(gm.draftNotes(db).find((n) => n.note.includes('코드가 대신'))).toBeDefined()
    expect(jobs('gm_swap').filter((j) => ['queued', 'running'].includes(j.status))).toHaveLength(1)
  })

  it('the AI never offers or takes a player who already moved this draft, even where swapped players weren’t protected', async () => {
    const { config } = loadConfig(db)
    if (config.draft.kind === 'card-swap') updateConfig(db, { ...config, draft: { ...config.draft, swappedProtected: false } })
    story.afterChange('test', db, dir)
    await drain()
    closeProtection(db)
    story.afterChange('test', db, dir)
    await drain(40)
    expect(draftView(db).next).toBeNull()
    const swaps = draftView(db).actions.filter((a) => a.kind === 'swap')
    expect(swaps.length).toBeGreaterThan(1)
    // Each player moved at most once: nobody swapped in was sent on or taken again.
    const moved = swaps.flatMap((a) => [a.playerId, a.targetPlayerId])
    expect(new Set(moved).size).toBe(moved.length)
  })

  it('offers no swap for a moved player, and leaves a team you took over mid-batch to you', async () => {
    story.afterChange('test', db, dir)
    await drain()
    closeProtection(db)
    // You play t8's first card yourself: its two players are now off limits to every option.
    const first = draftView(db).next!
    const own = (db.prepare("SELECT id FROM players WHERE team_id = ? AND slot_id = 'pg'").get(first.ownerTeamId) as { id: string }).id
    const target = (db.prepare("SELECT id FROM players WHERE team_id = 't1' AND slot_id = 'sg'").get() as { id: string }).id
    draftMove(db, { kind: 'swap', teamId: first.ownerTeamId, cardId: first.id, playerId: own, targetPlayerId: target })
    const d = readDraft(db, dir)
    for (const team of ['t7', 't6', 't1']) {
      for (const o of swapOptions(d, team, draftView(db).next!.id, 50)) {
        expect([own, target]).not.toContain(o.deal.aGives[0])
        expect([own, target]).not.toContain(o.deal.bGives[0])
      }
    }
    // A batch is written for the next AI turns; then you take that team over before it answers.
    story.afterChange('test', db, dir)
    expect(jobs('gm_swap').filter((j) => ['queued', 'running'].includes(j.status))).toHaveLength(1)
    const next = draftView(db).next!
    db.prepare("UPDATE teams SET control = 'user' WHERE id = ?").run(next.ownerTeamId)
    await drain(10)
    expect(jobs('gm_swap').at(-1)!.status).toBe('done')
    expect(draftView(db).next?.id).toBe(next.id)
    expect(gm.status('test', db, dir).draft).toMatchObject({ waitingFor: next.ownerTeamId })
  })

  it('a batch you cancel is played by code, as a failed one is; then Claude gets the next turn', async () => {
    story.afterChange('test', db, dir)
    await drain()
    closeProtection(db)
    // Claude takes its time: the batch is still being written when you cancel it.
    process.env.TWOK_FAKE_HOLD = 'gm_swap'
    try {
      story.afterChange('test', db, dir)
      const batch = db.prepare("SELECT id, status, input FROM jobs WHERE kind = 'gm_swap'").get() as { id: number; status: string; input: string }
      expect(batch.status).toBe('running')
      const next = draftView(db).next!
      expect((JSON.parse(batch.input) as { cards: { cardId: number }[] }).cards[0]!.cardId).toBe(next.id)
      ai.cancel('test', db, dir, batch.id)
      // The draft moves on once the change is heard.
      await new Promise((r) => setImmediate(r))
      // Code played the turn it covered, saying why; nothing of its own answer landed.
      expect(db.prepare('SELECT note, job_id FROM draft_notes WHERE card_id = ?').get(next.id)).toEqual({ note: '작업이 취소돼 코드가 대신 골랐다.', job_id: null })
      expect(db.prepare('SELECT COUNT(*) AS n FROM draft_notes WHERE job_id = ?').get(batch.id)).toEqual({ n: 0 })
      // Claude gets the next turn.
      const swaps = jobs('gm_swap')
      expect(swaps.map((j) => j.status)).toEqual(['cancelled', 'running'])
      expect((JSON.parse(swaps[1]!.input) as { cards: { cardId: number }[] }).cards[0]!.cardId).toBe(draftView(db).next!.id)
    } finally {
      delete process.env.TWOK_FAKE_HOLD
    }
  })

  it('protection jobs you cancel are tried once more, as failed ones are, and never stall the draft', async () => {
    const live = () => (db.prepare("SELECT id FROM jobs WHERE kind = 'gm_protect' AND status IN ('queued', 'running')").all() as { id: number }[]).map((r) => r.id)
    process.env.TWOK_FAKE_HOLD = 'gm_protect'
    try {
      story.afterChange('test', db, dir)
      const first = live()
      expect(first.length).toBeGreaterThan(0)
      for (const id of first) ai.cancel('test', db, dir, id)
      await new Promise((r) => setImmediate(r))
      // The second (and last) try, for the teams that haven't decided.
      const second = live()
      expect(second.length).toBeGreaterThan(0)
      expect(second.filter((id) => first.includes(id))).toEqual([])
      for (const id of second) ai.cancel('test', db, dir, id)
      await new Promise((r) => setImmediate(r))
      expect(live()).toEqual([])
      expect(gm.status('test', db, dir).draft).toMatchObject({ working: 0, stuck: false })
    } finally {
      delete process.env.TWOK_FAKE_HOLD
    }
    // Once you close protection, the picks go on.
    closeProtection(db)
    story.afterChange('test', db, dir)
    await drain(40)
    expect(draftView(db).next).toBeNull()
  })

  it('after three failures in a row, code plays the rest', () => {
    story.afterChange('test', db, dir)
    closeProtection(db)
    db.prepare("UPDATE jobs SET status = 'cancelled' WHERE kind IN ('gm_protect', 'gm_swap') AND status IN ('queued', 'running')").run()
    for (let i = 0; i < 3; i++) failedBatch([-1])
    gm.reconcileDraft('test', db, dir)
    expect(draftView(db).next).toBeNull()
    expect(jobs('gm_swap').filter((j) => ['queued', 'running'].includes(j.status))).toHaveLength(0)
  })
})

describe('the AI-run draft (demo GMs)', () => {
  it('protects when the draft opens, then picks in turn once you close protection', async () => {
    expect(currentSeason(db).phase).toBe('draft')
    story.afterChange('test', db, dir)
    expect(jobs('gm_protect').length).toBeGreaterThan(0)
    await drain()
    const view = draftView(db)
    expect(view.protectedPlayers.length).toBe(8)
    // Protecting happens once a season, however often the story engine looks.
    story.afterChange('test', db, dir)
    expect(jobs('gm_protect').filter((j) => j.status === 'queued')).toHaveLength(0)

    closeProtection(db)
    story.afterChange('test', db, dir)
    await drain(30)
    expect(draftView(db).next).toBeNull()
    expect(listEvents(db, 'draft_swap').length).toBeGreaterThan(0)
    const notes = gm.draftNotes(db)
    expect(notes.filter((n) => n.kind === 'swap').length).toBe(listEvents(db, 'draft_swap').length)
    expect(notes.every((n) => n.note !== '')).toBe(true)
    expect(gm.status('test', db, dir).draft).toMatchObject({ working: 0, waitingFor: null })
  })

  it('waits for a team you run, then carries on', async () => {
    story.afterChange('test', db, dir)
    await drain()
    // The worst team picks first; make it yours.
    db.prepare("UPDATE teams SET control = 'user' WHERE id = 't8'").run()
    closeProtection(db)
    story.afterChange('test', db, dir)
    expect(jobs('gm_swap')).toHaveLength(0)
    expect(gm.status('test', db, dir).draft).toMatchObject({ working: 0, waitingFor: 't8' })
    const next = draftView(db).next!
    draftMove(db, { kind: 'pass', teamId: 't8', cardId: next.id })
    story.afterChange('test', db, dir)
    expect(jobs('gm_swap')).toHaveLength(1)
  })

  it('the forum follows the draft in one live thread', async () => {
    story.afterChange('test', db, dir)
    await drain()
    const key = `draft-live:${currentSeason(db).id}`
    const live = storyValue(db, key)
    expect(live).toMatch(/^\d+$/)
    closeProtection(db)
    story.afterChange('test', db, dir)
    await drain(30)
    const threads = jobs('event_thread').filter((j) => j.input.includes('draft-live'))
    expect(threads).toHaveLength(1)
    expect(jobs('live_comments').length).toBeGreaterThan(0)
    const comments = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(Number(live)) as { n: number }
    expect(comments.n).toBeGreaterThan(10)
  })
})
