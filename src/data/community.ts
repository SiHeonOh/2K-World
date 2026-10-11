import { hash32 } from '@core/random'
import type { CommunityConfig } from '@shared/config/schema'
import type { EventType } from '@shared/events'
import type { AuthorView, BoardPage, CommentView, PollInput, PostKind, PostSummary, PostView } from '@shared/community'
import { untag } from '@shared/numbers'
import type { PersonaSeed } from '@story/personas'
import { jsonField, transaction, type Db } from './db'
import { createPoll, pollView, resultsOf, userPoll, writerPoll } from './polls'
import { flagNumbers, flagsFor, flagsOf } from './flags'
import { refuse } from './rules'

/**
 * The community's posts, comments and personas. Writers' output lands here
 * (checked), refresh reveals buffered items and moves views and votes, and
 * your own posts and votes are stored like anyone else's.
 */

/** Your own persona. */
export const ME = 'me'
export const PAGE_SIZE = 20

export interface PersonaRow {
  id: string
  kind: 'fan' | 'reporter' | 'user'
  nick: string
  teamId: string | null
  archetype: string
  spice: number
  quirks: string[]
  favPlayerId: string | null
  outlet: string | null
  level: number
  rumor: boolean
}

interface PersonaDbRow {
  id: string
  kind: 'fan' | 'reporter' | 'user'
  nick: string
  team_id: string | null
  archetype: string
  spice: number
  quirks: string
  fav_player_id: string | null
  outlet: string | null
  level: number
  rumor: number
}

const toPersona = (r: PersonaDbRow): PersonaRow => ({
  id: r.id,
  kind: r.kind,
  nick: r.nick,
  teamId: r.team_id,
  archetype: r.archetype,
  spice: r.spice,
  quirks: JSON.parse(r.quirks) as string[],
  favPlayerId: r.fav_player_id,
  outlet: r.outlet,
  level: r.level,
  rumor: r.rumor === 1,
})

export function listPersonas(db: Db): PersonaRow[] {
  return (db.prepare('SELECT * FROM personas ORDER BY id').all() as unknown as PersonaDbRow[]).map(toPersona)
}

export function personaCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM personas WHERE kind <> 'user'").get() as { n: number }).n
}

/** Stores the cast once (and you, as 'me'); later calls leave an existing cast alone. */
export function savePersonas(db: Db, cast: PersonaSeed[], myNick: string): void {
  transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM personas WHERE id = ?').get(ME)) {
      db.prepare(
        "INSERT INTO personas (id, kind, nick, archetype, spice, level) VALUES (?, 'user', ?, 'user', 1, 1)",
      ).run(ME, myNick.trim() || '나')
    }
    if (personaCount(db) > 0) return
    const insert = db.prepare(
      `INSERT INTO personas (id, kind, nick, team_id, archetype, spice, quirks, fav_player_id, outlet, level, rumor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const taken = new Set([myNick.trim() || '나', ...cast.map((p) => p.nick)])
    for (const p of cast) {
      // A nick can't collide with yours.
      let nick = p.nick
      if (nick === (myNick.trim() || '나')) {
        let n = 2
        while (taken.has(`${p.nick}${n}`)) n++
        nick = `${p.nick}${n}`
        taken.add(nick)
      }
      insert.run(p.id, p.kind, nick, p.teamId, p.archetype, p.spice, JSON.stringify(p.quirks), p.favPlayerId, p.outlet, p.level, p.rumor ? 1 : 0)
    }
  })
}

/** Your name on the boards; it can't be one a persona already uses. */
export function setMyNick(db: Db, nick: string): void {
  const name = nick.trim()
  if (!name) refuse('empty-post', {})
  if (db.prepare('SELECT 1 FROM personas WHERE nick = ? AND id <> ?').get(name, ME)) refuse('nick-taken', { nick: name })
  db.prepare('UPDATE personas SET nick = ? WHERE id = ?').run(name, ME)
}

// ── Generated content ────────────────────────────────────────────────────

export interface GenComment {
  author: string
  body: string
  /** Index of an earlier comment in the same list this one answers. */
  reply?: number | null
  /** Or the id of a comment already on the post. */
  replyToId?: number | null
  /** Numbers to mark for you: not in the facts the writer was given (see story/numbers.ts). */
  flags?: string[]
}

export interface GenPost {
  board: string
  author: string
  title: string
  body: string
  tag?: string | null
  /** 1-5: how much attention it draws. */
  heat?: number | null
  comments: GenComment[]
  /** A poll on the post (the title is the question when it has none); fewer than two usable options means none. */
  poll?: { question?: string | null; options: string[] } | null
  /** Numbers to mark for you in its title or body. */
  flags?: string[]
}

export interface PostLinks {
  kind: PostKind
  gameId?: number | null
  eventId?: number | null
  jobId?: number | null
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Writers must use the cast; anything else becomes a fan picked from the text, so output never fails on a typo. */
function authorFor(db: Db, wanted: string, salt: string): string {
  if (wanted !== ME && db.prepare("SELECT 1 FROM personas WHERE id = ? AND kind <> 'user'").get(wanted)) return wanted
  // Fans first; with no fans configured, reporters.
  let pool = db.prepare("SELECT id FROM personas WHERE kind = 'fan' ORDER BY id").all() as { id: string }[]
  if (pool.length === 0) pool = db.prepare("SELECT id FROM personas WHERE kind <> 'user' ORDER BY id").all() as { id: string }[]
  if (pool.length === 0) refuse('no-personas', {})
  return pool[hash32(`${wanted}:${salt}`) % pool.length]!.id
}

/**
 * The board a writer's post goes on. A 말머리 that names a board (유머,
 * 자유…) wins: writers often tag a joke 유머 but leave it on the main board,
 * where the 유머 tab never shows it.
 */
function boardFor(community: CommunityConfig, wanted: string, tag: string | null, fallback: 'main' | 'games' = 'main'): string {
  const tagged = tag ? community.boards.find((b) => b.role !== 'poten' && b.name.trim() === tag) : undefined
  if (tagged) return tagged.id
  const board = community.boards.find((b) => b.id === wanted && b.role !== 'poten')
  if (board) return board.id
  return (community.boards.find((b) => b.role === fallback) ?? community.boards.find((b) => b.role === 'main')!).id
}

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

/** A title without the 말머리 at its start (writers sometimes repeat it there), so the list doesn't show "[현장] [현장] …". */
function untagged(title: string, tag: string | null): string {
  const t = title.trim()
  if (!tag) return t
  const head = /^[[(【〔]\s*([^\])】〕]+?)\s*[\])】〕]\s*/.exec(t)
  return head && head[1]!.trim() === tag && t.length > head[0].length ? t.slice(head[0].length).trim() : t
}

/** A 말머리 as shown in brackets: writers sometimes include the brackets themselves ("[현장]"). */
export function cleanTag(tag: string | null | undefined): string | null {
  const t = (tag ?? '').trim().replace(/^[[(【〔]+|[\])】〕]+$/g, '').trim()
  return t ? clamp(t, 10) : null
}

/** A writer's text as it's stored (the number check reads exactly that): a title without a repeated 말머리, a body, a comment. */
export const storedTitle = (title: string, tag: string | null | undefined) => clamp(untagged(title, cleanTag(tag)), 120)
export const storedBody = (body: string) => clamp(body.trim(), 20000)
export const storedComment = (body: string) => clamp(body.trim(), 2000)

/**
 * Inserts comments that appear one by one over `spreadMs` from `startMs`
 * (in list order, unevenly spaced). Returns the new ids in list order.
 */
export function addComments(db: Db, postId: number, comments: GenComment[], jobId: number | null, startMs: number, spreadMs: number): number[] {
  const insert = db.prepare(
    'INSERT INTO comments (post_id, parent_id, author_id, body, job_id, shown_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const belongs = db.prepare('SELECT 1 FROM comments WHERE id = ? AND post_id = ?')
  const ids: number[] = []
  let at = startMs
  comments.forEach((c, i) => {
    const body = storedComment(c.body)
    if (!body) {
      ids.push(-1)
      return
    }
    let parent: number | null = null
    if (c.reply != null && c.reply >= 0 && c.reply < i && ids[c.reply]! > 0) parent = ids[c.reply]!
    else if (c.replyToId != null && belongs.get(c.replyToId, postId)) parent = c.replyToId
    if (spreadMs > 0 && comments.length > 1) {
      // Uneven gaps: a burst at first, slower later.
      const share = (hash32(`${postId}:${i}:${body}`) % 1000) / 1000
      at += Math.round((spreadMs / comments.length) * (0.3 + 1.4 * share))
    }
    const r = insert.run(postId, parent, authorFor(db, c.author, `${postId}:${i}`), body, jobId, iso(at))
    ids.push(Number(r.lastInsertRowid))
    flagNumbers(db, 'comment', Number(r.lastInsertRowid), c.flags, jobId)
  })
  db.prepare('UPDATE posts SET last_activity = MAX(last_activity, ?) WHERE id = ?').run(iso(at), postId)
  return ids
}

/** A writer's post, shown now, with its comments trickling in over `spreadMs` (and its poll, if it has one). */
export function addPost(db: Db, community: CommunityConfig, post: GenPost, links: PostLinks, nowMs: number, spreadMs: number): number {
  return transaction(db, () => {
    const heat = Math.min(5, Math.max(1, post.heat ?? 2))
    const fallback = links.kind === 'thread' && links.gameId ? 'games' : 'main'
    const tag = cleanTag(post.tag)
    const title = storedTitle(post.title, tag) || '(제목 없음)'
    const r = db
      .prepare(
        `INSERT INTO posts (board_id, author_id, kind, tag, title, body, game_id, event_id, job_id, heat, shown_at, last_activity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        boardFor(community, post.board, tag, fallback),
        authorFor(db, post.author, post.title),
        links.kind,
        tag,
        title,
        storedBody(post.body),
        links.gameId ?? null,
        links.eventId ?? null,
        links.jobId ?? null,
        heat,
        iso(nowMs),
        iso(nowMs),
      )
    const id = Number(r.lastInsertRowid)
    const poll = writerPoll(post.poll, title)
    if (poll) createPoll(db, id, poll, nowMs)
    flagNumbers(db, 'post', id, post.flags, links.jobId ?? null)
    addComments(db, id, post.comments, links.jobId ?? null, nowMs, spreadMs)
    return id
  })
}

/** True once anything from this job was stored (so a re-run after a crash doesn't post twice). */
export function jobSaved(db: Db, jobId: number): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM posts WHERE job_id = ? UNION ALL SELECT 1 FROM comments WHERE job_id = ?
         UNION ALL SELECT 1 FROM feed_buffer WHERE job_id = ? UNION ALL SELECT 1 FROM persona_memory WHERE job_id = ? LIMIT 1`,
      )
      .get(jobId, jobId, jobId, jobId),
  )
}

export function remember(db: Db, notes: { author: string; note: string }[], jobId: number | null, nowMs: number): void {
  const insert = db.prepare('INSERT INTO persona_memory (persona_id, note, job_id, created_at) VALUES (?, ?, ?, ?)')
  const known = db.prepare("SELECT 1 FROM personas WHERE id = ? AND kind <> 'user'")
  for (const n of notes) {
    // One plain line: notes are replayed to writers later, so nothing in them may pose as a heading or block (or carry the unverified tag).
    const note = clamp(untag(n.note).replace(/[#「」]/g, '').replace(/\s+/g, ' ').trim(), 100)
    if (note && known.get(n.author)) insert.run(n.author, note, jobId, iso(nowMs))
  }
}

/** A persona's latest notes, newest first. */
export function memoriesOf(db: Db, personaId: string, limit = 3): string[] {
  return (db.prepare('SELECT note FROM persona_memory WHERE persona_id = ? ORDER BY id DESC LIMIT ?').all(personaId, limit) as { note: string }[]).map(
    (r) => r.note,
  )
}

// ── The buffer ───────────────────────────────────────────────────────────

export type BufferItem = { type: 'post'; post: GenPost } | { type: 'comments'; postId: number; comments: GenComment[] }

export function bufferItems(db: Db, jobId: number | null, items: BufferItem[], asOfEvent: number, staleAfterEvent: boolean, nowMs: number): void {
  const insert = db.prepare('INSERT INTO feed_buffer (job_id, item, as_of_event, stale_after_event, created_at) VALUES (?, ?, ?, ?, ?)')
  transaction(db, () => {
    for (const item of items) insert.run(jobId, JSON.stringify(item), asOfEvent, staleAfterEvent ? 1 : 0, iso(nowMs))
  })
}

export function bufferSize(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM feed_buffer').get() as { n: number }).n
}

/** The newest event id (0 when none). */
export function lastEventId(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get() as { n: number }).n
}

/**
 * Events fans would talk about; bookkeeping (settings, the 2K checklist, card allocation) doesn't make chatter stale.
 * A slot change counts only when it moved someone between the starters and the bench (`rotation`).
 */
export const NEWS_EVENTS: readonly EventType[] = [
  'season_created',
  'season_started',
  'phase_changed',
  'game_recorded',
  'game_corrected',
  'game_unrecorded',
  'playoffs_seeded',
  'series_won',
  'series_result_changed',
  'trade_applied',
  'move_vetoed',
  'draft_protect',
  'draft_swap',
  'draft_pass',
  'award_given',
  'award_removed',
  'news_posted',
  'standings_moment',
  'slots_changed',
]

/** The newest event fans would talk about (0 when none). */
export function lastNewsEventId(db: Db): number {
  const marks = NEWS_EVENTS.map(() => '?').join(',')
  return (
    db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE type IN (${marks}) AND (type <> 'slots_changed' OR ${jsonField('payload', '$.rotation')} = 1)`)
      .get(...NEWS_EVENTS) as { n: number }
  ).n
}

/** Drops chatter written before the latest news, so fans never talk about a finished game as if it's coming. */
export function dropStale(db: Db): number {
  return Number(db.prepare('DELETE FROM feed_buffer WHERE stale_after_event = 1 AND as_of_event < ?').run(lastNewsEventId(db)).changes)
}

// ── Reading ──────────────────────────────────────────────────────────────

interface PostDbRow {
  id: number
  board_id: string
  author_id: string
  kind: PostKind
  tag: string | null
  title: string
  body: string
  game_id: number | null
  views: number
  up: number
  down: number
  my_vote: -1 | 0 | 1
  poten_at: string | null
  shown_at: string
  read_at: string | null
  nick: string
  author_kind: 'fan' | 'reporter' | 'user'
  level: number
  badge: string | null
  comments: number
  newest: string | null
  poll_state: 'open' | 'closed' | null
}

const POST_SELECT = `
  SELECT p.*, a.nick, a.kind AS author_kind, a.level, COALESCE(t.short_name, a.outlet) AS badge,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.shown_at <= :now) AS comments,
         (SELECT MAX(c.shown_at) FROM comments c WHERE c.post_id = p.id AND c.shown_at <= :now) AS newest,
         (SELECT CASE WHEN q.closed_at IS NULL AND (q.closes_at IS NULL OR q.closes_at > :now) THEN 'open' ELSE 'closed' END
          FROM polls q WHERE q.post_id = p.id) AS poll_state
  FROM posts p
  JOIN personas a ON a.id = p.author_id
  LEFT JOIN teams t ON t.id = a.team_id`

const author = (r: { author_id: string; nick: string; author_kind: AuthorView['kind']; level: number; badge: string | null }): AuthorView => ({
  id: r.author_id,
  nick: r.nick,
  kind: r.author_kind,
  level: r.level,
  badge: r.badge,
})

const summary = (r: PostDbRow): PostSummary => ({
  id: r.id,
  boardId: r.board_id,
  kind: r.kind,
  tag: r.tag,
  title: r.title,
  author: author(r),
  comments: r.comments,
  views: r.views,
  up: r.up,
  down: r.down,
  poten: r.poten_at !== null,
  shownAt: r.shown_at,
  fresh: r.read_at !== null && r.newest !== null && r.newest > r.read_at,
  pollState: r.poll_state,
})

/** One page of a board, newest first. The 포텐 board lists posts that crossed the threshold, newest 포텐 first. */
export function boardPage(db: Db, community: CommunityConfig, boardId: string, page: number, nowMs: number): BoardPage {
  const board = community.boards.find((b) => b.id === boardId)
  if (!board) refuse('unknown-board', { board: boardId })
  const now = iso(nowMs)
  const poten = board.role === 'poten'
  const where = poten ? 'p.poten_at IS NOT NULL AND p.shown_at <= :now' : 'p.board_id = :board AND p.shown_at <= :now'
  const order = poten ? 'p.poten_at DESC, p.id DESC' : 'p.id DESC'
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE ${where}`).get(poten ? { now } : { now, board: boardId }) as { n: number }
  ).n
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(Math.max(1, Math.floor(page)), pages)
  const rows = db
    .prepare(`${POST_SELECT} WHERE ${where} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
    .all({ now, ...(poten ? {} : { board: boardId }), limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE }) as unknown as PostDbRow[]
  return { boardId, posts: rows.map(summary), page: current, pages, total }
}

/** The newest posts across boards (the front page). */
export function latestPosts(db: Db, nowMs: number, limit = 10): PostSummary[] {
  const rows = db
    .prepare(`${POST_SELECT} WHERE p.shown_at <= :now ORDER BY p.id DESC LIMIT :limit`)
    .all({ now: iso(nowMs), limit }) as unknown as PostDbRow[]
  return rows.map(summary)
}

interface CommentDbRow {
  id: number
  parent_id: number | null
  author_id: string
  body: string
  up: number
  down: number
  my_vote: -1 | 0 | 1
  shown_at: string
  nick: string
  author_kind: AuthorView['kind']
  level: number
  badge: string | null
}

/**
 * A post with its visible comments. Opening it counts a view and marks it
 * read; `view: false` (the open page reading it again) only marks it read.
 */
export function openPost(db: Db, community: CommunityConfig, postId: number, nowMs: number, opts: { view?: boolean } = {}): PostView {
  const now = iso(nowMs)
  const row = db.prepare(`${POST_SELECT} WHERE p.id = :id AND p.shown_at <= :now`).get({ id: postId, now }) as unknown as PostDbRow | undefined
  if (!row) refuse('unknown-post', { post: postId })
  // A view counts once a minute at most, so leaving and coming straight back isn't two.
  const counted = opts.view !== false && (row.read_at === null || row.read_at < iso(nowMs - 60_000)) ? 1 : 0
  db.prepare('UPDATE posts SET views = views + ?, read_at = ? WHERE id = ?').run(counted, now, postId)
  const comments = (
    db
      .prepare(
        `SELECT c.*, a.nick, a.kind AS author_kind, a.level, COALESCE(t.short_name, a.outlet) AS badge
         FROM comments c JOIN personas a ON a.id = c.author_id LEFT JOIN teams t ON t.id = a.team_id
         WHERE c.post_id = ? AND c.shown_at <= ? ORDER BY c.shown_at, c.id`,
      )
      .all(postId, now) as unknown as CommentDbRow[]
  ).map(
    (c): CommentView => ({
      id: c.id,
      parentId: c.parent_id,
      author: author(c),
      body: c.body,
      up: c.up,
      down: c.down,
      myVote: c.my_vote,
      best: false,
      shownAt: c.shown_at,
      mine: c.author_id === ME,
      flags: [],
    }),
  )
  // Numbers a writer used that its facts didn't hold: marked for you.
  const flags = flagsFor(db, 'comment', comments.map((c) => c.id))
  for (const c of comments) c.flags = flags.get(c.id) ?? []
  const best = comments
    .filter((c) => c.up >= community.bestAt)
    .sort((a, b) => b.up - a.up || a.id - b.id)
    .slice(0, 3)
  const bestIds = new Set(best.map((c) => c.id))
  for (const c of comments) c.best = bestIds.has(c.id)
  const pending = (db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND shown_at > ?').get(postId, now) as { n: number }).n
  return {
    ...summary({ ...row, views: row.views + counted }),
    fresh: false,
    body: row.body,
    myVote: row.my_vote,
    gameId: row.game_id,
    thread: threadOrder(comments),
    best,
    pending,
    writing: replyWriting(db, postId),
    mine: row.author_id === ME,
    poll: pollView(db, postId, nowMs),
    resultsOf: resultsOf(db, postId),
    flags: flagsOf(db, 'post', postId),
  }
}

/**
 * A reply to your post or comment is queued or being written. (Game threads
 * arrive as new posts, so a waiting post_game_thread adds nothing to a post
 * already up.)
 */
function replyWriting(db: Db, postId: number): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM jobs WHERE kind = 'reply_to_user' AND status IN ('queued', 'running') AND ${jsonField('input', '$.postId')} = ? LIMIT 1`)
      .get(postId),
  )
}

/** Replies follow the comment they answer (one level of nesting, as on the boards). */
function threadOrder(comments: CommentView[]): CommentView[] {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const root = (c: CommentView): number => {
    let cur = c
    const seen = new Set<number>()
    while (cur.parentId !== null && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.parentId)!
    }
    return cur.id
  }
  const groups = new Map<number, CommentView[]>()
  for (const c of comments) {
    const r = root(c)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(c)
  }
  return comments.filter((c) => root(c) === c.id).flatMap((c) => groups.get(c.id)!)
}

// ── You ──────────────────────────────────────────────────────────────────

/** Your post, with a poll when you added one (refused unless it has 2–6 different options). */
export function writeUserPost(
  db: Db,
  community: CommunityConfig,
  input: { boardId: string; title: string; body: string; gameId?: number | null; poll?: PollInput },
  nowMs: number,
): number {
  const board = community.boards.find((b) => b.id === input.boardId)
  if (!board || board.role === 'poten') refuse('unknown-board', { board: input.boardId })
  const title = clamp(input.title.trim(), 120)
  if (!title) refuse('empty-post', {})
  const poll = input.poll ? userPoll(input.poll, title) : null
  return transaction(db, () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO posts (board_id, author_id, kind, title, body, game_id, heat, shown_at, last_activity)
           VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?)`,
        )
        .run(board.id, ME, input.gameId ? 'live' : 'user', title, clamp(input.body.trim(), 20000), input.gameId ?? null, iso(nowMs), iso(nowMs))
        .lastInsertRowid,
    )
    if (poll) createPoll(db, id, poll, nowMs)
    return id
  })
}

export function writeUserComment(db: Db, input: { postId: number; parentId?: number | null; body: string }, nowMs: number): number {
  const body = input.body.trim()
  if (!body) refuse('empty-post', {})
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ? AND shown_at <= ?').get(input.postId, iso(nowMs))) refuse('unknown-post', { post: input.postId })
  if (input.parentId != null && !db.prepare('SELECT 1 FROM comments WHERE id = ? AND post_id = ?').get(input.parentId, input.postId)) {
    refuse('unknown-post', { post: input.postId })
  }
  const r = db
    .prepare('INSERT INTO comments (post_id, parent_id, author_id, body, shown_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.postId, input.parentId ?? null, ME, clamp(body, 2000), iso(nowMs))
  db.prepare('UPDATE posts SET last_activity = ?, read_at = ? WHERE id = ?').run(iso(nowMs), iso(nowMs), input.postId)
  return Number(r.lastInsertRowid)
}

/** Your vote: +1, -1, or 0 to take it back. Voting the same way twice takes it back too. */
export function vote(db: Db, target: 'post' | 'comment', id: number, value: -1 | 0 | 1): { up: number; down: number; myVote: -1 | 0 | 1 } {
  const table = target === 'post' ? 'posts' : 'comments'
  return transaction(db, () => {
    const row = db.prepare(`SELECT up, down, my_vote FROM ${table} WHERE id = ?`).get(id) as { up: number; down: number; my_vote: -1 | 0 | 1 } | undefined
    if (!row) refuse('unknown-post', { post: id })
    const next = (row.my_vote === value ? 0 : value) as -1 | 0 | 1
    const up = row.up - (row.my_vote === 1 ? 1 : 0) + (next === 1 ? 1 : 0)
    const down = row.down - (row.my_vote === -1 ? 1 : 0) + (next === -1 ? 1 : 0)
    db.prepare(`UPDATE ${table} SET up = ?, down = ?, my_vote = ? WHERE id = ?`).run(up, down, next, id)
    return { up, down, myVote: next }
  })
}

// ── Refresh ──────────────────────────────────────────────────────────────

/**
 * What a refresh does without AI: drop stale chatter, reveal the next few
 * buffered items, and move views and votes (more on hot, recent posts).
 * Returns how many items appeared.
 */
export function refreshFeed(db: Db, community: CommunityConfig, random: () => number, nowMs: number): { revealed: number; waiting: number } {
  return transaction(db, () => {
    dropStale(db)
    let revealed = 0
    const next = db.prepare('SELECT id, job_id, item FROM feed_buffer ORDER BY id LIMIT ?').all(community.revealPerRefresh) as {
      id: number
      job_id: number | null
      item: string
    }[]
    for (const row of next) {
      const item = JSON.parse(row.item) as BufferItem
      if (item.type === 'post') {
        // Chatter posts collect their own comments over the next few minutes.
        addPost(db, community, item.post, { kind: 'thread', jobId: row.job_id }, nowMs, 6 * 60_000)
        revealed++
      } else if (db.prepare('SELECT 1 FROM posts WHERE id = ?').get(item.postId)) {
        addComments(db, item.postId, item.comments, row.job_id, nowMs, 2 * 60_000)
        revealed++
      }
      db.prepare('DELETE FROM feed_buffer WHERE id = ?').run(row.id)
    }
    // Numbers move with the time since the last refresh (not per click), up to 3 hours' worth.
    const last = storyValue(db, LAST_REFRESH)
    const hours = last === null ? 0.1 : Math.min(3, Math.max(0, (nowMs - Date.parse(last)) / 3_600_000))
    setStoryValue(db, LAST_REFRESH, iso(nowMs))
    moveNumbers(db, community, random, nowMs, hours)
    return { revealed, waiting: bufferSize(db) }
  })
}

const LAST_REFRESH = 'last-refresh'

/** Whole units from an expected amount: 2.3 gives 2, or 3 three times in ten. */
const draw = (expected: number, random: () => number) => Math.floor(expected) + (random() < expected - Math.floor(expected) ? 1 : 0)

/**
 * Views and votes drift up over time: newer and hotter posts gain more, and
 * the vote rate rises steeply with heat, so only hot threads reach 포텐 in an
 * evening (a heat-5 thread in about an hour and a half, heat 3 in most of a
 * day, chatter almost never). Comments that read well rise to BEST.
 */
function moveNumbers(db: Db, community: CommunityConfig, random: () => number, nowMs: number, hours: number): void {
  if (hours <= 0) return
  const now = iso(nowMs)
  const posts = db
    .prepare('SELECT id, heat, shown_at, poten_at, author_id FROM posts WHERE shown_at <= ? ORDER BY id DESC LIMIT 200')
    .all(now) as { id: number; heat: number; shown_at: string; poten_at: string | null; author_id: string }[]
  const setPost = db.prepare('UPDATE posts SET views = views + ?, up = up + ?, down = down + ? WHERE id = ?')
  const markPoten = db.prepare('UPDATE posts SET poten_at = ? WHERE id = ? AND poten_at IS NULL AND up >= ?')
  const comments = db.prepare('SELECT id, body FROM comments WHERE post_id = ? AND shown_at <= ? AND author_id <> ?')
  const setComment = db.prepare('UPDATE comments SET up = up + ?, down = down + ? WHERE id = ?')
  for (const p of posts) {
    const ageHours = Math.max(0, (nowMs - Date.parse(p.shown_at)) / 3_600_000)
    const pull = p.heat * Math.exp(-ageHours / 18)
    if (pull < 0.05) continue
    // About 30 views an hour per point of pull, give or take half.
    const views = draw(pull * 30 * hours * (0.5 + random()), random)
    const up = draw(views * 0.006 * p.heat ** 2 * (0.5 + random()), random)
    const down = draw(views * 0.01 * random(), random)
    if (views || up || down) setPost.run(views, up, down, p.id)
    markPoten.run(now, p.id, community.potenAt)
    for (const c of comments.all(p.id, now, ME) as { id: number; body: string }[]) {
      // Each comment has a fixed appeal, so the same ones keep rising.
      const appeal = (hash32(`${c.id}:${c.body}`) % 100) / 100
      const cu = draw(pull * appeal ** 2 * 8 * hours * (0.5 + random()), random)
      const cd = draw(pull * (1 - appeal) * hours * random(), random)
      if (cu || cd) setComment.run(cu, cd, c.id)
    }
  }
}

// ── Story state ──────────────────────────────────────────────────────────

export function storyValue(db: Db, key: string): string | null {
  return (db.prepare('SELECT value FROM story_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

export function setStoryValue(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO story_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
}
