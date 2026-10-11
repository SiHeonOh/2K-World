import { describe, expect, it } from 'vitest'
import { rng } from '@core/random'
import { sampleSetup } from '@shared/testing/fixtures'
import { makeCast } from '@story/personas'
import {
  addPost,
  boardPage,
  bufferItems,
  bufferSize,
  jobSaved,
  ME,
  memoriesOf,
  openPost,
  refreshFeed,
  remember,
  savePersonas,
  vote,
  writeUserComment,
  writeUserPost,
} from './community'
import { openDb } from './db'
import { appendEvent, loadConfig, seedLeague } from './league'

const T0 = Date.parse('2026-10-10T12:00:00.000Z')

function league() {
  const db = openDb(':memory:')
  seedLeague(db, sampleSetup())
  const { config } = loadConfig(db)
  const cast = makeCast({
    seed: 's',
    fans: 30,
    reporters: 2,
    maxSpice: 4,
    teams: [{ id: 't1', shortName: 'x', fanSize: 3 }],
    players: [],
  })
  savePersonas(db, cast, '테스터')
  return { db, community: config.community, fan: cast[0]!.id, fan2: cast[1]!.id }
}

describe('community data', () => {
  it('stores the cast once, with you as me', () => {
    const { db } = league()
    const before = db.prepare('SELECT COUNT(*) AS n FROM personas').get() as { n: number }
    savePersonas(db, makeCast({ seed: 'other', fans: 5, reporters: 0, maxSpice: 3, teams: [], players: [] }), '테스터')
    expect(db.prepare('SELECT COUNT(*) AS n FROM personas').get()).toEqual(before)
    expect(db.prepare('SELECT nick FROM personas WHERE id = ?').get(ME)).toEqual({ nick: '테스터' })
  })

  it('shows comments as they arrive, threads replies, and fixes bad authors and boards', () => {
    const { db, community, fan, fan2 } = league()
    const id = addPost(
      db,
      community,
      {
        board: 'no-such-board',
        author: 'nobody',
        title: '경기 후 스레드',
        body: '본문',
        comments: [
          { author: fan, body: '첫 댓' },
          { author: fan2, body: '둘째' },
          { author: fan2, body: '첫 댓에 답글', reply: 0 },
        ],
      },
      { kind: 'thread', jobId: null },
      T0,
      10 * 60_000,
    )
    const first = openPost(db, community, id, T0)
    expect(first.boardId).toBe('main')
    expect(first.author.id).toMatch(/^f\d+/)
    expect(first.thread.length + first.pending).toBe(3)
    const later = openPost(db, community, id, T0 + 60 * 60_000)
    expect(later.thread.map((c) => c.body)).toEqual(['첫 댓', '첫 댓에 답글', '둘째'])
    expect(later.thread[1]!.parentId).toBe(later.thread[0]!.id)
    expect(later.pending).toBe(0)
    expect(later.views).toBe(2)
    // Looking again within a minute (the page polls while comments arrive) isn't another view.
    expect(openPost(db, community, id, T0 + 60 * 60_000 + 15_000).views).toBe(2)
    // A 말머리 naming a board files the post there; brackets in a 말머리 go.
    const humor = community.boards.find((b) => b.role === 'humor')!
    const joke = addPost(db, community, { board: 'main', author: fan, tag: humor.name, title: '짤', body: '', comments: [] }, { kind: 'thread' }, T0, 0)
    expect(openPost(db, community, joke, T0).boardId).toBe(humor.id)
    // A title that repeats its 말머리 loses it, so the list doesn't read "[현장] [현장] …"; a title that is only the 말머리 keeps it.
    const repeated = addPost(db, community, { board: 'main', author: fan, tag: '현장', title: '[현장] 가람고 5연승', body: '', comments: [] }, { kind: 'thread' }, T0, 0)
    expect(openPost(db, community, repeated, T0).title).toBe('가람고 5연승')
    const scene = addPost(db, community, { board: 'main', author: fan, tag: '[현장]', title: '현장', body: '', comments: [] }, { kind: 'thread' }, T0, 0)
    expect(openPost(db, community, scene, T0)).toMatchObject({ boardId: 'main', tag: '현장' })
  })

  it('lists a board newest first, in pages, and 포텐 by threshold', () => {
    const { db, community, fan } = league()
    for (let i = 0; i < 25; i++) {
      addPost(db, community, { board: 'free', author: fan, title: `글 ${i}`, body: '', comments: [] }, { kind: 'thread' }, T0 + i, 0)
    }
    const page1 = boardPage(db, community, 'free', 1, T0 + 1000)
    expect(page1).toMatchObject({ total: 25, pages: 2, page: 1 })
    expect(page1.posts[0]!.title).toBe('글 24')
    expect(boardPage(db, community, 'free', 9, T0 + 1000).posts).toHaveLength(5)
    db.prepare("UPDATE posts SET up = 999 WHERE title = '글 3'").run()
    refreshFeed(db, community, rng(1), T0 + 2000)
    // Clicking refresh again and again moves the numbers by the time that passed, not per click.
    const before = (db.prepare('SELECT SUM(views) AS v FROM posts').get() as { v: number }).v
    for (let i = 1; i <= 50; i++) refreshFeed(db, community, rng(i), T0 + 2000 + i * 1000)
    const after = (db.prepare('SELECT SUM(views) AS v FROM posts').get() as { v: number }).v
    expect(after - before).toBeLessThan(40)
    expect(boardPage(db, community, 'poten', 1, T0 + 3000).posts.map((p) => p.title)).toEqual(['글 3'])
  })

  it('reveals buffered items on refresh and drops stale chatter after a new event', () => {
    const { db, community, fan } = league()
    const target = addPost(db, community, { board: 'free', author: fan, title: '기존 글', body: '', comments: [] }, { kind: 'thread' }, T0, 0)
    const asOf = (db.prepare('SELECT MAX(id) AS n FROM events').get() as { n: number }).n
    const items = Array.from({ length: 6 }, (_, i) => ({ type: 'post' as const, post: { board: 'free', author: fan, title: `잡담 ${i}`, body: '', comments: [] } }))
    bufferItems(db, null, [...items, { type: 'comments', postId: target, comments: [{ author: fan, body: '늦은 댓글' }] }], asOf, true, T0)
    const r = refreshFeed(db, community, rng(1), T0 + 1000)
    expect(r).toEqual({ revealed: community.revealPerRefresh, waiting: 7 - community.revealPerRefresh })
    appendEvent(db, 'season_started', { games: 1 }, null)
    expect(refreshFeed(db, community, rng(1), T0 + 2000)).toEqual({ revealed: 0, waiting: 0 })
    expect(bufferSize(db)).toBe(0)
  })

  it('keeps your posts, comments and votes', () => {
    const { db, community } = league()
    const id = writeUserPost(db, community, { boardId: 'free', title: '내 글', body: '안녕' }, T0)
    const c = writeUserComment(db, { postId: id, body: '셀프 댓글' }, T0 + 1)
    expect(vote(db, 'post', id, 1)).toEqual({ up: 1, down: 0, myVote: 1 })
    expect(vote(db, 'post', id, 1)).toEqual({ up: 0, down: 0, myVote: 0 })
    expect(vote(db, 'comment', c, -1)).toMatchObject({ down: 1, myVote: -1 })
    const view = openPost(db, community, id, T0 + 2)
    expect(view.mine).toBe(true)
    expect(view.thread[0]).toMatchObject({ mine: true, body: '셀프 댓글', myVote: -1 })
    expect(() => writeUserPost(db, community, { boardId: 'poten', title: 'x', body: '' }, T0)).toThrow(/unknown-board/)
    expect(() => writeUserPost(db, community, { boardId: 'free', title: '  ', body: '' }, T0)).toThrow(/empty-post/)
  })

  it('remembers notes for real personas only, and knows which jobs were saved', () => {
    const { db, community, fan } = league()
    remember(db, [{ author: fan, note: '가람고 우승 예측' }, { author: 'ghost', note: 'x' }, { author: ME, note: 'y' }], null, T0)
    expect(memoriesOf(db, fan)).toEqual(['가람고 우승 예측'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM persona_memory').get()).toEqual({ n: 1 })
    const job = Number(db.prepare("INSERT INTO jobs (kind, status, input, created_at) VALUES ('x', 'done', '{}', 'now')").run().lastInsertRowid)
    expect(jobSaved(db, job)).toBe(false)
    addPost(db, community, { board: 'free', author: fan, title: 't', body: '', comments: [] }, { kind: 'thread', jobId: job }, T0, 0)
    expect(jobSaved(db, job)).toBe(true)
  })
})
