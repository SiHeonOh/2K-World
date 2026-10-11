import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOPIC_KINDS } from '@shared/config/schema'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { loadConfig, seedLeague, updateConfig } from '@data/league'
import { pollView } from '@data/polls'
import { listGames, recordScore, startSeason } from '@data/season'
import { storyDemo, storyKinds, storyOutputSchema, type StoryInput } from '@story/jobs'
import type { JobRow } from '@ai/queue'
import { AiService } from './ai'
import { StoryService } from './story'

let dir: string
let db: Db
let ai: AiService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-polls-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  await ai.refresh()
  story = new StoryService(ai)
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const H = 3600_000
const drain = () => ai.queueFor('test', db, dir).kick()
const jobs = () => db.prepare('SELECT kind, status, input FROM jobs ORDER BY id').all() as { kind: string; status: string; input: string }[]
const neutral = (personaId: string) => (db.prepare('SELECT team_id FROM personas WHERE id = ?').get(personaId) as { team_id: string | null }).team_id === null

describe('polls on the boards', () => {
  it('turns a chatter poll topic into a real poll whose votes come in over time', async () => {
    // Nothing but poll topics, so the batch's plan has one.
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, community: { ...config.community, topicMix: Object.fromEntries(TOPIC_KINDS.map((k) => [k, k === 'poll' ? 5 : 0])) } })
    story.afterChange('test', db, dir)
    story.refresh('test', db, dir, () => 0.5)
    await drain()
    const chatter = JSON.parse(jobs().find((j) => j.kind === 'chatter_batch')!.input) as StoryInput
    expect(chatter.context).toContain('poll의 question')
    const planned = chatter.demo.poll!
    expect(planned.options.length).toBeGreaterThanOrEqual(3)
    story.refresh('test', db, dir, () => 0.5)
    const summary = story.front(db, dir).find((p) => p.pollState === 'open')!
    const view = story.post(db, summary.id).poll!
    expect(view.question).toBe(planned.question)
    expect(view.options.map((o) => o.text)).toEqual(planned.options)
    // Fans' votes were planned when it appeared; they keep arriving.
    const all = view.total + view.pending
    expect(all).toBeGreaterThan(0)
    expect(pollView(db, summary.id, Date.now() + 2 * H)!.total).toBe(all)
  })

  it('takes your poll: fans vote, you vote and change, and it closes when the next round is complete', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    await drain()
    const id = story.writePost('test', db, dir, { boardId: 'free', title: '이번 시즌 우승은?', body: '', poll: { question: '', options: ['가람고', '나람고', '다람고'] } })
    const view = story.post(db, id)
    expect(view.poll).toMatchObject({ question: '이번 시즌 우승은?', open: true, closesAfterRound: 1, closesAt: null, myVote: null })
    expect(view.poll!.total + view.poll!.pending).toBeGreaterThan(0)
    const pollId = view.poll!.id
    expect(story.pollVote(db, pollId, 0).myVote).toBe(0)
    expect(story.pollVote(db, pollId, 2).myVote).toBe(2)
    expect(() => story.pollVote(db, pollId, 3)).toThrow(/poll-bad-option/)
    expect(() => writeBad()).toThrow(/poll-options/)
    // The fans answering your post see the poll.
    await drain()
    expect(JSON.parse(jobs().find((j) => j.kind === 'reply_to_user')!.input).context).toContain('투표: 「이번 시즌 우승은?」 보기: 1번 「가람고」')

    // Every vote planned counts, those still on their way too: the round ending doesn't throw them away.
    const before = story.post(db, id).poll!
    const planned = before.total + before.pending
    for (const g of listGames(db, 1).filter((x) => x.round === 1)) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    const closed = story.post(db, id).poll!
    expect(closed).toMatchObject({ open: false, myVote: 2, pending: 0, total: planned })
    const results = story.post(db, closed.resultsPostId!)
    expect(results).toMatchObject({ title: '[투표 결과] 이번 시즌 우승은?', boardId: 'free', resultsOf: id })
    // Your poll's results come from a neutral regular.
    expect(neutral(results.author.id)).toBe(true)
    expect(results.body).toContain(`총 ${closed.total}표`)
    expect(() => story.pollVote(db, pollId, 1)).toThrow(/poll-closed/)
  })

  it('closes a day later outside the regular season; while the community is off it waits, and closes once it is on', () => {
    story.front(db, dir)
    const id = story.writePost('test', db, dir, { boardId: 'free', title: '최애 학교', body: '', poll: { question: '어디 응원함?', options: ['가람고', '나람고'] } })
    const poll = story.post(db, id).poll!
    expect(poll.closesAfterRound).toBeNull()
    expect(Date.parse(poll.closesAt!) - Date.now()).toBeGreaterThan(23 * H)
    // Its day is over: the next look at the board closes it.
    const past = new Date(Date.now() - 60_000).toISOString()
    db.prepare('UPDATE polls SET closes_at = ?').run(past)
    const board = story.board(db, dir, 'free', 1)
    expect(board.posts.find((p) => p.id === id)!.pollState).toBe('closed')
    expect(board.posts.some((p) => p.title === '[투표 결과] 어디 응원함?')).toBe(true)

    const { config } = loadConfig(db)
    story.saveSettings(db, { ...config.community, enabled: false })
    const quiet = story.writePost('test', db, dir, { boardId: 'free', title: '조용한 투표', body: '', poll: { question: '', options: ['가', '나'] } })
    db.prepare('UPDATE polls SET closes_at = ? WHERE closed_at IS NULL').run(past)
    expect(story.post(db, quiet).poll).toMatchObject({ open: false, closedAt: null, resultsPostId: null })
    expect(() => story.pollVote(db, story.post(db, quiet).poll!.id, 0)).toThrow(/poll-closed/)
    story.saveSettings(db, { ...loadConfig(db).config.community, enabled: true })
    const after = story.board(db, dir, 'free', 1)
    expect(story.post(db, quiet).poll).toMatchObject({ open: false, closedAt: past })
    // Its results post is the newest post.
    expect(after.posts[0]!.title).toBe('[투표 결과] 조용한 투표')
  })

  it('holds a round poll while the community is off and closes it, votes and all, once it is on', () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    const id = story.writePost('test', db, dir, { boardId: 'free', title: '1라운드 승자는?', body: '', poll: { question: '', options: ['가람고', '나람고'] } })
    const before = story.post(db, id).poll!
    const planned = before.total + before.pending
    const { config } = loadConfig(db)
    story.saveSettings(db, { ...config.community, enabled: false })
    for (const g of listGames(db, 1).filter((x) => x.round === 1)) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
    story.afterChange('test', db, dir)
    const held = story.post(db, id).poll!
    expect(held).toMatchObject({ open: false, closedAt: null, resultsPostId: null })
    story.saveSettings(db, { ...loadConfig(db).config.community, enabled: true })
    const closed = story.post(db, id).poll!
    expect(closed).toMatchObject({ open: false, closedAt: held.closesAt, total: planned, pending: 0 })
    expect(story.post(db, closed.resultsPostId!).title).toBe('[투표 결과] 1라운드 승자는?')
  })

  it('counts a view when the post is opened, not when the open page reads it again', () => {
    story.front(db, dir)
    const id = story.writePost('test', db, dir, { boardId: 'free', title: '조회수', body: '', poll: { question: '', options: ['가', '나'] } })
    expect(story.post(db, id).views).toBe(1)
    db.prepare('UPDATE posts SET read_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 60_000).toISOString(), id)
    expect(story.post(db, id, true).views).toBe(1)
    db.prepare('UPDATE posts SET read_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 60_000).toISOString(), id)
    expect(story.post(db, id).views).toBe(2)
  })

  it("stores a writer's poll from an event thread, and the writer's results come from the writer", () => {
    story.front(db, dir)
    const fan = (db.prepare("SELECT id FROM personas WHERE kind = 'fan' AND team_id IS NOT NULL ORDER BY id LIMIT 1").get() as { id: string }).id
    const kind = storyKinds(db).find((k) => k.kind === 'event_thread')!
    const jobId = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('event_thread', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    const input = { board: 'main', spreadMs: 0, asOfEvent: 0 } as unknown as StoryInput
    const output = storyOutputSchema.parse({
      posts: [{ board: 'main', author: fan, tag: '투표', title: '[투표] 최악의 트레이드는?', body: '', heat: 4, comments: [], poll: { question: null, options: ['1번 가람고 쪽', '2번 나람고 쪽', '2번 나람고 쪽'] } }],
    })
    kind.accept!(output, { id: jobId, kind: 'event_thread', input } as unknown as JobRow)
    const post = story.front(db, dir).find((p) => p.pollState === 'open')!
    const view = story.post(db, post.id)
    expect(view.poll).toMatchObject({ question: '최악의 트레이드는?', options: [{ text: '가람고 쪽' }, { text: '나람고 쪽' }] })
    db.prepare('UPDATE polls SET closes_at = ?').run(new Date(Date.now() - 1000).toISOString())
    const results = story.post(db, story.post(db, post.id).poll!.resultsPostId!)
    expect(results.author.id).toBe(fan)
  })
})

function writeBad() {
  return story.writePost('test', db, dir, { boardId: 'free', title: '이상한 투표', body: '', poll: { question: 'q', options: ['하나'] } })
}
