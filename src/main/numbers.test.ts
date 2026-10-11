import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { UNVERIFIED } from '@shared/numbers'
import { lastEventId, lastNewsEventId, listPersonas, openPost, refreshFeed } from '@data/community'
import { openDb, type Db } from '@data/db'
import { flagNumbers, flagsFor, flagsOf } from '@data/flags'
import { currentSeason, listEvents, listTeams, loadConfig, seedLeague } from '@data/league'
import { listGames, recordScore, startPlayoffs, startSeason } from '@data/season'
import { addTalk } from '@data/talk'
import { pageByTitle, revisionBody, saveRevision } from '@data/wiki'
import type { JobRow } from '@ai/queue'
import { chatterInput, eventThreadInput, gameThreadInput, readLeague, replyInput } from '@story/context'
import { checkNumbers, readFacts, unknownNumbers } from '@story/numbers'
import { STORY_PRIORITY, storyDemo, storyKinds, type StoryInput, type StoryKind, type StoryOutput } from '@story/jobs'
import { lockerRoom } from '@story/mood'
import { MISREMEMBERS } from '@story/personas'
import { playerState } from '@story/playerState'
import { PLAYER_REACTION, REACTION_PRIORITY, reactionDemo, reactionInput, reactionKind, releaseHeld, type PlayerReactionInput, type PlayerReactionOutput } from '@story/reactions'
import { pageOutline, WIKI_EDITS, WIKI_PRIORITY, wikiEditDemo, wikiEditKind, type WikiEditInput, type WikiEditOutput } from '@story/wikiEdits'
import {
  pushbackInput,
  TALK_PRIORITY,
  talkInput,
  warInput,
  wikiTalkDemo,
  wikiTalkKinds,
  type WikiTalkInput,
  type WikiTalkOutput,
  type WikiWarInput,
  type WikiWarOutput,
} from '@story/wikiTalk'
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
  dir = mkdtempSync(join(tmpdir(), '2kw-numbers-'))
  db = openDb(join(dir, 'league.db'))
  seedLeague(db, sampleSetup())
  ai = new AiService()
  ai.addKinds((d) => storyKinds(d), storyDemo)
  ai.addKinds((d) => [wikiEditKind(d)], wikiEditDemo)
  ai.addKinds((d) => wikiTalkKinds(d), wikiTalkDemo)
  await ai.refresh()
  story = new StoryService(ai)
  wiki = new WikiService({ talk: (s, d, f, id) => void story.wikiTalk(s, d, f, id) })
  startSeason(db)
  wiki.ensure(db, dir, true)
  // The cast exists once the story engine has looked.
  story.afterChange('test', db, dir)
  await ai.queueFor('test', db, dir).kick()
})

afterEach(() => {
  ai.closeAll()
  db.close()
  delete process.env.TWOK_FAKE_AI
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const iso = () => new Date().toISOString()
const later = () => Date.now() + 60 * 60_000
/** A job row to accept against (status done, as the queue would mark it). */
function jobRow<I>(kind: string, input: I): JobRow {
  const id = Number(db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES (?, 'done', 0, ?, ?)").run(kind, JSON.stringify(input), iso()).lastInsertRowid)
  return { id, kind, status: 'done', priority: 0, input, output: null, error: null, errorKind: null, attempts: 1, folder: null, costUsd: null, askedModel: null, askedEffort: null, usage: null, createdAt: iso(), startedAt: null, finishedAt: null }
}
/** A job already in the table, as the queue hands it to accept. */
function rowOf(id: number): JobRow {
  const r = db.prepare('SELECT kind, input, created_at FROM jobs WHERE id = ?').get(id) as { kind: string; input: string; created_at: string }
  return { ...jobRow(r.kind, {}), id, input: JSON.parse(r.input) as unknown, createdAt: r.created_at }
}
const allFlags = () => db.prepare('SELECT target_kind, numbers FROM ai_flags ORDER BY id').all() as { target_kind: string; numbers: string }[]

/** Two fans: one plain, one who misremembers numbers on purpose. */
function fans(): { plain: string; fuzzy: string } {
  const [a, b] = listPersonas(db).filter((p) => p.kind === 'fan')
  db.prepare("UPDATE personas SET quirks = '[]' WHERE id = ?").run(a!.id)
  db.prepare('UPDATE personas SET quirks = ? WHERE id = ?').run(JSON.stringify([MISREMEMBERS]), b!.id)
  return { plain: a!.id, fuzzy: b!.id }
}

const FACTS = '# 이 경기\nR1 · 가람고 81 : 77 나람고\n가람고: 가가가 31점 9리바 4어시'

function storyInput(extra: Partial<StoryInput> = {}): StoryInput {
  return {
    model: 'sonnet',
    instructions: '',
    context: FACTS,
    board: 'games',
    gameId: null,
    eventId: null,
    asOfEvent: lastNewsEventId(db),
    spreadMs: 0,
    liveKey: null,
    demo: { fans: [], reporters: [], boards: [], headline: '', teams: [], names: [], postIds: [] },
    ...extra,
  }
}

describe('the number check on community writing', () => {
  it('a thread with a made-up number is redone once with a note; the retry saves it with the numbers marked, but never a fuzzy fan’s', () => {
    const { plain, fuzzy } = fans()
    const retries: { kind: StoryKind; input: StoryInput }[] = []
    const kind = storyKinds(db, () => null, { requeue: (k, input) => void retries.push({ kind: k, input }) }).find((k) => k.kind === 'post_game_thread')!
    const out: StoryOutput = {
      posts: [
        {
          board: 'games',
          author: plain,
          tag: null,
          title: '가람고 81:77 승리, 4점 차',
          body: '가가가 31점, 사실상 44점급 활약',
          heat: 3,
          comments: [
            { author: plain, body: '지난 경기엔 47점 넣었는데', reply: null },
            { author: fuzzy, body: '내 기억엔 55점이었는데', reply: null },
            { author: plain, body: '9리바 4어시면 됐지', reply: null },
          ],
        },
      ],
      replies: [],
      memories: [{ author: plain, note: '가람고 우승 예상' }],
    }
    const first = jobRow('post_game_thread', storyInput({ liveKey: 'draft-live:1', spreadMs: 1234 }))
    kind.accept!(out, first)
    // Nothing of the first answer is kept, not even a note.
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE job_id = ?').get(first.id)).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM persona_memory WHERE job_id = ?').get(first.id)).toEqual({ n: 0 })
    // The same job again (live thread, timing and all), with the numbers it made up (as written); the fuzzy fan's 55 isn't one.
    expect(retries).toHaveLength(1)
    expect(retries[0]!.kind).toBe('post_game_thread')
    expect(retries[0]!.input).toEqual({ ...(first.input as StoryInput), numberRetry: ['44점', '47점'], retryOf: first.id })
    expect(kind.prompt(retries[0]!.input)).toContain('지난번 글에 자료에 없는 숫자가 있었다: 44점, 47점.')

    // The retry writes the same: it's kept, marked.
    const second = jobRow('post_game_thread', retries[0]!.input)
    kind.accept!(out, second)
    expect(retries).toHaveLength(1)
    const postId = (db.prepare('SELECT id FROM posts WHERE job_id = ?').get(second.id) as { id: number }).id
    const view = openPost(db, loadConfig(db).config.community, postId, later())
    expect(view.flags).toEqual(['44점'])
    expect(view.thread.map((c) => [c.body, c.flags])).toEqual([
      ['지난 경기엔 47점 넣었는데', ['47점']],
      ['내 기억엔 55점이었는데', []],
      ['9리바 4어시면 됐지', []],
    ])
  })

  it('a fan putting a fuzzy fan right may repeat his wrong number', () => {
    const { plain, fuzzy } = fans()
    const kind = storyKinds(db, () => null, { requeue: () => expect.unreachable('correcting him is no made-up number') }).find((k) => k.kind === 'post_game_thread')!
    const out: StoryOutput = {
      posts: [
        {
          board: 'games',
          author: plain,
          tag: null,
          title: '가람고 81:77 승리',
          body: '가가가 31점',
          heat: 2,
          comments: [
            { author: fuzzy, body: '가가가 55점 넣은 거 실화냐', reply: null },
            { author: plain, body: '55점은 무슨ㅋㅋ 31점이었음', reply: 0 },
          ],
        },
      ],
      replies: [],
      memories: [],
    }
    const job = jobRow('post_game_thread', storyInput())
    kind.accept!(out, job)
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE job_id = ?').get(job.id)).toEqual({ n: 2 })
    expect(allFlags()).toEqual([])
  })

  it('a clean answer (first try or retry) is saved without marks', () => {
    const { plain } = fans()
    const kind = storyKinds(db, () => null, { requeue: () => expect.unreachable('no retry for clean writing') }).find((k) => k.kind === 'post_game_thread')!
    const clean: StoryOutput = {
      posts: [{ board: 'games', author: plain, tag: null, title: '가람고 81:77, 4점 차 신승', body: '가가가 31점 9리바', heat: 3, comments: [{ author: plain, body: '2경기 연속 4어시', reply: null }] }],
      replies: [],
      memories: [],
    }
    kind.accept!(clean, jobRow('post_game_thread', storyInput()))
    kind.accept!(clean, jobRow('post_game_thread', storyInput({ numberRetry: ['44점'] })))
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get('가람고 81:77, 4점 차 신승')).toEqual({ n: 2 })
    expect(allFlags()).toEqual([])
  })

  it('a prediction is no made-up number; a past claim is', () => {
    const { plain } = fans()
    const retries: StoryInput[] = []
    const kind = storyKinds(db, () => null, { requeue: (_k, input) => void retries.push(input) }).find((k) => k.kind === 'post_game_thread')!
    const post = (body: string): StoryOutput => ({ posts: [{ board: 'games', author: plain, tag: null, title: '가람고 81:77 승리', body, heat: 2, comments: [] }], replies: [], memories: [] })
    kind.accept!(post('다음 경기는 30점 차로 이긴다. 가가가 40점 넣으면 인정'), jobRow('post_game_thread', storyInput()))
    expect(retries).toEqual([])
    kind.accept!(post('가가가 오늘 60점 넣었다'), jobRow('post_game_thread', storyInput()))
    expect(retries.map((r) => r.numberRetry)).toEqual([['60점']])
  })

  it('checks what’s stored: a made-up number past a comment’s cut is never shown, so it isn’t redone', () => {
    const { plain } = fans()
    const kind = storyKinds(db, () => null, { requeue: () => expect.unreachable('that number was never stored') }).find((k) => k.kind === 'post_game_thread')!
    const long = `${'ㄹㅇ '.repeat(700)}99점`
    const job = jobRow('post_game_thread', storyInput())
    kind.accept!({ posts: [{ board: 'games', author: plain, tag: null, title: '가람고 81:77 승리', body: '가가가 31점', heat: 2, comments: [{ author: plain, body: long, reply: null }] }], replies: [], memories: [] }, job)
    expect(db.prepare('SELECT LENGTH(body) AS n FROM comments WHERE job_id = ?').get(job.id)).toEqual({ n: 2000 })
    expect(allFlags()).toEqual([])
  })

  it('keeps no copied tag in what isn’t checked: a poll, a persona’s note', () => {
    const { plain } = fans()
    const kind = storyKinds(db, () => null, {}).find((k) => k.kind === 'event_thread')!
    const job = jobRow('event_thread', storyInput({ board: 'main' }))
    kind.accept!(
      {
        posts: [{ board: 'main', author: plain, tag: null, title: '투표', body: '골라라', heat: 2, comments: [], poll: { question: '41점(확인 안 된 숫자) 넘길까?', options: ['넘긴다 (확인안된 숫자)', '못 넘긴다'] } }],
        replies: [],
        memories: [{ author: plain, note: '41점[확인 안 된 숫자] 넘긴다고 함' }],
      },
      job,
    )
    const poll = db.prepare('SELECT question, options FROM polls').get() as { question: string; options: string }
    expect(poll).toEqual({ question: '41점 넘길까?', options: JSON.stringify(['넘긴다', '못 넘긴다']) })
    expect(db.prepare('SELECT note FROM persona_memory WHERE job_id = ?').get(job.id)).toEqual({ note: '41점 넘긴다고 함' })
  })

  it('chatter is checked when it’s written, and its marks land when refresh shows it', () => {
    const { plain } = fans()
    const retries: StoryInput[] = []
    const kind = storyKinds(db, () => null, { requeue: (_k, input) => void retries.push(input) }).find((k) => k.kind === 'chatter_batch')!
    const out: StoryOutput = {
      posts: [{ board: 'free', author: plain, tag: null, title: '가람고 지난 시즌 63승 찍었음', body: '81점 넣는 팀이면 가능', heat: 1, comments: [{ author: plain, body: 'ㄹㅇ', reply: null }] }],
      replies: [],
      memories: [],
    }
    kind.accept!(out, jobRow('chatter_batch', storyInput({ board: 'free' })))
    expect(db.prepare('SELECT COUNT(*) AS n FROM feed_buffer').get()).toEqual({ n: 0 })
    expect(retries[0]!.numberRetry).toEqual(['63승'])
    kind.accept!(out, jobRow('chatter_batch', retries[0]!))
    expect(allFlags()).toEqual([])
    refreshFeed(db, loadConfig(db).config.community, () => 0.5, Date.now())
    const post = db.prepare('SELECT id FROM posts WHERE title = ?').get('가람고 지난 시즌 63승 찍었음') as { id: number }
    expect(flagsOf(db, 'post', post.id)).toEqual(['63승'])
  })

  it('marked numbers reach later writers as unverified, never as facts: repeating one is marked, not redone', () => {
    const { plain } = fans()
    const retries: StoryInput[] = []
    const kind = storyKinds(db, () => null, { requeue: (_k, input) => void retries.push(input) }).find((k) => k.kind === 'post_game_thread')!
    const out: StoryOutput = {
      posts: [{ board: 'games', author: plain, tag: null, title: '가가가 44점급 활약', body: '가가가 31점', heat: 3, comments: [{ author: plain, body: '지난 경기엔 47점 넣었는데', reply: null }] }],
      replies: [],
      memories: [],
    }
    kind.accept!(out, jobRow('post_game_thread', storyInput()))
    kind.accept!(out, jobRow('post_game_thread', retries[0]!))
    const post = db.prepare("SELECT id FROM posts WHERE title = '가가가 44점급 활약'").get() as { id: number }
    const comment = db.prepare('SELECT id FROM comments WHERE post_id = ?').get(post.id) as { id: number }
    db.prepare('UPDATE posts SET shown_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), post.id)
    db.prepare('UPDATE comments SET shown_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), comment.id)
    const league = readLeague(db, dir)
    // Replying in that thread: the title and the comment carry the tag, and neither number is a fact; repeating one is marked, not redone.
    const reply = replyInput(league, post.id, null)
    expect(reply.context).toContain(`44점${UNVERIFIED}`)
    expect(reply.context).toContain(`47점${UNVERIFIED}`)
    expect(checkNumbers('44점, 47점', readFacts(reply.context, reply.instructions))).toEqual({ unknown: [], unverified: ['44점', '47점'] })
    // Titles already written, in any later job's facts.
    const chatter = chatterInput(league)
    expect(chatter.context).toContain(`44점${UNVERIFIED}`)
    expect(checkNumbers('44점', readFacts(chatter.context, chatter.instructions))).toEqual({ unknown: [], unverified: ['44점'] })
    // A writer who copies the tag along doesn't keep it (written any way); quoting the number isn't redone, but it's marked.
    const reply2 = storyKinds(db, () => null, { requeue: () => expect.unreachable('quoting an unverified number is no made-up one') }).find((k) => k.kind === 'reply_to_user')!
    const job = jobRow('reply_to_user', reply)
    reply2.accept!({ posts: [], replies: [{ postId: post.id, replyTo: null, comments: [{ author: plain, body: '44점 (확인안된 숫자)은 오바지', reply: null }] }], memories: [] }, job)
    const copied = db.prepare('SELECT id, body FROM comments WHERE job_id = ?').get(job.id) as { id: number; body: string }
    expect(copied.body).toBe('44점은 오바지')
    expect(flagsOf(db, 'comment', copied.id)).toEqual(['44점'])
  })
})

describe('the number check on the wiki', () => {
  it('a round edit with a made-up number lands only on the retry, marked on the page and in its history', () => {
    const title = listTeams(db)[0]!.shortName
    const page = pageByTitle(db, title)!
    const editor = listPersonas(db).find((p) => p.kind === 'fan')!.id
    const retries: WikiEditInput[] = []
    const kind = wikiEditKind(db, () => null, { requeue: (input) => void retries.push(input) })
    const input: WikiEditInput = {
      model: 'sonnet',
      instructions: `고칠 수 있는 문서: 「${title}」.`,
      context: '# 있었던 일\n- R1 가람고 81:77 나람고',
      pages: [title],
      seen: { [title]: page.currentRev! },
      editors: [editor],
      asOfEvent: lastEventId(db),
      demo: { pages: [], editors: [], facts: [] },
    }
    const out: WikiEditOutput = { edits: [{ page: title, section: '여담', mode: 'append', text: ' * 81:77로 이겼고, 이번 시즌 4321득점을 넘겼다.', summary: '여담', editor }], disputes: [] }
    const first = jobRow('wiki_edits', input)
    kind.accept!(out, first)
    expect(pageByTitle(db, title)!.currentRev).toBe(page.currentRev)
    // What the editors saw stays the same: a rewrite still can't drop text they never saw.
    expect(retries).toEqual([{ ...input, numberRetry: ['4321득점'], retryOf: first.id }])
    expect(kind.prompt(retries[0]!)).toContain('자료에 없는 숫자가 있었다: 4321득점.')
    kind.accept!(out, jobRow('wiki_edits', retries[0]!))
    const after = pageByTitle(db, title)!
    expect(after.currentRev).toBe(page.currentRev! + 1)
    expect(wiki.page(db, dir, title).flags).toEqual(['4321득점'])
    expect(wiki.history(db, title).map((r) => r.flags)).toEqual([['4321득점'], ...Array.from({ length: page.currentRev! }, () => [])])
    // An older revision shows no notice.
    expect(wiki.page(db, dir, title, page.currentRev!).flags).toEqual([])
    // Editors see the page with the number shown as unverified: no fact for them, so keeping it is marked (but not redone).
    const outline = pageOutline(db, after, '')
    expect(outline).toContain(`4321득점${UNVERIFIED}`)
    expect(checkNumbers('4321득점', readFacts(outline))).toEqual({ unknown: [], unverified: ['4321득점'] })
  })

  it('a page’s notice stays while its text still has the number, whoever edited it since', () => {
    const title = listTeams(db)[0]!.shortName
    const page = pageByTitle(db, title)!
    const editor = listPersonas(db).find((p) => p.kind === 'fan')!.id
    const body = revisionBody(db, page.id, page.currentRev!)!.body
    saveRevision(db, { title, body: `${body}\n== 기록 메모 ==\n통산 4321득점을 넘겼다.`, authorId: editor, summary: '메모', flags: ['4321득점'] }, Date.now())
    const marked = pageByTitle(db, title)!.currentRev!
    // Your edit elsewhere on the page: the number is still there, and so is the notice.
    wiki.save(db, { title, source: `${revisionBody(db, page.id, marked)!.body}\n== 여담2 ==\n추가`, summary: '추가', baseRev: marked })
    expect(wiki.page(db, dir, title).flags).toEqual(['4321득점'])
    // The badge stays on the revision that wrote it.
    expect(wiki.history(db, title).map((r) => r.flags.length)).toEqual([0, 1, ...Array.from({ length: page.currentRev! }, () => 0)])
    // The number gone: no notice.
    const now = pageByTitle(db, title)!.currentRev!
    wiki.save(db, { title, source: revisionBody(db, page.id, now)!.body.replace('통산 4321득점을 넘겼다.', '통산 득점 기록을 넘겼다.'), summary: '고침', baseRev: now })
    expect(wiki.page(db, dir, title).flags).toEqual([])
  })

  it('a 토론 answer with a made-up number is redone (its edit and close undone too); the retry is marked in the thread', () => {
    const title = listTeams(db)[0]!.shortName
    const { id } = wiki.openThread(db, { title, topic: '개요 서술 관련', body: '개요가 너무 짧습니다.' })
    const input = talkInput(readLeague(db, dir), id)!
    expect(input.answers).toBe(1)
    const before = pageByTitle(db, title)!.currentRev
    const retries: { kind: string; input: unknown }[] = []
    const talk = wikiTalkKinds(db, { hooks: { requeue: (kind, i) => void retries.push({ kind, input: i }) } }).find((k) => k.kind === 'wiki_talk')!
    const editor = input.editors[0]!
    const out: WikiTalkOutput = {
      comments: [{ editor, text: '#1 동의합니다. 통산 4321득점 학교라고 덧붙이겠습니다.' }],
      edit: { section: '개요', mode: 'append', text: '통산 4321득점을 올린 학교다.', summary: '토론 합의 반영', editor },
      close: { editor, note: '합의' },
      escalate: null,
      memories: [],
    }
    const first = jobRow('wiki_talk', input)
    talk.accept!(out, first)
    expect(wiki.thread(db, id)).toMatchObject({ status: 'open', lines: [expect.objectContaining({ n: 1 })] })
    expect(wiki.thread(db, id).lines).toHaveLength(1)
    expect(pageByTitle(db, title)!.currentRev).toBe(before)
    expect(retries).toEqual([{ kind: 'wiki_talk', input: { ...input, numberRetry: ['4321득점'], retryOf: first.id } }])

    talk.accept!(out, jobRow('wiki_talk', retries[0]!.input as WikiTalkInput))
    const lines = wiki.thread(db, id).lines
    expect(lines.find((l) => l.n === 2)).toMatchObject({ flags: ['4321득점'] })
    expect(lines.filter((l) => l.kind === 'status').every((l) => l.flags.length === 0)).toBe(true)
    expect(wiki.page(db, dir, title).flags).toEqual(['4321득점'])
    // The next answer in the thread (opened again) reads the marked comment as unverified.
    db.prepare("UPDATE wiki_threads SET status = 'open' WHERE id = ?").run(id)
    wiki.comment(db, id, '근거가 있나요?')
    const next = talkInput(readLeague(db, dir), id)!
    expect(next.context).toContain(`4321득점${UNVERIFIED}`)
    expect(checkNumbers('4321득점', readFacts(next.context, next.instructions))).toEqual({ unknown: [], unverified: ['4321득점'] })
  })

  it('a retry while you wrote again: the answer already waiting becomes the retry, so your newest comment gets one answer', () => {
    const insertQueued = (kind: string, input: unknown) =>
      Number(db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES (?, 'queued', 55, ?, ?)").run(kind, JSON.stringify(input), iso()).lastInsertRowid)
    const quiet = new StoryService({ fake: true, unavailable: () => false, ready: () => true, queueFor: () => ({ enqueue: insertQueued }) } as unknown as AiService)
    const title = listTeams(db)[0]!.shortName
    const { id: threadId } = new WikiService({}).openThread(db, { title, topic: '개요 서술', body: '개요가 짧습니다.' })
    quiet.wikiTalk('test', db, dir, threadId)
    const a = (db.prepare("SELECT id FROM jobs WHERE kind = 'wiki_talk' AND status = 'queued'").get() as { id: number }).id
    // A runs; you comment again meanwhile, and B is queued for that.
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a)
    addTalk(db, threadId, { authorId: 'me', body: '하나 더요.' }, iso())
    quiet.wikiTalk('test', db, dir, threadId)
    const requeued: number[] = []
    const talk = wikiTalkKinds(db, { hooks: { requeue: (kind, input) => void requeued.push(insertQueued(kind, input)), answered: (t) => quiet.wikiAnswered(db, dir, t) } }).find(
      (k) => k.kind === 'wiki_talk',
    )!
    const editor = (rowOf(a).input as WikiTalkInput).editors[0]!
    talk.accept!({ comments: [{ editor, text: '통산 4321득점 학교입니다.' }], edit: null, close: null, escalate: null, memories: [] }, rowOf(a))
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(a)
    // No second answer: B is now the retry, answering your newest comment, with no numbers from A's answer to the first.
    expect(requeued).toEqual([])
    const waiting = db.prepare("SELECT id, input FROM jobs WHERE kind = 'wiki_talk' AND status = 'queued'").all() as { id: number; input: string }[]
    expect(waiting).toHaveLength(1)
    const b = JSON.parse(waiting[0]!.input) as WikiTalkInput
    expect(b).toMatchObject({ answers: 2, numberRetry: [], retryOf: a })
    // Built while A was being written, it answered #2 alone; A's answer to #1 never landed, so it answers both now.
    expect(b.instructions).toContain('답할 내 글은 #1, #2.')
    expect(talk.prompt(b)).toContain('숫자는 자료에 있는 것만 쓰고')
    expect(talk.prompt(b)).not.toContain('4321')
  })

  it('an answer still waiting stays the retry when it’s rebuilt, naming the numbers only while it answers the same comment', () => {
    const title = listTeams(db)[0]!.shortName
    const { id } = wiki.openThread(db, { title, topic: '개요', body: '개요가 짧습니다.' })
    const waiting = { ...talkInput(readLeague(db, dir), id)!, numberRetry: ['4321득점'], retryOf: 7 }
    const job = Number(db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('wiki_talk', 'queued', 0, ?, ?)").run(JSON.stringify(waiting), iso()).lastInsertRowid)
    const input = () => JSON.parse((db.prepare('SELECT input FROM jobs WHERE id = ?').get(job) as { input: string }).input) as WikiTalkInput
    // Editors answered in the thread meanwhile: rebuilt, still answering #1.
    story.wikiAnswered(db, dir, id)
    expect(input()).toMatchObject({ answers: 1, numberRetry: ['4321득점'], retryOf: 7 })
    // Your new comment: it answers #2 now (and #1, which no editor has answered yet), still the retry, without the old numbers.
    wiki.comment(db, id, '하나 더 있습니다.', { slug: 'test', folder: dir })
    expect(input().instructions).toContain('답할 내 글은 #1, #2.')
    expect(input()).toMatchObject({ answers: 2, numberRetry: [], retryOf: 7 })
  })

  it('an edit war whose steps make up a number is fought again, still spread over the time since it was first queued', () => {
    const [a, b] = listPersonas(db).filter((p) => p.kind === 'fan')
    saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n원래 문장이다.\n== 여담 ==\n내 여담.', authorId: 'system', summary: '문서 생성' }, Date.now() - 120_000)
    saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n리그 최고의 선수로 꼽힌다.\n== 여담 ==\n내 여담.', authorId: a!.id, summary: '개요 보강' }, Date.now() - 100_000)
    const page = pageByTitle(db, '연습 문서')!
    const input = warInput(readLeague(db, dir), { pageId: page.id, section: '개요', challenger: b!.id, heat: 5, why: '과장' })!
    const retries: { kind: string; input: unknown }[] = []
    const war = wikiTalkKinds(db, { hooks: { requeue: (kind, i) => void retries.push({ kind, input: i }) } }).find((k) => k.kind === 'wiki_war')!
    const out: WikiWarOutput = {
      steps: [
        { text: '통산 4321득점의 선수다.', summary: '수정' },
        { text: null, summary: '되돌림' },
      ],
      topic: '개요 서술 관련',
      comments: [{ editor: b!.id, text: '4321득점은 근거가 없습니다.' }],
      outcome: { agreed: true, text: '뛰어난 선수로 평가받는다.', editor: b!.id, summary: '합의', note: '합의' },
      memories: [],
    }
    const queuedAt = new Date(Date.now() - 60_000).toISOString()
    const first = { ...jobRow('wiki_war', input), createdAt: queuedAt }
    war.accept!(out, first)
    expect(pageByTitle(db, '연습 문서')!.currentRev).toBe(page.currentRev)
    expect(wiki.threads(db, '연습 문서')).toEqual([])
    expect(retries).toEqual([{ kind: 'wiki_war', input: { ...input, queuedAt, numberRetry: ['4321득점'], retryOf: first.id } }])

    war.accept!(out, jobRow('wiki_war', retries[0]!.input as WikiWarInput))
    const history = wiki.history(db, '연습 문서')
    expect(history.map((r) => [r.summary, r.flags])).toEqual([
      ['합의', []],
      ['되돌림', []],
      ['수정', ['4321득점']],
      ['개요 보강', []],
      ['문서 생성', []],
    ])
    // Spread from a minute ago, when the first try was queued, not from the retry.
    expect(Date.parse(history[2]!.createdAt)).toBeLessThan(Date.now() - 30_000)
    const [thread] = wiki.threads(db, '연습 문서')
    expect(wiki.thread(db, thread!.id).lines.find((l) => l.kind === 'comment')).toMatchObject({ flags: ['4321득점'] })
  })

  it('shows a marked number as unverified in an edit war’s and a pushback’s quoted lines, never as a fact', () => {
    const [a, b] = listPersonas(db).filter((p) => p.kind === 'fan')
    saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n원래 문장이다.\n== 여담 ==\n내 여담.', authorId: 'system', summary: '문서 생성' }, Date.now() - 120_000)
    saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n통산 4321득점의 선수다.\n== 여담 ==\n내 여담.', authorId: a!.id, summary: '개요 보강', flags: ['4321득점'] }, Date.now() - 100_000)
    const page = pageByTitle(db, '연습 문서')!
    const war = warInput(readLeague(db, dir), { pageId: page.id, section: '개요', challenger: b!.id, heat: 5, why: '과장' })!
    expect(war.context).toContain(`- 고친 뒤(지금 판):\n│ 통산 4321득점${UNVERIFIED}의 선수다.`)
    expect(war.context).not.toMatch(/4321득점(?!\(확인)/)
    // Disputing it is no made-up number; repeating it is marked.
    expect(checkNumbers('통산 4321득점은 과장입니다.', readFacts(war.context, war.instructions))).toEqual({ unknown: [], unverified: ['4321득점'] })
    // You take the editor's marked line out: their answer quotes it unverified too.
    const marked = page.currentRev!
    wiki.save(db, { title: '연습 문서', source: revisionBody(db, page.id, marked)!.body.replace('통산 4321득점의 선수다.', '리그에서 손꼽히는 득점원이다. 기록은 확인이 필요하다.'), summary: '근거 없는 숫자 삭제', baseRev: marked })
    const push = pushbackInput(readLeague(db, dir), page.id, pageByTitle(db, '연습 문서')!.currentRev!)!
    expect(push.context).toContain(`│ 통산 4321득점${UNVERIFIED}의 선수다.`)
    expect(push.context).not.toMatch(/4321득점(?!\(확인)/)
    expect(checkNumbers('제가 쓴 4321득점은 근거가 있습니다.', readFacts(push.context, push.instructions))).toEqual({ unknown: [], unverified: ['4321득점'] })
  })

  it('keeps no copied tag in what isn’t checked: edit summaries, a 토론’s topic and its close note', () => {
    const [a, b] = listPersonas(db).filter((p) => p.kind === 'fan')
    saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n원래 문장이다.\n== 여담 ==\n내 여담.', authorId: 'system', summary: '문서 생성' }, Date.now() - 120_000)
    saveRevision(db, { title: '연습 문서', body: '== 개요 ==\n리그 최고의 선수로 꼽힌다.\n== 여담 ==\n내 여담.', authorId: a!.id, summary: '개요 보강' }, Date.now() - 100_000)
    const page = pageByTitle(db, '연습 문서')!
    const input = warInput(readLeague(db, dir), { pageId: page.id, section: '개요', challenger: b!.id, heat: 5, why: '과장' })!
    const war = wikiTalkKinds(db).find((k) => k.kind === 'wiki_war')!
    war.accept!(
      {
        steps: [
          { text: null, summary: '41점(확인 안 된 숫자) 삭제' },
          { text: null, summary: '되돌림 [확인 안 된 숫자]' },
        ],
        topic: '41점(확인안된 숫자) 서술',
        comments: [{ editor: b!.id, text: '근거가 없습니다.' }],
        outcome: { agreed: true, text: '뛰어난 선수로 평가받는다.', editor: b!.id, summary: '합의 41점 (확인 안된 숫자)', note: '41점(확인 안 된 숫자)은 뺌' },
        memories: [],
      } satisfies WikiWarOutput,
      jobRow('wiki_war', input),
    )
    expect(wiki.history(db, '연습 문서').map((r) => r.summary)).toEqual(['합의 41점', '되돌림', '41점 삭제', '개요 보강', '문서 생성'])
    const [thread] = wiki.threads(db, '연습 문서')
    expect(thread!.topic).toBe('41점 서술')
    const lines = wiki.thread(db, thread!.id)
    expect(lines.closeNote).toBe('41점은 뺌')
    expect(lines.lines.map((l) => l.body).join('\n')).not.toContain('확인')
  })
})

describe("the number check on players' words", () => {
  const P1 = { key: 'P1', playerId: 'p1', teamId: 't1', causes: ['트레이드'], weight: 3 }
  const P2 = { key: 'P2', playerId: 'p2', teamId: 't1', causes: ['트레이드'], weight: 2 }
  const line = (player: string, quote: string) => ({ player, channel: 'interview' as const, quote, action: 'none' as const, target: null, note: '' })
  const said = () => listEvents(db, 'player_said').map((e) => (e.payload as { playerId: string }).playerId)

  it('a quote with a made-up number gets him one more try on the same facts; the retry is kept, marked, and the forum’s post repeating it is marked too', () => {
    const retries: PlayerReactionInput[] = []
    let changed = 0
    const kind = reactionKind(db, dir, { requeue: (input) => void retries.push(input), changed: () => void changed++ })
    const input: PlayerReactionInput = { model: 'sonnet', seasonId: currentSeason(db).id, context: '# P1 · 가가가\n팀 성적: 5승 3패', players: [P1, P2], retry: false }
    const out: PlayerReactionOutput = { reactions: [line('P1', '이번 시즌 41점 넣은 경기가 제일 기억나요.'), line('P2', '5승 3패, 아직 갈 길이 멀어요.')] }
    const first = jobRow('player_reaction', input)
    kind.accept!(out, first)
    // The clean quote stays; the other player tries again on the same facts (the batch stays whole: its secrets were all read).
    const quotes = () => db.prepare('SELECT id, player_id, quote FROM player_quotes ORDER BY id').all() as { id: number; player_id: string; quote: string }[]
    expect(quotes().map((q) => q.player_id)).toEqual(['p2'])
    // His words wait for the retry, so the batch makes one forum thread.
    expect(said()).toEqual([])
    const p2 = quotes()[0]!
    expect(retries).toEqual([
      {
        ...input,
        retry: true,
        numberRetry: ['41점'],
        only: ['P1'],
        retryOf: first.id,
        held: [{ quoteId: p2.id, playerId: 'p2', teamId: 't1', channel: 'interview', quote: p2.quote, action: 'none', targetId: null }],
      },
    ])
    expect(kind.prompt(retries[0]!)).toContain('이번에는 P1만')
    expect(kind.prompt(retries[0]!)).toContain('자료에 없는 숫자가 있었다: 41점.')
    expect(kind.prompt(retries[0]!)).not.toContain('비밀')

    // On the retry, P2 (who already spoke) isn't heard twice; both players' words become news together.
    kind.accept!({ reactions: [line('P1', '이번 시즌 41점 넣은 경기가 제일 기억나요.'), line('P2', '또 말할게요.')] }, jobRow('player_reaction', retries[0]!))
    expect(retries).toHaveLength(1)
    expect(quotes().map((q) => q.player_id)).toEqual(['p2', 'p1'])
    expect(said()).toEqual(['p2', 'p1'])
    const quote = quotes().find((q) => q.player_id === 'p1')!
    expect(flagsOf(db, 'player_quote', quote.id)).toEqual(['41점'])
    const words = playerState(readLeague(db, dir), 'p1').timeline.find((t) => t.kind === 'said')
    expect(words).toMatchObject({ words: { quote: quote.quote, flags: ['41점'] } })
    expect(lockerRoom(readLeague(db, dir), 't1').players.find((p) => p.playerId === 'p1')!.said).toMatchObject({ flags: ['41점'] })

    // The forum's thread on his words: they're shown as unverified, but quoting him isn't redone; repeating his number
    // (whatever unit it's given: 41위 here) carries the mark.
    const event = listEvents(db, 'player_said').find((e) => (e.payload as { quoteId: number }).quoteId === quote.id)!
    const thread = eventThreadInput(readLeague(db, dir), [event])!
    expect(thread.marked).toEqual(['41점'])
    expect(thread.context).toContain(`41점${UNVERIFIED}`)
    const fan = listPersonas(db).find((p) => p.kind === 'fan')!.id
    const writer = storyKinds(db, () => null, { requeue: () => expect.unreachable('his words are his to quote') }).find((k) => k.kind === 'event_thread')!
    const job = jobRow('event_thread', thread)
    writer.accept!(
      { posts: [{ board: 'main', author: fan, tag: null, title: '가가가 "41점 경기가 제일 기억나"', body: '인터뷰 전문. 41위 팀 상대로', heat: 2, comments: [] }], replies: [], memories: [] },
      job,
    )
    const post = db.prepare('SELECT id FROM posts WHERE job_id = ?').get(job.id) as { id: number }
    expect(openPost(db, loadConfig(db).config.community, post.id, later()).flags).toEqual(['41점', '41위'])

    // What he says next: his own marked words are shown as unverified, not facts; saying it again is marked.
    const again = reactionInput(readLeague(db, dir), [{ playerId: 'p1', causes: ['수상'], weight: 2 }])!
    expect(again.context).toContain(`41점${UNVERIFIED}`)
    expect(checkNumbers('41점', readFacts(again.context))).toEqual({ unknown: [], unverified: ['41점'] })
  })

  it('keeps no copied tag in his 속마음', () => {
    const kind = reactionKind(db, dir, { requeue: () => {}, changed: () => {} })
    const input: PlayerReactionInput = { model: 'sonnet', seasonId: currentSeason(db).id, context: '# P1 · 가가가\n팀 성적: 5승 3패', players: [P1], retry: false }
    kind.accept!({ reactions: [{ ...line('P1', '열심히 하겠습니다.'), note: '41점(확인 안 된 숫자) 넣고 싶다' }] }, jobRow('player_reaction', input))
    expect(db.prepare('SELECT note FROM player_quotes').get()).toEqual({ note: '41점 넣고 싶다' })
  })

  it('words held for a retry that never saves become news when it ends', () => {
    const retries: PlayerReactionInput[] = []
    const kind = reactionKind(db, dir, { requeue: (input) => void retries.push(input), changed: () => {} })
    const input: PlayerReactionInput = { model: 'sonnet', seasonId: currentSeason(db).id, context: '# P1 · 가가가\n팀 성적: 5승 3패', players: [P1, P2], retry: false }
    kind.accept!({ reactions: [line('P1', '41점 넣은 경기가 기억나요.'), line('P2', '5승 3패예요.')] }, jobRow('player_reaction', input))
    expect(said()).toEqual([])
    // The retry is cancelled (he moved, say) or fails.
    const retry = Number(db.prepare("INSERT INTO jobs (kind, status, priority, input, created_at) VALUES ('player_reaction', 'queued', 0, ?, ?)").run(JSON.stringify(retries[0]!), iso()).lastInsertRowid)
    expect(releaseHeld(db, retry)).toBe(false)
    db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(retry)
    expect(releaseHeld(db, retry)).toBe(true)
    expect(said()).toEqual(['p2'])
    // Once only.
    expect(releaseHeld(db, retry)).toBe(false)
    expect(said()).toEqual(['p2'])
  })
})

describe('game facts', () => {
  it('carry each side’s team totals, so a writer quoting team shooting isn’t redone', () => {
    const game = listGames(db, currentSeason(db).id).find((g) => g.status === 'scheduled')!
    const roster = (team: string) => (db.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY id').all(team) as { id: string }[]).map((p) => p.id)
    const line = (playerId: string, teamId: string, i: number) => ({
      playerId,
      teamId,
      stats: { pts: 2 * (6 + i) + 2 + 1, reb: 4 + i, ast: 2 + i, stl: 1, blk: 0, to: 2, fgm: 6 + i, fga: 13 + i, '3pm': 2, '3pa': 5, ftm: 1, fta: 2 },
    })
    const lines = [...roster(game.home).map((p, i) => line(p, game.home, i)), ...roster(game.away).map((p, i) => line(p, game.away, i + 1))]
    const sum = (team: string) => lines.filter((l) => l.teamId === team).reduce((s, l) => s + l.stats.pts, 0)
    recordScore(db, { gameId: game.id, homeScore: sum(game.home), awayScore: sum(game.away), lines })
    const input = gameThreadInput(readLeague(db, dir), game.id, lastNewsEventId(db))
    expect(input.context).toContain('팀 합계:')
    const fgm = lines.filter((l) => l.teamId === game.home).reduce((s, l) => s + l.stats.fgm, 0)
    const fga = lines.filter((l) => l.teamId === game.home).reduce((s, l) => s + l.stats.fga, 0)
    const facts = readFacts(input.context, input.instructions)
    expect(unknownNumbers(`야투 ${fgm}/${fga}로 이겼다, 야투율 ${Math.round((fgm / fga) * 100)}%`, facts)).toEqual([])
    // The cast in the same context (ids, nicknames, 매운맛 3/5, 기억) adds no facts.
    const blocks = input.context.split('\n\n')
    expect(blocks.some((b) => b.startsWith('# 쓸 수 있는 사람'))).toBe(true)
    expect(facts).toEqual(readFacts(blocks.filter((b) => !b.startsWith('# 쓸 수 있는 사람')).join('\n\n'), input.instructions))
  })
})

describe('the demo writer', () => {
  it('never needs a retry: its numbers all come from the facts', async () => {
    const wired = new AiService()
    const queue = () => wired.queueFor('demo', db, dir)
    wired.addKinds((d) => storyKinds(d, () => null, { requeue: (k, i) => void queue().enqueue(k, i, STORY_PRIORITY[k]) }), storyDemo)
    wired.addKinds((d) => [wikiEditKind(d, () => null, { requeue: (i) => void queue().enqueue(WIKI_EDITS, i, WIKI_PRIORITY) })], wikiEditDemo)
    await wired.refresh()
    try {
      const round1 = listGames(db, 1).filter((g) => g.round === 1)
      for (const g of round1) {
        const ace = sampleSetup().players.find((p) => p.teamId === g.home)!
        recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 81, lines: [{ playerId: ace.id, teamId: g.home, stats: { pts: 35, reb: 9, ast: 4 } }] })
      }
      new StoryService(wired).afterChange('demo', db, dir)
      for (let i = 0; i < 4; i++) {
        await queue().kick()
        await new Promise((r) => setImmediate(r))
      }
      const done = db.prepare("SELECT kind FROM jobs WHERE status = 'done'").all() as { kind: string }[]
      expect(done.map((j) => j.kind)).toEqual(expect.arrayContaining(['post_game_thread', 'event_thread', 'wiki_edits']))
      expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(input, '$.numberRetry') IS NOT NULL").get()).toEqual({ n: 0 })
      expect(allFlags()).toEqual([])
    } finally {
      wired.closeAll()
    }
  })

  it('makes no retries and no marks over a whole season with box scores, chatter and playoffs', async () => {
    const wired = new AiService()
    const queue = () => wired.queueFor('demo', db, dir)
    const service = new StoryService(wired)
    wired.addKinds((d) => storyKinds(d, () => null, { requeue: (k, i) => void queue().enqueue(k, i, STORY_PRIORITY[k]) }), storyDemo)
    wired.addKinds(
      (d) => [wikiEditKind(d, () => null, { requeue: (i) => void queue().enqueue(WIKI_EDITS, i, WIKI_PRIORITY), contested: (edits) => service.wikiContested('demo', d, dir, edits) })],
      wikiEditDemo,
    )
    wired.addKinds((d) => wikiTalkKinds(d, { hooks: { requeue: (k, i) => void queue().enqueue(k, i, TALK_PRIORITY) } }), wikiTalkDemo)
    wired.addKinds((d) => [reactionKind(d, dir, { requeue: (i) => void queue().enqueue(PLAYER_REACTION, i, REACTION_PRIORITY), changed: () => {} })], reactionDemo)
    await wired.refresh()
    const drain = async () => {
      for (let i = 0; i < 6; i++) {
        await queue().kick()
        await new Promise((r) => setImmediate(r))
      }
    }
    let seed = 3
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % k
    }
    const roster = (team: string) => (db.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY id').all(team) as { id: string }[]).map((p) => p.id)
    // Every scheduled game of these, with a box score for everyone; the story engine looks after each batch.
    const play = async (which: (g: { stage: string; round: number }) => boolean) => {
      for (;;) {
        const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && which(g))
        if (open.length === 0) return
        for (const g of open) {
          const lines = [g.home, g.away].flatMap((team) =>
            roster(team).map((playerId) => {
              const fga = 8 + rnd(12)
              const fgm = 3 + rnd(Math.min(fga, 10) - 2)
              const pm = rnd(Math.min(fgm, 4))
              const ftm = rnd(6)
              return { playerId, teamId: team, stats: { pts: 2 * fgm + pm + ftm, reb: 2 + rnd(10), ast: 1 + rnd(7), stl: rnd(3), blk: rnd(3), to: rnd(4), fgm, fga, '3pm': pm, '3pa': pm + rnd(5), ftm, fta: ftm + rnd(3) } }
            }),
          )
          const sum = (team: string) => lines.filter((l) => l.teamId === team).reduce((s, l) => s + l.stats.pts, 0)
          if (sum(g.home) === sum(g.away)) {
            lines[0]!.stats.pts++
            lines[0]!.stats.ftm++
            lines[0]!.stats.fta++
          }
          recordScore(db, { gameId: g.id, homeScore: sum(g.home), awayScore: sum(g.away), lines })
        }
        service.afterChange('demo', db, dir)
        service.refresh('demo', db, dir, () => 0.5)
        await drain()
      }
    }
    try {
      for (let round = 1; listGames(db, currentSeason(db).id).some((g) => g.status === 'scheduled' && g.stage === 'regular'); round++) {
        await play((g) => g.stage === 'regular' && g.round === round)
      }
      startPlayoffs(db)
      await play((g) => g.stage !== 'regular')
      const done = new Set((db.prepare("SELECT kind FROM jobs WHERE status = 'done'").all() as { kind: string }[]).map((j) => j.kind))
      expect([...done]).toEqual(expect.arrayContaining(['post_game_thread', 'event_thread', 'chatter_batch', 'wiki_edits', 'wiki_war', 'player_reaction']))
      expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(input, '$.numberRetry') IS NOT NULL").get()).toEqual({ n: 0 })
      expect(allFlags()).toEqual([])
    } finally {
      wired.closeAll()
    }
  }, 30_000) // A whole season: slow when the machine is busy.
})

describe('ai_flags', () => {
  it('keeps one row per marked text, replaced when marked again, and reads them back by id', () => {
    flagNumbers(db, 'comment', 7, ['41점', '41점', '72'], null)
    flagNumbers(db, 'comment', 8, [], null)
    flagNumbers(db, 'comment', 7, ['99점'], null)
    flagNumbers(db, 'post', 7, ['5'], null)
    expect(flagsFor(db, 'comment', [7, 8, 9])).toEqual(new Map([[7, ['99점']]]))
    expect(flagsOf(db, 'post', 7)).toEqual(['5'])
    expect(() => db.prepare("INSERT INTO ai_flags (target_kind, target_id, numbers, created_at) VALUES ('lore', 1, '[]', ?)").run(iso())).toThrow()
  })
})
