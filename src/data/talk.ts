import type { WikiAuthor, WikiTalkLine, WikiThreadSummary } from '@shared/wiki'
import { transaction, type Db } from './db'
import { flagNumbers, parseFlags } from './flags'
import { refuse } from './rules'

/**
 * The wiki's 토론: threads on a page, each a numbered run of comments and
 * grey status lines (opened, closed, an edit made). A thread about one
 * section that editors are fighting over (a 'war' or 'pushback' thread)
 * keeps the AI editors off that section while it's open.
 */

export type ThreadOrigin = 'user' | 'war' | 'pushback'

/** Completed rounds a dispute nobody settles stays open (and holds its section). */
export const DISPUTE_ROUNDS = 2

export const MAX_TOPIC = 60
export const MAX_TALK = 2000

export interface ThreadRow {
  id: number
  pageId: number
  pageTitle: string
  topic: string
  status: 'open' | 'closed'
  origin: ThreadOrigin
  section: string | null
  openedBy: string
  roundsLeft: number | null
  reverted: boolean
  createdAt: string
  updatedAt: string
  closedAt: string | null
  closeNote: string | null
}

interface ThreadDbRow {
  id: number
  page_id: number
  title: string
  topic: string
  status: 'open' | 'closed'
  origin: ThreadOrigin
  section: string | null
  opened_by: string
  rounds_left: number | null
  reverted: number
  created_at: string
  updated_at: string
  closed_at: string | null
  close_note: string | null
}

const toThread = (r: ThreadDbRow): ThreadRow => ({
  id: r.id,
  pageId: r.page_id,
  pageTitle: r.title,
  topic: r.topic,
  status: r.status,
  origin: r.origin,
  section: r.section,
  openedBy: r.opened_by,
  roundsLeft: r.rounds_left,
  reverted: r.reverted === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
  closeNote: r.close_note,
})

const THREAD_SELECT = 'SELECT t.*, p.title FROM wiki_threads t JOIN wiki_pages p ON p.id = t.page_id'

export function threadById(db: Db, id: number): ThreadRow | null {
  const r = db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as ThreadDbRow | undefined
  return r ? toThread(r) : null
}

/** A thread you can see, or a refusal. */
export function getThread(db: Db, id: number): ThreadRow {
  const t = threadById(db, id)
  if (!t) refuse('wiki-no-thread', { thread: id })
  return t
}

const clean = (text: string, max: number) => text.replace(/\r\n?/g, '\n').trim().slice(0, max)

/** Opens a thread on a page. The opening comment, if any, is #1. */
export function openThread(
  db: Db,
  input: { pageId: number; topic: string; origin: ThreadOrigin; openedBy: string; section?: string | null; roundsLeft?: number | null; reverted?: boolean; jobId?: number | null },
  nowIso: string,
): number {
  const topic = clean(input.topic, MAX_TOPIC).replace(/\s+/g, ' ')
  if (!topic) refuse('wiki-empty-topic')
  return Number(
    db
      .prepare(
        `INSERT INTO wiki_threads (page_id, topic, origin, section, opened_by, rounds_left, reverted, job_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.pageId, topic, input.origin, input.section ?? null, input.openedBy, input.roundsLeft ?? null, input.reverted ? 1 : 0, input.jobId ?? null, nowIso, nowIso)
      .lastInsertRowid,
  )
}

/**
 * Adds a line to a thread; returns its number. Empty comments are refused.
 * `flags` are numbers an AI editor wrote that its facts didn't hold, marked for you.
 */
export function addTalk(
  db: Db,
  threadId: number,
  line: { kind?: 'comment' | 'status'; authorId: string; body: string; rev?: number | null; jobId?: number | null; flags?: string[] },
  nowIso: string,
): number {
  const body = clean(line.body, MAX_TALK)
  if (!body) refuse('empty-post')
  return transaction(db, () => {
    const n = (db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM wiki_talk WHERE thread_id = ?').get(threadId) as { n: number }).n
    const saved = db
      .prepare('INSERT INTO wiki_talk (thread_id, n, kind, author_id, body, rev, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(threadId, n, line.kind ?? 'comment', line.authorId, body, line.rev ?? null, line.jobId ?? null, nowIso)
    flagNumbers(db, 'wiki_talk', Number(saved.lastInsertRowid), line.flags, line.jobId ?? null)
    db.prepare('UPDATE wiki_threads SET updated_at = ? WHERE id = ?').run(nowIso, threadId)
    return n
  })
}

/** Closes a thread (lifting any hold on its section), with a status line saying why. */
export function closeThread(db: Db, threadId: number, by: string, note: string, nowIso: string): void {
  transaction(db, () => {
    const t = getThread(db, threadId)
    if (t.status === 'closed') return
    const why = clean(note, 300)
    db.prepare("UPDATE wiki_threads SET status = 'closed', closed_at = ?, close_note = ?, rounds_left = NULL WHERE id = ?").run(nowIso, why || null, threadId)
    addTalk(db, threadId, { kind: 'status', authorId: by, body: why ? `토론을 닫음: ${why}` : '토론을 닫음' }, nowIso)
  })
}

/** Opens a closed thread again. A reopened dispute holds its section again, and counts down afresh. */
export function reopenThread(db: Db, threadId: number, by: string, nowIso: string): void {
  transaction(db, () => {
    const t = getThread(db, threadId)
    if (t.status === 'open') return
    const rounds = t.origin !== 'user' && t.section !== null ? DISPUTE_ROUNDS : null
    db.prepare("UPDATE wiki_threads SET status = 'open', closed_at = NULL, close_note = NULL, rounds_left = ? WHERE id = ?").run(rounds, threadId)
    addTalk(db, threadId, { kind: 'status', authorId: by, body: '토론을 다시 엶' }, nowIso)
  })
}

const AUTHOR = `COALESCE(a.nick, CASE x.author_id WHEN 'system' THEN '2K World' WHEN 'me' THEN '나' ELSE x.author_id END) AS nick,
  CASE x.author_id WHEN 'system' THEN 'system' WHEN 'me' THEN 'user' ELSE COALESCE(a.kind, 'fan') END AS author_kind`

const author = (id: string, nick: string, kind: WikiAuthor['kind']): WikiAuthor => ({ id, nick, kind })

interface SummaryDbRow extends ThreadDbRow {
  nick: string
  author_kind: WikiAuthor['kind']
  comments: number
}

const toSummary = (r: SummaryDbRow): WikiThreadSummary => ({
  id: r.id,
  pageTitle: r.title,
  topic: r.topic,
  status: r.status,
  origin: r.origin,
  section: r.section,
  openedBy: author(r.opened_by, r.nick, r.author_kind),
  comments: r.comments,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const SUMMARY_SELECT = `SELECT t.*, p.title, ${AUTHOR.replace(/x\.author_id/g, 't.opened_by')},
  (SELECT COUNT(*) FROM wiki_talk c WHERE c.thread_id = t.id AND c.kind = 'comment') AS comments
  FROM wiki_threads t JOIN wiki_pages p ON p.id = t.page_id LEFT JOIN personas a ON a.id = t.opened_by`

export function threadSummary(db: Db, id: number): WikiThreadSummary | null {
  const r = db.prepare(`${SUMMARY_SELECT} WHERE t.id = ?`).get(id) as SummaryDbRow | undefined
  return r ? toSummary(r) : null
}

/** A page's threads: open ones first, then the newest. */
export function threadsOfPage(db: Db, pageId: number): WikiThreadSummary[] {
  return (db.prepare(`${SUMMARY_SELECT} WHERE t.page_id = ? ORDER BY t.status = 'closed', t.updated_at DESC, t.id DESC`).all(pageId) as unknown as SummaryDbRow[]).map(toSummary)
}

/** 최근 토론: threads across the wiki with the latest activity. */
export function recentThreads(db: Db, limit = 50): WikiThreadSummary[] {
  return (db.prepare(`${SUMMARY_SELECT} ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`).all(limit) as unknown as SummaryDbRow[]).map(toSummary)
}

export function talkLines(db: Db, threadId: number): WikiTalkLine[] {
  const rows = db
    .prepare(
      `SELECT x.n, x.kind, x.author_id, ${AUTHOR}, x.body, x.rev, x.created_at, f.numbers AS flags
       FROM wiki_talk x LEFT JOIN personas a ON a.id = x.author_id
       LEFT JOIN ai_flags f ON f.target_kind = 'wiki_talk' AND f.target_id = x.id
       WHERE x.thread_id = ? ORDER BY x.n`,
    )
    .all(threadId) as {
    n: number
    kind: 'comment' | 'status'
    author_id: string
    nick: string
    author_kind: WikiAuthor['kind']
    body: string
    rev: number | null
    created_at: string
    flags: string | null
  }[]
  // Only comments are numbered (#1, #2…), as on Namuwiki; status lines sit between them unnumbered.
  let no = 0
  return rows.map((r) => ({
    seq: r.n,
    n: r.kind === 'comment' ? ++no : null,
    kind: r.kind,
    author: author(r.author_id, r.nick, r.author_kind),
    body: r.body,
    rev: r.rev,
    createdAt: r.created_at,
    flags: parseFlags(r.flags),
  }))
}

/** How many comments a thread has (the next one is this + 1). */
export function commentCount(db: Db, threadId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM wiki_talk WHERE thread_id = ? AND kind = 'comment'").get(threadId) as { n: number }).n
}

/** Open threads holding a section (wars and pushback), for one page or all. */
export function openDisputes(db: Db, pageId?: number): { threadId: number; pageId: number; section: string; topic: string; origin: ThreadOrigin }[] {
  const rows = db
    .prepare(
      `SELECT id, page_id, section, topic, origin FROM wiki_threads
       WHERE status = 'open' AND origin IN ('war', 'pushback') AND section IS NOT NULL ${pageId === undefined ? '' : 'AND page_id = ?'} ORDER BY id`,
    )
    .all(...(pageId === undefined ? [] : [pageId])) as { id: number; page_id: number; section: string; topic: string; origin: ThreadOrigin }[]
  return rows.map((r) => ({ threadId: r.id, pageId: r.page_id, section: r.section, topic: r.topic, origin: r.origin }))
}

export function openThreadCount(db: Db, pageId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM wiki_threads WHERE page_id = ? AND status = 'open'").get(pageId) as { n: number }).n
}

/** Whether an editor has already undone your change to this section once (they get one, ever). */
export function sectionReverted(db: Db, pageId: number, section: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM wiki_threads WHERE page_id = ? AND section = ? AND origin = 'pushback' AND reverted = 1 LIMIT 1").get(pageId, section))
}

/**
 * A completed round passes: disputes count down, and the ones nobody
 * settled close as they stand. Returns the threads closed.
 */
export function tickDisputes(db: Db, nowIso: string): number[] {
  return transaction(db, () => {
    db.prepare("UPDATE wiki_threads SET rounds_left = rounds_left - 1 WHERE status = 'open' AND rounds_left IS NOT NULL").run()
    const due = (db.prepare("SELECT id FROM wiki_threads WHERE status = 'open' AND rounds_left IS NOT NULL AND rounds_left <= 0").all() as { id: number }[]).map((r) => r.id)
    for (const id of due) closeThread(db, id, 'system', '합의 없이 시간이 지나 닫힘. 지금 판을 유지한다.', nowIso)
    return due
  })
}
