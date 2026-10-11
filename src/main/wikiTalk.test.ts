import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { listPersonas } from '@data/community'
import { openDb, type Db } from '@data/db'
import { listTeams, seedLeague } from '@data/league'
import { listGames, recordScore, startSeason } from '@data/season'
import { addTalk, openDisputes, openThread, tickDisputes } from '@data/talk'
import { pageByTitle, revisionBody, saveRevision, sectionKeys } from '@data/wiki'
import type { JobRow } from '@ai/queue'
import { readLeague } from '@story/context'
import { storyDemo, storyKinds } from '@story/jobs'
import { wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { talkInput, warInput, wikiTalkDemo, wikiTalkKinds, type WikiTalkOutput, type WikiWarOutput } from '@story/wikiTalk'
import { AiService } from './ai'
import { StoryService } from './story'
import { WikiService } from './wiki'

let dir: string
let db: Db
let ai: AiService
let story: StoryService
let wiki: WikiService

beforeEach(async () => {
  process.env.TWOK_FAKE_AI = '1'
  dir = mkdtempSync(join(tmpdir(), '2kw-talk-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d, folder, slug) => [wikiEditKind(d, () => null, { contested: (edits) => story.wikiContested(slug, d, folder, edits) })], wikiEditDemo)
  ai.addKinds(
    (d, folder, slug) => wikiTalkKinds(d, { hooks: { war: (c) => void story.wikiWar(slug, d, folder, c), answered: (id) => story.wikiAnswered(d, folder, id) } }),
    wikiTalkDemo,
  )
  await ai.refresh()
  story = new StoryService(ai)
  wiki = new WikiService({
    talk: (s, d, f, id) => void story.wikiTalk(s, d, f, id),
    saved: (s, d, f, pageId, rev) => void story.wikiSaved(s, d, f, pageId, rev),
  })
  startSeason(db)
  wiki.ensure(db, dir, true)
  // The cast exists once the story engine has looked.
  story.afterChange('test', db, dir)
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const at = () => ({ slug: 'test', folder: dir })
const drain = () => ai.queueFor('test', db, dir).kick()
const jobs = (kind: string) => db.prepare('SELECT status, input FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { status: string; input: string }[]
const fans = () => listPersonas(db).filter((p) => p.kind === 'fan')
const body = (title: string) => {
  const p = pageByTitle(db, title)!
  return revisionBody(db, p.id, p.currentRev!)!.body
}
/** A page whose 개요 an editor (a fan persona) wrote over the seed. */
function editorsPage(writer: string) {
  saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n원래 문장이다.\n== 여담 ==\n내 여담.', authorId: 'system', summary: '문서 생성' }, Date.now() - 5000)
  saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n리그 최고의 선수로 꼽힌다.\n== 여담 ==\n내 여담.', authorId: writer, summary: '개요 보강' }, Date.now() - 4000)
  return pageByTitle(db, '연습 문서')!
}

describe('토론', () => {
  it('editors answer you; comments made while an answer waits join it; you can close and reopen', async () => {
    const title = pageByTitle(db, listTeams(db)[0]!.shortName)!.title
    const { id } = wiki.openThread(db, { title, topic: '개요 서술 관련', body: '개요가 너무 짧습니다.' }, at())
    // The first answer is already being written; the next two comments share one waiting answer.
    wiki.comment(db, id, '별명 문단도 있었으면 합니다.', at())
    wiki.comment(db, id, '라이벌 문단도요.', at())
    expect(jobs('wiki_talk').map((j) => j.status)).toEqual(['running', 'queued'])
    // It answers both of them (the one being written answers #1).
    expect(JSON.parse(jobs('wiki_talk')[1]!.input).instructions).toContain('답할 내 글은 #2, #3.')
    expect(wiki.thread(db, id).replying).toBe(true)
    await drain()
    // The waiting answer was rebuilt once the first one landed: it saw those replies, and numbered its own after them.
    const second = JSON.parse(jobs('wiki_talk')[1]!.input)
    expect(second.context).toContain('#4 ')
    expect(second.instructions).toContain('#6부터')
    const t = wiki.thread(db, id)
    expect(t.replying).toBe(false)
    expect(t.lines.map((l) => [l.n, l.author.kind])).toEqual([
      [1, 'user'],
      [2, 'user'],
      [3, 'user'],
      [4, 'fan'],
      [5, 'fan'],
      [6, 'fan'],
      [7, 'fan'],
    ])
    expect(wiki.page(db, dir, title).talk.open).toBe(1)
    expect(wiki.threads(db, title).map((x) => x.topic)).toEqual(['개요 서술 관련'])
    expect(wiki.recentThreads(db)[0]).toMatchObject({ id, comments: 7, origin: 'user' })
    wiki.setThread(db, id, false, '해결됨')
    expect(wiki.thread(db, id)).toMatchObject({ status: 'closed', closeNote: '해결됨' })
    expect(wiki.thread(db, id).lines.at(-1)).toMatchObject({ kind: 'status', body: '토론을 닫음: 해결됨' })
    expect(() => wiki.comment(db, id, '하나 더', at())).toThrow(/wiki-thread-closed/)
    wiki.setThread(db, id, true, '')
    expect(wiki.thread(db, id).status).toBe('open')
  })
})

describe('토론 edits', () => {
  it('a thread that agrees edits the page, but never a section you wrote', () => {
    const [a] = fans()
    editorsPage(a!.id)
    // 여담 is yours now (saved without a story hook: no pushback here).
    wiki.save(db, { title: '연습 문서', source: body('연습 문서').replace('내 여담.', '내가 쓴 여담.'), summary: '', baseRev: 2 })
    const { id } = wiki.openThread(db, { title: '연습 문서', topic: '개요 서술 관련', body: '"리그 최고"는 과장입니다.' })
    const input = talkInput(readLeague(db, dir), id)!
    expect(input.editors[0]).toBe(a!.id)
    const talk = wikiTalkKinds(db).find((k) => k.kind === 'wiki_talk')!
    const run = (out: WikiTalkOutput) => {
      const job = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_talk', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
      talk.accept!(out, { id: job, input, createdAt: new Date().toISOString() } as unknown as JobRow)
    }
    const say = (text: string) => [{ editor: a!.id, text }]
    run({ comments: say('#1 여담도 고치겠습니다.'), edit: { section: '여담', mode: 'replace', text: '바꿈.', summary: '수정', editor: a!.id }, close: null, escalate: null, memories: [] })
    expect(sectionKeys(body('연습 문서')).get('여담#1')).toBe('내가 쓴 여담.')
    run({
      comments: say('#1 동의합니다. 수정안대로 고치겠습니다.'),
      edit: { section: '개요', mode: 'replace', text: '뛰어난 선수로 평가받는다.', summary: '토론 합의 반영', editor: a!.id },
      close: { editor: a!.id, note: '수정안으로 합의' },
      escalate: null,
      memories: [],
    })
    expect(sectionKeys(body('연습 문서')).get('개요#1')).toBe('뛰어난 선수로 평가받는다.')
    const t = wiki.thread(db, id)
    expect(t).toMatchObject({ status: 'closed', closeNote: '수정안으로 합의' })
    expect(t.lines.map((l) => (l.kind === 'status' ? l.body : `${l.n}`))).toEqual(['1', '2', '3', 'r4 편집: 토론 합의 반영', '토론을 닫음: 수정안으로 합의'])
  })
})

describe('a 토론 that boils over', () => {
  it('starts a war in its own thread; your thread only gets a note, and is never held or closed by it', async () => {
    const [a, b] = fans()
    const page = editorsPage(a!.id)
    const { id } = wiki.openThread(db, { title: '연습 문서', topic: '개요 서술 관련', body: '과장입니다.' })
    const input = talkInput(readLeague(db, dir), id)!
    const talk = wikiTalkKinds(db, { hooks: { war: (c) => void story.wikiWar('test', db, dir, c) } }).find((k) => k.kind === 'wiki_talk')!
    const run = (out: Partial<WikiTalkOutput>) => {
      const job = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_talk', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
      talk.accept!({ comments: [{ editor: b!.id, text: '#1 반대합니다.' }], edit: null, close: null, escalate: null, memories: [], ...out }, { id: job, input } as unknown as JobRow)
    }
    const boil = { section: '개요', challenger: b!.id, heat: 5, why: '과장' }
    // A thread that closes as it answers doesn't boil over.
    run({ close: { editor: b!.id, note: '정리됨' }, escalate: boil })
    expect(jobs('wiki_war')).toHaveLength(0)
    wiki.setThread(db, id, true, '')
    run({ escalate: boil })
    expect(jobs('wiki_war')).toHaveLength(1)
    expect(JSON.parse(jobs('wiki_war')[0]!.input)).toMatchObject({ fromThread: id, section: '개요' })
    await drain()
    const threads = wiki.threads(db, '연습 문서')
    expect(threads.map((t) => [t.origin, t.status, t.section])).toEqual([
      ['user', 'open', null],
      ['war', 'closed', '개요'],
    ])
    expect(wiki.thread(db, id).lines.at(-1)).toMatchObject({ kind: 'status', body: expect.stringContaining('편집 분쟁이 번졌다') })
    expect(openDisputes(db, page.id)).toHaveLength(0)
    tickDisputes(db, new Date().toISOString())
    tickDisputes(db, new Date().toISOString())
    expect(wiki.thread(db, id).status).toBe('open')
  })
})

describe('edit wars', () => {
  it("a round's contested edit becomes a capped war between editors, settled in 토론", async () => {
    await drain()
    const round1 = listGames(db, 1).filter((g) => g.round === 1)
    const [first, ...rest] = round1
    const ace = sampleSetup().players.find((p) => p.teamId === first!.home)!
    recordScore(db, { gameId: first!.id, homeScore: 90, awayScore: 80, lines: [{ playerId: ace.id, teamId: first!.home, stats: { pts: 35, reb: 9, ast: 4 } }] })
    for (const g of rest) recordScore(db, { gameId: g.id, homeScore: 70, awayScore: 60, lines: null })
    story.afterChange('test', db, dir)
    await drain()
    expect(jobs('wiki_war').map((j) => j.status)).toEqual(['done'])
    const history = wiki.history(db, ace.name).map((r) => r.summary)
    expect(history.slice(0, 5)).toEqual(['토론 합의 반영', '반달 복구', '편향 서술 삭제', '시즌 문단 정리', '최근 경기 반영'])
    const [thread] = wiki.threads(db, ace.name)
    expect(thread).toMatchObject({ origin: 'war', status: 'closed', section: '시즌 1' })
    const lines = wiki.thread(db, thread!.id).lines
    // Status lines aren't numbered: the first comment is #1, as the writers were told.
    expect(lines[0]).toMatchObject({ kind: 'status', n: null, body: expect.stringContaining("'시즌 1' 문단이 r") })
    expect(lines[1]).toMatchObject({ kind: 'comment', n: 1 })
    expect(JSON.parse(jobs('wiki_war')[0]!.input).instructions).toContain('#1부터')
    expect(lines.at(-1)).toMatchObject({ kind: 'status', body: expect.stringContaining('토론을 닫음') })
    expect(sectionKeys(body(ace.name)).get('시즌 1#1')).toContain('[* 토론 합의로 표현을 다듬었다.]')
  })

  it('an unsettled war freezes the section as it was, holds it from editors, and times out', () => {
    const [a, b] = fans()
    const page = editorsPage(a!.id)
    const league = readLeague(db, dir)
    // 가끔 (the default) takes a 3: a bias dispute.
    expect(warInput(league, { pageId: page.id, section: '개요', challenger: b!.id, heat: 2, why: '과장' })).toBeNull()
    const input = warInput(league, { pageId: page.id, section: '개요', challenger: b!.id, heat: 3, why: '과장' })!
    expect(input).toMatchObject({ defender: a!.id, challenger: b!.id, rev: 2 })
    const war = wikiTalkKinds(db).find((k) => k.kind === 'wiki_war')!
    const out: WikiWarOutput = {
      steps: [
        { text: '뛰어난 선수로 평가받는다.', summary: '편향 서술 수정' },
        { text: null, summary: '반달 복구' },
        { text: null, summary: '되돌림' },
        { text: '네 번째는 없다.', summary: '상한 초과' },
      ],
      topic: '개요 서술 관련',
      comments: [{ editor: b!.id, text: '근거 제시 바랍니다.' }],
      outcome: { agreed: false, text: null, editor: b!.id, summary: '', note: '' },
      memories: [],
    }
    const id = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_war', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    war.accept!(out, { id, input, createdAt: new Date(Date.now() - 60_000).toISOString() } as unknown as JobRow)
    // Three steps at most, then frozen at the text from before the dispute.
    expect(wiki.history(db, '연습 문서').map((r) => [r.summary, r.author.id])).toEqual([
      ['토론 중 서술 고정', input.mediator ?? b!.id],
      ['되돌림', b!.id],
      ['반달 복구', a!.id],
      ['편향 서술 수정', b!.id],
      ['개요 보강', a!.id],
      ['문서 생성', 'system'],
    ])
    expect(sectionKeys(body('연습 문서')).get('개요#1')).toBe('원래 문장이다.')
    expect(openDisputes(db, page.id)).toEqual([expect.objectContaining({ section: '개요', origin: 'war' })])
    expect(wiki.page(db, dir, '연습 문서').talk.disputes).toEqual([expect.objectContaining({ section: '개요' })])
    // Round editors leave the held section alone.
    const editId = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_edits', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    wikiEditKind(db).accept!(
      { edits: [{ page: '연습 문서', section: '개요', mode: 'replace', text: '끼어든 편집.', summary: '편집', editor: a!.id }], disputes: [] },
      { id: editId, input: { pages: ['연습 문서'], editors: [a!.id] } } as unknown as JobRow,
    )
    expect(body('연습 문서')).not.toContain('끼어든 편집.')
    // A second war on the held section waits for this one.
    expect(warInput(league, { pageId: page.id, section: '개요', challenger: a!.id, heat: 5, why: '' })).toBeNull()
    // You change the frozen lines: nobody undoes you inside the hold; the answer goes to the war's thread.
    const [held] = wiki.threads(db, '연습 문서')
    const frozen = body('연습 문서')
    wiki.save(db, { title: '연습 문서', source: frozen.replace('원래 문장이다.', '내가 정리한 새 문장이다.'), summary: '', baseRev: pageByTitle(db, '연습 문서')!.currentRev! }, at())
    const push = JSON.parse(jobs('wiki_pushback')[0]!.input)
    expect(push).toMatchObject({ canRevert: false, threadId: held!.id })
    const pushback = wikiTalkKinds(db).find((k) => k.kind === 'wiki_pushback')!
    const pushJob = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_pushback', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    pushback.accept!(
      { stance: 'revert', summary: '되돌림', topic: '', comments: [{ editor: push.editor, text: '토론 중에는 서술 고정입니다.' }], memories: [] },
      { id: pushJob, input: { ...push, canRevert: true } } as unknown as JobRow,
    )
    expect(sectionKeys(body('연습 문서')).get('개요#1')).toBe('내가 정리한 새 문장이다.')
    expect(wiki.threads(db, '연습 문서')).toHaveLength(1)
    expect(wiki.thread(db, held!.id).lines.at(-1)).toMatchObject({ body: '토론 중에는 서술 고정입니다.' })
    tickDisputes(db, new Date().toISOString())
    expect(openDisputes(db, page.id)).toHaveLength(1)
    tickDisputes(db, new Date().toISOString())
    expect(openDisputes(db, page.id)).toHaveLength(0)
    // Reopened, it holds the section again and counts down afresh.
    wiki.setThread(db, held!.id, true, '')
    expect(openDisputes(db, page.id)).toHaveLength(1)
    tickDisputes(db, new Date().toISOString())
    tickDisputes(db, new Date().toISOString())
    expect(openDisputes(db, page.id)).toHaveLength(0)
  })

  it("an agreed 토론 edit elsewhere doesn't end a war's hold, and an answer that agrees on an edit doesn't also start a war", () => {
    const [a, b] = fans()
    const page = editorsPage(a!.id)
    const league = readLeague(db, dir)
    const input = warInput(league, { pageId: page.id, section: '개요', challenger: b!.id, heat: 5, why: '과장' })!
    const war = wikiTalkKinds(db).find((k) => k.kind === 'wiki_war')!
    const warJob = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_war', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    war.accept!(
      { steps: [{ text: null, summary: '삭제' }], topic: '개요', comments: [{ editor: b!.id, text: '근거 제시 바랍니다.' }], outcome: { agreed: false, text: null, editor: b!.id, summary: '', note: '' }, memories: [] },
      { id: warJob, input, createdAt: new Date().toISOString() } as unknown as JobRow,
    )
    const [held] = wiki.threads(db, '연습 문서')
    // You ask about 여담 in the war's thread; the editors agree and edit 여담, and would boil over on it too.
    wiki.comment(db, held!.id, '여담도 손볼 게 있습니다.')
    const talkIn = talkInput(readLeague(db, dir), held!.id)!
    const talk = wikiTalkKinds(db, { hooks: { war: (c) => void story.wikiWar('test', db, dir, c) } }).find((k) => k.kind === 'wiki_talk')!
    const talkJob = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_talk', 'done', '{}', ?)").run(new Date().toISOString()).lastInsertRowid)
    talk.accept!(
      {
        comments: [{ editor: a!.id, text: '#2 동의합니다.' }],
        edit: { section: '여담', mode: 'append', text: ' * 새 여담.', summary: '여담 추가', editor: a!.id },
        close: null,
        escalate: { section: '여담', challenger: b!.id, heat: 5, why: '반대' },
        memories: [],
      },
      { id: talkJob, input: talkIn } as unknown as JobRow,
    )
    expect(body('연습 문서')).toContain(' * 새 여담.')
    expect(wiki.thread(db, held!.id).status).toBe('open')
    expect(openDisputes(db, page.id)).toEqual([expect.objectContaining({ section: '개요' })])
    // (The one row there is the war accepted by hand above.)
    expect(jobs('wiki_war').filter((j) => j.input !== '{}')).toHaveLength(0)
  })

  it('a pushback waiting in a thread is rebuilt when editors answer there', () => {
    const [a] = fans()
    const page = editorsPage(a!.id)
    wiki.save(db, { title: '연습 문서', source: body('연습 문서').replace('리그 최고의 선수로 꼽힌다.', '아직 검증이 더 필요한 선수다.'), summary: '', baseRev: 2 })
    // An editor's pushback thread on 개요 with one comment in it.
    const now = new Date().toISOString()
    const id = openThread(db, { pageId: page.id, topic: '개요', origin: 'pushback', section: '개요', openedBy: a!.id, roundsLeft: 2 }, now)
    addTalk(db, id, { authorId: a!.id, body: '근거 제시 바랍니다.' }, now)
    const job = Number(
      db
        .prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('wiki_pushback', 'queued', 0, ?, ?)")
        .run(JSON.stringify({ pageId: page.id, rev: 3, threadId: id, instructions: 'old' }), new Date().toISOString()).lastInsertRowid,
    )
    story.wikiAnswered(db, dir, id)
    const rebuilt = JSON.parse((db.prepare('SELECT input FROM jobs WHERE id = ?').get(job) as { input: string }).input)
    expect(rebuilt).toMatchObject({ pageId: page.id, rev: 3, editor: a!.id, section: '개요', threadId: id })
    expect(rebuilt.instructions).toContain('#2부터')
  })

  it('at most three wars are open or on their way', () => {
    const [a, b] = fans()
    const page = editorsPage(a!.id)
    const league = readLeague(db, dir)
    const call = { pageId: page.id, section: '개요', challenger: b!.id, heat: 5, why: '' }
    expect(warInput(league, call)).not.toBeNull()
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('wiki_war', 'queued', '{}', ?)").run(new Date().toISOString())
    expect(warInput(league, call)).toBeNull()
  })

  it('edit wars off: no wars, no pushback', () => {
    const [a, b] = fans()
    const page = editorsPage(a!.id)
    wiki.saveSettings(db, { editWars: 'off' })
    expect(warInput(readLeague(db, dir), { pageId: page.id, section: '개요', challenger: b!.id, heat: 5, why: '' })).toBeNull()
    wiki.save(db, { title: '연습 문서', source: body('연습 문서').replace('리그 최고의 선수로 꼽힌다.', '평범한 선수다. 과장된 서술을 고쳤다.'), summary: '', baseRev: 2 }, at())
    expect(jobs('wiki_pushback')).toHaveLength(0)
  })
})

describe('pushback', () => {
  it('an editor undoes your change to their text once, then only argues; small fixes pass', async () => {
    const [a] = fans()
    editorsPage(a!.id)
    // A typo-sized change gets nothing.
    wiki.save(db, { title: '연습 문서', source: body('연습 문서').replace('꼽힌다.', '꼽힌다'), summary: '', baseRev: 2 }, at())
    expect(jobs('wiki_pushback')).toHaveLength(0)
    const yours = body('연습 문서').replace('리그 최고의 선수로 꼽힌다', '아직 검증이 더 필요한 선수다')
    wiki.save(db, { title: '연습 문서', source: yours, summary: '과장 삭제', baseRev: 3 }, at())
    expect(jobs('wiki_pushback').map((j) => JSON.parse(j.input)).map((i) => [i.editor, i.section, i.canRevert])).toEqual([[a!.id, '개요', true]])
    await drain()
    // Undone once, and taken to 토론.
    expect(sectionKeys(body('연습 문서')).get('개요#1')).toBe('리그 최고의 선수로 꼽힌다')
    expect(sectionKeys(body('연습 문서')).get('여담#1')).toBe('내 여담.')
    const [thread] = wiki.threads(db, '연습 문서')
    expect(thread).toMatchObject({ origin: 'pushback', status: 'open', section: '개요' })
    expect(wiki.thread(db, thread!.id).lines[0]).toMatchObject({ kind: 'status', body: expect.stringContaining('되돌림') })
    // You put your version back: they never revert again, and argue in the same thread.
    const rev = pageByTitle(db, '연습 문서')!.currentRev!
    wiki.save(db, { title: '연습 문서', source: yours, summary: '다시', baseRev: rev }, at())
    expect(JSON.parse(jobs('wiki_pushback').at(-1)!.input)).toMatchObject({ canRevert: false, threadId: thread!.id })
    await drain()
    expect(sectionKeys(body('연습 문서')).get('개요#1')).toBe('아직 검증이 더 필요한 선수다')
    expect(wiki.threads(db, '연습 문서')).toHaveLength(1)
    expect(wiki.thread(db, thread!.id).lines.filter((l) => l.kind === 'comment')).toHaveLength(4)
  })

  it("a section whose title appears twice gets no pushback: which one was theirs isn't clear", () => {
    const [a] = fans()
    editorsPage(a!.id)
    wiki.save(db, { title: '연습 문서', source: body('연습 문서').replace('== 여담 ==', '== 개요 ==\n내 새 개요.\n== 여담 =='), summary: '', baseRev: 2 })
    const rev = pageByTitle(db, '연습 문서')!.currentRev!
    wiki.save(db, { title: '연습 문서', source: body('연습 문서').replace('리그 최고의 선수로 꼽힌다.', '완전히 다른 평가를 적었다.'), summary: '', baseRev: rev }, at())
    expect(jobs('wiki_pushback')).toHaveLength(0)
  })
})
