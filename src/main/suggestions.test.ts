import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { currentSeason, listPlayers, seedLeague } from '@data/league'
import { listGames, recordScore, startSeason } from '@data/season'
import { addSuggestion, expireOld, getSuggestion, listSuggestions } from '@data/suggestions'
import { loreFor, readLeague } from '@story/context'
import { storyDemo, storyKinds } from '@story/jobs'
import { loreDemo, loreKinds, suggestionPatch, type LoreJobTarget } from '@story/loreJobs'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { AiService } from './ai'
import { LoreService } from './lore'
import { StoryService } from './story'
import { SuggestionService } from './suggestions'

const SECRET = '사실은 전학을 원한다'

let dir: string
let db: Db
let ai: AiService
let lore: LoreService
let suggestions: SuggestionService
let story: StoryService

const loreDir = () => join(dir, 'lore', 'teams', '가람고')
const read = (name: string) => readFileSync(join(loreDir(), name), 'utf8')

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-suggest-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  mkdirSync(loreDir(), { recursive: true })
  // The school is written in (story and fans), the ace has a story and a secret but no traits yet.
  writeFileSync(join(loreDir(), '가람고.md'), '---\nid: 가람고\nfans:\n  size: 5\n---\n\n## 공개\n전통의 강호.\n\n## 소문\n\n## 비밀\n')
  writeFileSync(join(loreDir(), '가가가.md'), `---\nid: 가가가\n---\n\n## 공개\n팀의 에이스.\n\n## 소문\n\n## 비밀\n${SECRET}\n`)
  ai = new AiService()
  lore = new LoreService(join(process.cwd(), 'defaults'))
  suggestions = new SuggestionService(ai, lore)
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d, f) => loreKinds(d, f, { afterStore: (x, y) => void suggestions.applyAuto(x, y) }), loreDemo)
  await ai.refresh()
  story = new StoryService(ai, { onRound: (slug, d, f, season, round) => suggestions.sweep(slug, d, f, season, round) })
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const drain = async () => {
  await ai.queueFor('test', db, dir).kick()
  // Auto-approvals run just after the job's own transaction.
  await new Promise((r) => setImmediate(r))
}
const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]
const card = (playerOrTeam: string) => listSuggestions(db, 'pending').find((s) => (s.target.kind === 'player' ? s.target.playerId : `${s.target.kind}:${s.target.teamId}`) === playerOrTeam)!
const playRound = (round: number) => {
  for (const g of listGames(db, 1).filter((x) => x.stage === 'regular' && x.round === round)) {
    const lines = listPlayers(db)
      .filter((p) => p.teamId === g.home || p.teamId === g.away)
      .map((p, i) => ({ playerId: p.id, teamId: p.teamId, stats: { pts: 30 - i, fgm: 10, fga: 20 } }))
    recordScore(db, { gameId: g.id, homeScore: 80, awayScore: 70, lines })
  }
}

describe('lore drafts', () => {
  it('drafts only the blank parts of a school, never sees a secret, and changes nothing until approved', async () => {
    const before = read('가가가.md')
    expect(suggestions.draft('test', db, dir, { scope: 'team', teamId: 't1' })).toEqual({ jobs: 1, targets: 7 })
    expect(jobs('lore_draft')[0]!.input).not.toContain(SECRET)
    await drain()
    const pending = listSuggestions(db, 'pending')
    // The GM and all six players; the school is written in already.
    expect(pending.map((s) => s.target.kind).sort()).toEqual(['gm', 'player', 'player', 'player', 'player', 'player', 'player'])
    // The ace keeps his story: his card only fills traits.
    const ace = card('p1')
    expect(ace.patch.public).toBeUndefined()
    expect(Object.keys(ace.patch.traits ?? {})).toHaveLength(7)
    // Nothing reached the files, so no writer can use it yet.
    expect(read('가가가.md')).toBe(before)
    expect(existsSync(join(loreDir(), '가람고 단장.md'))).toBe(false)
    expect(loreFor(readLeague(db, dir), [], ['p2'])).toBe('')
    // Asking again doesn't duplicate what's waiting.
    expect(suggestions.draft('test', db, dir, { scope: 'team', teamId: 't1' })).toEqual({ jobs: 0, targets: 0 })
  })

  it('approves through the editor merge (keeping your edits and a backup), as edited, or turns a card down', async () => {
    suggestions.draft('test', db, dir, { scope: 'team', teamId: 't1' })
    await drain()
    // A player without a file gets one from the template, with the draft in it.
    const second = card('p2')
    expect(suggestions.approve(db, dir, second.id)).toEqual({ status: 'approved', file: 'teams/가람고/가나나.md' })
    expect(read('가나나.md')).toContain(second.patch.public!)
    expect(read('가나나.md')).toContain('# 1(낮음) ~ 5(높음)')
    // You edit the ace's file meanwhile; approving an edited card keeps your edit.
    writeFileSync(join(loreDir(), '가가가.md'), read('가가가.md').replace('## 소문\n', '## 소문\n감독과 불화설.\n'))
    const ace = card('p1')
    expect(suggestions.approve(db, dir, ace.id, { traits: { ...ace.patch.traits, ego: 5 }, public: '경기 전엔 꼭 혼자 슛을 쏜다.' })).toEqual({
      status: 'approved',
      file: 'teams/가람고/가가가.md',
    })
    const text = read('가가가.md')
    expect(text).toContain('감독과 불화설.')
    expect(text).toMatch(/ego: 5/)
    expect(text).toContain('팀의 에이스.\n\n경기 전엔 꼭 혼자 슛을 쏜다.')
    expect(text).toContain(SECRET)
    expect(readdirSync(join(dir, 'backups', 'lore', 'teams', '가람고', '가가가')).length).toBeGreaterThan(0)
    expect(getSuggestion(db, ace.id)!.patch.traits!.ego).toBe(5)
    // Decided cards can't be applied again.
    expect(suggestions.approve(db, dir, ace.id)).toMatchObject({ status: 'error', code: 'gone' })
    const gm = card('gm:t1')
    suggestions.reject(db, gm.id)
    expect(getSuggestion(db, gm.id)!.status).toBe('rejected')
    expect(existsSync(join(loreDir(), '가람고 단장.md'))).toBe(false)
  })

  it('drafts one file with your own description', async () => {
    expect(suggestions.draft('test', db, dir, { scope: 'one', target: { kind: 'player', playerId: 'p1' }, hint: '수비만 하는 노력파' })).toEqual({ jobs: 1, targets: 1 })
    expect(jobs('lore_draft')[0]!.input).toContain('수비만 하는 노력파')
    // Heights in the league's own unit (ft-in here, as 2K shows them).
    expect(jobs('lore_draft')[0]!.input).toContain('6피트 1인치')
    await drain()
    const ace = card('p1')
    expect(ace.patch.public).toContain('수비만 하는 노력파')
    expect(ace.source.hint).toBe('수비만 하는 노력파')
  })
})

describe('round suggestions', () => {
  it('sweeps each finished round; nicknames go on the roster; kinds can approve themselves or be turned off', async () => {
    startSeason(db)
    story.afterChange('test', db, dir)
    playRound(1)
    story.afterChange('test', db, dir)
    expect(jobs('lore_suggest')).toHaveLength(1)
    await drain()
    const kinds = listSuggestions(db, 'pending').map((s) => s.kind).sort()
    expect(kinds).toEqual(['fact', 'nickname', 'relationship'])
    const nick = listSuggestions(db, 'pending').find((s) => s.kind === 'nickname')!
    expect(suggestions.approve(db, dir, nick.id)).toEqual({ status: 'approved', file: null })
    const target = (nick.target as { playerId: string }).playerId
    expect(listPlayers(db).find((p) => p.id === target)!.nicknames).toContain('R1의 사나이')

    // "Always approve" facts: the waiting one is applied now, later ones as they arrive.
    expect(suggestions.setMode(db, dir, 'fact', 'auto')).toEqual({ applied: 1 })
    suggestions.setMode(db, dir, 'relationship', 'off')
    playRound(2)
    story.afterChange('test', db, dir)
    await drain()
    const pending = listSuggestions(db, 'pending')
    expect(pending.filter((s) => s.kind === 'fact')).toHaveLength(0)
    expect(pending.filter((s) => s.round === 2 && s.kind === 'relationship')).toHaveLength(0)
    const facts = listSuggestions(db, 'decided').filter((s) => s.kind === 'fact')
    expect(facts.map((s) => s.auto)).toEqual([true, true])
  }, 30_000) // Several rounds of writing: slow when the machine is busy.
})

describe('what the review found', () => {
  const P1: LoreJobTarget = { key: 'P1', target: { kind: 'player', playerId: 'p1' }, name: '가가가', ref: '가가가', parts: null }
  const P2: LoreJobTarget = { key: 'P2', target: { kind: 'player', playerId: 'p2' }, name: '가나나', ref: '가나나', parts: null }
  const ask = (s: Record<string, unknown>) => suggestionPatch(readLeague(db, dir), [P1, P2], P1, s.kind as never, { target: 'P1', reason: '', ...s } as never)

  it('a story card is a story: a box-score line is dropped, three a round at most, one per player', () => {
    // A game's numbers retold is no lore (the box score is kept already); one telling number is.
    expect(ask({ kind: 'fact', section: 'public', text: '개막전에서 야투 21/33, 3점 7/12로 50점을 넣었지만 팀은 78-91로 졌다.' })).toBeNull()
    expect(ask({ kind: 'fact', section: 'public', text: '개막전에서 50점을 넣고도 졌다. 팬들은 이 경기를 "혼자 하는 농구"의 시작으로 꼽는다.' })?.patch).toEqual({
      public: '개막전에서 50점을 넣고도 졌다. 팬들은 이 경기를 "혼자 하는 농구"의 시작으로 꼽는다.',
    })

    const roster = listPlayers(db).slice(0, 5)
    const targets: LoreJobTarget[] = roster.map((p, i) => ({ key: `P${i + 1}`, target: { kind: 'player', playerId: p.id }, name: p.name, ref: p.name, parts: null }))
    const input = { model: 'sonnet', context: '', instructions: '', targets, posts: [], seasonId: currentSeason(db).id, round: 1 }
    const id = Number(
      db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('lore_suggest', 'running', 12, ?, ?)").run(JSON.stringify(input), new Date().toISOString())
        .lastInsertRowid,
    )
    const story = (key: string, text: string) => ({ kind: 'fact', target: key, section: 'public', text, reason: '' })
    const output = {
      suggestions: [
        story('P1', '첫 경기에서 버저비터를 넣었다.'),
        story('P1', '같은 경기에서 감독과 언성을 높였다.'),
        story('P2', '주장 완장을 두고 팀 안에서 말이 나오기 시작했다.'),
        story('P3', '데뷔전에서 벤치를 지키다 4쿼터에만 뛰고 승부를 뒤집었다.'),
        story('P4', '라이벌전에서 결승 자유투를 놓쳤다.'),
        story('P5', '전학 온 첫 주에 별명이 생겼다.'),
      ],
    }
    const kind = loreKinds(db, dir).find((k) => k.kind === 'lore_suggest')!
    kind.accept!(output as never, { id, kind: 'lore_suggest', status: 'running', priority: 12, input } as never)
    const facts = listSuggestions(db, 'pending').filter((s) => s.kind === 'fact')
    const of = (s: (typeof facts)[number]) => (s.target as { playerId: string }).playerId
    expect(facts.map(of).sort()).toEqual(roster.slice(0, 3).map((p) => p.id).sort())
    // The first of P1's two is the one kept.
    expect(facts.find((s) => of(s) === roster[0]!.id)!.patch).toEqual({ public: '첫 경기에서 버저비터를 넣었다.' })
  })

  it('keeps secret relationships out of both jobs and never rewrites one', async () => {
    writeFileSync(
      join(loreDir(), '가가가.md'),
      `---
id: 가가가
relationships:
  - { with: 가나나, type: family, strength: 5, visibility: secret }
---

## 공개
팀의 에이스.

## 비밀
${SECRET}
`,
    )
    suggestions.draft('test', db, dir, { scope: 'one', target: { kind: 'player', playerId: 'p1' } })
    const input = jobs('lore_draft')[0]!.input
    expect(input).not.toContain('family')
    expect(input).not.toContain(SECRET)
    expect(ask({ kind: 'relationship', with: 'P2', type: 'rival', strength: 3, visibility: 'public' })).toBeNull()
  })

  it('moves a trait one step at a time, and turns a "secret" from the AI into a rumour', () => {
    expect(ask({ kind: 'trait', trait: 'ego', value: 5 })).toMatchObject({ patch: { traits: { ego: 4 } }, from: 3 })
    expect(ask({ kind: 'relationship', with: 'P2', type: 'friend', strength: 3, visibility: 'secret' })?.patch.relationships?.[0]?.visibility).toBe('rumor')
  })

  it('a bulk draft leaves out anyone already in a draft job, so your description wins', async () => {
    suggestions.draft('test', db, dir, { scope: 'one', target: { kind: 'player', playerId: 'p2' }, hint: '노력파' })
    expect(suggestions.draft('test', db, dir, { scope: 'team', teamId: 't1' })).toEqual({ jobs: 1, targets: 6 })
    await drain()
    expect(card('p2').source.hint).toBe('노력파')
  })

  it('a card taken as it is must still fit the file', async () => {
    suggestions.draft('test', db, dir, { scope: 'team', teamId: 't1' })
    await drain()
    // You write the story yourself meanwhile: the draft's 공개 is left out, and with nothing else left it's stale.
    const second = card('p2')
    writeFileSync(join(loreDir(), '가나나.md'), '---\nid: 가나나\ntraits: { ego: 4 }\n---\n\n## 공개\n내가 쓴 이야기.\n\n## 소문\n소문.\n')
    expect(suggestions.approve(db, dir, second.id)).toMatchObject({ status: 'error', code: 'stale' })
    expect(getSuggestion(db, second.id)!.error).toBe('stale')
    // Edited, it goes in as you wrote it.
    expect(suggestions.approve(db, dir, second.id, { public: '덧붙임.' })).toMatchObject({ status: 'approved' })
    expect(read('가나나.md')).toContain('내가 쓴 이야기.\n\n덧붙임.')
  })
})

describe('round suggestions with the community off', () => {
  it('still sweeps finished rounds, and writes no threads', async () => {
    const { config } = (await import('@data/league')).loadConfig(db)
    story.saveSettings(db, { ...config.community, enabled: false })
    startSeason(db)
    story.afterChange('test', db, dir)
    playRound(1)
    expect(story.afterChange('test', db, dir)).toBe(1)
    expect(jobs('lore_suggest')).toHaveLength(1)
    expect(jobs('post_game_thread')).toHaveLength(0)
  })
})

describe('the inbox store', () => {
  it('merges repeats, never re-asks what you decided, and expires old round cards', () => {
    const base = { kind: 'nickname' as const, target: { kind: 'player' as const, playerId: 'p1' }, patch: { nicknames: ['킹'] }, reason: '', seasonId: 1, jobId: null }
    const a = addSuggestion(db, { ...base, dedupe: 'nickname:player:p1:킹', round: 1 }, Date.now())!
    expect(addSuggestion(db, { ...base, dedupe: 'nickname:player:p1:킹', round: 2 }, Date.now())).toEqual({ id: a.id, merged: true })
    expect(getSuggestion(db, a.id)!.times).toBe(2)
    db.prepare("UPDATE suggestions SET status = 'rejected' WHERE id = ?").run(a.id)
    expect(addSuggestion(db, { ...base, dedupe: 'nickname:player:p1:킹', round: 3 }, Date.now())).toBeNull()
    const b = addSuggestion(db, { ...base, patch: { nicknames: ['왕'] }, dedupe: 'nickname:player:p1:왕', round: 2 }, Date.now())!
    expect(expireOld(db, 1, 4, 3, Date.now())).toBe(0)
    expect(expireOld(db, 1, 5, 3, Date.now())).toBe(1)
    expect(getSuggestion(db, b.id)!.status).toBe('expired')
  })
})
