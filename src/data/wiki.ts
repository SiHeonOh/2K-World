import { parseWiki, splitWikiSections } from '@shared/namumark'
import { usesNumber } from '@shared/numbers'
import type { WikiAuthor, WikiKind, WikiRevisionView, WikiSearchResult } from '@shared/wiki'
import { transaction, type Db } from './db'
import { flagNumbers, parseFlags } from './flags'
import { refuse } from './rules'

/**
 * Wiki pages and their revisions. Every save is a new revision; the page
 * points at the latest. Links in the current text are indexed for 역링크
 * and red links.
 */

export const SYSTEM = 'system'
const MAX_BODY = 200_000

export interface PageRow {
  id: number
  title: string
  kind: WikiKind
  refId: string | null
  currentRev: number | null
  updatedAt: string
}

interface PageDbRow {
  id: number
  title: string
  kind: WikiKind
  ref_id: string | null
  current_rev: number | null
  updated_at: string
}

const toPage = (r: PageDbRow): PageRow => ({ id: r.id, title: r.title, kind: r.kind, refId: r.ref_id, currentRev: r.current_rev, updatedAt: r.updated_at })

/** How every title is stored and looked up: no brackets, bars or # (they'd break links), single spaces. */
export function normalTitle(title: string): string {
  return title.replace(/[\[\]|#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100)
}

/** A title fit to store, or a refusal. */
export function cleanTitle(title: string): string {
  const t = normalTitle(title)
  if (!t) refuse('wiki-bad-title', { title })
  return t
}

export function pageByTitle(db: Db, title: string): PageRow | null {
  const t = normalTitle(title)
  if (!t) return null
  const r = db.prepare('SELECT * FROM wiki_pages WHERE title = ?').get(t) as PageDbRow | undefined
  return r ? toPage(r) : null
}

export function pageById(db: Db, id: number): PageRow | null {
  const r = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as PageDbRow | undefined
  return r ? toPage(r) : null
}

/** Existing pages' titles by what they're about, e.g. player id → title (titles don't move when a player does). */
export function titlesByRef(db: Db, kind: WikiKind): Map<string, string> {
  const rows = db.prepare('SELECT ref_id, title FROM wiki_pages WHERE kind = ? AND ref_id IS NOT NULL').all(kind) as { ref_id: string; title: string }[]
  return new Map(rows.map((r) => [r.ref_id, r.title]))
}

export function pageByRef(db: Db, kind: WikiKind, refId: string): PageRow | null {
  const r = db.prepare('SELECT * FROM wiki_pages WHERE kind = ? AND ref_id = ?').get(kind, refId) as PageDbRow | undefined
  return r ? toPage(r) : null
}

/** Gives a page a new title, unless another page has it. Links to the old title aren't rewritten (they're your text). */
export function renamePage(db: Db, pageId: number, title: string): boolean {
  const t = normalTitle(title)
  if (!t) return false
  const taken = pageByTitle(db, t)
  if (taken && taken.id !== pageId) return false
  db.prepare('UPDATE wiki_pages SET title = ? WHERE id = ?').run(t, pageId)
  return true
}

export function pageCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM wiki_pages').get() as { n: number }).n
}

export function revisionBody(db: Db, pageId: number, rev: number): { body: string; authorId: string; createdAt: string } | null {
  const r = db.prepare('SELECT body, author_id, created_at FROM wiki_revisions WHERE page_id = ? AND rev = ?').get(pageId, rev) as
    | { body: string; author_id: string; created_at: string }
    | undefined
  return r ? { body: r.body, authorId: r.author_id, createdAt: r.created_at } : null
}

function indexLinks(db: Db, pageId: number, body: string): void {
  db.prepare('DELETE FROM wiki_links WHERE from_page = ?').run(pageId)
  const insert = db.prepare('INSERT OR IGNORE INTO wiki_links (from_page, to_title) VALUES (?, ?)')
  for (const link of parseWiki(body).links) {
    const t = normalTitle(link)
    if (t) insert.run(pageId, t)
  }
}

/**
 * Saves a new revision (creating the page if needed). `baseRev` is the
 * revision the edit started from: if someone saved in between, it's refused
 * rather than silently overwriting their text. `flags` are numbers an AI
 * editor wrote that its facts didn't hold, marked on the revision for you.
 */
export function saveRevision(
  db: Db,
  input: {
    title: string
    kind?: WikiKind
    refId?: string | null
    body: string
    authorId: string
    summary: string
    baseRev?: number | null
    jobId?: number | null
    flags?: string[]
  },
  nowMs: number,
): { pageId: number; rev: number } {
  const body = input.body.replace(/\r\n?/g, '\n')
  if (body.length > MAX_BODY) refuse('wiki-too-long', { max: MAX_BODY })
  const now = new Date(nowMs).toISOString()
  return transaction(db, () => {
    let page = pageByTitle(db, input.title)
    if (!page) {
      const title = cleanTitle(input.title)
      const id = Number(
        db
          .prepare('INSERT INTO wiki_pages (title, kind, ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(title, input.kind ?? 'page', input.refId ?? null, now, now).lastInsertRowid,
      )
      page = { id, title, kind: input.kind ?? 'page', refId: input.refId ?? null, currentRev: null, updatedAt: now }
    } else if (input.baseRev !== undefined && input.baseRev !== page.currentRev) {
      refuse('wiki-conflict', { title: page.title })
    }
    const before = page.currentRev === null ? '' : (revisionBody(db, page.id, page.currentRev)?.body ?? '')
    if (page.currentRev !== null && before === body) return { pageId: page.id, rev: page.currentRev }
    const rev = (page.currentRev ?? 0) + 1
    const saved = db
      .prepare('INSERT INTO wiki_revisions (page_id, rev, body, author_id, summary, job_id, size_delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(page.id, rev, body, input.authorId, input.summary.trim().slice(0, 200), input.jobId ?? null, body.length - before.length, now)
    flagNumbers(db, 'wiki_revision', Number(saved.lastInsertRowid), input.flags, input.jobId ?? null)
    db.prepare('UPDATE wiki_pages SET current_rev = ?, updated_at = ? WHERE id = ?').run(rev, now, page.id)
    indexLinks(db, page.id, body)
    return { pageId: page.id, rev }
  })
}

const AUTHOR_SELECT = `COALESCE(a.nick, CASE r.author_id WHEN 'system' THEN '2K World' WHEN 'me' THEN '나' ELSE r.author_id END) AS nick,
  CASE r.author_id WHEN 'system' THEN 'system' WHEN 'me' THEN 'user' ELSE COALESCE(a.kind, 'fan') END AS author_kind`

const author = (r: { author_id: string; nick: string; author_kind: WikiAuthor['kind'] }): WikiAuthor => ({ id: r.author_id, nick: r.nick, kind: r.author_kind })

export function authorOf(db: Db, id: string): WikiAuthor {
  if (id === SYSTEM) return { id, nick: '2K World', kind: 'system' }
  const p = db.prepare('SELECT nick, kind FROM personas WHERE id = ?').get(id) as { nick: string; kind: WikiAuthor['kind'] } | undefined
  if (id === 'me') return { id, nick: p?.nick ?? '나', kind: 'user' }
  return { id, nick: p?.nick ?? id, kind: p?.kind ?? 'fan' }
}

interface RevDbRow {
  title: string
  rev: number
  author_id: string
  nick: string
  author_kind: WikiAuthor['kind']
  summary: string
  size_delta: number
  created_at: string
  flags: string | null
}

const toRev = (r: RevDbRow): WikiRevisionView => ({
  pageTitle: r.title,
  rev: r.rev,
  author: author(r),
  summary: r.summary,
  sizeDelta: r.size_delta,
  createdAt: r.created_at,
  flags: parseFlags(r.flags),
})

/** A revision's line, with the numbers marked on it (an AI editor's, not in its facts). */
const REV_SELECT = `SELECT p.title, r.rev, r.author_id, ${AUTHOR_SELECT}, r.summary, r.size_delta, r.created_at, f.numbers AS flags
  FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id LEFT JOIN personas a ON a.id = r.author_id
  LEFT JOIN ai_flags f ON f.target_kind = 'wiki_revision' AND f.target_id = r.id`

export function pageHistory(db: Db, pageId: number, limit = 100): WikiRevisionView[] {
  return (db.prepare(`${REV_SELECT} WHERE r.page_id = ? ORDER BY r.rev DESC LIMIT ?`).all(pageId, limit) as unknown as RevDbRow[]).map(toRev)
}

/** One revision's line in the history (who, when, why). */
export function revisionView(db: Db, pageId: number, rev: number): WikiRevisionView | null {
  const r = db.prepare(`${REV_SELECT} WHERE r.page_id = ? AND r.rev = ?`).get(pageId, rev) as RevDbRow | undefined
  return r ? toRev(r) : null
}

/** 최근 변경: the newest revisions across the wiki (seeded pages left out). */
export function recentChanges(db: Db, limit = 50): WikiRevisionView[] {
  return (db.prepare(`${REV_SELECT} WHERE r.author_id <> 'system' ORDER BY r.id DESC LIMIT ?`).all(limit) as unknown as RevDbRow[]).map(toRev)
}

/**
 * The marked numbers a revision of a page carries ([] when none): its own,
 * and earlier revisions' that its text (`body`) still uses. A mark stays with
 * its number, not with the revision that wrote it.
 */
export function pageFlags(db: Db, pageId: number, rev: number, body: string): string[] {
  const rows = db
    .prepare("SELECT r.rev, f.numbers FROM wiki_revisions r JOIN ai_flags f ON f.target_kind = 'wiki_revision' AND f.target_id = r.id WHERE r.page_id = ? AND r.rev <= ? ORDER BY r.rev DESC")
    .all(pageId, rev) as { rev: number; numbers: string }[]
  const out: string[] = []
  for (const r of rows) for (const n of parseFlags(r.numbers)) if (!out.includes(n) && (r.rev === rev || usesNumber(body, n))) out.push(n)
  return out
}

export function backlinks(db: Db, title: string): string[] {
  return (
    db
      .prepare('SELECT p.title FROM wiki_links l JOIN wiki_pages p ON p.id = l.from_page WHERE l.to_title = ? ORDER BY p.title')
      .all(normalTitle(title)) as { title: string }[]
  ).map((r) => r.title)
}

export function backlinkCount(db: Db, title: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM wiki_links WHERE to_title = ?').get(normalTitle(title)) as { n: number }).n
}

/** Which of these link targets have pages (as written in the link). */
export function existingTitles(db: Db, titles: string[]): string[] {
  if (titles.length === 0) return []
  const found = new Set<string>()
  const q = db.prepare('SELECT 1 FROM wiki_pages WHERE title = ?')
  for (const t of titles) if (q.get(normalTitle(t))) found.add(t)
  return [...found]
}

/** Title matches first, then pages whose current text mentions the words. */
export function searchWiki(db: Db, query: string, limit = 30): WikiSearchResult[] {
  const q = query.trim()
  if (!q) return []
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = db
    .prepare(
      `SELECT p.title, p.kind, r.body, (p.title LIKE ? ESCAPE '\\') AS in_title
       FROM wiki_pages p JOIN wiki_revisions r ON r.page_id = p.id AND r.rev = p.current_rev
       WHERE p.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\'
       ORDER BY in_title DESC, length(p.title), p.title LIMIT ?`,
    )
    .all(like, like, like, limit) as { title: string; kind: WikiKind; body: string; in_title: number }[]
  return rows.map((r) => {
    const at = r.body.indexOf(q)
    const snippet = at >= 0 ? r.body.slice(Math.max(0, at - 30), at + q.length + 50).replace(/\s+/g, ' ') : ''
    return { title: r.title, kind: r.kind, snippet }
  })
}

export function randomTitle(db: Db): string | null {
  return (db.prepare('SELECT title FROM wiki_pages ORDER BY RANDOM() LIMIT 1').get() as { title: string } | undefined)?.title ?? null
}

export const TRAILER_LINE = /^\s*(\[각주\]|\[footnote\]|\[\[분류:.*\]\])\s*$/i

/**
 * A page's sections keyed by title and occurrence ("여담#1", a second
 * "2025" is "2025#2"), with text compared loosely: trailing blank space and
 * the page's closing [각주]/분류 lines don't count, so moving those around
 * doesn't change whose a section is.
 */
export function sectionKeys(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const s of splitWikiSections(body)) {
    const title = s.title ?? ''
    const n = (seen.get(title) ?? 0) + 1
    seen.set(title, n)
    const lines = s.text.replace(/\r\n?/g, '\n').split('\n')
    const own = (s.title === null ? lines : lines.slice(1)).filter((l) => !TRAILER_LINE.test(l))
    out.set(`${title}#${n}`, own.join('\n').replace(/\s+$/, ''))
  }
  return out
}

/**
 * Sets one section's own text (by key, see sectionKeys), keeping its heading
 * and its [각주]/분류 lines, which go after the new text. Null when the page
 * has no such section.
 */
export function setSectionText(body: string, key: string, text: string): string | null {
  const sections = splitWikiSections(body)
  const seen = new Map<string, number>()
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!
    const title = s.title ?? ''
    const n = (seen.get(title) ?? 0) + 1
    seen.set(title, n)
    if (`${title}#${n}` !== key) continue
    const lines = s.text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    const head = s.title === null ? [] : [lines[0]!]
    const body = s.title === null ? lines : lines.slice(1)
    // The blank lines before the next heading stay, and so do those between the text and its closing
    // [각주]/분류 lines, so a diff shows only the text that changed.
    let blanks = 0
    while (blanks < body.length && body[body.length - 1 - blanks]!.trim() === '') blanks++
    const rest = body.slice(0, body.length - blanks)
    const trailer = rest.filter((l) => TRAILER_LINE.test(l))
    const first = rest.findIndex((l) => TRAILER_LINE.test(l))
    let gap = 0
    while (first > 0 && gap < first && rest[first - 1 - gap]!.trim() === '') gap++
    const own = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
    const lines2 = own ? own.split('\n') : []
    const next = [...head, ...lines2, ...Array<string>(trailer.length && lines2.length ? gap : 0).fill(''), ...trailer]
    const ends = s.text.endsWith('\n') || i < sections.length - 1
    // An emptied preamble leaves nothing behind (not even a blank line).
    sections[i] = { ...s, text: next.length === 0 ? '' : [...next, ...Array<string>(blanks).fill('')].join('\n') + (ends ? '\n' : '') }
    return sections.map((x) => x.text).join('')
  }
  return null
}

/**
 * Sections whose current text is what you (not an AI editor) last wrote, by
 * key (see sectionKeys), with that text. A section is yours when the latest
 * revision that changed it was yours.
 */
export function ownedSections(db: Db, pageId: number): Map<string, string> {
  return new Map([...sectionAuthors(db, pageId)].filter(([, v]) => v.author === 'me').map(([k, v]) => [k, v.text]))
}

/** The revisions (up to `upTo`) that changed one section, oldest first, with its text after each. */
export function sectionHistory(db: Db, pageId: number, key: string, upTo: number): { rev: number; author: string; text: string }[] {
  const revs = db.prepare('SELECT rev, body, author_id FROM wiki_revisions WHERE page_id = ? AND rev <= ? ORDER BY rev').all(pageId, upTo) as {
    rev: number
    body: string
    author_id: string
  }[]
  const out: { rev: number; author: string; text: string }[] = []
  for (const r of revs) {
    const text = sectionKeys(r.body).get(key)
    if (text !== undefined && text !== out.at(-1)?.text) out.push({ rev: r.rev, author: r.author_id, text })
  }
  return out
}

/**
 * Who last changed each section of the page as it stood at `upTo` (default:
 * now), by key (see sectionKeys): the author, the revision and the text.
 * Sections gone by then are left out.
 */
export function sectionAuthors(db: Db, pageId: number, upTo?: number): Map<string, { text: string; author: string; rev: number }> {
  const revs = db
    .prepare(`SELECT rev, body, author_id FROM wiki_revisions WHERE page_id = ? ${upTo === undefined ? '' : 'AND rev <= ?'} ORDER BY rev`)
    .all(...(upTo === undefined ? [pageId] : [pageId, upTo])) as { rev: number; body: string; author_id: string }[]
  const last = new Map<string, { text: string; author: string; rev: number }>()
  for (const r of revs) {
    for (const [key, text] of sectionKeys(r.body)) {
      const prev = last.get(key)
      if (!prev || prev.text !== text) last.set(key, { text, author: r.author_id, rev: r.rev })
    }
  }
  // A section that's gone from the current text isn't anyone's any more (else it would block every edit).
  const current = revs.length ? sectionKeys(revs.at(-1)!.body) : new Map<string, string>()
  return new Map([...last].filter(([k]) => current.has(k)))
}

/** Titles of the sections you own (for marking them in the editors' context). */
export function sectionsYouOwn(db: Db, pageId: number): Set<string> {
  return new Set([...ownedSections(db, pageId).keys()].map((k) => k.slice(0, k.lastIndexOf('#'))))
}
