import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import type { TradeItem } from '@shared/season'
import { lastEventId, setStoryValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { currentSeason, listEvents, listPlayers, seedLeague } from '@data/league'
import { applyTrade } from '@data/moves'
import { pollView } from '@data/polls'
import { listGames, recordScore, startSeason } from '@data/season'
import { pageByRef, revisionBody } from '@data/wiki'
import { tradeIsBlockbuster } from '@sim/gm'
import { BLOCKBUSTER_NOTE, readLeague, TRADE_POLL, TRADE_POLL_BOTH } from '@story/context'
import { leagueFeelings } from '@story/feelings'
import { storyDemo, storyKinds, type StoryInput } from '@story/jobs'
import { PLAYER_REACTION, reactionDemo, reactionKind, type PlayerReactionInput } from '@story/reactions'
import { wikiEditDemo, wikiEditKind, type WikiEditInput } from '@story/wikiEdits'
import { AiService } from './ai'
import { StoryService } from './story'

/**
 * A trade that moves a star gets the story engine's big treatment: a long
 * article on the stats pack and a busier thread with a poll, the star and the
 * key teammates on both sides speaking, and a fuller wiki write-up with a
 * paragraph in the star's 역사.
 */

let dir: string
let db: Db
let ai: AiService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-blockbuster-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f, slug) => [reactionKind(d, f, { requeue: (input) => void ai.queueFor(slug, d, f).enqueue(PLAYER_REACTION, input, 22), changed: () => story.afterChange(slug, d, f) })], reactionDemo)
  await ai.refresh()
  story = new StoryService(ai)
  // 가람고's PG (p1) is the league's star; everyone else is 70–75.
  db.prepare("UPDATE ratings SET num = 99 WHERE player_id = 'p1' AND column_id = 'ovr'").run()
  startSeason(db)
  // Two rounds with box lines, so the stats pack has a season to tell.
  for (const g of listGames(db, currentSeason(db).id).filter((x) => x.round <= 2)) {
    const lines = listPlayers(db)
      .filter((p) => p.teamId === g.home || p.teamId === g.away)
      .map((p) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: p.id === 'p1' ? 31 : 12, reb: 5, ast: 3, fgm: 5, fga: 10 } }))
    recordScore(db, { gameId: g.id, homeScore: 88, awayScore: 80, lines })
  }
  setStoryValue(db, 'events-handled', String(lastEventId(db)))
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = async () => {
  for (let i = 0; i < 6; i++) {
    await ai.queueFor('test', db, dir).kick()
    await new Promise((r) => setImmediate(r))
  }
}
const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]
const nameOf = (id: string) => listPlayers(db).find((p) => p.id === id)!.name
const flags = () => (db.prepare('SELECT COUNT(*) AS n FROM ai_flags').get() as { n: number }).n

/** A trade made the way the app makes one: tagged first, from the league as it stood. */
function trade(items: TradeItem[]): void {
  const blockbuster = tradeIsBlockbuster(db, dir, items)
  applyTrade(db, items, 'user', '', blockbuster ? { blockbuster } : undefined)
}

// The star and 가람고's weakest (SG 71) to 나람고 for its C (74) and PF (73): a consolidation.
const STAR_DEAL: TradeItem[] = [
  { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
  { kind: 'player', playerId: 'p2', from: 't1', to: 't2' },
  { kind: 'player', playerId: 'p11', from: 't2', to: 't1' },
  { kind: 'player', playerId: 'p10', from: 't2', to: 't1' },
]

describe('blockbuster coverage', () => {
  it('the trade is tagged, and the thread asks for the long article and a poll, with the stats pack', () => {
    trade(STAR_DEAL)
    expect(listEvents(db, 'trade_applied').at(-1)!.payload).toMatchObject({ blockbuster: true })
    story.afterChange('test', db, dir)
    const thread = JSON.parse(jobs('event_thread').at(-1)!.input) as StoryInput
    expect(thread.instructions).toBe(BLOCKBUSTER_NOTE)
    expect(thread.guide).toContain('1,000~2,500자')
    expect(thread.guide).toContain('댓글 20~30개')
    expect(thread.guide).toContain(`질문 "${TRADE_POLL}", 보기는 "가람고", "나람고", "${TRADE_POLL_BOTH}"`)
    // What each school sent, the star, and the stats pack: both schools' seasons and every moved player's, the star first.
    expect(thread.context).toContain('# 블록버스터 트레이드')
    expect(thread.context).toMatch(/- 가람고 → 나람고: \S+\(포인트 가드\), \S+\(슈팅 가드\)/)
    expect(thread.context).toContain(`- 이 트레이드의 스타: ${nameOf('p1')} (가람고에서 나람고(으)로)`)
    expect(thread.context).toContain('# 두 학교 시즌 기록')
    expect(thread.context).toMatch(/\[가람고\] 2경기 \d승 \d패/)
    expect(thread.context).toMatch(/\[나람고\] 2경기 \d승 \d패/)
    const players = thread.context.slice(thread.context.indexOf('# 옮긴 선수들의 시즌 기록'))
    expect(players).toContain(`[${nameOf('p1')}(가람고)] 2경기 평균 31.0점`)
    for (const id of ['p2', 'p10', 'p11']) expect(players).toContain(`[${nameOf(id)}(`)
    // A busier crowd than an ordinary trade's.
    expect(thread.demo.fans.length).toBeGreaterThan(16)
  })

  it('an ordinary trade gets the ordinary thread', () => {
    trade([
      { kind: 'player', playerId: 'p14', from: 't3', to: 't4' },
      { kind: 'player', playerId: 'p20', from: 't4', to: 't3' },
    ])
    expect(listEvents(db, 'trade_applied').at(-1)!.payload).not.toHaveProperty('blockbuster')
    story.afterChange('test', db, dir)
    const thread = JSON.parse(jobs('event_thread').at(-1)!.input) as StoryInput
    expect(thread.guide).toBeUndefined()
    expect(thread.context).not.toContain('# 블록버스터 트레이드')
    const wiki = JSON.parse(jobs('wiki_edits').at(-1)!.input) as WikiEditInput
    expect(wiki.instructions).not.toContain('블록버스터')
  })

  it('the star and the key teammate on each side have their say', () => {
    trade(STAR_DEAL)
    story.afterChange('test', db, dir)
    const input = JSON.parse(jobs(PLAYER_REACTION).at(-1)!.input) as PlayerReactionInput
    const who = input.players.map((p) => p.playerId)
    expect(who[0]).toBe('p1')
    // 가람고's best who stayed (its bench, 75) and 나람고's (its bench, 75), on top of the four who moved: six, a batch's worth.
    expect(who).toEqual(expect.arrayContaining(['p1', 'p2', 'p10', 'p11', 'p6', 'p12']))
    expect(who).toHaveLength(6)
    expect(input.players.find((p) => p.playerId === 'p6')!.causes[0]).toBe(`${nameOf('p1')}이(가) 트레이드로 나람고(으)로 떠남`)
    expect(input.players.find((p) => p.playerId === 'p12')!.causes[0]).toBe(`스타 ${nameOf('p1')}이(가) 트레이드로 우리 학교에 합류함`)
  })

  it('the wiki writes it up fuller, with a paragraph in the star’s 역사; the forum gets its poll; numbers all from the facts', async () => {
    trade(STAR_DEAL)
    story.afterChange('test', db, dir)
    const wiki = JSON.parse(jobs('wiki_edits').at(-1)!.input) as WikiEditInput
    expect(wiki.instructions).toMatch(/^이번 일은 블록버스터 트레이드다: 리그의 스타 \S+[이가] 학교를 옮겼다\./)
    expect(wiki.instructions).toContain('문서의 역사 문단에 이 트레이드를 한 문단으로 덧붙인다')
    // The star's page first, then the others who moved and both schools.
    expect(wiki.pages[0]).toBe(nameOf('p1'))
    expect(wiki.pages).toEqual(expect.arrayContaining([nameOf('p2'), nameOf('p10'), nameOf('p11'), '가람고', '나람고']))
    expect(wiki.context).toMatch(/- 가람고 → 나람고: \S+\(포인트 가드\)/)
    expect(wiki.context).toMatch(new RegExp(`- ${nameOf('p1')}: 2경기 평균 31\\.0점`))
    await drain()
    const page = pageByRef(db, 'player', 'p1')!
    const body = revisionBody(db, page.id, page.currentRev!)!.body
    const history = body.slice(body.indexOf('== 역사 =='), body.indexOf('== 플레이 스타일 =='))
    expect(history).toContain('[역사]')
    expect(history).toContain('트레이드 성사(블록버스터')
    // The fans' thread carries the poll: who won the trade.
    const poll = db.prepare('SELECT post_id FROM polls ORDER BY id DESC LIMIT 1').get() as { post_id: number } | undefined
    expect(poll).toBeDefined()
    const view = pollView(db, poll!.post_id, Date.now())!
    expect(view.question).toBe(TRADE_POLL)
    expect(view.options.map((o) => o.text)).toEqual(['가람고', '나람고', TRADE_POLL_BOTH])
    // The reporter's long article is up too, the poll on the fans' thread beside it.
    const event = listEvents(db, 'trade_applied').at(-1)!.id
    const posts = db.prepare('SELECT id, kind, body FROM posts WHERE event_id = ? ORDER BY id').all(event) as { id: number; kind: string; body: string }[]
    expect(posts.find((p) => p.kind === 'article')!.body).toContain('이 트레이드의 스타')
    expect(posts.find((p) => p.kind === 'thread')!.id).toBe(poll!.post_id)
    expect(flags()).toBe(0)
  })

  it('losing the star already weighs on those left behind and on him (the existing mood code)', () => {
    // 가람고 sends its star for one 74 and keeps losing value; he goes without asking.
    trade([
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p11', from: 't2', to: 't1' },
    ])
    const feelings = leagueFeelings(readLeague(db, dir))
    // He leaves a grudge at the school that sent him away.
    expect(feelings.get('p1')!.grudges.some((g) => g.target.id === 't1' && g.why === 'sent_away')).toBe(true)
    // His old teammates trust their GM less for a deal that made them weaker.
    for (const id of ['p3', 'p4', 'p6']) expect(feelings.get(id)!.why.trust.some((r) => r.key === 'deal' && r.value < 0)).toBe(true)
  })
})
