import { hash32 } from '@core/random'
import type { PollInput, PollView } from '@shared/community'
import { cleanOptions, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from '@shared/polls'
import { transaction, type Db } from './db'
import { currentSeason } from './league'
import { openSession, playedSeason } from './played'
import { refuse } from './rules'
import { regularSeasonTotal, roundComplete } from './schedule'

/**
 * Polls on the boards. A post can carry one: a question and 2–6 options.
 * Fans' votes are planned by code (story/polls.ts) and each counts from its
 * own shown_at, so the numbers grow while you look; your vote counts at once
 * and can change while the poll is open. A poll closes when the regular-season
 * round it waits for is complete, or a day after it opened when no round is
 * ahead (playoffs, the offseason); a short [투표 결과] post by code then
 * reports the shares.
 */

/** Your persona id (community.ts' ME; this file can't import it, community.ts imports this one). */
const YOU = 'me'
/** How long a poll stays open when no regular-season round is ahead. */
export const POLL_OPEN_HOURS = 24

const iso = (ms: number) => new Date(ms).toISOString()
const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

/** A poll ready to store: its question and cleaned options. */
export interface PollDraft {
  question: string
  options: string[]
}

const cleanQuestion = (question: string | null | undefined, title: string) => clamp((question ?? '').replace(/\s+/g, ' ').trim() || title.trim(), 80)

/** A writer's poll, leniently: options cleaned and cut to six; fewer than two means no poll. */
export function writerPoll(poll: { question?: string | null; options: string[] } | null | undefined, title: string): PollDraft | null {
  if (!poll || !Array.isArray(poll.options)) return null
  const options = cleanOptions(poll.options.filter((o): o is string => typeof o === 'string')).slice(0, POLL_MAX_OPTIONS)
  return options.length >= POLL_MIN_OPTIONS ? { question: cleanQuestion(poll.question, title), options } : null
}

/** Your poll, strictly: refused unless it has 2–6 different options. A blank question takes the title. */
export function userPoll(poll: PollInput, title: string): PollDraft {
  const options = cleanOptions(poll.options)
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) refuse('poll-options', { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS })
  return { question: cleanQuestion(poll.question, title), options }
}

/** The first regular-season round of this season that isn't complete yet (in 2K 일정대로, the open session). */
function nextRound(db: Db, seasonId: number): number {
  if (playedSeason(db, seasonId)) return openSession(db, seasonId)
  const last = (db.prepare("SELECT COALESCE(MAX(round), 0) AS r FROM games WHERE season_id = ? AND stage = 'regular'").get(seasonId) as { r: number }).r
  for (let r = 1; r <= last; r++) if (!roundComplete(db, seasonId, r)) return r
  return last + 1
}

/**
 * When a poll opened now closes: with regular-season games still to play,
 * when the first round not complete yet is (the one being played, or the next
 * one between rounds); otherwise in a day.
 */
function closingRule(db: Db, nowMs: number): { seasonId: number; afterRound: number | null; closesAt: string | null } {
  const season = currentSeason(db)
  if (season.phase === 'regular') {
    const played = (db.prepare("SELECT COUNT(*) AS n FROM games WHERE season_id = ? AND stage = 'regular' AND status = 'final'").get(season.id) as { n: number }).n
    if (played < regularSeasonTotal(db)) return { seasonId: season.id, afterRound: nextRound(db, season.id), closesAt: null }
  }
  return { seasonId: season.id, afterRound: null, closesAt: iso(nowMs + POLL_OPEN_HOURS * 3600_000) }
}

/** Puts a poll on a post (one per post). Its fans' votes are planned later, by story/polls.ts. */
export function createPoll(db: Db, postId: number, draft: PollDraft, nowMs: number): number {
  const rule = closingRule(db, nowMs)
  return Number(
    db
      .prepare(
        `INSERT INTO polls (post_id, question, options, season_id, closes_after_round, closes_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(postId, draft.question, JSON.stringify(draft.options), rule.seasonId, rule.afterRound, rule.closesAt, iso(nowMs)).lastInsertRowid,
  )
}

interface PollRow {
  id: number
  post_id: number
  question: string
  options: string
  season_id: number | null
  closes_after_round: number | null
  closes_at: string | null
  planned: number
  created_at: string
  closed_at: string | null
  results_post_id: number | null
}

const isOpen = (row: PollRow, nowMs: number) => row.closed_at === null && !(row.closes_at !== null && row.closes_at <= iso(nowMs))

/** Votes per option among those shown by `atIso` (all of them for a closed poll). */
function counts(db: Db, row: PollRow, atIso: string): number[] {
  const options = JSON.parse(row.options) as string[]
  const out = options.map(() => 0)
  const rows = db.prepare('SELECT option, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? AND shown_at <= ? GROUP BY option').all(row.id, atIso) as { option: number; n: number }[]
  for (const r of rows) if (r.option >= 0 && r.option < out.length) out[r.option] = r.n
  return out
}

function viewOf(db: Db, row: PollRow, nowMs: number): PollView {
  const now = iso(nowMs)
  const options = JSON.parse(row.options) as string[]
  const votes = counts(db, row, now)
  const total = votes.reduce((a, b) => a + b, 0)
  const mine = db.prepare('SELECT option FROM poll_votes WHERE poll_id = ? AND voter_id = ?').get(row.id, YOU) as { option: number } | undefined
  const pending = (db.prepare('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ? AND shown_at > ?').get(row.id, now) as { n: number }).n
  return {
    id: row.id,
    question: row.question,
    options: options.map((text, i) => ({ text, votes: votes[i]!, share: total ? votes[i]! / total : 0 })),
    total,
    myVote: mine?.option ?? null,
    open: isOpen(row, nowMs),
    closesAfterRound: row.closes_after_round,
    closesAt: row.closes_at,
    closedAt: row.closed_at,
    resultsPostId: row.results_post_id,
    pending,
  }
}

/** The poll on a post, counting only the votes shown by now; null when the post has none. */
export function pollView(db: Db, postId: number, nowMs: number): PollView | null {
  const row = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(postId) as PollRow | undefined
  return row ? viewOf(db, row, nowMs) : null
}

/** The post whose poll this [투표 결과] post reports, or null. */
export function resultsOf(db: Db, postId: number): number | null {
  return (db.prepare('SELECT post_id FROM polls WHERE results_post_id = ?').get(postId) as { post_id: number } | undefined)?.post_id ?? null
}

/** Your vote: one per poll, changeable while it's open. */
export function votePoll(db: Db, pollId: number, option: number, nowMs: number): PollView {
  return transaction(db, () => {
    const row = db.prepare('SELECT q.* FROM polls q JOIN posts p ON p.id = q.post_id WHERE q.id = ? AND p.shown_at <= ?').get(pollId, iso(nowMs)) as PollRow | undefined
    if (!row) refuse('unknown-poll', { poll: pollId })
    if (!isOpen(row, nowMs)) refuse('poll-closed', { poll: pollId })
    const options = JSON.parse(row.options) as string[]
    if (!Number.isInteger(option) || option < 0 || option >= options.length) refuse('poll-bad-option', { option })
    db.prepare(
      `INSERT INTO poll_votes (poll_id, voter_id, option, shown_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (poll_id, voter_id) DO UPDATE SET option = excluded.option`,
    ).run(pollId, YOU, option, iso(nowMs))
    return viewOf(db, row, nowMs)
  })
}

// ── Fans' votes ──────────────────────────────────────────────────────────

export interface UnplannedPoll {
  id: number
  question: string
  options: string[]
  /** The post's heat (1–5), and whether it's yours. */
  heat: number
  mine: boolean
  createdAt: string
  /** The latest a fan's vote may arrive: the poll's closing time, when it has one. */
  closesAt: string | null
}

/** Polls whose fans' votes haven't been planned yet. */
export function unplannedPolls(db: Db): UnplannedPoll[] {
  const rows = db
    .prepare('SELECT q.*, p.heat, p.author_id FROM polls q JOIN posts p ON p.id = q.post_id WHERE q.planned = 0 ORDER BY q.id')
    .all() as unknown as (PollRow & { heat: number; author_id: string })[]
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    heat: r.heat,
    mine: r.author_id === YOU,
    createdAt: r.created_at,
    closesAt: r.closed_at ?? r.closes_at,
  }))
}

/** Stores a poll's planned fan votes, once (a second call does nothing). A closed poll keeps only votes from before it closed. */
export function savePlannedVotes(db: Db, pollId: number, votes: { voterId: string; option: number; shownAtMs: number }[]): void {
  transaction(db, () => {
    if (db.prepare('UPDATE polls SET planned = 1 WHERE id = ? AND planned = 0').run(pollId).changes === 0) return
    const closed = (db.prepare('SELECT closed_at FROM polls WHERE id = ?').get(pollId) as { closed_at: string | null }).closed_at
    const insert = db.prepare('INSERT OR IGNORE INTO poll_votes (poll_id, voter_id, option, shown_at) VALUES (?, ?, ?, ?)')
    for (const v of votes) {
      if (v.voterId === YOU) continue
      const at = iso(v.shownAtMs)
      if (closed === null || at <= closed) insert.run(pollId, v.voterId, v.option, at)
    }
  })
}

// ── Closing ──────────────────────────────────────────────────────────────

/** A regular who posts results for your polls: one of the senior neutral fans (else any fan, else anyone but you). */
function regular(db: Db, salt: string): string | null {
  const pools = [
    "SELECT id FROM personas WHERE kind = 'fan' AND team_id IS NULL ORDER BY level DESC, id LIMIT 3",
    "SELECT id FROM personas WHERE kind = 'fan' ORDER BY level DESC, id LIMIT 3",
    "SELECT id FROM personas WHERE kind <> 'user' ORDER BY id LIMIT 3",
  ]
  for (const sql of pools) {
    const ids = db.prepare(sql).all() as { id: string }[]
    if (ids.length) return ids[hash32(salt) % ids.length]!.id
  }
  return null
}

/**
 * The [투표 결과] body: each option's share as a text bar, then the winner.
 * A fan posts it in a fan's voice; a reporter (`news`) states it plainly.
 */
export function resultsBody(question: string, options: readonly string[], votes: readonly number[], voice: 'fan' | 'news' = 'fan'): string {
  const total = votes.reduce((a, b) => a + b, 0)
  const lines = [voice === 'news' ? `「${question}」 투표가 마감됐다. 총 ${total}표.` : `「${question}」 투표 마감. 총 ${total}표`, '']
  options.forEach((text, i) => {
    const share = total ? votes[i]! / total : 0
    const filled = Math.round(share * 20)
    lines.push(`${i + 1}. ${text}`, `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${Math.round(share * 100)}% (${votes[i]}표)`, '')
  })
  const top = Math.max(...votes)
  const winners = options.filter((_, i) => votes[i] === top)
  const nobody = voice === 'news' ? '투표에 참여한 사람은 없었다.' : '아무도 투표 안 함 ㅋㅋ'
  lines.push(total === 0 ? nobody : winners.length > 1 ? `공동 1위: ${winners.join(', ')}` : `1위: ${winners[0]}`)
  return lines.join('\n')
}

/**
 * Writes the results post on the poll's board, by its author (your poll's
 * results come from a neutral regular), with the count as of the close
 * (`atMs`). It shows now, or at the close if that's later: a poll that closed
 * while the app was shut gets its results among today's posts, not under them.
 */
function writeResults(db: Db, row: PollRow, atMs: number, nowMs: number): number | null {
  const post = db.prepare('SELECT board_id, author_id FROM posts WHERE id = ?').get(row.post_id) as { board_id: string; author_id: string }
  const persona = post.author_id !== YOU && db.prepare("SELECT 1 FROM personas WHERE id = ? AND kind <> 'user'").get(post.author_id)
  const author = persona ? post.author_id : regular(db, `poll:${row.id}`)
  if (!author) return null
  const reporter = (db.prepare('SELECT kind FROM personas WHERE id = ?').get(author) as { kind: string }).kind === 'reporter'
  const body = resultsBody(row.question, JSON.parse(row.options) as string[], counts(db, row, iso(atMs)), reporter ? 'news' : 'fan')
  const shown = iso(Math.max(atMs, nowMs))
  return Number(
    db
      .prepare(
        `INSERT INTO posts (board_id, author_id, kind, title, body, heat, shown_at, last_activity)
         VALUES (?, ?, ?, ?, ?, 2, ?, ?)`,
      )
      .run(post.board_id, author, reporter ? 'article' : 'thread', clamp(`[투표 결과] ${row.question}`, 120), body, shown, shown).lastInsertRowid,
  )
}

/**
 * Closes a poll as of `atMs` and puts up its results post. Fans' votes still
 * on their way count as cast at the close, so a poll whose round ends while
 * they trickle in keeps its crowd. (A timed poll's votes are all planned
 * inside its day, so nothing arrives late there.) False when it was closed
 * already.
 */
function close(db: Db, row: PollRow, atMs: number, nowMs: number): boolean {
  return transaction(db, () => {
    const at = iso(atMs)
    if (db.prepare('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(at, row.id).changes === 0) return false
    db.prepare('UPDATE poll_votes SET shown_at = ? WHERE poll_id = ? AND shown_at > ?').run(at, row.id, at)
    const results = writeResults(db, row, atMs, nowMs)
    if (results !== null) db.prepare('UPDATE polls SET results_post_id = ? WHERE id = ?').run(results, row.id)
    return true
  })
}

/**
 * While the community is off nothing closes (its results post couldn't go
 * up): a poll whose round is done just stops taking votes, its closing time
 * set to now, and closes as of then once the community is on again. Its
 * fans' votes still on their way count now, as at a close, so the count it
 * shows meanwhile is already the final one.
 */
function hold(db: Db, row: PollRow, nowMs: number): void {
  const at = iso(notBefore(row, nowMs))
  transaction(db, () => {
    if (db.prepare('UPDATE polls SET closes_at = ? WHERE id = ? AND closed_at IS NULL AND closes_at IS NULL').run(at, row.id).changes === 0) return
    db.prepare('UPDATE poll_votes SET shown_at = ? WHERE poll_id = ? AND shown_at > ?').run(at, row.id, at)
  })
}

/** Now, or the poll's own start if that's later (an article's poll can be stamped a few seconds ahead). */
const notBefore = (row: PollRow, nowMs: number) => Math.max(nowMs, Date.parse(row.created_at))

/** One poll that can't be closed (or held) is logged and left for the next look; the others still go. */
function each(rows: PollRow[], what: (row: PollRow) => boolean): number {
  let n = 0
  for (const row of rows) {
    try {
      if (what(row)) n++
    } catch (e) {
      console.warn(`[polls] could not close poll ${row.id}`, e)
    }
  }
  return n
}

/**
 * Closes polls whose time is up (at their closing time), and polls waiting
 * for a round in a season that has no regular-season round ahead any more
 * (now). With the community off nothing closes: polls whose time is up wait,
 * and the round polls are held. Returns how many closed.
 */
export function closeDuePolls(db: Db, nowMs: number, communityOn: boolean): number {
  const season = currentSeason(db)
  const rows = db.prepare('SELECT * FROM polls WHERE closed_at IS NULL ORDER BY id').all() as unknown as PollRow[]
  return each(rows, (row) => {
    if (row.closes_at !== null && row.closes_at <= iso(nowMs)) return communityOn && close(db, row, Date.parse(row.closes_at), nowMs)
    if (row.closes_after_round !== null && (row.season_id !== season.id || season.phase !== 'regular')) {
      if (communityOn) return close(db, row, notBefore(row, nowMs), nowMs)
      hold(db, row, nowMs)
    }
    return false
  })
}

/**
 * A regular-season round of this season was completed: polls waiting for it
 * (or for an earlier round: rounds can finish out of order) close. A poll
 * waits for the first round that wasn't complete when it opened, so one
 * opened after this round was complete keeps waiting. With the community off
 * they're held instead. Returns how many closed.
 */
export function closeRoundPolls(db: Db, seasonId: number, round: number, nowMs: number, communityOn: boolean): number {
  const rows = db
    .prepare('SELECT * FROM polls WHERE closed_at IS NULL AND closes_after_round IS NOT NULL AND season_id = ? AND closes_after_round <= ? ORDER BY id')
    .all(seasonId, round) as unknown as PollRow[]
  return each(rows, (row) => {
    if (!communityOn) {
      hold(db, row, nowMs)
      return false
    }
    // Held while the community was off: it closed back then.
    const at = row.closes_at !== null ? Math.min(Date.parse(row.closes_at), nowMs) : notBefore(row, nowMs)
    return close(db, row, at, nowMs)
  })
}
