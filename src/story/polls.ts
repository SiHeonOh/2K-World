import { rng } from '@core/random'
import { listPersonas } from '@data/community'
import type { Db } from '@data/db'
import { listPlayers, listTeams } from '@data/league'
import { savePlannedVotes, unplannedPolls } from '@data/polls'
import { mentions, type League } from './context'

/**
 * How the fans vote on a poll, worked out by code (no AI). How many vote
 * grows with the community and the post's heat; each voter leans by who
 * they are: an option naming their school (or one of its players) pulls
 * them, their favourite player pulls harder, a put-down question
 * (과대평가, 거품, 먹튀…) turns that around, and antis and trolls vote against
 * the crowd's pick. Some noise on top. Seeded, so the same poll always gets
 * the same votes, and the votes arrive over hours like comments.
 */

/**
 * Words that make a question a put-down: fans then steer away from their own
 * school and favourite. Only clear ones: "제일 아쉬운 탈락 팀은?" or "부진 끝낼
 * 선수는?" is a question fans answer with their own.
 */
export const NEGATIVE_WORDS = ['과대평가', '거품', '실망', '최악', '먹튀', '비호감', '노잼', '폭망', '흑역사', '역적', '못하는', '방출', '꼴불견', '빌런', '밉상', '욕먹']

/** Right after the word: a "not" or a "despite" makes it praise ("거품 없는", "실망시키지 않을", "욕먹어도"), "에서" a situation ("최악의 상황에서"). */
const PRAISE_AFTER = /^.{0,6}?(?:없|않|안 |어도|아도|해도|에서)/

export const isNegative = (question: string) =>
  NEGATIVE_WORDS.some((w) => {
    for (let i = question.indexOf(w); i >= 0; i = question.indexOf(w, i + 1)) {
      if (!PRAISE_AFTER.test(question.slice(i + w.length))) return true
    }
    return false
  })

/** How long fans' votes take to come in (front-loaded: most in the first hours). */
export const VOTE_SPREAD_MS = 10 * 3600_000

export interface PollVoter {
  id: string
  teamId: string | null
  archetype: string
  favPlayerId: string | null
}

/** What an option names: schools, and players with their school. */
export interface OptionTarget {
  teams: string[]
  players: { id: string; teamId: string }[]
}

export interface VotePlan {
  seed: string
  question: string
  /** One per option, in order. */
  targets: OptionTarget[]
  /** Everyone who might vote (the fans), in a fixed order. */
  voters: PollVoter[]
  count: number
  startMs: number
  spreadMs: number
}

export interface PlannedVote {
  voterId: string
  option: number
  shownAtMs: number
}

/** How strongly a voter is tied to an option: their school in it, their favourite player in it. */
function tie(v: PollVoter, t: OptionTarget): number {
  let pull = 0
  if (v.teamId && (t.teams.includes(v.teamId) || t.players.some((p) => p.teamId === v.teamId))) pull += v.archetype === 'local' ? 5 : 3
  if (v.favPlayerId && t.players.some((p) => p.id === v.favPlayerId)) pull += 6
  return pull
}

const contrarian = (v: PollVoter) => v.archetype === 'anti' || v.archetype === 'troll'

/**
 * How many fans vote: a share of the fans that grows with the post's heat
 * (about 17% at heat 1, 53% at heat 5), give or take 15%.
 */
export function fanVoteCount(fans: number, heat: number, seed: string): number {
  if (fans <= 0) return 0
  const h = Math.min(5, Math.max(1, heat))
  const wobble = 0.85 + 0.3 * rng(`poll-count:${seed}`)()
  return Math.min(fans, Math.max(Math.min(fans, 3), Math.round(fans * (0.08 + 0.09 * h) * wobble)))
}

/** Each chosen fan's vote and when it shows. */
export function planFanVotes(plan: VotePlan): PlannedVote[] {
  const n = plan.targets.length
  if (n < 2 || plan.count <= 0 || plan.voters.length === 0) return []
  const random = rng(`poll:${plan.seed}`)
  const negative = isNegative(plan.question)
  const leaning = (v: PollVoter) =>
    plan.targets.map((t) => {
      const pull = tie(v, t)
      return negative ? 1 / (1 + pull) : 1 + pull
    })
  // Fans with a stake in an option are likelier to vote at all.
  const voters = plan.voters
    .map((v) => ({ v, key: random() * (plan.targets.some((t) => tie(v, t) > 0) ? 0.5 : 1) }))
    .sort((a, b) => a.key - b.key)
    .slice(0, plan.count)
    .map((x) => x.v)
  // The crowd's pick, which antis and trolls vote against: only when it clearly leads.
  const crowd = plan.targets.map(() => 0)
  for (const v of voters) {
    if (contrarian(v)) continue
    const w = leaning(v)
    const sum = w.reduce((a, b) => a + b, 0)
    w.forEach((x, i) => (crowd[i]! += x / sum))
  }
  const top = Math.max(...crowd)
  const total = crowd.reduce((a, b) => a + b, 0)
  const popular = total > 0 && top > (total / n) * 1.15 ? crowd.indexOf(top) : null
  return voters
    .map((v): PlannedVote => {
      let option: number
      if (random() < 0.08) {
        // Some just click anything.
        option = Math.floor(random() * n)
      } else {
        const w = leaning(v).map((x, i) => (contrarian(v) && i === popular ? x * 0.15 : x) * (0.5 + random()))
        let roll = random() * w.reduce((a, b) => a + b, 0)
        option = w.findIndex((x) => (roll -= x) < 0)
        if (option < 0) option = n - 1
      }
      return { voterId: v.id, option, shownAtMs: plan.startMs + Math.round(plan.spreadMs * random() ** 2) }
    })
    .sort((a, b) => a.shownAtMs - b.shownAtMs)
}

/**
 * Plans the fans' votes for every poll that has none yet. Options are
 * matched to schools and players with `mentions`. A poll's votes all arrive
 * before it closes by time; `fast` (demo mode) plays them 30 times faster,
 * like comments. Returns how many polls were planned.
 */
export function planPolls(db: Db, opts: { fast?: boolean } = {}): number {
  const polls = unplannedPolls(db)
  if (polls.length === 0) return 0
  const fans = listPersonas(db).filter((p) => p.kind === 'fan')
  const names: Pick<League, 'teams' | 'players'> = {
    teams: new Map(listTeams(db).map((t) => [t.id, { id: t.id, shortName: t.shortName, name: t.name }])),
    players: new Map(listPlayers(db).map((p) => [p.id, { id: p.id, name: p.name, teamId: p.teamId, firstTeamId: p.teamId }])),
  }
  for (const poll of polls) {
    const targets = poll.options.map((text): OptionTarget => {
      const m = mentions(names, text)
      return { teams: m.teams, players: m.players.map((id) => ({ id, teamId: names.players.get(id)!.teamId })) }
    })
    const start = Date.parse(poll.createdAt)
    const window = poll.closesAt === null ? Infinity : Math.max(0, Date.parse(poll.closesAt) - start)
    const spread = Math.min(VOTE_SPREAD_MS, window * 0.8) / (opts.fast ? 30 : 1)
    const votes = planFanVotes({
      seed: `${poll.id}:${poll.question}`,
      question: poll.question,
      targets,
      voters: fans,
      // Your own polls draw a bit more of a crowd.
      count: fanVoteCount(fans.length, poll.mine ? 4 : poll.heat, String(poll.id)),
      startMs: start,
      spreadMs: spread,
    })
    savePlannedVotes(db, poll.id, votes)
  }
  return polls.length
}
