import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { lastEventId, lastNewsEventId, setStoryValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { appendEvent, currentSeason, listEvents, listPlayers, seedLeague } from '@data/league'
import { applyTrade, vetoTrade } from '@data/moves'
import { updatePlayers } from '@data/roster'
import { startSeason } from '@data/season'
import { intentInput, readMarket } from '@sim/gm'
import { readLeague } from '@story/context'
import { snapshotMoods } from '@story/mood'
import { playerState } from '@story/playerState'
import { storyDemo, storyKinds } from '@story/jobs'
import {
  leaksSecret,
  PLAYER_REACTION,
  reactionDemo,
  reactionEvents,
  reactionInput,
  reactionKind,
  reactionPicks,
  type PlayerReactionInput,
  type PlayerReactionOutput,
} from '@story/reactions'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { ko } from '../renderer/i18n/ko'
import { AiService } from './ai'
import { StoryService } from './story'

const SECRET = '사실 그는 졸업하면 농구를 그만두고 아버지 가게를 물려받기로 약속했다'
const OTHER_SECRET = '무릎 연골이 찢어진 걸 숨기고 뛰고 있다'

let dir: string
let db: Db
let ai: AiService
let story: StoryService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-react-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  mkdirSync(join(dir, 'lore', 'teams', '가람고'), { recursive: true })
  writeFileSync(join(dir, 'lore', 'teams', '가람고', '가가가.md'), `---\nid: 가가가\nmedia: outspoken\n---\n\n## 공개\n팀의 에이스.\n\n## 비밀\n${SECRET}\n`)
  // 가나나 (p2): a hidden injury, and a secret friendship with 나나다 (p8, 나람고).
  writeFileSync(
    join(dir, 'lore', 'teams', '가람고', '가나나.md'),
    `---\nid: 가나나\nrelationships:\n  - { with: 나나다, type: friend, strength: 4, visibility: secret }\n---\n\n## 공개\n식스맨.\n\n## 비밀\n${OTHER_SECRET}\n`,
  )
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds(
    (d, f, slug) => [
      reactionKind(d, f, {
        requeue: (input) => void ai.queueFor(slug, d, f).enqueue(PLAYER_REACTION, input, 22),
        changed: () => story.afterChange(slug, d, f),
      }),
    ],
    reactionDemo,
  )
  await ai.refresh()
  story = new StoryService(ai)
  startSeason(db)
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
const iso = () => new Date().toISOString()

/** Runs one reaction job's accept by hand with the given answers; returns the retry inputs it queued. */
function acceptWith(players: PlayerReactionInput['players'], reactions: PlayerReactionOutput['reactions']): PlayerReactionInput[] {
  const retries: PlayerReactionInput[] = []
  const kind = reactionKind(db, dir, { requeue: (input) => void retries.push(input), changed: () => {} })
  const input: PlayerReactionInput = { model: 'sonnet', seasonId: currentSeason(db).id, context: '', players, retry: false }
  const jobId = Number(db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('player_reaction', 'running', 22, ?, ?)").run(JSON.stringify(input), iso()).lastInsertRowid)
  kind.accept!(
    { reactions },
    { id: jobId, kind: PLAYER_REACTION, status: 'running', priority: 22, input, output: null, error: null, errorKind: null, attempts: 1, folder: null, costUsd: null, askedModel: null, askedEffort: null, usage: null, createdAt: iso(), startedAt: null, finishedAt: null },
  )
  return retries
}
const P1 = { key: 'P1', playerId: 'p1', teamId: 't1', causes: ['트레이드'], weight: 3 }
const P2 = { key: 'P2', playerId: 'p2', teamId: 't1', causes: ['트레이드'], weight: 2 }
const line = (player: string, quote: string, extra: Partial<PlayerReactionOutput['reactions'][number]> = {}) => ({
  player,
  channel: 'interview' as const,
  quote,
  action: 'none' as const,
  target: null,
  note: '',
  ...extra,
})
const quotes = () => db.prepare('SELECT player_id, quote, action, target_id FROM player_quotes ORDER BY id').all() as { player_id: string; quote: string; action: string; target_id: string | null }[]

describe('다시 시도 of players’ words', () => {
  it('leaves out the held words that already became news when the second try failed', () => {
    const kind = reactionKind(db, dir, { requeue: () => {}, changed: () => {} })
    const said = (quoteId: number) => ({ quoteId, playerId: 'p1', teamId: 't1', channel: 'interview', quote: `말 ${quoteId}`, action: 'none', targetId: null })
    const seasonId = currentSeason(db).id
    const input: PlayerReactionInput = { model: 'sonnet', seasonId, context: '', players: [P1], retry: true, held: [said(901), said(902)] }
    const job = { id: 1, kind: PLAYER_REACTION, status: 'failed' as const, priority: 22, input, output: null, error: null, errorKind: null, attempts: 2, folder: null, costUsd: null, askedModel: null, askedEffort: null, usage: null, createdAt: iso(), startedAt: null, finishedAt: iso() }
    appendEvent(db, 'player_said', said(901), seasonId)
    expect(kind.retryInput!(input, job)).toEqual({ ...input, held: [said(902)] })
    appendEvent(db, 'player_said', said(902), seasonId)
    expect(kind.retryInput!(input, job)).not.toHaveProperty('held')
    // A batch that held nothing goes again as it was.
    const plain: PlayerReactionInput = { model: 'sonnet', seasonId, context: '', players: [P1], retry: false }
    expect(kind.retryInput!(plain, job)).toBe(plain)
  })
})

describe('leaksSecret', () => {
  it('catches a secret said outright or nearly word for word, not a quote that only hints at a mood', () => {
    expect(leaksSecret('저는 졸업하면 농구를 그만두고 아버지 가게를 물려받을 거예요', SECRET)).toBe(true)
    expect(leaksSecret('농구 그만두고 가게 물려받기로 아버지랑 약속했어요', SECRET)).toBe(true)
    expect(leaksSecret('요즘 마음이 좀 복잡하네요. 경기에 집중하겠습니다.', SECRET)).toBe(false)
    expect(leaksSecret('아무 말', '')).toBe(false)
  })

  it('catches a paraphrase and a short secret; common words alone are not a leak', () => {
    expect(leaksSecret('연골 찢어진 거 숨기고 뛰는 중이에요', OTHER_SECRET)).toBe(true)
    expect(leaksSecret('우리 아버지가 감독님이세요', '아버지가 감독이다')).toBe(true)
    expect(leaksSecret('저 사실 입양됐어요', '입양됨')).toBe(true)
    expect(leaksSecret('사실 농구가 제일 좋아요', '그는 사실 농구를 싫어한다')).toBe(false)
    expect(leaksSecret('지는 건 싫어요', '그는 사실 농구를 싫어한다')).toBe(false)
  })

  it('one sentence of a long secret is enough; everyday words that only look alike are not', () => {
    const long = '그는 중학교 때까지 다른 이름으로 살았다. 사실 그는 입양됐다. 친부모를 찾고 싶어 한다. 아무에게도 말하지 않았다.'
    expect(leaksSecret('저 사실 입양됐어요', long)).toBe(true)
    expect(leaksSecret('아무 말도 하지 않았어요. 부모님께 죄송해요', '부모님이 이혼했는데 아무에게도 말하지 않았다')).toBe(false)
    expect(leaksSecret('그만하고 싶다는 생각은 안 해요', '농구 선수 그만두고 싶다')).toBe(false)
    expect(leaksSecret('2년 만에 교통정리가 됐네요', '2년 전 교통사고')).toBe(false)
    expect(leaksSecret('봉사업무도 열심히 했어요', '아버지 사업이 망했다')).toBe(false)
  })
})

describe('player reactions (demo writer)', () => {
  it('picks the players worth hearing from', () => {
    const league = readLeague(db, dir)
    const picks = reactionPicks(league, [
      { id: 1, type: 'mood_changed', seasonId: 1, createdAt: '', payload: { playerId: 'p2', teamId: 't1', from: 'neutral', to: 'boiling', reasons: ['usage'] } },
      { id: 2, type: 'trade_applied', seasonId: 1, createdAt: '', payload: { tradeId: 1, teams: ['t1', 't2'], players: ['p1', 'p7'], cards: [] } },
      { id: 3, type: 'award_given', seasonId: 1, createdAt: '', payload: { awardId: 'x', period: 'W1', teamRank: 1, playerId: 'p13' } },
    ] as never)
    expect(picks[0]!.playerId).toBe('p2')
    expect(picks.map((p) => p.playerId).sort()).toEqual(['p1', 'p2', 'p7'])
  })

  it('a mood swing alone does not get him talking again until his team has played a few games; a move does', () => {
    db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, 'p2', 't1', 'interview', '말', 'none', '', ?)").run(
      currentSeason(db).id,
      new Date(Date.now() - 1000).toISOString(),
    )
    const mood = { id: 1, type: 'mood_changed', seasonId: 1, createdAt: '', payload: { playerId: 'p2', teamId: 't1', from: 'neutral', to: 'unhappy', reasons: [] } }
    const trade = { id: 2, type: 'trade_applied', seasonId: 1, createdAt: '', payload: { tradeId: 1, teams: ['t1', 't2'], players: ['p2', 'p8'], cards: [] } }
    expect(reactionPicks(readLeague(db, dir), [mood] as never)).toEqual([])
    expect(reactionPicks(readLeague(db, dir), [mood, trade] as never).map((p) => p.playerId)).toContain('p2')
    for (let g = 0; g < 3; g++) appendEvent(db, 'game_recorded', { gameId: 900 + g, stage: 'regular', home: 't1', away: 't3', homeScore: 80, awayScore: 70 }, currentSeason(db).id)
    expect(reactionPicks(readLeague(db, dir), [mood] as never).map((p) => p.playerId)).toEqual(['p2'])
  })

  it('draft swaps wait for the draft to close, then the whole draft (minus vetoed picks) counts once', () => {
    const season = currentSeason(db).id
    db.prepare("UPDATE seasons SET phase = 'draft' WHERE id = ?").run(season)
    appendEvent(db, 'phase_changed', { from: 'playoffs', to: 'draft' }, season)
    const swap = (actionId: number, own: string, target: string) => {
      const id = appendEvent(db, 'draft_swap', { actionId, teamId: 't1', playerId: own, targetPlayerId: target, targetTeamId: 't2', cardId: 1, ownSlot: null, targetSlot: null }, season)
      return listEvents(db, 'draft_swap').find((e) => e.id === id)!
    }
    const first = swap(1, 'p1', 'p7')
    db.prepare("INSERT INTO draft_actions (id, season_id, seq, team_id, kind, created_at, vetoed_at) VALUES (2, ?, 2, 't1', 'swap', ?, ?)").run(season, iso(), iso())
    swap(2, 'p2', 'p8')
    expect(reactionEvents(db, [first]).filter((e) => e.type === 'draft_swap')).toEqual([])
    db.prepare("UPDATE seasons SET phase = 'offseason' WHERE id = ?").run(season)
    const closedId = appendEvent(db, 'phase_changed', { from: 'draft', to: 'offseason' }, season)
    const closed = listEvents(db, 'phase_changed').find((e) => e.id === closedId)!
    const picks = reactionPicks(readLeague(db, dir), reactionEvents(db, [closed]))
    expect(picks.map((p) => p.playerId).sort()).toEqual(['p1', 'p7'])
  })

  it("the draft closing gets the drafted players talking, through the story engine's own look", () => {
    const season = currentSeason(db).id
    db.prepare("UPDATE seasons SET phase = 'draft' WHERE id = ?").run(season)
    appendEvent(db, 'phase_changed', { from: 'playoffs', to: 'draft' }, season)
    appendEvent(db, 'draft_swap', { actionId: 1, teamId: 't1', playerId: 'p1', targetPlayerId: 'p7', targetTeamId: 't2', cardId: 1, ownSlot: null, targetSlot: null }, season)
    // A vetoed pick: neither it nor the mood swing it caused counts.
    db.prepare("INSERT INTO draft_actions (id, season_id, seq, team_id, kind, created_at, vetoed_at) VALUES (2, ?, 2, 't1', 'swap', ?, ?)").run(season, iso(), iso())
    appendEvent(db, 'draft_swap', { actionId: 2, teamId: 't1', playerId: 'p2', targetPlayerId: 'p8', targetTeamId: 't2', cardId: 2, ownSlot: null, targetSlot: null }, season)
    appendEvent(db, 'mood_changed', { playerId: 'p8', teamId: 't2', from: 'neutral', to: 'unhappy', reasons: ['stability'] }, season)
    story.afterChange('test', db, dir)
    expect(jobs(PLAYER_REACTION)).toHaveLength(0)
    db.prepare("UPDATE seasons SET phase = 'offseason' WHERE id = ?").run(season)
    appendEvent(db, 'phase_changed', { from: 'draft', to: 'offseason' }, season)
    story.afterChange('test', db, dir)
    const queued = jobs(PLAYER_REACTION)
    expect(queued).toHaveLength(1)
    expect((JSON.parse(queued[0]!.input) as PlayerReactionInput).players.map((p) => p.playerId).sort()).toEqual(['p1', 'p7'])
  })

  it('after a trade, the players speak; their words reach the forum and the locker room, never their secret', async () => {
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    story.afterChange('test', db, dir)
    const queued = jobs(PLAYER_REACTION)
    expect(queued).toHaveLength(1)
    // The player's own job is the one that may read his secret.
    expect(queued[0]!.input).toContain(SECRET)
    await drain()
    const said = listEvents(db, 'player_said')
    expect(said.length).toBe(2)
    for (const e of said) expect(JSON.stringify(e.payload)).not.toContain(SECRET)
    // Their words get a thread of their own, which never sees the secret.
    const threads = jobs('event_thread').filter((j) => j.input.includes('인터뷰'))
    expect(threads.length).toBeGreaterThan(0)
    for (const t of jobs('event_thread')) expect(t.input).not.toContain(SECRET)
    const room = (await import('@story/mood')).lockerRoom(readLeague(db, dir), 't2')
    expect(room.players.find((p) => p.playerId === 'p1')!.said?.quote).toBeTruthy()
  })

  it('a starter sent to the bench in 로스터 편집: moods are retaken, and crossing into 불만 is news and gets him talking', () => {
    // p5 is 가람고's C: proud, and being benched cuts deep.
    const c = listPlayers(db).find((p) => p.id === 'p5')!
    writeFileSync(
      join(dir, 'lore', 'teams', '가람고', `${c.name}.md`),
      `---\nid: ${c.name}\ntraits:\n  ego: 5\nhooks:\n  - when: benched\n    mood: { recognition: -100, winning: -100 }\n---\n`,
    )
    snapshotMoods(readLeague(db, dir), 't1', Date.now())
    setStoryValue(db, 'events-handled', String(lastEventId(db)))
    const snapshots = () => (db.prepare("SELECT COUNT(*) AS n FROM player_mood WHERE player_id = 'p5'").get() as { n: number }).n
    // The PG and the SG trading places moves nobody's role: no snapshot, nothing to write, and the fans' chatter isn't stale.
    const news = lastNewsEventId(db)
    updatePlayers(db, [
      { playerId: 'p1', slotId: 'sg' },
      { playerId: 'p2', slotId: 'pg' },
    ])
    expect(story.afterChange('test', db, dir)).toBe(0)
    expect(snapshots()).toBe(1)
    expect(lastNewsEventId(db)).toBe(news)

    updatePlayers(db, [
      { playerId: 'p5', slotId: 'bench' },
      { playerId: 'p6', slotId: 'c' },
    ])
    expect(lastNewsEventId(db)).toBe(listEvents(db, 'slots_changed').at(-1)!.id)
    story.afterChange('test', db, dir)
    expect(snapshots()).toBe(2)
    expect(listEvents(db, 'mood_changed').map((e) => e.payload)).toEqual([expect.objectContaining({ playerId: 'p5', to: expect.stringMatching(/^(unhappy|boiling)$/) })])
    // One thread: the lineup change and the mood it stirred.
    const threads = jobs('event_thread').filter((j) => j.input.includes('라인업 변경'))
    expect(threads).toHaveLength(1)
    expect(threads[0]!.input).toContain(`라인업 변경: 가람고 — ${c.name} 주전 → 벤치 (C → Bench)`)
    expect(threads[0]!.input).toContain('선수 분위기')
    // His words say why.
    const words = jobs(PLAYER_REACTION).flatMap((j) => (JSON.parse(j.input) as PlayerReactionInput).players)
    expect(words.find((p) => p.playerId === 'p5')?.causes).toContain('주전에서 벤치로 밀려남')
    // His page shows the move.
    expect(playerState(readLeague(db, dir), 'p5').timeline).toContainEqual(expect.objectContaining({ kind: 'slot', from: 'C', to: 'Bench', rotation: 'down' }))
  })

  it('a second look while a reaction job waits joins it instead of adding a job', async () => {
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    story.afterChange('test', db, dir)
    applyTrade(db, [
      { kind: 'player', playerId: 'p3', from: 't1', to: 't3' },
      { kind: 'player', playerId: 'p15', from: 't3', to: 't1' },
    ])
    story.afterChange('test', db, dir)
    const queued = jobs(PLAYER_REACTION)
    expect(queued).toHaveLength(1)
    expect((JSON.parse(queued[0]!.input) as PlayerReactionInput).players.map((p) => p.playerId).sort()).toEqual(['p1', 'p15', 'p3', 'p7'])
    await drain()
    expect(listEvents(db, 'player_said')).toHaveLength(4)
  })

  it('a quote that gives the secret away is dropped, and the player gets one more try', () => {
    const retries = acceptWith([P1], [line('P1', '사실 졸업하면 농구를 그만두고 아버지 가게를 물려받기로 했어요')])
    expect(listEvents(db, 'player_said')).toHaveLength(0)
    expect(quotes()).toEqual([])
    expect(retries).toHaveLength(1)
    expect(retries[0]!.retry).toBe(true)
    expect(retries[0]!.players.map((p) => p.playerId)).toEqual(['p1'])
  })

  it("a player can't give away a teammate's secret from the same batch either", () => {
    const retries = acceptWith([P1, P2], [line('P1', '가나나 걔 연골 찢어진 거 숨기고 뛰는 중이에요'), line('P2', '열심히 하겠습니다.')])
    expect(quotes().map((q) => q.player_id)).toEqual(['p2'])
    expect(retries[0]!.players.map((p) => p.playerId)).toEqual(['p1'])
  })

  it('a secret friendship stays secret: naming him is a leak, and praise for him loses its target', () => {
    const named = acceptWith([P2], [line('P2', '나나다는 정말 좋은 선수예요')])
    expect(named).toHaveLength(1)
    expect(acceptWith([P2], [line('P2', '나다랑 연락은 자주 해요')])).toHaveLength(1)
    expect(quotes()).toEqual([])
    acceptWith([P2], [line('P2', '좋은 친구가 있어서 힘이 나요', { action: 'praise_teammate', target: '나나다' })])
    expect(quotes()).toEqual([{ player_id: 'p2', quote: '좋은 친구가 있어서 힘이 나요', action: 'none', target_id: null }])
    const said = listEvents(db, 'player_said')
    expect(said).toHaveLength(1)
    expect(said[0]!.payload).toMatchObject({ action: 'none', targetId: null })
  })

  it('on the second try, a leaking quote is dropped for good, but a request he made still counts', () => {
    const kind = reactionKind(db, dir, { requeue: () => expect.unreachable('no third try'), changed: () => {} })
    const input: PlayerReactionInput = { model: 'sonnet', seasonId: currentSeason(db).id, context: '', players: [P1], retry: true }
    const jobId = Number(db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('player_reaction', 'running', 22, ?, ?)").run(JSON.stringify(input), iso()).lastInsertRowid)
    kind.accept!(
      { reactions: [line('P1', '졸업하면 농구를 그만두고 아버지 가게를 물려받을 거라서요', { action: 'private_request' })] },
      { id: jobId, kind: PLAYER_REACTION, status: 'running', priority: 22, input, output: null, error: null, errorKind: null, attempts: 1, folder: null, costUsd: null, askedModel: null, askedEffort: null, usage: null, createdAt: iso(), startedAt: null, finishedAt: null },
    )
    expect(quotes()).toEqual([{ player_id: 'p1', quote: '', action: 'private_request', target_id: null }])
    expect(listEvents(db, 'player_said')).toHaveLength(0)
  })

  it('a player who moved since the job was queued (or whose move was vetoed) says nothing, and one answer per player', () => {
    acceptWith(
      [{ ...P1, teamId: 't2' }, P2],
      [line('P1', '새 팀에서 잘하겠습니다.'), line('P2', '첫 번째 말'), line('P2', '두 번째 말')],
    )
    expect(quotes()).toEqual([{ player_id: 'p2', quote: '첫 번째 말', action: 'none', target_id: null }])
  })
})

describe('trade requests and the GMs', () => {
  const request = (player: string, team: string, action: string, at: string) =>
    db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, ?, ?, 'none', '', ?, '', ?)").run(currentSeason(db).id, player, team, action, at)

  it('a request makes his GM keener to move him; only a public one is known around the league; a window come and gone ends it', () => {
    const before = new Date(Date.now() - 60_000).toISOString()
    request('p1', 't1', 'private_request', before)
    request('p7', 't2', 'public_request', before)
    request('p7', 't2', 'private_request', before)
    const league = readLeague(db, dir)
    const data = readMarket(league)
    expect(data.requests.get('p1')).toBe('private_request')
    // A later private word doesn't take back a public request.
    expect(data.requests.get('p7')).toBe('public_request')
    expect(data.market.players.find((p) => p.id === 'p1')!.unhappy).toBe(true)
    const market = intentInput(league, data, 1, null, []).context
    expect(market).toContain('공개적으로 트레이드를 요청한 선수: 나가나')
    expect(market).not.toMatch(/불만이 소문난 선수:[^\n]*가가가/)
    db.prepare("INSERT INTO trade_windows (season_id, round, phase, status, reason, opened_at, closed_at) VALUES (?, NULL, 'regular', 'closed', 'manual', ?, ?)").run(currentSeason(db).id, iso(), iso())
    expect(readMarket(readLeague(db, dir)).requests.size).toBe(0)
  })
})

describe("a player's memory and his page", () => {
  const tradeP1 = () =>
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])

  it('the next time he speaks, he reads what he said before and where his trade request stands', async () => {
    tradeP1()
    story.afterChange('test', db, dir)
    await drain()
    const next = () => reactionInput(readLeague(db, dir), [{ playerId: 'p1', causes: ['기분이 보통에서 불만(으)로 바뀜'], weight: 3 }])!.context
    expect(next()).toContain('지난 말(오래된 순):')
    // His lasting feelings too: trust, attachment, wanting out (traded away without asking: a grudge).
    expect(next()).toMatch(/마음 깊은 곳[^\n]*단장 신뢰[^\n]*학교 애착[^\n]*떠나고 싶은 마음[^\n]*앙금: 「가람고」/)
    expect(next()).toContain('「새로운 마음으로 열심히 하겠습니다.」')
    expect(next()).toContain('속마음 「분위기를 좋게 가져가고 싶다.」')
    db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, 'p1', 't2', 'none', '', 'private_request', '', ?)").run(
      currentSeason(db).id,
      new Date(Date.now() - 1000).toISOString(),
    )
    expect(next()).toContain('트레이드 요청: 비공개 트레이드 요청 중(아직 답 없음)')
    db.prepare("INSERT INTO trade_windows (season_id, round, phase, status, reason, opened_at, closed_at) VALUES (?, NULL, 'regular', 'closed', 'manual', ?, ?)").run(currentSeason(db).id, iso(), iso())
    expect(next()).toContain('그대로 남음')
    // Only his own words: 가나나 (p2) never spoke, so nothing of 가가가's or 나가나's shows up in his block.
    expect(reactionInput(readLeague(db, dir), [{ playerId: 'p2', causes: ['x'], weight: 1 }])!.context).not.toContain('지난 말')
  })

  it("a past 속마음 carrying another player's secret stays out of his next job; his own harmless one stays in", () => {
    const say = (note: string) =>
      db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, note, cause, created_at) VALUES (?, 'p7', 't2', 'interview', '열심히 할게요', 'none', ?, '', ?)").run(
        currentSeason(db).id,
        note,
        iso(),
      )
    say('가가가 형이 농구 그만두고 가게 물려받기로 아버지랑 약속했다는 걸 안다')
    say('나다랑 가나나 사이를 눈치챘다')
    say('새 팀에 빨리 녹아들고 싶다')
    const context = reactionInput(readLeague(db, dir), [{ playerId: 'p7', causes: ['x'], weight: 1 }])!.context
    expect(context).not.toContain('물려받기로')
    expect(context).not.toContain('눈치챘다')
    expect(context).toContain('새 팀에 빨리 녹아들고 싶다')
  })

  it("a batch-mate's private trade request is no one else's to tell", () => {
    db.prepare("INSERT INTO player_quotes (season_id, player_id, team_id, channel, quote, action, cause, created_at) VALUES (?, 'p2', 't1', 'none', '', 'private_request', '', ?)").run(currentSeason(db).id, iso())
    const context = reactionInput(readLeague(db, dir), [{ playerId: 'p2', causes: ['x'], weight: 1 }])!.context
    expect(context).toContain('(비공개 — 그와 단장만 앎)')
    const retries = acceptWith([P1, P2], [line('P1', '가나나가 트레이드 요청했다던데 아쉽네요'), line('P2', '열심히 하겠습니다.')])
    expect(retries[0]!.players.map((p) => p.playerId)).toEqual(['p1'])
    expect(quotes().filter((q) => q.player_id === 'p1')).toEqual([])
  })

  it('taking an award back marks the award on his page', () => {
    appendEvent(db, 'award_given', { awardId: 'potw', period: 'W1', teamRank: 1, playerId: 'p1' }, currentSeason(db).id)
    appendEvent(db, 'award_removed', { awardId: 'potw', period: 'W1', teamRank: 1, playerId: 'p1' }, currentSeason(db).id)
    const awards = playerState(readLeague(db, dir), 'p1').timeline.filter((x) => x.kind === 'award')
    expect(awards).toEqual([expect.objectContaining({ award: '이주의 선수', removed: true })])
  })

  it('his page names a weekly award by its week and the conference it was given in', () => {
    appendEvent(db, 'award_given', { awardId: 'potw', period: 'w3', teamRank: 1, playerId: 'p1', group: 'east' }, currentSeason(db).id)
    appendEvent(db, 'award_given', { awardId: 'potm', period: 'm2', teamRank: 1, playerId: 'p1' }, currentSeason(db).id)
    // Newest first.
    const awards = playerState(readLeague(db, dir), 'p1').timeline.flatMap((x) => (x.kind === 'award' ? [x] : []))
    expect(awards.map((a) => [a.award, a.period, a.group])).toEqual([
      ['이달의 선수', 'm2', ''],
      ['이주의 선수', 'w3', '동'],
    ])
    expect(awards.map((a) => ko.mood.player.award(a.award, a.period, a.teamRank, a.group))).toEqual(['수상: 11월 이달의 선수', '수상: 3주차 동 이주의 선수'])
  })

  it('his page has his mood after each move, what happened to him and what he said, newest first', async () => {
    const tradeId = tradeP1()
    story.afterChange('test', db, dir)
    await drain()
    appendEvent(db, 'award_given', { awardId: 'potw', period: 'W1', teamRank: 1, playerId: 'p1' }, currentSeason(db).id)
    const v = playerState(readLeague(db, dir), 'p1')
    expect(v.teamId).toBe('t2')
    expect(v.current).toBe(true)
    expect(v.now?.playerId).toBe('p1')
    expect(v.history.length).toBeGreaterThan(0)
    expect(v.timeline[0]).toMatchObject({ kind: 'award', award: '이주의 선수', period: 'W1' })
    const said = v.timeline.find((x) => x.kind === 'said')
    expect(said).toMatchObject({ words: { quote: '새로운 마음으로 열심히 하겠습니다.', note: '분위기를 좋게 가져가고 싶다.' } })
    expect(v.timeline.find((x) => x.kind === 'trade')).toMatchObject({ from: 't1', to: 't2', vetoed: false })
    // His secret is in his lore, not on this page: only traits, relationships and what he said.
    expect(JSON.stringify(v)).not.toContain(SECRET)
    vetoTrade(db, tradeId)
    const after = playerState(readLeague(db, dir), 'p1')
    expect(after.teamId).toBe('t1')
    expect(after.timeline.find((x) => x.kind === 'trade')).toMatchObject({ vetoed: true })
  })

  it("his page shows his relationships, secret ones marked, and refuses a player who isn't there", () => {
    const v = playerState(readLeague(db, dir), 'p2')
    expect(v.relationships).toEqual([{ name: '나나다', playerId: 'p8', type: 'friend', strength: 4, visibility: 'secret' }])
    expect(v.history).toEqual([])
    expect(() => playerState(readLeague(db, dir), 'nobody')).toThrow()
  })
})
