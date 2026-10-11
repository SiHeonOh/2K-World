import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import type { EventPayloads, EventType, LeagueEvent } from '@shared/events'
import { openDb, type Db } from '@data/db'
import { seedLeague } from '@data/league'
import { readLeague } from './context'
import { finalSound, particle } from './wiki'
import { MAX_NOTES, OCCASION_TARGETS, planOccasion, type OccasionItem, type OccasionNote, type TakenBack, type WikiOccasion, type Written } from './wikiOccasions'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-occasions-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
let nextId = 1
const ev = <T extends EventType>(type: T, payload: EventPayloads[T]): LeagueEvent => ({ id: nextId++, type, seasonId: 1, payload, createdAt: '' })
const potw = (playerId: string, week: number) => ({ awardId: 'potw', period: `w${week}`, teamRank: 1, playerId })
/** A weekly award's item, as planOccasion makes it (only the key and pages matter here). */
const item = (playerId: string, week = 1): OccasionItem => ({ key: `award:potw:w${week}:1:${playerId}`, facts: [`수상: ${playerId}`], players: [playerId], teams: [] })
const note = (key: string, player: string): OccasionNote => ({ key, text: `수상 취소(없던 일이 됨): ${key}`, players: [player] })
const job = (items: OccasionItem[], notes: OccasionNote[] = []): WikiOccasion => ({ kind: 'award', seasonId: 1, items, notes })
const none: TakenBack = { notes: [], items: [] }
const nothing: Written = () => null
const ran = '2026-01-01T00:00:00.000Z'
const plan = (waiting: WikiOccasion[], events: LeagueEvent[], pending: OccasionNote[], create = true, written = nothing) =>
  planOccasion(readLeague(db, dir), 'award', 1, waiting, events, { notes: pending, items: [] }, { create, written })

describe('planOccasion', () => {
  it('keeps a job left with only its lines (new items join it), and empties one left with nothing', () => {
    const emptied = job([item('p1')], [note('n1', 'p2')])
    const out = plan([emptied], [ev('award_removed', potw('p1', 1)), ev('award_given', potw('p3', 2))], [])
    // Its line still has to be told: the new award joins it.
    expect(emptied.items.map((i) => i.key)).toEqual([item('p3', 2).key])
    expect(emptied.notes).toEqual([note('n1', 'p2')])
    expect(out).toEqual({ added: [], pending: none })

    // Nothing new is written (the community off, Claude Code unusable): it still runs, with its line.
    const alone = job([item('p1')], [note('n1', 'p2')])
    const off = plan([alone], [ev('award_removed', potw('p1', 1)), ev('award_given', potw('p3', 2))], [], false)
    expect(alone).toEqual(job([], [note('n1', 'p2')]))
    expect(off).toEqual({ added: [], pending: none })

    // Nothing at all left: it's emptied (and its job cancelled).
    const bare = job([item('p1')])
    plan([bare], [ev('award_removed', potw('p1', 1))], [])
    expect(bare).toEqual(job([]))
  })

  it('puts at most MAX_NOTES lines in a job and gives the rest one of their own, or keeps the newest MAX_NOTES waiting', () => {
    const lines = Array.from({ length: MAX_NOTES + 2 }, (_, i) => note(`n${i}`, 'p1'))
    const waiting = job([item('p1')])
    const out = plan([waiting], [ev('award_given', potw('p5', 9))], lines)
    expect(waiting.notes.map((n) => n.key)).toEqual(lines.slice(0, MAX_NOTES).map((n) => n.key))
    expect(out.added).toEqual([job([], lines.slice(MAX_NOTES))])
    expect(out.pending).toEqual(none)
    // No job may be made: the newest wait.
    const kept = plan([], [], lines, false)
    expect(kept.pending.notes.map((n) => n.key)).toEqual(lines.slice(-MAX_NOTES).map((n) => n.key))
    // No awards job waiting: the lines get one of their own (no more awards may come this season).
    expect(plan([], [], lines.slice(0, 2)).added).toEqual([job([], lines.slice(0, 2))])
    // Already in a job: not placed twice.
    const again = plan([waiting], [], [lines[0]!])
    expect(waiting.notes.filter((n) => n.key === 'n0')).toHaveLength(1)
    expect(again).toEqual({ added: [], pending: none })
  })

  it("counts a line's page toward the job's cap", () => {
    const cap = () => job(Array.from({ length: OCCASION_TARGETS - 1 }, (_, i) => item(`p${i + 1}`)))
    const full = cap()
    const out = plan([full], [], [note('a', 'p30'), note('b', 'p31'), note('c', 'p1')])
    expect(full.notes.map((n) => n.key)).toEqual(['a', 'c'])
    expect(out.added).toEqual([job([], [note('b', 'p31')])])
    const off = cap()
    expect(plan([off], [], [note('a', 'p30'), note('b', 'p31')], false).pending.notes.map((n) => n.key)).toEqual(['b'])
  })

  it('has words only for what was written: an award removed gets the line its editors were told, with the page', () => {
    const mvp = { awardId: 'mvp', period: '', teamRank: 1, playerId: 'p7' }
    const told: OccasionItem = { key: 'award:mvp::1:p7', facts: ['수상: MVP(시즌 상) — 나가나 (가람고)'], players: ['p7'], teams: [], cast: ['t1'] }
    expect(plan([], [ev('award_removed', mvp)], []).pending).toEqual(none)
    const written: Written = (key) => (key === told.key ? { item: told, job: 3, ran } : null)
    expect(plan([], [ev('award_removed', mvp)], [], false, written).pending.notes).toEqual([
      { key: told.key, text: '수상 취소(없던 일이 됨): MVP(시즌 상) — 나가나 (가람고)', players: ['p7'], cast: ['t1'] },
    ])
    // An item kept without its school: the line leaves the fans to his school now.
    const plain: OccasionItem = { key: told.key, facts: told.facts, players: ['p7'], teams: [] }
    const line = plan([], [ev('award_removed', mvp)], [], false, (key) => (key === told.key ? { item: plain, job: 3, ran } : null)).pending.notes[0]!
    expect(line).not.toHaveProperty('cast')
    // Given again: the news is the award, not that it went.
    expect(plan([], [ev('award_given', mvp)], [note(told.key, 'p7')], false).pending).toEqual(none)
    // A swap vetoed that nobody wrote about leaves nothing to put right.
    const draft = planOccasion(readLeague(db, dir), 'draft', 1, [], [ev('move_vetoed', { kind: 'draft-swap', refId: 5 })], none, { create: true, written: nothing })
    expect(draft).toEqual({ added: [], pending: none })
  })

  it('never keeps an item waiting beside the words taking it back', () => {
    const league = readLeague(db, dir)
    // A job put back in the queue (a usage limit, the app closed, a failed first try) still holds an award taken back
    // while it ran: the line waiting for a job, or already in one, wins.
    const k = item('p1')
    const back = job([k, item('p2')])
    plan([back], [], [note(k.key, 'p1')])
    expect(back).toEqual(job([item('p2')], [note(k.key, 'p1')]))
    const both = job([item('p3'), item('p4')], [note(item('p3').key, 'p3')])
    plan([both], [], [])
    expect(both.items).toEqual([item('p4')])
    // A swap and its veto.
    const swap: OccasionItem = { key: 'swap:4', facts: ['스왑'], players: ['p1', 'p7'], teams: ['t1', 't2'] }
    const veto: OccasionItem = { key: 'veto:4', facts: ['무효'], players: ['p1', 'p7'], teams: ['t1', 't2'] }
    const drafted: WikiOccasion = { kind: 'draft', seasonId: 1, items: [swap], notes: [] }
    planOccasion(league, 'draft', 1, [drafted], [], { notes: [], items: [veto] }, { create: false, written: nothing })
    expect(drafted.items).toEqual([])
    // A number check's retry of a series result put right while it ran, behind the job putting it right.
    const old: OccasionItem = { key: 'series:5', facts: ['우승: t1'], players: [], teams: ['t1', 't3'], result: { winner: 't1', loser: 't3', title: '우승' } }
    const now: OccasionItem = { key: 'series:5', facts: ['우승: t3'], players: [], teams: ['t3', 't1'], result: { winner: 't3', loser: 't1', title: '우승' } }
    const fix: OccasionItem = { key: 'fix:series:5:t1', facts: ['정정'], players: [], teams: ['t1', 't3'] }
    const fixing: WikiOccasion = { kind: 'playoffs', seasonId: 1, items: [now, fix], notes: [] }
    const retry: WikiOccasion = { kind: 'playoffs', seasonId: 1, items: [old], notes: [] }
    planOccasion(league, 'playoffs', 1, [fixing, retry], [], none, { create: true, written: nothing })
    expect(retry.items).toEqual([])
    expect(fixing.items).toEqual([now, fix])
  })

  it('holds words putting right what was written while no job may be made, and sends them out once one may', () => {
    const league = readLeague(db, dir)
    const veto: OccasionItem = { key: 'veto:4', facts: ['무효'], players: ['p1', 'p7'], teams: ['t1', 't2'] }
    const held = planOccasion(league, 'draft', 1, [], [], { notes: [], items: [veto] }, { create: false, written: nothing })
    expect(held).toEqual({ added: [], pending: { notes: [], items: [veto] } })
    const out = planOccasion(league, 'draft', 1, [], [], { notes: [], items: [veto] }, { create: true, written: nothing })
    expect(out).toEqual({ added: [{ kind: 'draft', seasonId: 1, items: [veto], notes: [] }], pending: none })
  })

  it('reads names ending in a consonant or a digit right in the swap lines', () => {
    db.prepare("UPDATE teams SET short_name = '새별' WHERE id = 't1'").run()
    db.prepare("UPDATE teams SET short_name = '청운' WHERE id = 't2'").run()
    db.prepare("UPDATE teams SET short_name = '신일1' WHERE id = 't3'").run()
    db.prepare("UPDATE teams SET short_name = '한빛6' WHERE id = 't4'").run()
    const rename = (id: string, name: string) => db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id)
    rename('p1', '한결')
    rename('p7', '지훈')
    rename('p13', '도윤7')
    rename('p19', '서준3')
    const swap = (actionId: number, teamId: string, playerId: string, targetTeamId: string, targetPlayerId: string) =>
      ev('draft_swap', { actionId, teamId, playerId, targetTeamId, targetPlayerId, cardId: 1, ownSlot: null, targetSlot: null })
    const out = planOccasion(readLeague(db, dir), 'draft', 1, [], [swap(1, 't1', 'p1', 't2', 'p7'), swap(2, 't3', 'p13', 't4', 'p19')], none, { create: true, written: nothing })
    expect(out.added.flatMap((o) => o.items.flatMap((i) => i.facts))).toEqual([
      '드래프트 스왑: 새별이 청운의 지훈을 지명하고 한결을 내줌',
      '지훈: 드래프트 스왑으로 청운에서 새별로 이적',
      '한결: 드래프트 스왑으로 새별에서 청운으로 이적',
      '드래프트 스왑: 신일1이 한빛6의 서준3을 지명하고 도윤7을 내줌',
      '서준3: 드래프트 스왑으로 한빛6에서 신일1로 이적',
      '도윤7: 드래프트 스왑으로 신일1에서 한빛6으로 이적',
    ])
  })
})

describe('particles', () => {
  const all = (word: string) => [particle(word, '은', '는'), particle(word, '이', '가'), particle(word, '을', '를'), particle(word, '으로', '로')].join(' ')

  it('read Hangul by its last syllable, with 로 after ㄹ', () => {
    expect(all('가람고')).toBe('는 가 를 로')
    expect(all('지훈')).toBe('은 이 을 으로')
    expect(all('한결')).toBe('은 이 을 로')
  })

  it('read digits as Korean numbers', () => {
    // 일 칠 팔 end in ㄹ; 삼 육 영 (and 십, 백…) in another consonant; 이 사 오 구 in none.
    expect(['1', '7', '8'].map(all)).toEqual(Array(3).fill('은 이 을 로'))
    expect(['3', '6', '0', '10', '100'].map(all)).toEqual(Array(5).fill('은 이 을 으로'))
    expect(['2', '4', '5', '9', '12'].map(all)).toEqual(Array(5).fill('는 가 를 로'))
    expect(all('가람고2')).toBe('는 가 를 로')
    expect(all('R3')).toBe('은 이 을 으로')
  })

  it('read capitals by their names and words as they are usually written in Hangul', () => {
    expect(all('M')).toBe('은 이 을 으로')
    expect(all('L')).toBe('은 이 을 로')
    expect(all('ABC')).toBe('는 가 를 로')
    expect(all('Kim')).toBe('은 이 을 으로')
    expect(all('Paul')).toBe('은 이 을 로')
    expect(all('Lee')).toBe('는 가 를 로')
    expect(all('Bob')).toBe('은 이 을 으로')
    expect(all('Mark')).toBe('는 가 를 로')
  })

  it('read a silent e and other English endings as the names are written in Hangul', () => {
    // 카일, 콜, 게이블; 제인, 웨인, 제롬, 앤, 잭, 에릭; 마이크, 케이트, 리.
    expect(['Kyle', 'Cole', 'Gable'].map(all)).toEqual(Array(3).fill('은 이 을 로'))
    expect(['Jane', 'Wayne', 'Jerome', 'Anne', 'Zach', 'Eric'].map(all)).toEqual(Array(6).fill('은 이 을 으로'))
    expect(['Mike', 'Kate', 'Lee'].map(all)).toEqual(Array(3).fill('는 가 를 로'))
  })

  it('read three or more capitals with a vowel as a word, and others by their names', () => {
    expect(all('BOB')).toBe('은 이 을 으로')
    expect(all('KYLE')).toBe('은 이 을 로')
    // 케이비엘, 엠브이피.
    expect(all('KBL')).toBe('은 이 을 로')
    expect(all('MVP')).toBe('는 가 를 로')
    expect(all('JR')).toBe('은 이 을 로')
  })

  it('look past a closing bracket and quotes', () => {
    expect(finalSound('한결(가람고)')).toBe('rieul')
    expect(finalSound("'''지훈'''")).toBe('other')
    // A closing bracket left over, its opening one cut off.
    expect(finalSound('지훈)')).toBe('other')
    expect(finalSound('가람고)')).toBe('none')
    expect(finalSound('[[한결]]')).toBe('rieul')
  })
})
