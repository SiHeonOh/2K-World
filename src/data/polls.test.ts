import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { makeCast } from '@story/personas'
import { addPost, boardPage, openPost, savePersonas, writeUserPost } from './community'
import { openDb, type Db } from './db'
import { currentSeason, listTeams, loadConfig, seedLeague } from './league'
import { closeDuePolls, closeRoundPolls, pollView, resultsBody, savePlannedVotes, unplannedPolls, votePoll } from './polls'
import { listGames, recordScore, startSeason } from './season'

const T0 = Date.parse('2026-10-10T12:00:00.000Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

function league() {
  const db = openDb(':memory:')
  seedLeague(db, sampleSetup())
  const { config } = loadConfig(db)
  const cast = makeCast({
    seed: 's',
    fans: 40,
    reporters: 2,
    maxSpice: 4,
    teams: listTeams(db).map((t) => ({ id: t.id, shortName: t.shortName, fanSize: 3 })),
    players: [],
  })
  savePersonas(db, cast, '테스터')
  return { db, community: config.community, fans: cast.filter((p) => p.kind === 'fan'), reporters: cast.filter((p) => p.kind === 'reporter') }
}

/** Plays the season's unplayed regular-season games in `round` (all of them without one), or the first `limit` of them. */
function play(db: Db, round?: number, limit = Infinity) {
  const games = listGames(db, currentSeason(db).id).filter((g) => g.stage === 'regular' && g.status !== 'final' && (round === undefined || g.round === round))
  for (const g of games.slice(0, limit)) recordScore(db, { gameId: g.id, homeScore: 90, awayScore: 80, lines: null })
}

describe('polls', () => {
  it("puts a writer's poll on its post (the title as its question) and leaves out one with too few options", () => {
    const { db, community, fans } = league()
    const options = ['1번 가가가(가람고)', '2. 나가나(나람고)', '3) 가가가 (가람고)', '4.다가다(다람고)', '5번: 라가라(라람고)', '6. 마가마(마람고)', '7) 바가바(바람고)', '8) 사가사(사람고)']
    const id = addPost(db, community, { board: 'main', author: fans[0]!.id, tag: '투표', title: '[투표] 올시즌 MVP는?', body: '', comments: [], poll: { options } }, { kind: 'thread' }, T0, 0)
    const view = openPost(db, community, id, T0)
    // Outside the regular season it's open for a day.
    expect(view.poll).toMatchObject({
      question: '올시즌 MVP는?',
      total: 0,
      myVote: null,
      open: true,
      closesAfterRound: null,
      closesAt: iso(T0 + 24 * H),
      closedAt: null,
      resultsPostId: null,
    })
    // The numbering goes, then the repeat, and it's cut to six.
    expect(view.poll!.options.map((o) => o.text)).toEqual(['가가가(가람고)', '나가나(나람고)', '다가다(다람고)', '라가라(라람고)', '마가마(마람고)', '바가바(바람고)'])
    expect(view.resultsOf).toBeNull()
    // With "6 마가마" not numbered, nothing is: numbering goes only from a whole 1…n list.
    const partly = addPost(db, community, { board: 'main', author: fans[0]!.id, title: '번호 투표', body: '', comments: [], poll: { options: options.map((o) => o.replace('6. ', '6 ')) } }, { kind: 'thread' }, T0, 0)
    expect(openPost(db, community, partly, T0).poll!.options.map((o) => o.text)).toEqual(['1번 가가가(가람고)', '2. 나가나(나람고)', '3) 가가가 (가람고)', '4.다가다(다람고)', '5번: 라가라(라람고)', '6 마가마(마람고)'])
    const lone = addPost(db, community, { board: 'main', author: fans[0]!.id, title: '혼자 투표', body: '', comments: [], poll: { question: '이거?', options: ['하나', ' 하나 '] } }, { kind: 'thread' }, T0, 0)
    expect(openPost(db, community, lone, T0).poll).toBeNull()
    // The list marks the poll post.
    const listed = boardPage(db, community, 'main', 1, T0).posts
    expect(listed.find((p) => p.id === id)!.pollState).toBe('open')
    expect(listed.find((p) => p.id === lone)!.pollState).toBeNull()
  })

  it('takes your poll strictly: 2–6 different options, a blank question takes the title', () => {
    const { db, community } = league()
    const id = writeUserPost(db, community, { boardId: 'free', title: '누가 이김?', body: '', poll: { question: '  ', options: ['1. 가람고', '2) 나람고', ''] } }, T0)
    expect(openPost(db, community, id, T0).poll).toMatchObject({ question: '누가 이김?', options: [{ text: '가람고' }, { text: '나람고' }] })
    expect(unplannedPolls(db)).toMatchObject([{ question: '누가 이김?', mine: true, heat: 3 }])
    const bad = (options: string[]) => () => writeUserPost(db, community, { boardId: 'free', title: '투표', body: '', poll: { question: 'q', options } }, T0)
    expect(bad(['가람고', ' 가람고 '])).toThrow(/poll-options/)
    expect(bad(['1. 가람고', '2. 가람고'])).toThrow(/poll-options/)
    expect(bad(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toThrow(/poll-options/)
    // A refused poll leaves no post behind.
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get()).toEqual({ n: 1 })
  })

  it("counts fans' votes as they arrive and yours at once; yours can change while it's open", () => {
    const { db, community, fans } = league()
    const id = writeUserPost(db, community, { boardId: 'free', title: '최고 학교', body: '', poll: { question: '', options: ['가람고', '나람고', '다람고'] } }, T0)
    const pollId = openPost(db, community, id, T0).poll!.id
    savePlannedVotes(db, pollId, [
      { voterId: fans[0]!.id, option: 0, shownAtMs: T0 + H },
      { voterId: fans[1]!.id, option: 1, shownAtMs: T0 + 2 * H },
      { voterId: fans[2]!.id, option: 0, shownAtMs: T0 + 3 * H },
    ])
    expect(unplannedPolls(db)).toEqual([])
    // Planned once: a second plan changes nothing.
    savePlannedVotes(db, pollId, [{ voterId: fans[3]!.id, option: 2, shownAtMs: T0 }])
    expect(pollView(db, id, T0 + H / 2)).toMatchObject({ total: 0, pending: 3 })
    expect(pollView(db, id, T0 + 2 * H)!.options.map((o) => o.votes)).toEqual([1, 1, 0])
    expect(votePoll(db, pollId, 2, T0 + 2 * H)).toMatchObject({ myVote: 2, total: 3 })
    const changed = votePoll(db, pollId, 1, T0 + 2 * H + 1)
    expect(changed.options.map((o) => o.votes)).toEqual([1, 2, 0])
    expect(changed.options[1]!.share).toBeCloseTo(2 / 3)
    expect(pollView(db, id, T0 + 4 * H)).toMatchObject({ total: 4, myVote: 1, pending: 0 })
    expect(() => votePoll(db, pollId, 3, T0 + 4 * H)).toThrow(/poll-bad-option/)
    expect(() => votePoll(db, pollId, 0.5, T0 + 4 * H)).toThrow(/poll-bad-option/)
    expect(() => votePoll(db, pollId + 99, 0, T0 + 4 * H)).toThrow(/unknown-poll/)
  })

  it("refuses a vote on a post that isn't shown yet", () => {
    const { db, community, reporters } = league()
    // An article goes up a little after its thread.
    const id = addPost(db, community, { board: 'main', author: reporters[0]!.id, title: '기사', body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'article' }, T0 + 20_000, 0)
    const pollId = (db.prepare('SELECT id FROM polls WHERE post_id = ?').get(id) as { id: number }).id
    expect(() => votePoll(db, pollId, 0, T0)).toThrow(/unknown-poll/)
    expect(votePoll(db, pollId, 0, T0 + 30_000).myVote).toBe(0)
  })

  it('closes a day later outside the regular season; the results post shows when it is written, counting as of the close', () => {
    const { db, community, fans } = league()
    const id = writeUserPost(db, community, { boardId: 'free', title: '최고 학교', body: '', poll: { question: '', options: ['가람고', '나람고'] } }, T0)
    const pollId = openPost(db, community, id, T0).poll!.id
    savePlannedVotes(db, pollId, [
      { voterId: fans[0]!.id, option: 0, shownAtMs: T0 + H },
      { voterId: fans[1]!.id, option: 1, shownAtMs: T0 + 2 * H },
    ])
    votePoll(db, pollId, 0, T0 + 3 * H)
    expect(closeDuePolls(db, T0 + 23 * H, true)).toBe(0)
    expect(() => votePoll(db, pollId, 1, T0 + 25 * H)).toThrow(/poll-closed/)
    // The app was shut for days; meanwhile (by the clock) a newer post went up.
    const newer = writeUserPost(db, community, { boardId: 'free', title: '그 뒤에 쓴 글', body: '' }, T0 + 30 * H)
    expect(closeDuePolls(db, T0 + 72 * H, true)).toBe(1)
    const view = pollView(db, id, T0 + 72 * H)!
    expect(view).toMatchObject({ open: false, closedAt: iso(T0 + 24 * H), total: 3, pending: 0, myVote: 0 })
    expect(view.options.map((o) => o.votes)).toEqual([2, 1])
    const results = openPost(db, community, view.resultsPostId!, T0 + 72 * H)
    expect(results).toMatchObject({ title: '[투표 결과] 최고 학교', boardId: 'free', kind: 'thread', resultsOf: id, poll: null, shownAt: iso(T0 + 72 * H) })
    expect(results.author.kind).toBe('fan')
    expect(db.prepare('SELECT team_id FROM personas WHERE id = ?').get(results.author.id)).toEqual({ team_id: null })
    expect(results.body).toContain('총 3표')
    expect(results.body).toContain('█████████████░░░░░░░ 67% (2표)')
    expect(results.body).toContain('1위: 가람고')
    const listed = boardPage(db, community, 'free', 1, T0 + 72 * H).posts
    expect(listed.find((p) => p.id === id)!.pollState).toBe('closed')
    // Newest first by id, and the dates agree.
    expect(listed.map((p) => p.id).slice(0, 2)).toEqual([results.id, newer])
    expect(listed[0]!.shownAt > listed[1]!.shownAt).toBe(true)
    expect(() => votePoll(db, pollId, 1, T0 + 73 * H)).toThrow(/poll-closed/)
    // Closing twice does nothing (and isn't counted).
    expect(closeDuePolls(db, T0 + 80 * H, true)).toBe(0)
  })

  it('opened mid-round waits for that round; once every regular-season game is played it is open for a day', () => {
    const { db, community, fans } = league()
    startSeason(db)
    const post = (at: number) =>
      openPost(db, community, addPost(db, community, { board: 'main', author: fans[0]!.id, title: '투표', body: '', comments: [], poll: { options: ['가', '나'] } }, { kind: 'thread' }, at, 0), at).poll!
    play(db, 1, 1)
    expect(post(T0)).toMatchObject({ closesAfterRound: 1, closesAt: null })
    play(db, 1)
    expect(post(T0)).toMatchObject({ closesAfterRound: 2, closesAt: null })
    play(db)
    expect(currentSeason(db).phase).toBe('regular')
    expect(post(T0)).toMatchObject({ closesAfterRound: null, closesAt: iso(T0 + 24 * H) })
  })

  it('closes when the round it waits for (or a later one) is complete, not before; results by the poll’s author', () => {
    const { db, community, fans } = league()
    startSeason(db)
    const season = currentSeason(db).id
    const post = (title: string, at = T0) =>
      addPost(db, community, { board: 'main', author: fans[5]!.id, title, body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'thread' }, at, 0)
    const a = post('누가 이김?')
    expect(openPost(db, community, a, T0).poll).toMatchObject({ closesAfterRound: 1, closesAt: null, open: true })
    // Waiting for a round, it doesn't close by time.
    expect(closeDuePolls(db, T0 + 100 * H, true)).toBe(0)
    // An article's poll, stamped a little ahead of the round's end, still closes with it (as it shows).
    const ahead = post('기사 투표', T0 + H + 20_000)
    play(db, 1)
    // Opened after round 1 was complete: it waits for round 2.
    const b = post('2라운드는?')
    expect(openPost(db, community, b, T0).poll!.closesAfterRound).toBe(2)
    expect(closeRoundPolls(db, season, 1, T0 + H, true)).toBe(2)
    expect(pollView(db, a, T0 + H)).toMatchObject({ open: false, closedAt: iso(T0 + H) })
    expect(pollView(db, ahead, T0 + 2 * H)).toMatchObject({ open: false, closedAt: iso(T0 + H + 20_000) })
    expect(pollView(db, b, T0 + H)!.open).toBe(true)
    const closed = pollView(db, a, T0 + H)!
    expect(openPost(db, community, closed.resultsPostId!, T0 + H)).toMatchObject({ title: '[투표 결과] 누가 이김?', boardId: 'main', author: { id: fans[5]!.id } })
    // Round 1 again closes nothing more (and counts nothing).
    expect(closeRoundPolls(db, season, 1, T0 + 2 * H, true)).toBe(0)
    // A later round finishing first closes it too.
    expect(closeRoundPolls(db, season, 3, T0 + 3 * H, true)).toBe(1)
    expect(pollView(db, b, T0 + 3 * H)!.open).toBe(false)
  })

  it('holds an article’s poll stamped a little ahead at its own start, never before it shows', () => {
    const { db, community, fans } = league()
    startSeason(db)
    const ahead = addPost(db, community, { board: 'main', author: fans[5]!.id, title: '기사 투표', body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'thread' }, T0 + 20_000, 0)
    const pollId = pollView(db, ahead, T0 + 20_000)!.id
    savePlannedVotes(db, pollId, [{ voterId: fans[0]!.id, option: 0, shownAtMs: T0 + H }])
    play(db, 1)
    // The community is off: held, as of the poll's own start.
    expect(closeRoundPolls(db, currentSeason(db).id, 1, T0, false)).toBe(0)
    expect(pollView(db, ahead, T0 + 30_000)).toMatchObject({ open: false, closedAt: null, closesAt: iso(T0 + 20_000), total: 1 })
    const first = (db.prepare('SELECT MIN(shown_at) AS at FROM poll_votes WHERE poll_id = ?').get(pollId) as { at: string }).at
    expect(first).toBe(iso(T0 + 20_000))
  })

  it("keeps fans' votes still on their way when the round ends: they count at the close", () => {
    const { db, community, fans } = league()
    startSeason(db)
    const id = addPost(db, community, { board: 'main', author: fans[5]!.id, title: '누가 이김?', body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'thread' }, T0, 0)
    const pollId = pollView(db, id, T0)!.id
    savePlannedVotes(db, pollId, [
      { voterId: fans[0]!.id, option: 0, shownAtMs: T0 + H },
      { voterId: fans[1]!.id, option: 1, shownAtMs: T0 + 5 * H },
      { voterId: fans[2]!.id, option: 1, shownAtMs: T0 + 9 * H },
    ])
    expect(closeRoundPolls(db, currentSeason(db).id, 1, T0 + 2 * H, true)).toBe(1)
    const view = pollView(db, id, T0 + 2 * H)!
    expect(view).toMatchObject({ open: false, closedAt: iso(T0 + 2 * H), total: 3, pending: 0 })
    expect(view.options.map((o) => o.votes)).toEqual([1, 2])
    expect(openPost(db, community, view.resultsPostId!, T0 + 2 * H).body).toContain('1위: 나람고')
    expect(db.prepare('SELECT MAX(shown_at) AS at FROM poll_votes WHERE poll_id = ?').get(pollId)).toEqual({ at: iso(T0 + 2 * H) })
  })

  it('plans a poll closed before anyone looked only up to its close', () => {
    const { db, community, fans } = league()
    startSeason(db)
    const id = addPost(db, community, { board: 'main', author: fans[5]!.id, title: '누가 이김?', body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'thread' }, T0, 0)
    closeRoundPolls(db, currentSeason(db).id, 1, T0 + 2 * H, true)
    // Its votes must land by the time it closed, not by a closing time it never had.
    expect(unplannedPolls(db)).toMatchObject([{ createdAt: iso(T0), closesAt: iso(T0 + 2 * H) }])
    const pollId = pollView(db, id, T0)!.id
    savePlannedVotes(db, pollId, [
      { voterId: fans[0]!.id, option: 0, shownAtMs: T0 + H },
      { voterId: fans[1]!.id, option: 1, shownAtMs: T0 + 3 * H },
    ])
    expect(pollView(db, id, T0 + 10 * H)).toMatchObject({ total: 1, pending: 0 })
  })

  it('closes nothing while the community is off, and closes (with results) once it is on again', () => {
    const { db, community, fans } = league()
    const timed = writeUserPost(db, community, { boardId: 'free', title: '오프시즌 투표', body: '', poll: { question: '', options: ['가', '나'] } }, T0)
    startSeason(db)
    const round = addPost(db, community, { board: 'main', author: fans[5]!.id, title: '라운드 투표', body: '', comments: [], poll: { options: ['가', '나'] } }, { kind: 'thread' }, T0, 0)
    const roundPoll = pollView(db, round, T0)!.id
    savePlannedVotes(db, roundPoll, [{ voterId: fans[0]!.id, option: 0, shownAtMs: T0 + 5 * H }])
    // Round 1 ends while it's off: the round poll stops taking votes (those on their way count now) but doesn't close.
    expect(closeRoundPolls(db, currentSeason(db).id, 1, T0 + 2 * H, false)).toBe(0)
    expect(pollView(db, round, T0 + 3 * H)).toMatchObject({ open: false, closedAt: null, resultsPostId: null, closesAt: iso(T0 + 2 * H), total: 1, pending: 0 })
    // Another round ending meanwhile doesn't move its time.
    expect(closeRoundPolls(db, currentSeason(db).id, 2, T0 + 4 * H, false)).toBe(0)
    expect(pollView(db, round, T0 + 4 * H)!.closesAt).toBe(iso(T0 + 2 * H))
    expect(() => votePoll(db, roundPoll, 1, T0 + 3 * H)).toThrow(/poll-closed/)
    // The timed poll's day passes while it's off: closed to votes, not closed.
    expect(closeDuePolls(db, T0 + 30 * H, false)).toBe(0)
    expect(pollView(db, timed, T0 + 30 * H)).toMatchObject({ open: false, closedAt: null, resultsPostId: null })
    expect(boardPage(db, community, 'free', 1, T0 + 30 * H).posts.find((p) => p.id === timed)!.pollState).toBe('closed')
    // On again: both close as of their time, with results posts that show now.
    expect(closeDuePolls(db, T0 + 40 * H, true)).toBe(2)
    const r = pollView(db, round, T0 + 40 * H)!
    const t = pollView(db, timed, T0 + 40 * H)!
    expect(r).toMatchObject({ open: false, closedAt: iso(T0 + 2 * H), total: 1 })
    expect(t).toMatchObject({ open: false, closedAt: iso(T0 + 24 * H) })
    for (const id of [r.resultsPostId, t.resultsPostId]) expect(openPost(db, community, id!, T0 + 40 * H).shownAt).toBe(iso(T0 + 40 * H))
  })

  it("posts a reporter's results plainly, as an article", () => {
    const { db, community, reporters } = league()
    const id = addPost(db, community, { board: 'main', author: reporters[0]!.id, title: '팬 투표', body: '', comments: [], poll: { options: ['가람고', '나람고'] } }, { kind: 'article' }, T0, 0)
    expect(closeDuePolls(db, T0 + 25 * H, true)).toBe(1)
    const results = openPost(db, community, pollView(db, id, T0 + 25 * H)!.resultsPostId!, T0 + 25 * H)
    expect(results).toMatchObject({ kind: 'article', author: { id: reporters[0]!.id } })
    expect(results.body).toContain('투표에 참여한 사람은 없었다.')
    expect(results.body).not.toContain('ㅋ')
  })

  it('writes results as text bars, with ties and empty polls', () => {
    expect(resultsBody('q', ['a', 'b'], [3, 1])).toContain('a\n███████████████░░░░░ 75% (3표)')
    expect(resultsBody('q', ['a', 'b'], [2, 2])).toContain('공동 1위: a, b')
    expect(resultsBody('q', ['a', 'b'], [0, 0])).toContain('아무도 투표 안 함')
    expect(resultsBody('q', ['a', 'b'], [0, 0], 'news')).toContain('투표에 참여한 사람은 없었다.')
    expect(resultsBody('q', ['a', 'b'], [1, 0], 'news')).toContain('「q」 투표가 마감됐다. 총 1표.')
  })
})
