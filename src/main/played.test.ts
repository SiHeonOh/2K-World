import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { addPost, listPersonas } from '@data/community'
import { openDb, type Db } from '@data/db'
import { windowAfterRound } from '@data/gm'
import { currentSeason, listPlayers, listTeams, loadConfig, seedLeague, updateConfig } from '@data/league'
import { addPlayedGame, closeSession } from '@data/played'
import { pollView } from '@data/polls'
import { recordScore, startPlayoffs, startSeason } from '@data/season'
import { PLAYED_NOTE, readLeague, roundUpInput } from '@story/context'
import { storyDemo, storyKinds } from '@story/jobs'
import { suggestInput } from '@story/loreJobs'
import { WIKI_EDITS, wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { gmDemo, gmKinds, type GmHooks } from '@sim/gm'
import { AiService } from './ai'
import { GmService } from './gm'
import { StoryService } from './story'

/**
 * 2K 일정대로 and the story engine: 오늘 경기 끝 is what completes a round
 * (a session, N일차), however many games it had, so round-ups, wiki edits,
 * the lore sweep, trade windows and round polls all follow it.
 */

let dir: string
let db: Db
let ai: AiService
let gm: GmService
let story: StoryService
/** Rounds the lore sweep hook was called for (it also opens trade windows, as in context.ts). */
let swept: number[]

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-played-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  setup.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'played' }
  setup.config.gm.tradeWindowEveryRounds = 2
  seedLeague(db, setup)
  ai = new AiService()
  const hooks = (slug: string, d: Db, f: string): GmHooks => ({
    queue: (kind, input, priority) => void ai.queueFor(slug, d, f).enqueue(kind, input, priority),
    changed: () => story.afterChange(slug, d, f),
  })
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f, slug) => gmKinds(d, f, hooks(slug, d, f)), gmDemo)
  await ai.refresh()
  gm = new GmService(ai, hooks)
  swept = []
  story = new StoryService(ai, {
    onRound: (slug, d, f, season, round) => {
      swept.push(round)
      return gm.onRound(slug, d, f, season, round)
    },
  })
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]
const roundUps = () => jobs('event_thread').filter((j) => j.input.includes('일차 정리다.'))
const look = () => story.afterChange('test', db, dir)
/** A game just played in 2K: added to the open session and recorded, its home school's two best players on the box score. */
function playGame(home: string, away: string, homeScore = 90, awayScore = 80): number {
  const { gameId } = addPlayedGame(db, { home, away })
  const lines = listPlayers(db)
    .filter((p) => p.teamId === home || p.teamId === away)
    .slice(0, 4)
    .map((p, i) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 30 - i * 5, reb: 5, ast: 3 } }))
  recordScore(db, { gameId, homeScore, awayScore, lines })
  return gameId
}

describe('오늘 경기 끝 and what follows it', () => {
  it('writes the session’s round-up and wiki edits and runs the lore sweep only when it closes, however uneven', () => {
    startSeason(db)
    look()
    // t1 plays twice, t7 and t8 rest: no round is "full" here, and none needs to be.
    playGame('t1', 't2')
    playGame('t3', 't1')
    playGame('t5', 't6')
    look()
    expect(roundUps()).toHaveLength(0)
    expect(swept).toEqual([])
    closeSession(db)
    look()
    expect(roundUps()).toHaveLength(1)
    expect(swept).toEqual([1])
    expect(jobs(WIKI_EDITS)).toHaveLength(1)
    // Looking again doesn't write it twice.
    look()
    expect(roundUps()).toHaveLength(1)
    expect(swept).toEqual([1])

    // What the writers read: the session's name, who played how often, and that schools are uneven. Never "N라운드", never "R1".
    const input = JSON.parse(roundUps()[0]!.input) as { instructions: string; context: string; demo: { headline: string } }
    expect(input.instructions).toBe('1일차 정리다.')
    expect(input.demo.headline).toBe('1일차 정리')
    expect(input.context).toContain('1일차 경기가 모두 끝났다(3경기)')
    expect(input.context).toContain('# 1일차 결과')
    expect(input.context).toMatch(/# 1일차에 뛴 학교 \(나머지는 쉼\)\n.*가람고 2경기/)
    expect(input.context).toContain(PLAYED_NOTE)
    expect(input.context).toContain('말머리 일차 정리')
    for (const text of [input.instructions, input.context]) {
      expect(text).not.toMatch(/\d+라운드/)
      expect(text).not.toMatch(/\bR1\b/)
      expect(text).not.toContain('라운드 정리')
    }
    const wiki = JSON.parse(jobs(WIKI_EDITS)[0]!.input) as { instructions: string; context: string }
    expect(wiki.context).toContain('1일차 결과(앞이 홈)')
    expect(wiki.instructions).toContain('1일차는 2K 일정대로 경기한 날 묶음이다')
    for (const text of [wiki.instructions, wiki.context]) {
      expect(text).not.toMatch(/\d+라운드/)
      expect(text).not.toMatch(/\bR1\b/)
    }
    // The lore sweep's input says the session too.
    const sweep = suggestInput(readLeague(db, dir), currentSeason(db).id, 1)!
    expect(sweep.instructions).toBe('1일차 경기가 끝났다(2K 일정대로: 학교마다 치른 경기 수가 다르다).')
    expect(sweep.context).toContain('# 1일차 결과')
    expect(sweep.context).not.toMatch(/\bR1\b/)
  })

  it('opens trade windows every N sessions closed, counting sessions rather than games', () => {
    startSeason(db)
    look()
    const season = currentSeason(db).id
    playGame('t1', 't2')
    closeSession(db)
    look()
    expect(windowAfterRound(db, season, 1)).toBe(false)
    // Session 2 is one game: with a window every 2 sessions, its close opens one.
    playGame('t3', 't4')
    look()
    expect(windowAfterRound(db, season, 2)).toBe(false)
    closeSession(db)
    look()
    expect(swept).toEqual([1, 2])
    expect(windowAfterRound(db, season, 2)).toBe(true)
    expect(jobs('gm_intent').length).toBeGreaterThan(0)
    // The GMs are told which session it came after.
    expect(jobs('gm_intent')[0]!.input).toContain('2일차 일정이 끝나고 열린 트레이드 창')
    // 단장실 counts the next window from the sessions closed, not the one being played.
    playGame('t5', 't6')
    expect(gm.status('test', db, dir).nextRound).toBe(4)
  })

  it('closes the round polls waiting for the session when it closes, not before', () => {
    startSeason(db)
    look()
    const { community } = loadConfig(db).config
    const fan = listPersonas(db).find((p) => p.kind === 'fan')!
    const post = addPost(db, community, { board: 'main', author: fan.id, title: '오늘 누가 이김?', body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'thread' }, Date.now(), 0)
    expect(pollView(db, post, Date.now())).toMatchObject({ open: true, closesAfterRound: 1, closesAt: null })
    playGame('t1', 't2')
    look()
    expect(pollView(db, post, Date.now())!.open).toBe(true)
    closeSession(db)
    look()
    expect(pollView(db, post, Date.now() + 1000)!.open).toBe(false)
    // A poll opened now waits for session 2.
    const next = addPost(db, community, { board: 'main', author: fan.id, title: '다음은?', body: '', comments: [], poll: { options: ['다람고', '라람고'] } }, { kind: 'thread' }, Date.now(), 0)
    expect(pollView(db, next, Date.now())!.closesAfterRound).toBe(2)
  })

  it('closes the last session with 플레이오프 시작, and still writes its round-up', () => {
    // The community's first look, then every pair meets: 27 games and a close, then the last one.
    startSeason(db)
    look()
    const ids = listTeams(db).map((t) => t.id)
    const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const))
    pairs.slice(0, 27).forEach(([a, b]) => {
      const { gameId } = addPlayedGame(db, { home: a, away: b })
      recordScore(db, { gameId, homeScore: 90, awayScore: 80, lines: null })
    })
    closeSession(db)
    look()
    playGame(...pairs[27]!)
    look()
    expect(roundUps().filter((j) => j.input.includes('2일차 정리다.'))).toHaveLength(0)
    startPlayoffs(db)
    look()
    expect(roundUps().filter((j) => j.input.includes('2일차 정리다.'))).toHaveLength(1)
    expect(swept).toEqual([1, 2])
  })

  it('says 라운드 in a round-built league, as before', () => {
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, season: { ...config.season, schedule: { kind: 'round-robin', cycles: 1, build: 'auto' } } })
    startSeason(db)
    const round1 = db.prepare("SELECT id FROM games WHERE round = 1 AND stage = 'regular'").all() as { id: number }[]
    for (const g of round1) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
    const input = roundUpInput(readLeague(db, dir), currentSeason(db).id, 1)!
    expect(input.instructions).toBe('R1 라운드 정리다.')
    expect(input.context).not.toContain(PLAYED_NOTE)
  })
})
