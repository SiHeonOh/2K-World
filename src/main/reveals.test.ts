import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobRow } from '@ai/queue'
import { sampleSetup } from '@shared/testing/fixtures'
import type { EventPayloads } from '@shared/events'
import { lastEventId, setStoryValue, storyValue } from '@data/community'
import { openDb, type Db } from '@data/db'
import { appendEvent, listEvents, listPlayers, loadConfig, seedLeague, updateConfig } from '@data/league'
import { applyTrade } from '@data/moves'
import { RuleError } from '@data/rules'
import { listGames, recordScore, startSeason } from '@data/season'
import { addSuggestion, getSuggestion, listSuggestions, setSuggestionError, type SuggestionRow } from '@data/suggestions'
import { eventThreadInput, forgetLore, loreFor, readLeague } from '@story/context'
import { storyDemo, storyKinds } from '@story/jobs'
import { LORE_SUGGEST, loreDemo, loreKinds } from '@story/loreJobs'
import { LORE_REVEAL, REVEAL_MARK, revealDemo, revealInput, revealKind, type LoreRevealInput, type LoreRevealOutput } from '@story/reveals'
import { planReactions } from '@story/triggers'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { AiService } from './ai'
import { createContext } from './context'
import { AppError } from './errors'
import { createHandlers, withStory } from './handlers'
import { LoreService, syncLoreFolder } from './lore'
import { StoryService } from './story'
import { SuggestionService } from './suggestions'

/** The ace's secret, his school's, and a bench player's elsewhere who's in nothing that happens. */
const SECRET = '사실은 전학을 원한다'
const SCHOOL = '재단이 농구부 예산을 빼돌렸다'
const OTHER = '부모님 몰래 농구를 한다'
/** Your news says it in other words: what gives the secret away, without being it. */
const NEWS = '가가가, 기자회견에서 전학을 원한다고 직접 밝혔다'

let dir: string
let db: Db
let ai: AiService
let suggestions: SuggestionService
let story: StoryService

const teamDir = (team: string) => join(dir, 'lore', 'teams', team)
const read = (name: string) => readFileSync(join(teamDir('가람고'), name), 'utf8')
/** Rewrites a 가람고 file by hand, as you would in an editor (the next read sees it at once). */
const write = (name: string, text: string) => {
  writeFileSync(join(teamDir('가람고'), name), text)
  forgetLore(dir)
}
const ACE = `---
id: 가가가
relationships:
  - { with: 가나나, type: dislikes, strength: 2, visibility: secret }
---

## 공개
팀의 에이스.

## 소문

## 비밀
${SECRET}
`

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-reveal-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  mkdirSync(teamDir('가람고'), { recursive: true })
  mkdirSync(teamDir('나람고'), { recursive: true })
  writeFileSync(join(teamDir('가람고'), '가람고.md'), `---\nid: 가람고\n---\n\n## 공개\n전통의 강호.\n\n## 비밀\n${SCHOOL}\n`)
  write('가가가.md', ACE)
  writeFileSync(join(teamDir('나람고'), '나바사.md'), `---\nid: 나바사\n---\n\n## 비밀\n${OTHER}\n`)
  ai = new AiService()
  suggestions = new SuggestionService(ai, new LoreService(join(process.cwd(), 'defaults')))
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f) => loreKinds(d, f, { afterStore: (x, y) => void suggestions.applyAuto(x, y) }), loreDemo)
  ai.addKinds((d, f) => [revealKind(d, f)], revealDemo)
  await ai.refresh()
  story = new StoryService(ai, {
    onRound: (slug, d, f, season, round) => {
      const swept = suggestions.sweep(slug, d, f, season, round)
      const revealing = suggestions.revealSweep(slug, d, f, season, round)
      return swept || revealing
    },
  })
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = () => ai.queueFor('test', db, dir).kick()
const jobs = (kind?: string) =>
  (db.prepare('SELECT kind, status, input FROM jobs ORDER BY id').all() as { kind: string; status: string; input: string }[]).filter((j) => kind === undefined || j.kind === kind)
/** What writers were handed: every job but the two that may read secrets (the check itself, and players' own words). */
const writerJobs = () => jobs().filter((j) => j.kind !== LORE_REVEAL && j.kind !== 'player_reaction')
const reveals = (): SuggestionRow[] => listSuggestions(db, 'pending').filter((s) => s.kind === 'reveal')
const revealed = () => listEvents(db, 'secret_revealed').map((e) => e.payload as EventPayloads['secret_revealed'])
const playRound = (round: number) => {
  for (const g of listGames(db, 1).filter((x) => x.stage === 'regular' && x.round === round)) {
    const lines = listPlayers(db)
      .filter((p) => p.teamId === g.home || p.teamId === g.away)
      .map((p, i) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 30 - i, fgm: 10, fga: 20 } }))
    recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
  }
}
/** News that gives the ace's secret away, then a round: the check runs and its card waits. */
const revealAfterNews = async (news = NEWS) => {
  startSeason(db)
  story.afterChange('test', db, dir)
  story.news('test', db, dir, news)
  playRound(1)
  story.afterChange('test', db, dir)
  await drain()
}

describe('the secret check after a round', () => {
  it('reads only the secrets of people in the round’s public happenings, and nothing reaches a writer', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    story.news('test', db, dir, NEWS)
    playRound(1)
    story.afterChange('test', db, dir)
    expect(jobs(LORE_REVEAL)).toHaveLength(1)
    const input = JSON.parse(jobs(LORE_REVEAL)[0]!.input) as LoreRevealInput
    // The ace is in your news (and the round's best lines); the bench player and the school are in nothing.
    expect(input.targets.map((t) => t.target)).toEqual([{ kind: 'player', playerId: 'p1' }])
    expect(input.context).toContain(SECRET)
    expect(input.context).toContain('[비밀 관계] 「가나나」')
    expect(input.context).toContain(`[소식 1] 소식: 「${NEWS}」`)
    expect(input.context).not.toContain(OTHER)
    expect(input.context).not.toContain(SCHOOL)
    // It runs on the round sweep's model, and gets its own guide.
    expect(input.model).toBe(loadConfig(db).config.ai.jobs.loreSweep.model)
    expect(storyValue(db, REVEAL_MARK)).not.toBeNull()

    await drain()
    const [card] = reveals()
    expect(card).toMatchObject({ kind: 'reveal', target: { kind: 'player', playerId: 'p1' }, patch: { fromSecret: SECRET, public: SECRET }, round: 1 })
    expect(card!.reason).toContain('소식 1')
    // Waiting isn't approved: the file and every writer (threads, the round-up, the round sweep) are as before.
    expect(read('가가가.md')).toBe(ACE)
    expect(loreFor(readLeague(db, dir), ['t1'], ['p1'])).not.toContain(SECRET)
    expect(writerJobs().length).toBeGreaterThan(3)
    for (const j of writerJobs()) expect(j.input).not.toContain(SECRET)
    // The next round's sweep doesn't see the waiting card either ("already suggested" leaves reveals out).
    playRound(2)
    story.afterChange('test', db, dir)
    expect(jobs('lore_suggest')).toHaveLength(2)
    for (const j of writerJobs()) expect(j.input).not.toContain(SECRET)
  })

  it('queues nothing when nobody with a secret was in public', () => {
    write('가가가.md', '---\nid: 가가가\n---\n\n## 공개\n팀의 에이스.\n')
    writeFileSync(join(teamDir('가람고'), '가람고.md'), '---\nid: 가람고\n---\n\n## 공개\n전통의 강호.\n')
    startSeason(db)
    story.afterChange('test', db, dir)
    playRound(1)
    story.afterChange('test', db, dir)
    expect(jobs('lore_suggest')).toHaveLength(1)
    expect(jobs(LORE_REVEAL)).toHaveLength(0)
    expect(storyValue(db, REVEAL_MARK)).toBe(String(lastEventId(db)))
  })
})

describe('approving a reveal', () => {
  it('moves the text from 비밀 to 공개, tells the community, and only then do writers see it', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    const before = story.afterChange('test', db, dir)
    expect(before).toBe(0)

    expect(suggestions.approve(db, dir, card.id)).toEqual({ status: 'approved', file: 'teams/가람고/가가가.md' })
    const entry = readLeague(db, dir).lore.player.get('p1')!
    expect(entry.sections).toEqual({ public: `팀의 에이스.\n\n${SECRET}`, rumor: '', secret: '' })
    // The secret relationship isn't part of it, and the old version is kept.
    expect(read('가가가.md')).toContain('visibility: secret')
    expect(readdirSync(join(dir, 'backups', 'lore', 'teams', '가람고', '가가가')).length).toBeGreaterThan(0)
    expect(getSuggestion(db, card.id)).toMatchObject({ status: 'approved', file: 'teams/가람고/가가가.md' })
    expect(revealed()).toEqual([{ suggestionId: card.id, target: 'player', playerId: 'p1', teamId: 't1', to: 'public', text: SECRET, relationship: null }])
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'error', code: 'gone' })

    // The community reacts like it does to any news, and writers have the moved text now.
    expect(planReactions(listEvents(db, 'secret_revealed')).map((r) => r.kind)).toEqual(['event_thread'])
    expect(story.afterChange('test', db, dir)).toBe(1)
    const thread = jobs('event_thread').at(-1)!
    expect(thread.input).toContain('감춰졌던 이야기가 밝혀짐')
    expect(thread.input).toContain(SECRET)
    expect(thread.input).not.toContain(SCHOOL)
    expect(thread.input).not.toContain('dislikes')
    await drain()
    expect(jobs('event_thread').at(-1)!.status).toBe('done')
    expect(loreFor(readLeague(db, dir), [], ['p1'])).toContain(SECRET)
    playRound(2)
    story.afterChange('test', db, dir)
    expect(jobs('post_game_thread').some((j) => j.status === 'queued' && j.input.includes(SECRET))).toBe(true)
  })

  it('takes your wording and sends it to 소문 instead, as a rumor the writers treat as one', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    expect(suggestions.approve(db, dir, card.id, { rumor: '전학을 원한다는 말이 돈다.', fromSecret: OTHER })).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: '팀의 에이스.', rumor: '전학을 원한다는 말이 돈다.', secret: '' })
    expect(readLeague(db, dir).lore.player.get('p12')!.sections.secret).toBe(OTHER)
    expect(revealed()[0]).toMatchObject({ to: 'rumor', text: '전학을 원한다는 말이 돈다.' })
    expect(eventThreadInput(readLeague(db, dir), listEvents(db, 'secret_revealed'))!.context).toContain('찌라시(확인 안 된 소문으로만 다룰 것): 가가가(가람고) — 「전학을 원한다는 말이 돈다.」')
  })

  it('leaves a card waiting as stale when the secret is no longer in the file', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    write('가가가.md', ACE.replace(SECRET, '다른 비밀.'))
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'error', code: 'stale' })
    expect(getSuggestion(db, card.id)).toMatchObject({ status: 'pending', error: 'stale:secret-gone' })
    // Editing can't bring the secret back.
    expect(suggestions.approve(db, dir, card.id, { public: SECRET })).toMatchObject({ status: 'error', code: 'stale' })
    expect(revealed()).toEqual([])
    expect(read('가가가.md')).toContain('다른 비밀.')
  })

  it('says why when the editor won’t save what’s left of 비밀 (a bare - line of your own reads as a heading)', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    const odd = ACE.replace(SECRET, `${SECRET}\n\n-\n\n다른 비밀.`)
    write('가가가.md', odd)
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'error', code: 'lore-error', detail: 'heading-in-text' })
    expect(getSuggestion(db, card.id)).toMatchObject({ status: 'pending', error: 'lore-error:heading-in-text' })
    expect(read('가가가.md')).toBe(odd)
    expect(revealed()).toEqual([])
  })

  it('says which box is too long when your wording is refused', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    expect(suggestions.approve(db, dir, card.id, { public: '전학을 원한다.', keepSecret: '가'.repeat(1501) })).toMatchObject({ status: 'error', code: 'invalid' })
    expect(getSuggestion(db, card.id)!.error).toBe('invalid:keep-too-long')
    expect(suggestions.approve(db, dir, card.id, { public: '가'.repeat(1501) })).toMatchObject({ status: 'error', code: 'invalid' })
    expect(getSuggestion(db, card.id)!.error).toBe('invalid:too-long')
    expect(read('가가가.md')).toBe(ACE)
    expect(revealed()).toEqual([])
  })

  it('approving again after a crash between writing the file and recording it adds nothing twice', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    // What you keep holds the card's text, so a second cut would find it again.
    const edited = { public: '전학을 원한다고 밝혔다.', keepSecret: `${SECRET}. 아버지는 모른다.` }
    expect(suggestions.approve(db, dir, card.id, edited)).toMatchObject({ status: 'approved' })
    const after = read('가가가.md')
    // The crash: the file was written, the card and the event weren't.
    db.prepare("UPDATE suggestions SET status = 'pending', decided_at = NULL, patch = ? WHERE id = ?").run(JSON.stringify(card.patch), card.id)
    db.prepare("DELETE FROM events WHERE type = 'secret_revealed'").run()
    expect(suggestions.approve(db, dir, card.id, edited)).toMatchObject({ status: 'approved' })
    expect(read('가가가.md')).toBe(after)
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: '팀의 에이스.\n\n전학을 원한다고 밝혔다.', rumor: '', secret: `${SECRET}. 아버지는 모른다.` })
    expect(revealed()).toMatchObject([{ suggestionId: card.id, text: '전학을 원한다고 밝혔다.' }])
  })

  it('makes a secret relationship known', async () => {
    await revealAfterNews('가가가와 가나나가 연습 중에 또 크게 다퉜다고 감독이 밝혔다')
    const [card] = reveals()
    expect(card!.patch).toEqual({ relationships: [{ with: '가나나', type: 'dislikes', strength: 2, visibility: 'rumor' }] })
    expect(suggestions.approve(db, dir, card!.id)).toMatchObject({ status: 'approved' })
    expect(read('가가가.md')).toContain('visibility: rumor')
    expect(read('가가가.md')).toContain(SECRET)
    expect(revealed()[0]).toMatchObject({ to: 'rumor', text: '', relationship: { with: '가나나', type: 'dislikes', playerId: 'p2' } })
  })
})

describe('what the check finds becomes cards', () => {
  const INPUT: LoreRevealInput = {
    model: 'sonnet',
    context: '',
    instructions: '',
    targets: [
      { key: 'P1', target: { kind: 'player', playerId: 'p1' }, name: '가가가' },
      { key: 'S1', target: { kind: 'team', teamId: 't1' }, name: '가람고' },
      { key: 'G1', target: { kind: 'gm', teamId: 't1' }, name: '가람고 단장' },
    ],
    posts: [5, 6],
    games: [7],
    seasonId: 1,
    round: 1,
    demo: { secrets: [], happenings: [] },
  }
  const accept = (reveals: LoreRevealOutput['reveals'], round = 1, seasonId = 1) => {
    const input = { ...INPUT, round, seasonId }
    const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES (?, 'running', ?, ?)").run(LORE_REVEAL, JSON.stringify(input), new Date().toISOString()).lastInsertRowid)
    const job = { id, kind: LORE_REVEAL, status: 'running', priority: 11, input, output: null, error: null, errorKind: null, attempts: 1, folder: null, costUsd: null, createdAt: '', startedAt: null, finishedAt: null } as JobRow
    revealKind(db, dir).accept!({ reveals }, job)
  }
  const whisper = { target: 'P1', secret: `${SECRET.replace(' ', '  ')}`, status: 'whispered', evidence: '글 5에서 다들 그렇게 말한다.', source: '글 5' }

  it('keeps only secrets really in the file, merges repeats, and lets a confirmation replace a whisper', () => {
    accept([
      whisper,
      { target: 'P9', secret: SECRET, status: 'confirmed', evidence: '없는 대상' },
      { target: 'P1', secret: '사실은 이적을 원한다', status: 'confirmed', evidence: '지어낸 비밀' },
      { target: 'P1', secret: SECRET, status: 'confirmed', evidence: '' },
      { target: 'P1', relationship: '나가나', status: 'confirmed', evidence: '비밀 관계가 아님' },
    ])
    expect(reveals()).toMatchObject([{ patch: { fromSecret: SECRET, rumor: SECRET }, source: { postId: 5 }, times: 1 }])
    accept([whisper])
    expect(reveals()).toMatchObject([{ times: 2 }])
    accept([{ ...whisper, status: 'confirmed', evidence: '본인이 인터뷰에서 말했다.', source: '소식 1' }], 2)
    expect(reveals()).toMatchObject([{ patch: { fromSecret: SECRET, public: SECRET }, round: 2 }])
    expect(listSuggestions(db, 'decided').map((s) => s.status)).toEqual(['expired'])
    // A whisper while the confirmation waits adds nothing; one you turned down isn't asked again.
    accept([whisper], 2)
    expect(reveals()).toHaveLength(1)
    suggestions.reject(db, reveals()[0]!.id)
    accept([{ ...whisper, status: 'confirmed' }], 3)
    expect(reveals()).toHaveLength(0)
    // The same tie named either way is one card.
    accept([{ target: 'P1', relationship: '가나나', status: 'confirmed', evidence: '둘이 대놓고 싸웠다.' }], 3)
    accept([{ target: 'P1', relationship: '가나나(가람고)', status: 'confirmed', evidence: '또 싸웠다.' }], 3)
    expect(reveals()).toMatchObject([{ patch: { relationships: [{ with: '가나나', visibility: 'public' }] }, times: 2 }])
  })

  it('adds nothing while reveals or the round sweep are off', () => {
    updateConfig(db, { ...loadConfig(db).config, lore: { roundSweep: true, suggest: { reveal: 'off' } } })
    accept([whisper])
    expect(reveals()).toHaveLength(0)
    updateConfig(db, { ...loadConfig(db).config, lore: { roundSweep: false, suggest: {} } })
    accept([whisper])
    expect(reveals()).toHaveLength(0)
    updateConfig(db, { ...loadConfig(db).config, lore: { roundSweep: true, suggest: {} } })
    accept([whisper])
    expect(reveals()).toHaveLength(1)
  })

  it('never asks again about a secret you turned down, as a whisper or a confirmation', () => {
    accept([{ ...whisper, status: 'confirmed', evidence: '본인이 밝혔다.' }])
    suggestions.reject(db, reveals()[0]!.id)
    accept([whisper], 2)
    expect(reveals()).toHaveLength(0)
    // And the other way round, for a tie.
    accept([{ target: 'P1', relationship: '가나나', status: 'whispered', evidence: '글 5에서 둘이 싸운다고 한다.' }], 2)
    suggestions.reject(db, reveals()[0]!.id)
    accept([{ target: 'P1', relationship: '가나나', status: 'confirmed', evidence: '감독이 밝혔다.' }], 3)
    expect(reveals()).toHaveLength(0)
  })

  it('takes a secret copied with the brackets the check saw it in', () => {
    accept([{ ...whisper, secret: `「${SECRET}」` }])
    expect(reveals()).toMatchObject([{ patch: { fromSecret: SECRET, rumor: SECRET } }])
  })

  it('a repeat brings its own source, and a failed approval stays on the card unless the repeat proves it wrong', () => {
    accept([whisper])
    const id = reveals()[0]!.id
    setSuggestionError(db, id, 'stale:secret-gone')
    accept([{ ...whisper, evidence: '경기 7 뒤에 다들 그 얘기다.', source: '경기 7' }])
    // The check just found the secret in the file again, so "no longer in the file" is wrong now.
    expect(getSuggestion(db, id)).toMatchObject({ times: 2, reason: '경기 7 뒤에 다들 그 얘기다.', source: { gameId: 7 }, error: null })
    // Any other failure stays.
    setSuggestionError(db, id, 'lore-error:heading-in-text')
    accept([whisper])
    expect(getSuggestion(db, id)).toMatchObject({ times: 3, error: 'lore-error:heading-in-text' })
    // A draft or trait card with a newer patch starts clean: the error was about the old one.
    const trait = { kind: 'trait' as const, target: { kind: 'player' as const, playerId: 'p1' }, reason: '', seasonId: 1, round: 1, jobId: null, dedupe: 'trait:player:p1:ego:4' }
    const t = addSuggestion(db, { ...trait, patch: { traits: { ego: 4 } } }, Date.now())!
    setSuggestionError(db, t.id, 'stale')
    addSuggestion(db, { ...trait, patch: { traits: { ego: 4 } }, source: { from: 3 } }, Date.now())
    expect(getSuggestion(db, t.id)).toMatchObject({ error: null, source: { from: 3 } })
  })

  it('a check that runs late, after a new season began, never expires the new season’s cards', () => {
    db.prepare("INSERT INTO seasons (label, phase, started_at) VALUES ('시즌 2', 'regular', 'now')").run()
    accept([whisper], 1, 2)
    expect(reveals()).toHaveLength(1)
    accept([], 9, 1)
    expect(reveals()).toHaveLength(1)
    // The round sweep's cards too.
    const sweep = loreKinds(db, dir).find((k) => k.kind === LORE_SUGGEST)!
    const input = { model: 'sonnet', context: '', instructions: '', targets: [], posts: [], seasonId: 1, round: 9 }
    const jobId = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES (?, 'running', ?, ?)").run(LORE_SUGGEST, JSON.stringify(input), new Date().toISOString()).lastInsertRowid)
    sweep.accept!({ suggestions: [] }, { id: jobId, kind: LORE_SUGGEST, input, createdAt: '' } as unknown as JobRow)
    expect(reveals()).toHaveLength(1)
    // A check of the current season still expires its own old cards.
    accept([], 9, 2)
    expect(reveals()).toHaveLength(0)
  })

  it('reveals a school’s and a GM’s secret, each in its own file', () => {
    const GM_SECRET = '사실은 이사장과 사이가 나쁘다.'
    const GM_FILE = `---\nid: 가람고 단장\nteam: 가람고\n---\n\n## 공개\n노련한 단장.\n\n## 비밀\n${GM_SECRET}\n`
    write('가람고 단장.md', GM_FILE)
    accept([
      { target: 'S1', secret: SCHOOL, status: 'confirmed', evidence: '감사 결과가 소식으로 나왔다.', source: '소식 1' },
      { target: 'G1', secret: GM_SECRET, status: 'whispered', evidence: '글 5에서 다들 말한다.', source: '글 5' },
    ])
    const school = reveals().find((s) => s.target.kind === 'team')!
    const gm = reveals().find((s) => s.target.kind === 'gm')!
    expect(school.patch).toEqual({ fromSecret: SCHOOL, public: SCHOOL })
    expect(gm.patch).toEqual({ fromSecret: GM_SECRET, rumor: GM_SECRET })
    // Nothing moves before approval.
    expect(read('가람고 단장.md')).toBe(GM_FILE)
    expect(suggestions.approve(db, dir, school.id)).toEqual({ status: 'approved', file: 'teams/가람고/가람고.md' })
    expect(suggestions.approve(db, dir, gm.id)).toEqual({ status: 'approved', file: 'teams/가람고/가람고 단장.md' })
    const league = readLeague(db, dir)
    expect(league.lore.team.get('t1')!.sections).toEqual({ public: `전통의 강호.\n\n${SCHOOL}`, rumor: '', secret: '' })
    expect(league.lore.gm.get('t1')!.sections).toEqual({ public: '노련한 단장.', rumor: GM_SECRET, secret: '' })
    expect(revealed()).toEqual([
      { suggestionId: school.id, target: 'team', playerId: null, teamId: 't1', to: 'public', text: SCHOOL, relationship: null },
      { suggestionId: gm.id, target: 'gm', playerId: null, teamId: 't1', to: 'rumor', text: GM_SECRET, relationship: null },
    ])
  })

  it('approves a player’s reveal after a trade moved his file to his new school', () => {
    accept([{ ...whisper, status: 'confirmed' }])
    const card = reveals()[0]!
    startSeason(db)
    applyTrade(db, [
      { kind: 'player', playerId: 'p1', from: 't1', to: 't2' },
      { kind: 'player', playerId: 'p7', from: 't2', to: 't1' },
    ])
    expect(syncLoreFolder(db, dir).moved).toEqual([{ from: 'teams/가람고/가가가.md', to: 'teams/나람고/가가가.md' }])
    expect(suggestions.approve(db, dir, card.id)).toEqual({ status: 'approved', file: 'teams/나람고/가가가.md' })
    expect(readFileSync(join(teamDir('나람고'), '가가가.md'), 'utf8')).toContain(`## 공개\n팀의 에이스.\n\n${SECRET}`)
    expect(revealed()).toMatchObject([{ playerId: 'p1', teamId: 't2', text: SECRET }])
  })

  it('takes a bulleted secret out whole, leaving the other items as they were', () => {
    const LIST = '- 사실 그는 입양아다.\n- 친부는 상대팀 감독이다.'
    write('가가가.md', ACE.replace(SECRET, LIST))
    accept([{ target: 'P1', secret: '사실 그는 입양아다.', status: 'confirmed', evidence: '본인이 밝혔다.' }])
    const card = reveals()[0]!
    expect(card.patch).toEqual({ fromSecret: '사실 그는 입양아다.', public: '사실 그는 입양아다.' })
    expect(suggestions.list(db, dir, 'pending').find((s) => s.id === card.id)!.current.secret).toBe(LIST)
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'approved' })
    // A decided card no longer carries 비밀 to the screen.
    expect(suggestions.list(db, dir, 'decided').find((s) => s.id === card.id)!.current.secret).toBeUndefined()
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: '팀의 에이스.\n\n사실 그는 입양아다.', rumor: '', secret: '- 친부는 상대팀 감독이다.' })
    // The last item too.
    write('가가가.md', ACE.replace(SECRET, LIST))
    accept([{ target: 'P1', secret: '친부는 상대팀 감독이다', status: 'confirmed', evidence: '감독이 밝혔다.' }], 2)
    expect(suggestions.approve(db, dir, reveals()[0]!.id)).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections.secret).toBe('- 사실 그는 입양아다.')
  })

  it('reveals only the tie of the kind named when there are several with one person', () => {
    const ties = (a: string, b: string) => `---\nid: 가가가\nrelationships:\n  - { with: 가나나, type: rival, strength: 3, visibility: ${a} }\n  - { with: 가나나, type: family, strength: 5, visibility: ${b} }\n---\n\n## 공개\n팀의 에이스.\n`
    // A public rivalry and a secret family tie: the family tie goes, the rivalry stays as it was.
    write('가가가.md', ties('public', 'secret'))
    accept([{ target: 'P1', relationship: '가나나', status: 'confirmed', evidence: '형제라고 밝혔다.' }])
    const card = reveals()[0]!
    expect(card.patch).toEqual({ relationships: [{ with: '가나나', type: 'family', strength: 5, visibility: 'public' }] })
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.settings).toMatchObject({
      relationships: [
        { with: '가나나', type: 'rival', visibility: 'public' },
        { with: '가나나', type: 'family', visibility: 'public' },
      ],
    })
    expect(revealed()).toMatchObject([{ to: 'public', relationship: { with: '가나나', type: 'family', playerId: 'p2' } }])
    // Two secret ties with him: each is its own card, named "이름 · 관계". (A fresh inbox: a tie you approved isn't asked about again as a whisper.)
    db.prepare('DELETE FROM suggestions').run()
    write('가가가.md', ties('secret', 'secret'))
    accept(
      [
        { target: 'P1', relationship: '「가나나」 · 가족 5', status: 'whispered', evidence: '형제라는 말이 돈다.' },
        { target: 'P1', relationship: '가나나 · 라이벌', status: 'confirmed', evidence: '라이벌이라고 밝혔다.' },
      ],
      2,
    )
    expect(reveals().map((s) => s.patch.relationships![0]!).sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { with: '가나나', type: 'family', strength: 5, visibility: 'rumor' },
      { with: '가나나', type: 'rival', strength: 3, visibility: 'public' },
    ])
    // The family tie changed by hand to another kind: its card is stale, and the rivalry is untouched by it.
    const family = reveals().find((s) => s.patch.relationships![0]!.type === 'family')!
    write('가가가.md', ties('secret', 'secret').replace('type: family', 'type: friend'))
    expect(suggestions.approve(db, dir, family.id)).toMatchObject({ status: 'error', code: 'stale' })
    expect(getSuggestion(db, family.id)!.error).toBe('stale:tie-gone')
    expect(read('가가가.md')).toBe(ties('secret', 'secret').replace('type: family', 'type: friend'))
  })

  it('makes no tie card when it can’t tell which secret tie was meant', () => {
    write('가가가.md', `---\nid: 가가가\nrelationships:\n  - { with: 가나나, type: family, strength: 5, visibility: secret }\n  - { with: 가나나, type: rival, strength: 3, visibility: secret }\n---\n\n## 공개\n팀의 에이스.\n`)
    // Two with him: no kind, or one the app doesn't know, could be either.
    accept([
      { target: 'P1', relationship: '가나나', status: 'confirmed', evidence: '라이벌이라고 밝혔다.' },
      { target: 'P1', relationship: '가나나 · 경쟁자', status: 'whispered', evidence: '경쟁 관계라는 말.' },
    ])
    expect(reveals()).toHaveLength(0)
    // A kind named in English is a kind.
    accept([{ target: 'P1', relationship: '가나나(가람고) · rival 3', status: 'whispered', evidence: '라이벌이라는 말.' }], 2)
    expect(reveals()).toMatchObject([{ patch: { relationships: [{ with: '가나나', type: 'rival', visibility: 'rumor' }] } }])
    // One with him (앙숙): a kind it isn't makes no card; no kind the app knows is that one.
    db.prepare('DELETE FROM suggestions').run()
    write('가가가.md', ACE)
    accept([{ target: 'P1', relationship: '가나나 · 가족', status: 'confirmed', evidence: '형제라고 밝혔다.' }], 3)
    expect(reveals()).toHaveLength(0)
    accept([{ target: 'P1', relationship: '가나나 · 사이가 나쁘다', status: 'confirmed', evidence: '둘이 대놓고 싸웠다.' }], 3)
    expect(reveals()).toMatchObject([{ patch: { relationships: [{ with: '가나나', type: 'dislikes', visibility: 'public' }] } }])
  })

  it('makes no card for text found in two places that widen to different sentences', () => {
    const TWO = '어머니는 그가 전학을 원한다고 생각한다. 사실 그는 전학을 원한다.'
    write('가가가.md', ACE.replace(SECRET, TWO))
    accept([{ target: 'P1', secret: '전학을 원한다', status: 'confirmed', evidence: '본인이 전학을 원한다고 밝혔다.' }])
    expect(reveals()).toHaveLength(0)
    // Copied whole, it's that sentence.
    accept([{ target: 'P1', secret: '사실 그는 전학을 원한다.', status: 'confirmed', evidence: '본인이 밝혔다.' }], 2)
    const card = reveals()[0]!
    expect(card.patch).toEqual({ fromSecret: '사실 그는 전학을 원한다.', public: '사실 그는 전학을 원한다.' })
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections.secret).toBe('어머니는 그가 전학을 원한다고 생각한다.')
  })

  it('a cut that would leave a heading-like line is refused, and keeping words in its place gets it through', () => {
    write('가가가.md', ACE.replace(SECRET, `${SECRET}. #비밀계정`))
    accept([{ target: 'P1', secret: `${SECRET}.`, status: 'confirmed', evidence: '본인이 밝혔다.' }])
    const card = reveals()[0]!
    expect(card.patch).toEqual({ fromSecret: `${SECRET}.`, public: `${SECRET}.` })
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'error', code: 'lore-error', detail: 'heading-in-text' })
    expect(getSuggestion(db, card.id)!.error).toBe('lore-error:heading-in-text')
    // What the message suggests: words of your own in the text's place, so the tag isn't at a line's start.
    expect(suggestions.approve(db, dir, card.id, { public: `${SECRET}.`, keepSecret: '비밀 계정이 있다.' })).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toMatchObject({ public: `팀의 에이스.\n\n${SECRET}.`, secret: '비밀 계정이 있다. #비밀계정' })
  })

  it('a secret you kept in 비밀 while approving isn’t asked about again, except to confirm a whisper', () => {
    const confirmed = { ...whisper, status: 'confirmed', evidence: '본인이 인터뷰에서 말했다.', source: '소식 1' }
    accept([confirmed])
    expect(suggestions.approve(db, dir, reveals()[0]!.id, { public: '전학을 원한다고 직접 밝혔다.', keepSecret: SECRET })).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: '팀의 에이스.\n\n전학을 원한다고 직접 밝혔다.', rumor: '', secret: SECRET })
    // Still in 비밀, so the next check finds it: neither a whisper nor a confirmation is asked again.
    accept([whisper], 2)
    accept([confirmed], 2)
    expect(reveals()).toHaveLength(0)
    // Approved as a whisper and kept, a confirmation is still worth asking about.
    write('가가가.md', ACE.replace(SECRET, '사실은 부상을 숨기고 있다.'))
    accept([{ ...whisper, secret: '부상을 숨기고 있다' }], 3)
    expect(suggestions.approve(db, dir, reveals()[0]!.id, { rumor: '부상설이 돈다.', keepSecret: '사실은 부상을 숨기고 있다.' })).toMatchObject({ status: 'approved' })
    accept([{ ...whisper, secret: '부상을 숨기고 있다' }], 4)
    expect(reveals()).toHaveLength(0)
    accept([{ ...confirmed, secret: '부상을 숨기고 있다' }], 4)
    expect(reveals()).toMatchObject([{ patch: { fromSecret: '사실은 부상을 숨기고 있다.', public: '사실은 부상을 숨기고 있다.' } }])
  })

  it('matches keys by how they start whatever a name holds (an emoji is one letter to SQLite, two to JS)', () => {
    write('가가가.md', ACE.replace('with: 가나나', 'with: 🐯가나나'))
    accept([{ target: 'P1', relationship: '🐯가나나', status: 'whispered', evidence: '글 5에서 둘이 싸운다고 한다.' }])
    expect(reveals()).toHaveLength(1)
    // A confirmation replaces the whisper.
    accept([{ target: 'P1', relationship: '🐯가나나', status: 'confirmed', evidence: '감독이 밝혔다.' }], 2)
    expect(reveals()).toMatchObject([{ patch: { relationships: [{ with: '🐯가나나', visibility: 'public' }] } }])
    expect(listSuggestions(db, 'decided').map((s) => s.status)).toEqual(['expired'])
    // Turned down, it isn't asked again either way.
    suggestions.reject(db, reveals()[0]!.id)
    accept([{ target: 'P1', relationship: '🐯가나나', status: 'whispered', evidence: '또 싸웠다.' }], 3)
    expect(reveals()).toHaveLength(0)
  })

  it('moves all of a long secret, never cutting more than goes public', () => {
    const LONG = `${'가'.repeat(900)}. ${'나'.repeat(800)}.`
    write('가가가.md', ACE.replace(SECRET, LONG))
    accept([{ target: 'P1', secret: LONG, status: 'confirmed', evidence: '본인이 다 밝혔다.' }])
    const card = reveals()[0]!
    expect(card.patch).toEqual({ fromSecret: LONG, public: LONG })
    // Your own wording may not run longer than the secret: refused with a reason, nothing written.
    expect(suggestions.approve(db, dir, card.id, { public: `${LONG}더` })).toMatchObject({ status: 'error', code: 'invalid' })
    expect(getSuggestion(db, card.id)!.error).toBe('invalid:too-long')
    expect(read('가가가.md')).toBe(ACE.replace(SECRET, LONG))
    expect(suggestions.approve(db, dir, card.id)).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: `팀의 에이스.\n\n${LONG}`, rumor: '', secret: '' })
    expect(revealed()[0]!.text).toBe(LONG)
  })

  it('adds the text even when 공개 already holds the same words, and cuts it from 비밀', () => {
    const HELD = '사실은 전학을 원한다는 소문은 거짓이라고 본인이 말했다.'
    write('가가가.md', ACE.replace('팀의 에이스.', HELD))
    accept([{ ...whisper, status: 'confirmed' }])
    expect(suggestions.approve(db, dir, reveals()[0]!.id)).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: `${HELD}\n\n${SECRET}`, rumor: '', secret: '' })
  })

  it('keeps what you choose in 비밀, and says nothing of it', () => {
    const TWO = '사실은 전학을 원한다. 아버지가 감독과 싸웠기 때문이다.'
    write('가가가.md', ACE.replace(SECRET, TWO))
    accept([{ target: 'P1', secret: TWO, status: 'confirmed', evidence: '본인이 밝혔다.' }])
    const card = reveals()[0]!
    expect(suggestions.approve(db, dir, card.id, { public: '사실은 전학을 원한다.', keepSecret: '아버지가 감독과 싸웠기 때문이다.' })).toMatchObject({ status: 'approved' })
    expect(readLeague(db, dir).lore.player.get('p1')!.sections).toEqual({ public: '팀의 에이스.\n\n사실은 전학을 원한다.', rumor: '', secret: '아버지가 감독과 싸웠기 때문이다.' })
    expect(revealed()).toMatchObject([{ text: '사실은 전학을 원한다.' }])
    expect(JSON.stringify(revealed())).not.toContain('감독과 싸웠')
  })
})

describe('who the check looks at, and when', () => {
  /** A school's secret and its GM's, for the schools after the first. */
  const schoolSecrets = (teams: string[]) => {
    for (const short of teams) {
      mkdirSync(teamDir(short), { recursive: true })
      writeFileSync(join(teamDir(short), `${short}.md`), `---\nid: ${short}\n---\n\n## 비밀\n${short}의 재단이 돈을 빼돌렸다.\n`)
      writeFileSync(join(teamDir(short), `${short} 단장.md`), `---\nid: ${short} 단장\nteam: ${short}\n---\n\n## 비밀\n${short} 단장은 사실 사표를 냈다.\n`)
    }
  }
  const post = (title: string) => {
    db.prepare("INSERT OR IGNORE INTO personas (id, kind, nick, archetype, spice) VALUES ('me', 'user', '나', 'user', 1)").run()
    const at = new Date().toISOString()
    db.prepare("INSERT INTO posts (board_id, author_id, kind, title, body, up, shown_at, last_activity) VALUES ('free', 'me', 'thread', ?, '', 5, ?, ?)").run(title, at, at)
  }

  it('puts players’ words, trades and news ahead of games, and games ahead of being named in a post; a GM only for trades and news', () => {
    const others = ['나람고', '다람고', '라람고', '마람고', '바람고', '사람고', '아람고']
    schoolSecrets(others)
    startSeason(db)
    story.news('test', db, dir, '가가가, 오늘 훈련에서 빛났다')
    // Every other school named in two posts: under the old count they (and their GMs) pushed the ace out.
    for (const t of ['나람고 다람고 라람고', '마람고 바람고 사람고', '아람고 나람고', '다람고 라람고 마람고', '바람고 사람고 아람고', '잡담']) post(t)
    const input = revealInput(readLeague(db, dir), 1, 1)!
    expect(input.targets).toHaveLength(8)
    expect(input.targets[0]).toMatchObject({ key: 'P1', target: { kind: 'player', playerId: 'p1' } })
    expect(input.targets.filter((t) => t.target.kind === 'team')).toHaveLength(7)
    expect(input.targets.some((t) => t.target.kind === 'gm')).toBe(false)
    expect(input.context).not.toContain('사표')
    // News naming a school is about its GM too.
    story.news('test', db, dir, '나람고 단장이 기자회견을 열었다')
    const after = revealInput(readLeague(db, dir), 1, 1)!
    expect(after.targets.map((t) => t.target)).toContainEqual({ kind: 'gm', teamId: 't2' })
  })

  it('with no mark yet (just upgraded), starts at this round, not at the league’s first news', () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    story.news('test', db, dir, NEWS)
    playRound(1)
    story.afterChange('test', db, dir)
    db.prepare('DELETE FROM story_state WHERE key = ?').run(REVEAL_MARK)
    story.news('test', db, dir, '가가가, 오늘 훈련에서 빛났다')
    playRound(2)
    const input = revealInput(readLeague(db, dir), 1, 2)!
    expect(input.context).toContain('오늘 훈련에서 빛났다')
    expect(input.context).not.toContain(NEWS)
    // In round 1 it starts at the season's start.
    expect(revealInput(readLeague(db, dir), 1, 1)!.context).toContain(NEWS)
  })

  it('with no mark yet, starts after the last earlier round’s games even when the schedule skips a round number', () => {
    startSeason(db)
    // A schedule built by hand: round 1, then round 102 (no 101).
    db.prepare("UPDATE games SET round = round + 100 WHERE stage = 'regular' AND round >= 2").run()
    story.news('test', db, dir, NEWS)
    playRound(1)
    story.news('test', db, dir, '가가가, 오늘 훈련에서 빛났다')
    playRound(102)
    db.prepare('DELETE FROM story_state WHERE key = ?').run(REVEAL_MARK)
    const input = revealInput(readLeague(db, dir), 1, 102)!
    expect(input.context).toContain('오늘 훈련에서 빛났다')
    expect(input.context).not.toContain(NEWS)
  })

  it('a queued check no longer runs once reveals or the round sweep are off, or the league can’t be read', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    story.news('test', db, dir, NEWS)
    playRound(1)
    story.afterChange('test', db, dir)
    expect(jobs(LORE_REVEAL)).toMatchObject([{ status: 'queued' }])
    suggestions.setMode(db, dir, 'reveal', 'off')
    await drain()
    expect(jobs(LORE_REVEAL)).toMatchObject([{ status: 'cancelled' }])
    expect(reveals()).toHaveLength(0)
    const job = { createdAt: new Date().toISOString() } as JobRow
    const wanted = () => revealKind(db, dir).stillWanted!({} as LoreRevealInput, job)
    expect(wanted()).toBe(false)
    suggestions.setMode(db, dir, 'reveal', 'ask')
    expect(wanted()).toBe(true)
    suggestions.saveSettings(db, dir, { roundSweep: false, suggest: {} })
    expect(wanted()).toBe(false)
    const empty = openDb(join(dir, 'empty.db'))
    expect(revealKind(empty, dir).stillWanted!({} as LoreRevealInput, job)).toBe(false)
    empty.close()
  })

  it('keeps the mark where it was while Claude Code isn’t usable, so the next check still sees the news', async () => {
    startSeason(db)
    story.news('test', db, dir, NEWS)
    playRound(1)
    delete process.env.TWOK_FAKE_AI
    process.env.TWOK_NO_AI = '1'
    const off = new AiService()
    try {
      await off.refresh()
      expect(off.unavailable()).toBe(true)
      const offline = new SuggestionService(off, new LoreService(join(process.cwd(), 'defaults')))
      expect(offline.revealSweep('test', db, dir, 1, 1)).toBe(false)
      expect(storyValue(db, REVEAL_MARK)).toBeNull()
      setStoryValue(db, REVEAL_MARK, '1')
      expect(offline.revealSweep('test', db, dir, 1, 1)).toBe(false)
      expect(storyValue(db, REVEAL_MARK)).toBe('1')
    } finally {
      off.closeAll()
      delete process.env.TWOK_NO_AI
      process.env.TWOK_FAKE_AI = '1'
    }
    expect(suggestions.revealSweep('test', db, dir, 1, 1)).toBe(true)
    expect(jobs(LORE_REVEAL)[0]!.input).toContain(NEWS)
    expect(storyValue(db, REVEAL_MARK)).toBe(String(lastEventId(db)))
  })

  it('clears the check’s input and answer three days after it ran', async () => {
    await revealAfterNews()
    const row = () => db.prepare('SELECT input, output FROM jobs WHERE kind = ?').get(LORE_REVEAL) as { input: string; output: string | null }
    expect(row().input).toContain(SECRET)
    expect(row().output).toContain(SECRET)
    story.prune(db, dir, Date.now() + 2 * 86_400_000)
    expect(row().input).toContain(SECRET)
    story.prune(db, dir, Date.now() + 4 * 86_400_000)
    expect(row()).toEqual({ input: '{}', output: null })
  })
})

describe('reveals always ask', () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return e instanceof RuleError ? e.issues[0]!.code : String(e)
    }
    return 'no-error'
  }

  it('can be asked about or off, never applied by a setting or a batch', async () => {
    expect(refusal(() => suggestions.setMode(db, dir, 'reveal', 'auto'))).toBe('reveal-always-asks')
    expect(refusal(() => suggestions.saveSettings(db, dir, { roundSweep: true, suggest: { fact: 'auto', reveal: 'auto' } }))).toBe('reveal-always-asks')
    expect(loadConfig(db).config.lore.suggest).toEqual({})

    // Off: no check, and the mark moves on, so turning it back on doesn't look at the old news.
    suggestions.setMode(db, dir, 'reveal', 'off')
    startSeason(db)
    story.afterChange('test', db, dir)
    story.news('test', db, dir, NEWS)
    playRound(1)
    story.afterChange('test', db, dir)
    expect(jobs(LORE_REVEAL)).toHaveLength(0)
    suggestions.setMode(db, dir, 'reveal', 'ask')
    playRound(2)
    story.afterChange('test', db, dir)
    expect(jobs(LORE_REVEAL)).toHaveLength(1)
    expect(jobs(LORE_REVEAL)[0]!.input).not.toContain(NEWS)

    // The round sweep off: no check either.
    suggestions.saveSettings(db, dir, { roundSweep: false, suggest: {} })
    playRound(3)
    story.afterChange('test', db, dir)
    expect(jobs(LORE_REVEAL)).toHaveLength(1)
  })

  it('a waiting card is never applied by itself, even with auto forced into the settings', async () => {
    await revealAfterNews()
    const card = reveals()[0]!
    updateConfig(db, { ...loadConfig(db).config, lore: { roundSweep: true, suggest: { reveal: 'auto' } } })
    expect(suggestions.applyAuto(db, dir)).toBe(0)
    expect(suggestions.approveMany(db, dir, [card.id])).toEqual({ approved: 0, failed: 1 })
    expect(getSuggestion(db, card.id)).toMatchObject({ status: 'pending', error: null })
    expect(read('가가가.md')).toBe(ACE)
  })

  it('reads an auto written into the settings by hand as asking, so saving the rest still works', () => {
    updateConfig(db, { ...loadConfig(db).config, lore: { roundSweep: true, suggest: { reveal: 'auto', fact: 'auto' } } })
    const { lore } = loadConfig(db).config
    expect(lore.suggest).toEqual({ fact: 'auto' })
    expect(refusal(() => suggestions.saveSettings(db, dir, { ...lore, suggest: { ...lore.suggest, nickname: 'off' } }))).toBe('no-error')
    expect(loadConfig(db).config.lore.suggest).toEqual({ fact: 'auto', nickname: 'off' })
  })
})

describe('nothing reaches a writer while a tie card waits', () => {
  it('keeps the secret tie out of every writer’s job until you approve it', async () => {
    await revealAfterNews('가가가와 가나나가 연습 중에 또 크게 다퉜다고 감독이 밝혔다')
    expect(reveals()).toMatchObject([{ patch: { relationships: [{ with: '가나나', type: 'dislikes' }] } }])
    playRound(2)
    story.afterChange('test', db, dir)
    await drain()
    expect(writerJobs().length).toBeGreaterThan(3)
    for (const j of writerJobs()) {
      expect(j.input).not.toContain('dislikes')
      expect(j.input).not.toContain('앙숙')
      expect(j.input).not.toContain(SECRET)
    }
  })
})

describe('through the app’s handlers', () => {
  it('finds the reveal after a round, refuses auto, and an approval gets its thread', async () => {
    const ctx = createContext(join(dir, 'data'), join(process.cwd(), 'defaults'), '0')
    const info = { version: '0', dataDir: ctx.dataDir, isPackaged: false }
    const h = withStory(
      createHandlers({ context: () => ctx, appInfo: () => info, pickFile: async () => null, pickFolder: async () => null, openFolder: () => {}, showItem: () => {}, switchDataDir: () => info }),
      () => ctx,
    )
    try {
      ctx.leagues.create({ slug: 'rv', setup: sampleSetup(), saveTemplate: null, importMapping: null })
      await h['ai.recheck']()
      const lore = join(ctx.dataDir, 'rv', 'lore', 'teams', '가람고')
      mkdirSync(lore, { recursive: true })
      writeFileSync(join(lore, '가가가.md'), ACE)
      await h['season.start']('rv')
      await h['community.news']('rv', { text: NEWS })
      for (const g of (await h['season.games']('rv')).filter((x) => x.round === 1)) await h['season.recordScore']('rv', { gameId: g.id, homeScore: 80, awayScore: 70, lines: null })
      const leagueDb = ctx.leagues.dbFor('rv')
      await ctx.ai.queueFor('rv', leagueDb, ctx.leagues.folderOf('rv')).kick()

      const card = (await h['suggestions.list']('rv', 'pending')).find((s) => s.kind === 'reveal')!
      expect(card).toMatchObject({ name: '가가가', patch: { fromSecret: SECRET, public: SECRET }, current: { exists: true, public: '팀의 에이스.', rumor: '' } })
      let refused: unknown
      try {
        await h['suggestions.setMode']('rv', 'reveal', 'auto')
      } catch (e) {
        refused = e
      }
      expect((refused as AppError).toShape()).toMatchObject({ code: 'rule', rules: [{ code: 'reveal-always-asks' }] })
      let refusedSave: unknown
      try {
        await h['suggestions.saveSettings']('rv', { roundSweep: true, suggest: { fact: 'auto', reveal: 'auto' } })
      } catch (e) {
        refusedSave = e
      }
      expect((refusedSave as AppError).toShape()).toMatchObject({ code: 'rule', rules: [{ code: 'reveal-always-asks' }] })
      expect(loadConfig(leagueDb).config.lore.suggest).toEqual({})

      // What you keep in 비밀 comes through the handler and stays there; only the card's text goes public.
      expect(await h['suggestions.approve']('rv', card.id, { public: SECRET, keepSecret: '아버지는 반대한다.' })).toEqual({ status: 'approved', file: 'teams/가람고/가가가.md' })
      expect(readFileSync(join(lore, '가가가.md'), 'utf8')).toContain(`팀의 에이스.\n\n${SECRET}`)
      expect(readFileSync(join(lore, '가가가.md'), 'utf8')).toContain('## 비밀\n아버지는 반대한다.')
      const threads = (leagueDb.prepare("SELECT input FROM jobs WHERE kind = 'event_thread'").all() as { input: string }[]).filter((j) => j.input.includes('감춰졌던 이야기가 밝혀짐'))
      expect(threads).toHaveLength(1)
      expect(threads[0]!.input).not.toContain('아버지는 반대한다')
      expect(existsSync(join(ctx.dataDir, 'rv', 'backups', 'lore'))).toBe(true)
    } finally {
      ctx.ai.closeAll()
      ctx.leagues.closeAll()
    }
  })
})
