import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { addPost, listPersonas, savePersonas } from '@data/community'
import { openDb } from '@data/db'
import { listPlayers, listTeams, loadConfig, seedLeague } from '@data/league'
import { pollView } from '@data/polls'
import { makeCast } from './personas'
import { fanVoteCount, isNegative, planFanVotes, planPolls, VOTE_SPREAD_MS, type OptionTarget, type PlannedVote, type PollVoter, type VotePlan } from './polls'

const T0 = Date.parse('2026-10-10T12:00:00.000Z')
const H = 3600_000

/** Four options, each naming one school's player (school tN, player pN). */
const targets: OptionTarget[] = [1, 2, 3, 4].map((n) => ({ teams: [`t${n}`], players: [{ id: `p${n}`, teamId: `t${n}` }] }))

const voters = (n: number, prefix: string, make: (i: number) => Omit<PollVoter, 'id'>): PollVoter[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(3, '0')}`, ...make(i) }))

const plan = (over: Partial<VotePlan>): VotePlan => ({
  seed: 's',
  question: '올시즌 MVP는?',
  targets,
  voters: [],
  count: 200,
  startMs: T0,
  spreadMs: VOTE_SPREAD_MS,
  ...over,
})

/** Share of these votes (by voters whose id starts with `prefix`) that went to `option`. */
const share = (votes: PlannedVote[], option: number, prefix = '') => {
  const mine = votes.filter((v) => v.voterId.startsWith(prefix))
  return mine.filter((v) => v.option === option).length / mine.length
}

describe('fan votes on polls', () => {
  it('are the same every time for the same poll, and arrive over hours, most early', () => {
    const fans = voters(150, 'f', (i) => ({ teamId: `t${(i % 4) + 1}`, archetype: 'analyst', favPlayerId: null }))
    const a = planFanVotes(plan({ voters: fans, count: 120 }))
    expect(planFanVotes(plan({ voters: fans, count: 120 }))).toEqual(a)
    expect(planFanVotes(plan({ voters: fans, count: 120, seed: 'other' }))).not.toEqual(a)
    expect(a).toHaveLength(120)
    expect(new Set(a.map((v) => v.voterId)).size).toBe(120)
    expect(a.every((v, i) => v.shownAtMs >= T0 && v.shownAtMs <= T0 + VOTE_SPREAD_MS && (i === 0 || v.shownAtMs >= a[i - 1]!.shownAtMs))).toBe(true)
    expect(a[60]!.shownAtMs - T0).toBeLessThan(VOTE_SPREAD_MS / 2)
  })

  it("pull fans to their school's option, and their favourite player harder", () => {
    const loyal = voters(200, 'f', () => ({ teamId: 't1', archetype: 'analyst', favPlayerId: null }))
    expect(share(planFanVotes(plan({ voters: loyal })), 0)).toBeGreaterThan(0.45)
    // Fans of the first school whose favourite plays for the second.
    const stans = voters(200, 'f', () => ({ teamId: 't1', archetype: 'stan', favPlayerId: 'p2' }))
    const votes = planFanVotes(plan({ voters: stans }))
    expect(share(votes, 1)).toBeGreaterThan(share(votes, 0))
    expect(share(votes, 0)).toBeGreaterThan(share(votes, 2))
  })

  it('turn around on a put-down question: fans steer away from their own', () => {
    expect(isNegative('제일 과대평가된 선수는?')).toBe(true)
    expect(isNegative('올시즌 MVP는?')).toBe(false)
    const loyal = voters(200, 'f', () => ({ teamId: 't1', archetype: 'local', favPlayerId: null }))
    expect(share(planFanVotes(plan({ voters: loyal, question: '제일 과대평가된 선수는?' })), 0)).toBeLessThan(0.15)
  })

  it('keep fans behind their own on questions that only sound sad', () => {
    for (const q of ['제일 아쉬운 탈락 팀은?', '하락세 끊을 학교는?', '부진 탈출할 선수는?']) expect(isNegative(q)).toBe(false)
    for (const q of ['올시즌 최악의 트레이드는?', '거품 낀 선수는?', '먹튀 1순위는?', '제일 실망스러운 학교는?']) expect(isNegative(q)).toBe(true)
    // A put-down word turned into praise ("not", "despite") or a situation.
    for (const q of ['못하는 게 없는 선수는?', '실망시키지 않을 학교는?', '최악의 상황에서 믿을 선수는?', '거품 없는 진짜 에이스는?', '방출 위기에서 살아날 선수는?', '욕먹어도 응원하는 학교는?'])
      expect(isNegative(q)).toBe(false)
    // Praise in one place doesn't hide a put-down in another.
    expect(isNegative('거품 없는 척하는 최악의 먹튀는?')).toBe(true)
    const loyal = voters(200, 'f', () => ({ teamId: 't1', archetype: 'local', favPlayerId: null }))
    expect(share(planFanVotes(plan({ voters: loyal, question: '제일 아쉬운 탈락 팀은?' })), 0)).toBeGreaterThan(0.45)
  })

  it("have antis and trolls vote against the crowd's pick", () => {
    const crowd = [
      ...voters(120, 'f', () => ({ teamId: 't1', archetype: 'local', favPlayerId: null })),
      ...voters(40, 'a', (i) => ({ teamId: null, archetype: i % 2 ? 'anti' : 'troll', favPlayerId: null })),
      ...voters(40, 'n', () => ({ teamId: null, archetype: 'analyst', favPlayerId: null })),
    ]
    const votes = planFanVotes(plan({ voters: crowd }))
    expect(share(votes, 0, 'f')).toBeGreaterThan(0.5)
    expect(share(votes, 0, 'a')).toBeLessThan(0.12)
    // Neutral fans who aren't contrarian spread evenly.
    expect(share(votes, 0, 'n')).toBeGreaterThan(0.12)
  })

  it('come from more fans on hotter posts, never more than there are', () => {
    expect(fanVoteCount(200, 1, 'x')).toBeLessThan(fanVoteCount(200, 3, 'x'))
    expect(fanVoteCount(200, 3, 'x')).toBeLessThan(fanVoteCount(200, 5, 'x'))
    expect(fanVoteCount(200, 5, 'x')).toBeLessThanOrEqual(200 * 0.53 * 1.15 + 1)
    expect(fanVoteCount(2, 5, 'x')).toBe(2)
    expect(fanVoteCount(0, 5, 'x')).toBe(0)
    expect(planFanVotes(plan({ voters: [], count: 10 }))).toEqual([])
    expect(planFanVotes(plan({ voters: voters(5, 'f', () => ({ teamId: null, archetype: 'analyst', favPlayerId: null })), targets: targets.slice(0, 1) }))).toEqual([])
  })

  it('are planned once per poll, matching options to the schools and players they name', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    const teams = listTeams(db)
    const players = listPlayers(db)
    savePersonas(db, makeCast({ seed: 'polls', fans: 300, reporters: 1, maxSpice: 5, teams: teams.map((t) => ({ id: t.id, shortName: t.shortName, fanSize: 3 })), players }), '테스터')
    const { community } = loadConfig(db).config
    const star = (teamId: string) => players.find((p) => p.teamId === teamId)!
    const options = teams.slice(0, 4).map((t) => `${star(t.id).name}(${t.shortName})`)
    const author = listPersonas(db).find((p) => p.kind === 'fan')!.id
    const id = addPost(db, community, { board: 'main', author, title: '올시즌 MVP는?', body: '', heat: 5, comments: [], poll: { options } }, { kind: 'thread' }, T0, 0)
    expect(planPolls(db)).toBe(1)
    expect(planPolls(db)).toBe(0)
    const early = pollView(db, id, T0 + 10 * 60_000)!
    const late = pollView(db, id, T0 + 24 * H)!
    // Outside the regular season the poll closes in a day: every vote arrives before that.
    expect(late.pending).toBe(0)
    expect(early.total).toBeLessThan(late.total)
    expect(late.total).toBe(fanVoteCount(300, 5, String(late.id)))
    // The first school's fans mostly back its own player.
    const byFans = db
      .prepare('SELECT v.option, COUNT(*) AS n FROM poll_votes v JOIN personas a ON a.id = v.voter_id WHERE a.team_id = ? GROUP BY v.option ORDER BY n DESC')
      .all(teams[0]!.id) as { option: number; n: number }[]
    expect(byFans[0]!.option).toBe(0)
    // Demo mode plays them 30 times faster.
    const fast = addPost(db, community, { board: 'main', author, title: '빠른 투표', body: '', heat: 3, comments: [], poll: { options } }, { kind: 'thread' }, T0, 0)
    planPolls(db, { fast: true })
    expect(pollView(db, fast, T0 + H)!.pending).toBe(0)
  })
})
