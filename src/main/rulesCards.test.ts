import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { TOPIC_KINDS, type TopicKind } from '@shared/config/schema'
import { sampleSetup } from '@shared/testing/fixtures'
import { lastEventId, setStoryValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { readDraftOutlook } from '@data/draftOutlook'
import { appendEvent, currentSeason, loadConfig, seedLeague, updateConfig } from '@data/league'
import { applyTrade, closeProtection, draftMove, draftView, listCards } from '@data/moves'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from '@data/season'
import { chatterInput, ensureCast, readLeague, roundUpInput } from '@story/context'
import { RULES_HEADING } from '@story/leagueRules'
import { readFacts, unknownNumbers } from '@story/numbers'
import { planTopics } from '@story/topics'
import { storyDemo, storyKinds, type StoryInput } from '@story/jobs'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { AiService } from './ai'
import { StoryService } from './story'

/**
 * The writers get the league's rules and the schools' draft cards where
 * they argue about trades and the draft: trade and draft threads, a trade
 * window's close, the draft's live thread, chatter, replies; round-ups get
 * the playoffs' format. A made-up card-swap league (가람고 t1 … 아람고 t8):
 * 5 cards for 1st, 4 for 2nd to 4th, 3 for the rest, a cap of 3 cards given
 * in season, 바람고 (t6) frozen, every PG a star (OVR 90).
 */

let dir: string
let db: Db
let ai: AiService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-rules-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 1, cards: 5 },
      { fromRank: 2, toRank: 4, cards: 4 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
  }
  setup.teams[5]!.control = 'frozen'
  for (const p of setup.players) p.ratings = { ovr: p.slotId === 'pg' ? 90 : 60, shoot: 'B' }
  seedLeague(db, setup)
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  await ai.refresh()
  story = new StoryService(ai)
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = () => ai.queueFor('test', db, dir).kick()
const inputs = (kind: string) => (db.prepare('SELECT input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { input: string }[]).map((j) => JSON.parse(j.input) as StoryInput)
/** The story mark moved past everything so far, as if it had all been written about. */
const caughtUp = () => setStoryValue(db, 'events-handled', String(lastEventId(db)))
/** A block of a job's context, by its heading. */
const block = (context: string, heading: string) => context.split('\n\n').find((b) => b.startsWith(heading)) ?? ''
const CARDS = '# 학교별 드래프트 카드'
/** The schools a card table has a line for, in its order. */
const schoolsIn = (cards: string) => cards.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(/[ (:]/)[0]!)
/** Only these chatter topics, at these weights. */
const mix = (weights: Partial<Record<TopicKind, number>>) => {
  const { config } = loadConfig(db)
  updateConfig(db, { ...config, community: { ...config.community, topicMix: { ...Object.fromEntries(TOPIC_KINDS.map((k) => [k, 0])), ...weights } } })
}

/** Plays the scheduled games of these stages, again and again (series add games), at most `limit`: the lower-numbered school wins. */
function playAll(stages: (stage: string) => boolean, limit = Infinity): void {
  let played = 0
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && stages(g.stage))
    if (open.length === 0) return
    for (const g of open) {
      if (played++ >= limit) return
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
  }
}

function sellCards(from: string, to: string, numbers: number[]): void {
  const cards = listCards(db, currentSeason(db).id).filter((c) => c.originalTeamId === from && numbers.includes(c.number))
  applyTrade(db, cards.map((c) => ({ kind: 'card' as const, cardId: c.id, from, to })))
}

/** Two rounds played and written about. */
function inSeason(): void {
  startSeason(db)
  playAll((s) => s === 'regular', 8)
  caughtUp()
}

describe('trade and draft threads', () => {
  it('a trade’s thread gets the rules, what each side sent, and both schools’ cards after it', () => {
    inSeason()
    const card = listCards(db, currentSeason(db).id).find((c) => c.originalTeamId === 't1' && c.number === 3)!
    applyTrade(db, [
      { kind: 'player', playerId: 'p2', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p8', from: 't2', to: 't1' },
      { kind: 'card', cardId: card.id, from: 't1', to: 't2' },
    ])
    story.afterChange('test', db, dir)
    const input = inputs('event_thread').find((i) => i.context.includes('트레이드 성사'))!
    expect(input.context).toContain(RULES_HEADING)
    expect(input.context).toContain('- 두 학교끼리만(삼각 트레이드 없음), 선수는 같은 수끼리(1대1, 2대2…), 선수 트레이드에 카드를 얹어도 된다.')
    const sent = block(input.context, '# 트레이드로 오간 것').split('\n')
    expect(sent.slice(1).sort()).toEqual(['- 가람고 → 나람고: 가나나(슈팅 가드), 가람고 3번 카드', '- 나람고 → 가람고: 나나다(슈팅 가드)'])
    // The two schools only, as they stand after it.
    const cards = block(input.context, CARDS)
    expect(schoolsIn(cards).sort()).toEqual(['가람고', '나람고'])
    expect(cards).toContain('카드 2장(자기 1·2번) · 내준 카드 자기 3번→나람고 · 시즌 중 내준 카드 1장(한도까지 2장 남음)')
    expect(cards).toContain('카드 4장(자기 1·2·3번, 가람고 3번)')
  })

  it('your news about trades gets the rules and the cards of the schools it names; other news neither', () => {
    inSeason()
    story.news('test', db, dir, '가람고가 트레이드 시장에 나왔다는 소식')
    const trade = inputs('event_thread').at(-1)!
    expect(trade.context).toContain(RULES_HEADING)
    expect(schoolsIn(block(trade.context, CARDS))).toEqual(['가람고'])
    story.news('test', db, dir, '가람고 체육관 공사가 끝났다')
    const other = inputs('event_thread').at(-1)!
    expect(other.context).not.toContain(RULES_HEADING)
    expect(other.context).not.toContain(CARDS)
  })

  it('a trade window’s close and its leaks get every school’s cards', () => {
    inSeason()
    const season = currentSeason(db).id
    appendEvent(db, 'trade_talks', { negotiationId: 1, teams: ['t1', 't2'], players: ['p1'] }, season)
    appendEvent(db, 'trade_window_closed', { windowId: 1, trades: 0, talks: 2 }, season)
    story.afterChange('test', db, dir)
    const input = inputs('event_thread').find((i) => i.context.includes('트레이드 창 마감'))!
    expect(input.context).toContain(RULES_HEADING)
    expect(schoolsIn(block(input.context, CARDS))).toHaveLength(8)
  })

  it('the draft’s live thread, and the comments that follow, get the whole draft room', async () => {
    startSeason(db)
    playAll((s) => s === 'regular')
    startPlayoffs(db)
    playAll((s) => s !== 'regular')
    finishPlayoffs(db)
    closeProtection(db)
    caughtUp()
    // 아람고 picks first: its bench player for 가람고's star.
    const first = draftView(db).next!
    expect(first.ownerTeamId).toBe('t8')
    draftMove(db, { kind: 'swap', teamId: 't8', cardId: first.id, playerId: 'p48', targetPlayerId: 'p1' })
    story.afterChange('test', db, dir)
    const live = inputs('event_thread').find((i) => i.liveKey)!
    expect(live.context).toContain(RULES_HEADING)
    const room = block(live.context, '# 드래프트 현황')
    expect(room).toContain('지명 순서: 아람고 → 사람고 → 마람고 → 라람고 → 다람고 → 나람고 → 가람고')
    expect(room).toContain('최근: 아람고: 아바가 주고 가람고 가가가 데려옴')
    expect(schoolsIn(room)).toHaveLength(8)
    await drain()
    // The next move goes to the thread as comments, with the room as it is then.
    const next = draftView(db).next!
    draftMove(db, { kind: 'pass', teamId: next.ownerTeamId, cardId: next.id })
    story.afterChange('test', db, dir)
    const comments = inputs('live_comments').at(-1)!
    expect(comments.context).toContain(RULES_HEADING)
    expect(block(comments.context, '# 드래프트 현황')).toContain('최근: 아람고: 아바가 주고 가람고 가가가 데려옴 / 사람고 패스')
  })
})

describe('chatter, replies and round-ups', () => {
  it('chatter gets the rules and the cards of the schools it plans to write about', () => {
    inSeason()
    mix({ school_pride: 5 })
    const league = readLeague(db, dir)
    ensureCast(league)
    const input = chatterInput(league)
    expect(input.context).toContain(RULES_HEADING)
    const schools = schoolsIn(block(input.context, CARDS))
    expect(schools.length).toBeGreaterThan(0)
    expect(schools.length).toBeLessThanOrEqual(2)
    for (const s of schools) expect(input.demo.teams).toContain(s)
  })

  it('plans 드래프트 보호 위기 only when a school is short of cards for its star or sits on others’, with every school’s cards', () => {
    inSeason()
    mix({ draft_watch: 5 })
    const plan = () => Array.from({ length: 12 }, (_, seed) => planTopics(readLeague(db, dir), 8, seed + 1)).flat()
    expect(plan()).toEqual([])
    // 아람고 sells its three cards to 가람고: its star can't be protected, and 가람고 sits on three of its cards.
    sellCards('t8', 't1', [1, 2, 3])
    const topics = plan()
    expect(topics.length).toBeGreaterThan(0)
    for (const t of topics) {
      expect(t).toMatchObject({ kind: 'draft_watch', board: 'draft', tag: '드래프트', market: true })
      expect(['t1', 't8']).toContain(t.teams[0])
    }
    const crunch = topics.find((t) => t.teams[0] === 't8')!
    expect(crunch.brief).toMatch(/^아람고 드래프트 보호 위기 글: /)
    expect(crunch.facts[0]).toMatch(/^아람고 \d위: 카드 0장 · 내준 카드 자기 1·2·3번→가람고 · 시즌 중 내준 카드 3장\(한도 다 씀\) · 드래프트 예상 0장/)
    expect(crunch.facts[1]).toBe('리그 정상급(상위 10%) 선수: 아가아(OVR 90)')
    expect(topics.find((t) => t.teams[0] === 't1')!.brief).toMatch(/^가람고 카드 사재기 글: /)
    // In the chatter: every school's cards.
    const league = readLeague(db, dir)
    ensureCast(league)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T12:00:00Z'))
    const input = chatterInput(league)
    spy.mockRestore()
    expect(input.context).toContain('[드래프트 보호 위기 · 게시판 draft')
    expect(schoolsIn(block(input.context, CARDS))).toHaveLength(8)
  })

  it('can make the draft’s storyline an analysis column, with the school’s cards in its pack', () => {
    inSeason()
    mix({ analysis: 5 })
    sellCards('t8', 't1', [1, 2, 3])
    const columns = Array.from({ length: 12 }, (_, seed) => planTopics(readLeague(db, dir), 8, seed + 1))
      .flat()
      .filter((t) => t.kind === 'analysis' && /드래프트 보호 위기|카드 사재기/.test(t.facts[0] ?? ''))
    expect(columns.length).toBeGreaterThan(0)
    for (const t of columns) {
      expect(t.market).toBe(true)
      expect(t.pack![0]).toMatch(/^(아람고|가람고) \d위: 카드 /)
    }
  })

  it('a reply gets the rules and the cards of the schools you named; every school’s when you ask about cards', () => {
    inSeason()
    story.writePost('test', db, dir, { boardId: 'free', title: '가람고 요즘 어떰?', body: '1위 굳히기 가능?' })
    const named = inputs('reply_to_user').at(-1)!
    expect(named.context).toContain(RULES_HEADING)
    expect(schoolsIn(block(named.context, CARDS))).toEqual(['가람고'])
    story.writePost('test', db, dir, { boardId: 'free', title: '드래프트 카드 누가 제일 많음?', body: '' })
    expect(schoolsIn(block(inputs('reply_to_user').at(-1)!.context, CARDS))).toHaveLength(8)
  })

  it('a round-up gets the playoffs’ format, not the trade rules or the cards', () => {
    startSeason(db)
    playAll((s) => s === 'regular', 4)
    const input = roundUpInput(readLeague(db, dir), currentSeason(db).id, 1)!
    const rules = block(input.context, RULES_HEADING)
    expect(rules).toContain('## 플레이오프')
    expect(rules).not.toContain('## 트레이드')
    expect(input.context).not.toContain(CARDS)
  })
})

describe('the number check', () => {
  it('passes writers quoting the rules and the card table, and still catches a made-up count', () => {
    inSeason()
    sellCards('t8', 't1', [1, 2, 3])
    appendEvent(db, 'trade_window_closed', { windowId: 1, trades: 1, talks: 1 }, currentSeason(db).id)
    story.afterChange('test', db, dir)
    const input = inputs('event_thread').find((i) => i.context.includes('트레이드 창 마감'))!
    const facts = readFacts(input.context, input.instructions)
    const t1 = readDraftOutlook(db)!.schools.find((s) => s.teamId === 't1')!
    for (const text of [
      '카드는 1위 5장, 2~4위 4장, 5~8위 3장이고 3장은 개막 때 받음',
      '시즌 중엔 3장까지만 내줄 수 있는데 아람고는 한도 다 씀',
      '아람고 카드 0장 ㅋㅋ 아가아(OVR 90) 지킬 카드도 없네',
      `가람고는 카드 6장 들고 ${t1.rank}위라 드래프트 예상 ${t1.projected}장, ${t1.toCome}장 더 받는다던데`,
      '팀당 7경기에 시리즈는 7전 4선승',
      '아람고 1·2·3번 카드 전부 가람고가 들고 있음',
    ]) {
      expect(unknownNumbers(text, facts), text).toEqual([])
    }
    expect(unknownNumbers('가람고 카드 27장 쌓아둠', facts)).toEqual(['27'])
  })
})
