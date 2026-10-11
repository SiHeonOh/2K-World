import { z } from 'zod'
import type { JobKind, JobRow } from '@ai/queue'
import { aiFor, type EffortLevel, type LeagueConfig, type ModelName, type WikiConfig } from '@shared/config/schema'
import { diffSeq } from '@shared/diff'
import { splitWikiSections } from '@shared/namumark'
import { tagUnverified, untag } from '@shared/numbers'
import { lastEventId, listPersonas, remember, type PersonaRow } from '@data/community'
import { jsonField, transaction, type Db } from '@data/db'
import { currentSeason, loadConfig } from '@data/league'
import { addTalk, closeThread, commentCount, DISPUTE_ROUNDS, openDisputes, openThread, sectionReverted, talkLines, threadById, type ThreadRow } from '@data/talk'
import { ownedSections, pageById, pageFlags, revisionBody, saveRevision, sectionAuthors, sectionHistory, sectionKeys, TRAILER_LINE, type PageRow } from '@data/wiki'
import { castBlock, join2, loreFor, pickCast, said, type League } from './context'
import { numberGate, NumbersRedo, readFacts, withRetryNote } from './numbers'
import { ensureSeasonSection, guardedEdit, MACRO_LINE, pageOutline, quoteBlock, safeEditText, SEASON_PARENTS, sectionBody, seasonBlock, SHOWN_SEASON, STYLE } from './wikiEdits'

/**
 * The wiki's 토론 and edit wars, three AI jobs:
 *
 * - wiki_talk: editors answer what you wrote in a thread. When the thread
 *   agrees, one of them edits the page (never a section you wrote last);
 *   when they're too far apart, it can turn into an edit war.
 * - wiki_war: editors fight over one section. The one who objects undoes or
 *   rewrites the disputed lines, the one who wrote them puts them back, up
 *   to three times; then 토론, ending in a compromise, or left open with the
 *   lines frozen as they were before the dispute (서술 고정) and the section
 *   held from AI editors until the thread closes.
 * - wiki_pushback: you changed an editor's text. They accept it, argue in
 *   토론, or undo your change once (each section gets one such revert,
 *   ever) and argue.
 *
 * How much disagreement it takes is the league's edit-war setting. An answer
 * that uses numbers the facts don't hold is redone once (nothing of it
 * kept), then kept with them marked (numbers.ts).
 */

export const WIKI_TALK = 'wiki_talk'
export const WIKI_WAR = 'wiki_war'
export const WIKI_PUSHBACK = 'wiki_pushback'
export const WIKI_TALK_KINDS: readonly string[] = [WIKI_TALK, WIKI_WAR, WIKI_PUSHBACK]

/** Answers to you come before the round's writing; wars after it. */
export const TALK_PRIORITY = 55
export const WAR_PRIORITY = 12

/** Most editor-vs-editor wars open at once, league-wide. */
const MAX_OPEN_WARS = 3
/** Back-and-forth reverts in one war. */
const MAX_STEPS = 3
/**
 * How hot (1–5) a disagreement must be to become a war, by setting. On the
 * scale the round editors use, 3 is a bias dispute and 2 a lesser one; in a
 * real run they rated contested edits 2–3.
 */
export const WAR_HEAT: Record<WikiConfig['editWars'], number> = { off: Infinity, sometimes: 3, often: 2 }
/** A change of yours smaller than this (characters either side) isn't worth anyone's pushback. */
const SMALL_CHANGE = 10
/** How much of each section the 토론 shows (a rewrite needs all of it). */
const TALK_SHOWN = 1500

// ── Pure helpers ─────────────────────────────────────────────────────────

/** The lines two versions of a section don't share: their common start and end trimmed away. */
export function disputedPart(before: string, after: string): { head: string[]; before: string[]; after: string[]; tail: string[] } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  return { head: a.slice(0, s), before: a.slice(s, a.length - e), after: b.slice(s, b.length - e), tail: a.slice(a.length - e) }
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

/** How many characters it takes to turn one text into the other (a long rewrite counts as all of both). */
export function changedChars(a: string, b: string): number {
  return diffSeq(Array.from(a), Array.from(b), 400).filter((op) => op !== 'same').length
}

/** Whether a page has one section of this title (a second one would make "the section" ambiguous). */
export const oneSection = (body: string, section: string) => !sectionKeys(body).has(`${section}#2`)

/** Text that can be fought over: no macro lines or folds (those need whole-section care). */
export const fightable = (text: string) => !MACRO_LINE.test(text) && !/\{\{\{|\}\}\}/.test(text)

/** `count` moments spread evenly between two times, oldest first. */
function spread(fromMs: number, toMs: number, count: number): number[] {
  const end = Math.max(fromMs, toMs)
  return Array.from({ length: count }, (_, i) => Math.round(fromMs + ((end - fromMs) * (i + 1)) / (count + 1)))
}

const iso = (ms: number) => new Date(ms).toISOString()
const title = (key: string) => key.slice(0, key.lastIndexOf('#'))
const isPersona = (db: Db, id: string | undefined) => Boolean(id && db.prepare("SELECT 1 FROM personas WHERE id = ? AND kind <> 'user'").get(id))

// ── What the writers see ─────────────────────────────────────────────────

/** Whom a page is about: its player (and his school) or its school. */
function subjectOf(league: League, page: PageRow): { players: string[]; teams: string[] } {
  if (page.kind === 'player' && page.refId) {
    const p = league.players.get(page.refId)
    return { players: p ? [p.id] : [], teams: p ? [p.teamId] : [] }
  }
  if (page.kind === 'team' && page.refId && league.teams.has(page.refId)) return { players: [], teams: [page.refId] }
  return { players: [], teams: [] }
}

/** Schools the lore calls these schools' rivals. */
function rivalsOf(league: League, teams: string[]): string[] {
  const byName = new Map([...league.teams.values()].map((t) => [t.shortName, t.id]))
  return teams.flatMap((t) => {
    const entry = league.lore.team.get(t)
    const names = entry?.kind === 'team' ? entry.settings.rivals : []
    return names.map((n) => byName.get(n)).filter((x): x is string => Boolean(x))
  })
}

/** The editors for a job: these people first (in order), then fans of the page's school and its rivals. */
function editorsFor(league: League, first: (string | undefined)[], subject: { teams: string[] }, salt: string, size = 7): PersonaRow[] {
  const all = new Map(listPersonas(league.db).filter((p) => p.kind !== 'user').map((p) => [p.id, p]))
  const out: PersonaRow[] = []
  const add = (p: PersonaRow | undefined) => p && !out.some((x) => x.id === p.id) && out.push(p)
  for (const id of first) add(id ? all.get(id) : undefined)
  for (const p of pickCast(league, { teams: [...subject.teams, ...rivalsOf(league, subject.teams)], fans: size, reporters: 0, salt })) {
    if (out.length >= Math.max(size, first.length)) break
    add(p)
  }
  return out
}

/** A neutral regular to settle a war: no school, a calm sort, not one of the sides. */
function mediatorFor(league: League, not: string[], salt: string): PersonaRow | null {
  const calm = ['analyst', 'stats', 'oldfan', 'lurker', 'newbie']
  const pool = listPersonas(league.db).filter((p) => p.kind === 'fan' && !p.teamId && calm.includes(p.archetype) && !not.includes(p.id))
  if (pool.length === 0) return null
  let h = 0
  for (const c of salt) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return pool[h % pool.length]!
}

const who = (league: League, id: string) => {
  if (id === 'me') return '나(사용자)'
  const p = listPersonas(league.db).find((x) => x.id === id)
  return p ? `${p.nick}(${p.id})` : id
}

function threadBlock(db: Db, thread: ThreadRow): string {
  const lines = talkLines(db, thread.id).slice(-30)
  const name = (l: (typeof lines)[number]) => (l.author.kind === 'user' ? '나' : l.author.kind === 'system' ? '2K World' : `${l.author.nick}(${l.author.id})`)
  // Numbers marked on an editor's comment are shown as unverified (and aren't facts for the answer).
  return `# 토론 ${said(thread.topic, 80)}${thread.section ? ` (문단 ${said(thread.section, 40)})` : ''}\n${lines
    .map((l) => (l.kind === 'status' ? `(${said(l.body, 200)})` : `#${l.n} ${name(l)}: ${tagUnverified(said(l.body, 700), l.flags)}`))
    .join('\n')}`
}

/** Who last wrote each section of the page: the takes people defend. */
function writersBlock(league: League, page: PageRow): string {
  const rows = [...sectionAuthors(league.db, page.id)]
    .filter(([key, v]) => key.endsWith('#1') && title(key) && v.author !== 'system')
    .map(([key, v]) => `- ${said(title(key), 40)}: ${who(league, v.author)}, r${v.rev}`)
  return rows.length ? `# 문단마다 마지막으로 고친 사람\n${rows.join('\n')}` : ''
}

/** Where the new comments' numbers start, so the writers can refer to each other's ("#3에 동의합니다"). */
const nextNumber = (db: Db, threadId: number | null) =>
  `새로 쓰는 comments는 차례대로 #${(threadId === null ? 0 : commentCount(db, threadId)) + 1}부터 번호가 붙는다(상태 줄은 번호가 없다).`

const seasonTitleOf = (db: Db) => currentSeason(db).label.trim().replace(/=/g, '')

function factsFor(league: League, subject: { players: string[]; teams: string[] }): string {
  const season = currentSeason(league.db)
  return join2(seasonBlock(league, season.id, season.label, subject.players, subject.teams), loreFor(league, subject.teams, subject.players))
}

const MOOD: Record<WikiConfig['editWars'], string> = {
  off: '편집자들은 싸우지 않는다: 토론으로만 이야기하고, escalate는 쓰지 않는다.',
  sometimes: '편집자들은 사소한 차이는 토론으로 푼다. 편향 서술처럼 제대로 갈릴 때 싸운다.',
  often: '편집자들은 쉽게 물러서지 않는다. 생각이 다르면 싸운다.',
}

// ── Inputs ───────────────────────────────────────────────────────────────

interface Base {
  model: ModelName
  /** Claude Code's --effort for this job (left out: its default). */
  effort?: EffortLevel
  instructions: string
  context: string
  /** Who may write: persona ids. */
  editors: string[]
  asOfEvent: number
  /** The one retry after the first answer used numbers the facts don't hold (these): it's saved with them marked. */
  numberRetry?: string[]
  /** On that retry: the job it redoes (for 최근 작업). */
  retryOf?: number
}

export interface WikiTalkInput extends Base {
  threadId: number
  /** The comment of yours it answers (#n). Left out by jobs queued before it was kept. */
  answers?: number
  /** The page's revision the editors saw: a rewrite of a section changed since is dropped. */
  seen: number
  season?: string
  demo: { editors: string[]; text: string }
}

export interface WikiWarInput extends Base {
  pageId: number
  section: string
  /** The revision whose change is fought over (the defender's), as the section stands. */
  rev: number
  defender: string
  challenger: string
  mediator: string | null
  /** The 토론 this boiled over from (it gets a note pointing at the war's own thread). */
  fromThread: number | null
  demo: { editors: string[]; after: string }
  /** On a retry: when the first try was queued, so the fight is still spread over the time since then. */
  queuedAt?: string
}

export interface WikiPushbackInput extends Base {
  pageId: number
  section: string
  /** Your revision, and the editor whose text it changed. */
  rev: number
  editor: string
  canRevert: boolean
  /** The open dispute on this section (your earlier pushback, or a war holding it), to carry on in. */
  threadId: number | null
  demo: { editors: string[] }
}

/**
 * Your comments in a thread still to answer ("#2, #3"), the last few: those
 * after the newest one an answer that landed (or is being written, other
 * than `except`) was for. An answer redone while you wrote again never
 * landed, so the one waiting answers its comment too.
 */
function unanswered(db: Db, threadId: number, except: number | null = null): string {
  const lines = talkLines(db, threadId)
  const row = db
    .prepare(
      `SELECT MAX(CAST(${jsonField('j.input', '$.answers')} AS INTEGER)) AS n FROM jobs j
       WHERE j.kind = ? AND ${jsonField('j.input', '$.threadId')} = ? AND j.id IS NOT ?
         AND (j.status = 'running' OR EXISTS (SELECT 1 FROM wiki_talk t WHERE t.job_id = j.id))`,
    )
    .get(WIKI_TALK, threadId, except) as { n: number | null }
  // Answers from before they kept what they answered: whatever came after the editors last spoke.
  const since = row.n ?? lines.findLast((l) => l.kind === 'comment' && l.author.kind !== 'user')?.n ?? 0
  return lines
    .filter((l) => l.kind === 'comment' && l.author.kind === 'user' && l.n !== null && l.n > since)
    .slice(-3)
    .map((l) => `#${l.n}`)
    .join(', ')
}

/** The editors' answer to your newest comment in a thread. Null when there's nothing to answer. */
export function talkInput(league: League, threadId: number): WikiTalkInput | null {
  const { db, config } = league
  const thread = threadById(db, threadId)
  if (!thread || thread.status !== 'open') return null
  const page = pageById(db, thread.pageId)
  if (!page || page.currentRev === null) return null
  const lines = talkLines(db, thread.id)
  const mine = [...lines].reverse().find((l) => l.kind === 'comment' && l.author.kind === 'user')
  if (!mine) return null
  const subject = subjectOf(league, page)
  const season = seasonTitleOf(db)
  const authors = sectionAuthors(db, page.id)
  // Whoever wrote what's being argued over answers first: the thread's section, sections your words name, and the regulars.
  const words = `${thread.topic} ${mine.body}`
  const named = [...authors].filter(([key]) => key.endsWith('#1') && title(key).length >= 2 && words.includes(title(key))).map(([, v]) => v.author)
  const regulars = lines.filter((l) => l.author.kind === 'fan' || l.author.kind === 'reporter').map((l) => l.author.id)
  const disputed = thread.section ? authors.get(`${thread.section}#1`)?.author : undefined
  const cast = editorsFor(league, [disputed, ...named, ...regulars].filter((id) => isPersona(db, id)), subject, `talk:${thread.id}:${mine.n}`)
  if (cast.length === 0) return null
  return {
    ...aiFor(config, 'wikiTalk'),
    instructions: `토론 번호 ${thread.id}. 답할 내 글은 ${unanswered(db, thread.id) || `#${mine.n}`}. ${nextNumber(db, thread.id)}${season ? ` 이번 시즌 문단 제목: ${said(season, 40)}.` : ''} ${MOOD[config.wiki.editWars]}`,
    context: join2(
      factsFor(league, subject),
      pageOutline(db, page, season, TALK_SHOWN),
      writersBlock(league, page),
      threadBlock(db, thread),
      castBlock(league, cast, 'editor'),
    ),
    threadId: thread.id,
    answers: mine.n ?? undefined,
    seen: page.currentRev,
    editors: cast.map((p) => p.id),
    season: season || undefined,
    asOfEvent: lastEventId(db),
    demo: { editors: cast.map((p) => p.id), text: mine.body },
  }
}

/** Something one editor wants to fight another over: the section, who objects, and how hot it is (1–5). */
export interface WarCall {
  pageId: number
  section: string
  challenger: string
  heat: number
  why: string
  /** The 토론 it boiled over from. */
  fromThread?: number | null
}

/**
 * An edit war over one section, or null when it isn't one: the setting's
 * heat isn't reached, the section's last change isn't an editor's (yours or
 * the seed's), it holds macro lines or folds, its title isn't unique, it's
 * already in dispute, a war on it is waiting, or three wars are already open
 * or on their way. A war always gets its own thread, which holds the section.
 */
export function warInput(league: League, call: WarCall): WikiWarInput | null {
  const { db, config } = league
  if (!(call.heat >= WAR_HEAT[config.wiki.editWars])) return null
  const page = pageById(db, call.pageId)
  if (!page || page.currentRev === null) return null
  const key = `${call.section}#1`
  const last = sectionAuthors(db, page.id).get(key)
  if (!last || !isPersona(db, last.author) || !isPersona(db, call.challenger) || call.challenger === last.author) return null
  if (openDisputes(db, page.id).some((d) => d.section === call.section)) return null
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND status IN ('queued', 'running')").get(WIKI_WAR) as { n: number }).n
  if (openDisputes(db).filter((d) => d.origin === 'war').length + pending >= MAX_OPEN_WARS) return null
  const waiting = db
    .prepare(`SELECT 1 FROM jobs WHERE kind = ? AND status IN ('queued', 'running') AND ${jsonField('input', '$.pageId')} = ? AND ${jsonField('input', '$.section')} = ? LIMIT 1`)
    .get(WIKI_WAR, page.id, call.section)
  if (waiting) return null
  const was = revisionBody(db, page.id, last.rev - 1)?.body ?? ''
  if (!oneSection(was, call.section) || !oneSection(revisionBody(db, page.id, page.currentRev)!.body, call.section)) return null
  const before = sectionKeys(was).get(key) ?? ''
  if (!fightable(before) || !fightable(last.text)) return null
  const part = disputedPart(before, last.text)
  if (part.before.length + part.after.length === 0) return null
  const subject = subjectOf(league, page)
  const mediator = mediatorFor(league, [last.author, call.challenger], `war:${page.id}:${last.rev}`)
  const cast = editorsFor(league, [call.challenger, last.author, mediator?.id], subject, `war:${page.id}:${last.rev}`, 6)
  // Numbers marked on either version are shown as unverified, as on the page itself.
  const lines = (l: string[], rev: number, body: string) => (l.length ? quoteBlock(tagUnverified(l.join('\n'), pageFlags(db, page.id, rev, body)), 2000) : '│ (없음)')
  const thread = call.fromThread ? threadById(db, call.fromThread) : null
  const dispute = [
    `# 편집 분쟁: 문서 ${said(page.title, 100)}의 문단 ${said(call.section, 40)}`,
    `r${last.rev}에서 ${who(league, last.author)}가 고친 줄들:`,
    `- 고치기 전${part.before.length ? '' : '(없었음: 새로 쓴 줄들)'}:`,
    lines(part.before, last.rev - 1, was),
    '- 고친 뒤(지금 판):',
    lines(part.after, last.rev, revisionBody(db, page.id, last.rev)?.body ?? ''),
    `${who(league, call.challenger)}가 반대한다: ${said(untag(call.why), 120)} (갈린 정도 ${Math.round(call.heat)}/5)`,
    mediator ? `중재에 나설 만한 사람: ${who(league, mediator.id)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ...aiFor(config, 'wikiWar'),
    instructions: `반대하는 사람(challenger)은 ${call.challenger}, 처음 쓴 사람(defender)은 ${last.author}${mediator ? `, 중재자는 ${mediator.id}` : ''}.${
      thread ? ` 토론 ${said(thread.topic, 60)}에서 번진 싸움이다. 새 토론을 연다.` : ''
    } ${nextNumber(db, null)} ${MOOD[config.wiki.editWars]}`,
    context: join2(
      factsFor(league, subject),
      pageOutline(db, page, seasonTitleOf(db)),
      dispute,
      thread ? threadBlock(db, thread) : '',
      castBlock(league, cast, 'editor'),
    ),
    pageId: page.id,
    section: call.section,
    rev: last.rev,
    defender: last.author,
    challenger: call.challenger,
    mediator: mediator?.id ?? null,
    fromThread: thread?.id ?? null,
    editors: cast.map((p) => p.id),
    asOfEvent: lastEventId(db),
    demo: { editors: cast.map((p) => p.id), after: part.after.join('\n') },
  }
}

/** The section of an editor's that your save changed most (worth an answer), found from the database alone. */
export interface PushbackTarget {
  section: string
  editor: string
  /** The section as the editor left it, before your save, and after it. */
  theirs: string
  old: string
  now: string
}

/**
 * Your save changed an editor's text: the biggest such change. Null when
 * there's none worth an answer (each counted by what this save changed),
 * edit wars are off, or an answer to that section is already on its way.
 */
export function pushbackTarget(db: Db, config: LeagueConfig, pageId: number, rev: number, opts: { rebuilding?: boolean } = {}): PushbackTarget | null {
  if (config.wiki.editWars === 'off') return null
  const mine = revisionBody(db, pageId, rev)
  if (!mine || mine.authorId !== 'me' || rev < 2) return null
  const was = revisionBody(db, pageId, rev - 1)?.body ?? ''
  const before = sectionKeys(was)
  const after = sectionKeys(mine.body)
  let best: (PushbackTarget & { size: number }) | null = null
  for (const [key, text] of before) {
    const now = after.get(key)
    const section = title(key)
    if (!key.endsWith('#1') || !section || now === undefined || now === text) continue
    // Two sections of one title: which one was theirs is anyone's guess.
    if (!oneSection(was, section) || !oneSection(mine.body, section)) continue
    // Whose text it was: the last editor to change the section, looking past small tweaks of yours since (a typo fix doesn't make it yours).
    const theirs = [...sectionHistory(db, pageId, key, rev - 1)].reverse().find((h) => h.author !== 'me')
    if (!theirs || !isPersona(db, theirs.author) || changedChars(theirs.text, text) >= SMALL_CHANGE) continue
    // What this save changed is what counts.
    const part = disputedPart(text, now)
    const size = changedChars(part.before.join('\n'), part.after.join('\n'))
    if (size >= SMALL_CHANGE && (!best || size > best.size)) best = { section, editor: theirs.author, theirs: theirs.text, old: text, now, size }
  }
  if (!best) return null
  // Rebuilding the waiting job itself, it doesn't count as another one.
  if (opts.rebuilding) return best
  const waiting = db
    .prepare(`SELECT 1 FROM jobs WHERE kind = ? AND status IN ('queued', 'running') AND ${jsonField('input', '$.pageId')} = ? AND ${jsonField('input', '$.section')} = ? LIMIT 1`)
    .get(WIKI_PUSHBACK, pageId, best.section)
  return waiting ? null : best
}

/**
 * The editor's answer to your change of their text (see pushbackTarget).
 * Null when there's none worth one. `rebuilding` makes a fresh input for
 * the job already waiting.
 */
export function pushbackInput(league: League, pageId: number, rev: number, opts: { rebuilding?: boolean } = {}): WikiPushbackInput | null {
  const { db, config } = league
  const page = pageById(db, pageId)
  const best = page ? pushbackTarget(db, config, pageId, rev, opts) : null
  if (!page || !best) return null
  const { section, old, now } = best
  const part = disputedPart(best.theirs, now)
  // A section a war holds isn't undone by anyone: they argue in the war's thread.
  const open = openDisputes(db, pageId).find((d) => d.section === section)
  const held = open !== undefined && open.origin !== 'pushback'
  const canRevert = !held && !sectionReverted(db, pageId, section) && fightable(old) && fightable(now)
  const thread = open ? threadById(db, open.threadId) : null
  const subject = subjectOf(league, page)
  const cast = editorsFor(league, [best.editor], subject, `pushback:${pageId}:${rev}`, 6)
  // Numbers marked on the editor's text are shown as unverified, in theirs and in what you kept of it.
  const lines = (l: string[], at: number, body: string) => (l.length ? quoteBlock(tagUnverified(l.join('\n'), pageFlags(db, pageId, at, body)), 2000) : '│ (없음: 지웠다)')
  const summary = (db.prepare('SELECT summary FROM wiki_revisions WHERE page_id = ? AND rev = ?').get(pageId, rev) as { summary: string } | undefined)?.summary ?? ''
  const change = [
    `# 내가 고친 서술: 문서 ${said(page.title, 100)}의 문단 ${said(section, 40)}`,
    `이 문단은 ${who(league, best.editor)}가 쓴 것인데, 내가(사용자) r${rev}에서 고쳤다.`,
    `- ${best.editor}가 쓴 줄:`,
    lines(part.before, rev - 1, best.theirs),
    '- 내가 바꾼 줄:',
    lines(part.after, rev, revisionBody(db, pageId, rev)?.body ?? ''),
    summary ? `내 편집 요약: ${said(summary, 100)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ...aiFor(config, 'wikiTalk'),
    instructions: `내 편집에 반응하는 사람은 ${best.editor}.${
      held ? ' 이 문단은 편집 분쟁으로 토론이 끝날 때까지 서술 고정 중이다: 되돌리지 않고 그 토론에서 이야기한다.' : canRevert ? '' : ' 이번에는 되돌릴 수 없다: stance에 revert를 쓰지 않는다.'
    }${thread ? ` 이미 열린 토론 ${said(thread.topic, 60)}에서 이어진다.` : ''} ${nextNumber(db, thread?.id ?? null)} ${MOOD[config.wiki.editWars]}`,
    context: join2(factsFor(league, subject), pageOutline(db, page, seasonTitleOf(db)), change, thread ? threadBlock(db, thread) : '', castBlock(league, cast, 'editor')),
    pageId,
    section,
    rev,
    editor: best.editor,
    canRevert,
    threadId: thread?.id ?? null,
    editors: cast.map((p) => p.id),
    asOfEvent: lastEventId(db),
    demo: { editors: cast.map((p) => p.id) },
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────

const comment = z.object({ editor: z.string().describe('쓸 수 있는 사람의 id'), text: z.string().describe('토론 댓글, 600자 이내') })
const memories = z
  .array(z.object({ author: z.string(), note: z.string() }))
  .default([])
  .describe('이 토론으로 생긴 앙금이나 약속처럼 그 사람이 나중에 기억할 한 줄(100자 이내). 없으면 빈 배열')

export const talkOutputSchema = z.object({
  comments: z.array(comment).default([]).describe('토론 댓글 1~4개'),
  edit: z
    .object({
      section: z.string().describe('고칠 문단 제목'),
      mode: z.enum(['append', 'replace']),
      text: z.string().describe('나무위키 문법의 문단 내용(제목 줄 없이), 1000자 이내'),
      summary: z.string().describe('편집 요약, 30자 이내'),
      editor: z.string(),
    })
    .nullable()
    .default(null)
    .describe('토론이 합의에 이르러 문서를 고칠 때만. 아니면 null'),
  close: z.object({ editor: z.string(), note: z.string().describe('결론 한 줄') }).nullable().default(null).describe('토론이 끝났을 때만. 아니면 null'),
  escalate: z
    .object({
      section: z.string(),
      challenger: z.string().describe('서술을 고치려는 편집자 id(그 문단을 쓴 사람이 아닌)'),
      heat: z.number().describe('갈린 정도 1~5'),
      why: z.string().describe('60자 이내'),
    })
    .nullable()
    .default(null)
    .describe('의견이 너무 갈려 편집자들끼리 문단을 두고 싸움이 날 때만. 아니면 null'),
  memories,
})

export const warOutputSchema = z.object({
  steps: z
    .array(
      z.object({
        text: z.string().nullable().describe('null: 자기 쪽 판으로 되돌림. 글: 다툰 줄들을 이렇게 고쳐 씀(제목 줄, 분류, [각주] 같은 줄 없이)'),
        summary: z.string().describe('편집 요약, 30자 이내'),
      }),
    )
    .default([])
    .describe('되돌리기 싸움 1~3번. 첫 번째는 challenger, 그다음 defender, 번갈아'),
  topic: z.string().describe('토론 주제, 40자 이내'),
  comments: z.array(comment).default([]).describe('토론 댓글 4~10개'),
  outcome: z.object({
    agreed: z.boolean(),
    text: z.string().nullable().describe('합의한 줄들(다툰 줄들 자리에 들어갈 글). 지금 판 그대로면 null'),
    editor: z.string().describe('합의안을 반영하는 사람 id'),
    summary: z.string().describe('합의안 편집 요약'),
    note: z.string().describe('결론 한 줄'),
  }),
  memories,
})

export const pushbackOutputSchema = z.object({
  stance: z.enum(['accept', 'talk', 'revert']).describe('accept: 수긍, talk: 토론에서 따짐, revert: 되돌리고 토론에서 따짐'),
  summary: z.string().describe('되돌릴 때의 편집 요약, 30자 이내'),
  topic: z.string().describe('토론 주제, 40자 이내'),
  comments: z.array(comment).default([]).describe('토론 댓글 2~6개(accept면 빈 배열)'),
  memories,
})

export type WikiTalkOutput = z.infer<typeof talkOutputSchema>
export type WikiWarOutput = z.infer<typeof warOutputSchema>
export type WikiPushbackOutput = z.infer<typeof pushbackOutputSchema>

// ── Saving ───────────────────────────────────────────────────────────────

const saved = (db: Db, jobId: number) =>
  Boolean(db.prepare('SELECT 1 FROM wiki_talk WHERE job_id = ? LIMIT 1').get(jobId) ?? db.prepare('SELECT 1 FROM wiki_revisions WHERE job_id = ? LIMIT 1').get(jobId))

/** New text for the disputed lines, if an editor may write it: plain lines, no headings, macros or folds. */
const cleanLines = (text: string | null | undefined): string[] | null => {
  if (text == null) return null
  const t = untag(text).replace(/\r\n?/g, '\n').slice(0, 1500).replace(/^(\s*\n)+/, '').replace(/\s+$/, '')
  return t && safeEditText(t) && fightable(t) ? t.split('\n') : null
}

export interface WikiTalkHooks {
  /** A 토론 boiled over: an edit war, if the setting lets it. */
  war?: (call: WarCall) => void
  /** Editors answered in a thread (a 토론 answer or a pushback): answers still waiting for it are rebuilt to see theirs. */
  answered?: (threadId: number) => void
  /** Queues the same kind again after an answer used numbers the facts don't hold. Left out: no retry, the numbers are marked. */
  requeue?: (kind: string, input: WikiTalkInput | WikiWarInput | WikiPushbackInput) => void
}

/**
 * The numbers a 토론 answer carries when it's rebuilt as the retry (or made
 * one): it stays the retry, but names the numbers only while it answers the
 * same comment of yours, since an answer to another comment didn't write
 * them. Undefined: it wasn't a retry.
 */
export function talkRetry(old: { numberRetry?: string[]; answers?: number }, now: { answers?: number }): string[] | undefined {
  if (old.numberRetry === undefined) return undefined
  return old.answers !== undefined && old.answers === now.answers ? old.numberRetry : []
}

/** Checks an answer's numbers as it's saved; the first try of a job that can be retried is undone by them. */
const gateFor = (input: Base, hooks: WikiTalkHooks) => numberGate(readFacts(input.context, input.instructions), input.numberRetry !== undefined || !hooks.requeue)

/** Runs a hook after a job's results are saved; its failure mustn't undo them. */
function afterwards(what: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.warn(`[wiki] ${what} failed`, e)
  }
}

function acceptTalk(db: Db, out: WikiTalkOutput, job: JobRow, hooks: WikiTalkHooks): void {
  const input = job.input as WikiTalkInput
  if (saved(db, job.id)) return
  const thread = threadById(db, input.threadId)
  // You closed it meanwhile: the answers came too late.
  if (!thread || thread.status !== 'open') return
  const editor = (id: string) => (input.editors.includes(id) ? id : (input.editors[0] ?? 'system'))
  let t = Date.now()
  const next = () => iso(t++)
  let edited: { rev: number; section: string } | null = null
  const gate = gateFor(input, hooks)
  try {
    transaction(db, () => {
      for (const c of out.comments.slice(0, 6)) {
        const body = untag(c.text).slice(0, 1000)
        if (body.trim()) addTalk(db, thread.id, { authorId: editor(c.editor), body, jobId: job.id, flags: gate.check(body) }, next())
      }
      // Summaries and notes aren't checked, but they don't keep a copied tag either.
      const edit = out.edit ? { ...out.edit, text: untag(out.edit.text), summary: untag(out.edit.summary).slice(0, 60), editor: editor(out.edit.editor) } : null
      edited = edit ? talkEdit(db, thread, input, edit, job.id, gate.check) : null
      if (edited) addTalk(db, thread.id, { kind: 'status', authorId: edit!.editor, body: `r${edited.rev} 편집: ${edit!.summary || '토론 합의 반영'}`, rev: edited.rev, jobId: job.id }, next())
      // A dispute's thread ends when its own section is settled; an edit elsewhere doesn't release the hold.
      if (out.close || (edited && thread.origin !== 'user' && edited.section === thread.section)) {
        closeThread(db, thread.id, editor(out.close?.editor ?? out.edit!.editor), out.close ? untag(out.close.note) : '합의에 따라 고침', next())
      }
      remember(db, out.memories.slice(0, 6), job.id, t)
      gate.redoIfAny()
    })
  } catch (e) {
    if (!(e instanceof NumbersRedo)) throw e
    // Nothing of this answer stays (no edit, no close, no war): the same answer again, with a note. If an answer
    // is already waiting in the thread (you wrote again meanwhile), it becomes the retry instead: a second one
    // would answer your newest comment twice.
    const retry: WikiTalkInput = { ...input, numberRetry: e.numbers, retryOf: job.id }
    const waiting = db
      .prepare(`SELECT id, input FROM jobs WHERE kind = ? AND status = 'queued' AND ${jsonField('input', '$.threadId')} = ? ORDER BY id DESC LIMIT 1`)
      .get(WIKI_TALK, thread.id) as { id: number; input: string } | undefined
    if (!waiting) {
      hooks.requeue!(WIKI_TALK, retry)
      return
    }
    const old = JSON.parse(waiting.input) as WikiTalkInput
    // It answers the comments this answer was for too: none of it landed.
    const open = unanswered(db, thread.id, job.id)
    const instructions = open ? old.instructions.replace(/답할 내 글은 [^.]*\./, `답할 내 글은 ${open}.`) : old.instructions
    const merged = { ...old, instructions, numberRetry: old.numberRetry ?? talkRetry(retry, old)!, retryOf: old.retryOf ?? job.id }
    db.prepare("UPDATE jobs SET input = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify(merged), waiting.id)
    return
  }
  // A thread that just closed (or that you closed meanwhile), or that just agreed on an edit, doesn't boil over.
  const e = out.escalate
  const section = e ? (input.season && SEASON_PARENTS.includes(e.section.trim()) ? input.season : e.section.trim()) : ''
  if (e && section && !edited && hooks.war && threadById(db, thread.id)?.status === 'open') {
    afterwards('starting an edit war', () => hooks.war!({ pageId: thread.pageId, section, challenger: e.challenger, heat: e.heat, why: e.why, fromThread: thread.id }))
  }
  if (hooks.answered) afterwards('rebuilding a waiting answer', () => hooks.answered!(thread.id))
}

/**
 * The edit a thread agreed on, with the round editors' guards. Returns the
 * new revision and the section it wrote, or null. `check` gives the numbers
 * to mark in the text (and counts them toward a retry) once it lands.
 */
function talkEdit(
  db: Db,
  thread: ThreadRow,
  input: WikiTalkInput,
  e: NonNullable<WikiTalkOutput['edit']>,
  jobId: number,
  check: (text: string) => string[],
): { rev: number; section: string } | null {
  const page = pageById(db, thread.pageId)
  if (!page || page.currentRev === null) return null
  const section = input.season && SEASON_PARENTS.includes(e.section.trim()) ? input.season : e.section.trim()
  // Another thread's disputed section waits for that thread.
  if (openDisputes(db, page.id).some((d) => d.section === section && d.threadId !== thread.id)) return null
  let body = revisionBody(db, page.id, page.currentRev)!.body
  if (e.mode === 'replace') {
    const text = sectionBody(body, section)
    if (text !== null && text.length > (section === input.season ? SHOWN_SEASON : TALK_SHOWN)) return null
    const then = revisionBody(db, page.id, input.seen)?.body
    if (then === undefined || sectionKeys(then).get(`${section}#1`) !== sectionKeys(body).get(`${section}#1`)) return null
  }
  if (input.season && section === input.season) body = ensureSeasonSection(body, input.season)
  const next = guardedEdit(body, ownedSections(db, page.id), { ...e, section }, input.season)
  if (next === null) return null
  const flags = check(e.text.slice(0, 1500))
  const { rev } = saveRevision(db, { title: page.title, body: next, authorId: e.editor, summary: e.summary.slice(0, 60) || '토론 합의 반영', jobId, baseRev: page.currentRev, flags }, Date.now())
  return { rev, section }
}

function acceptWar(db: Db, out: WikiWarOutput, job: JobRow, hooks: WikiTalkHooks): void {
  const input = job.input as WikiWarInput
  if (saved(db, job.id)) return
  const page = pageById(db, input.pageId)
  if (!page || page.currentRev === null) return
  const key = `${input.section}#1`
  const atRev = revisionBody(db, page.id, input.rev)
  let body = revisionBody(db, page.id, page.currentRev)!.body
  // Someone changed the section since (you, or another job): the fight is about text that's gone.
  if (!atRev || sectionKeys(atRev.body).get(key) !== sectionKeys(body).get(key)) return
  if (ownedSections(db, page.id).has(key) || !oneSection(body, input.section)) return
  if (openDisputes(db, page.id).some((d) => d.section === input.section)) return
  const before = sectionKeys(revisionBody(db, page.id, input.rev - 1)?.body ?? '').get(key) ?? ''
  const part = disputedPart(before, sectionKeys(atRev.body).get(key)!)
  const editor = (id: string, fallback: string) => (input.editors.includes(id) ? id : fallback)
  const steps = out.steps.slice(0, MAX_STEPS)
  const comments = out.comments.filter((c) => c.text.trim()).slice(0, 12)
  if (steps.length === 0 && comments.length === 0) return
  // Fights land over the time since the job was (first) queued, in order: reverts, the thread, the outcome.
  const queued = input.queuedAt ?? job.createdAt
  const from = Math.max(Date.parse(queued) || Date.now(), Date.parse(page.updatedAt) || 0)
  const times = spread(from, Date.now(), steps.length + comments.length + 5)
  let at = 0
  const tick = () => times[at++] ?? Date.now()
  const gate = gateFor(input, hooks)
  try {
    transaction(db, () => {
      const versions = { challenger: part.before, defender: part.after }
      let mid = part.after
      let first: number | null = null
      let last: number | null = null
      const put = (lines: string[], author: string, summary: string): number | null => {
        if (lines.join('\n') === mid.join('\n')) return null
        const next = setSectionText(body, key, [...part.head, ...lines, ...part.tail].join('\n'))
        if (next === null || next === body) return null
        const flags = gate.check(lines.join('\n'))
        const { rev } = saveRevision(db, { title: page.title, body: next, authorId: author, summary: untag(summary).slice(0, 60) || '편집', jobId: job.id, flags }, tick())
        body = next
        mid = lines
        first ??= rev
        last = rev
        return rev
      }
      steps.forEach((s, i) => {
        const side = i % 2 === 0 ? 'challenger' : 'defender'
        const own = cleanLines(s.text)
        if (own) versions[side] = own
        put(versions[side], input[side], s.summary || (side === 'challenger' ? '편향 서술 수정' : '되돌림'))
      })
      const topic = untag(out.topic).trim() || `'${input.section}' 문단 서술 관련`
      const id = openThread(
        db,
        { pageId: page.id, topic, origin: 'war', section: input.section, openedBy: input.challenger, roundsLeft: DISPUTE_ROUNDS, jobId: job.id },
        iso(tick()),
      )
      // The 토론 it boiled over from points at it (that thread itself never holds the section).
      const from = input.fromThread ? threadById(db, input.fromThread) : null
      if (from?.status === 'open') {
        addTalk(db, from.id, { kind: 'status', authorId: input.challenger, body: `'${input.section}' 문단을 두고 편집 분쟁이 번졌다: 토론 「${topic}」`, jobId: job.id }, iso(tick()))
      }
      if (first !== null) {
        addTalk(db, id, { kind: 'status', authorId: input.challenger, body: `편집 분쟁: '${input.section}' 문단이 r${first}~r${last}에서 오갔다`, rev: last, jobId: job.id }, iso(tick()))
      }
      for (const c of comments) {
        const text = untag(c.text).slice(0, 1000)
        addTalk(db, id, { authorId: editor(c.editor, input.challenger), body: text, jobId: job.id, flags: gate.check(text) }, iso(tick()))
      }
      const o = out.outcome
      if (o.agreed) {
        const agreed = cleanLines(o.text)
        const by = editor(o.editor, input.mediator ?? input.defender)
        const summary = untag(o.summary).slice(0, 60)
        const rev = agreed ? put(agreed, by, summary || '토론 합의 반영') : null
        if (rev !== null) addTalk(db, id, { kind: 'status', authorId: by, body: `r${rev} 편집: ${summary || '토론 합의 반영'}`, rev, jobId: job.id }, iso(tick()))
        closeThread(db, id, by, untag(o.note) || '합의', iso(tick()))
      } else {
        // 서술 고정: until the thread agrees, the section reads as it did before the disputed edit.
        const by = input.mediator ?? input.challenger
        const rev = put(part.before, by, '토론 중 서술 고정')
        if (rev !== null) addTalk(db, id, { kind: 'status', authorId: by, body: `r${rev}: 토론이 끝날 때까지 분쟁 전 판으로 서술 고정`, rev, jobId: job.id }, iso(tick()))
      }
      remember(db, out.memories.slice(0, 6), job.id, Date.now())
      gate.redoIfAny()
    })
  } catch (e) {
    if (!(e instanceof NumbersRedo)) throw e
    // No revision, thread or note of it stays: the same war again, still spread over the time since it was first queued.
    hooks.requeue!(WIKI_WAR, { ...input, queuedAt: queued, numberRetry: e.numbers, retryOf: job.id })
  }
}

function acceptPushback(db: Db, out: WikiPushbackOutput, job: JobRow, hooks: WikiTalkHooks): void {
  const input = job.input as WikiPushbackInput
  if (saved(db, job.id)) return
  const page = pageById(db, input.pageId)
  if (!page || page.currentRev === null) return
  const editor = (id: string) => (input.editors.includes(id) ? id : input.editor)
  const comments = out.comments.filter((c) => c.text.trim()).slice(0, 8)
  if (out.stance === 'accept' || comments.length === 0) {
    remember(db, out.memories.slice(0, 6), job.id, Date.now())
    return
  }
  const key = `${input.section}#1`
  const mine = revisionBody(db, page.id, input.rev)
  const body = revisionBody(db, page.id, page.currentRev)!.body
  let t = Date.now()
  const next = () => iso(t++)
  let into: number | null = null
  const gate = gateFor(input, hooks)
  try {
    transaction(db, () => {
      let reverted: number | null = null
      // The one revert: only while the section still reads as you left it, and edit wars are still on.
      const stillYours = mine !== null && sectionKeys(mine.body).get(key) === sectionKeys(body).get(key) && oneSection(body, input.section)
      const held = openDisputes(db, page.id).some((d) => d.section === input.section && d.origin !== 'pushback')
      if (out.stance === 'revert' && input.canRevert && stillYours && !held && loadConfig(db).config.wiki.editWars !== 'off' && !sectionReverted(db, page.id, input.section)) {
        const old = sectionKeys(revisionBody(db, page.id, input.rev - 1)?.body ?? '').get(key)
        const restored = old === undefined ? null : setSectionText(body, key, old)
        if (restored !== null && restored !== body) {
          reverted = saveRevision(db, { title: page.title, body: restored, authorId: input.editor, summary: untag(out.summary).slice(0, 60) || '근거 없는 수정 되돌림', jobId: job.id, baseRev: page.currentRev }, t++).rev
        }
      }
      const open = input.threadId ? threadById(db, input.threadId) : null
      const id =
        open && open.status === 'open'
          ? open.id
          : openThread(
              db,
              { pageId: page.id, topic: untag(out.topic).trim() || `'${input.section}' 문단 서술 관련`, origin: 'pushback', section: input.section, openedBy: input.editor, roundsLeft: DISPUTE_ROUNDS, jobId: job.id },
              next(),
            )
      if (reverted !== null) {
        db.prepare('UPDATE wiki_threads SET reverted = 1 WHERE id = ?').run(id)
        addTalk(db, id, { kind: 'status', authorId: input.editor, body: `r${reverted}: r${input.rev}의 '${input.section}' 문단 수정을 되돌림`, rev: reverted, jobId: job.id }, next())
      }
      for (const c of comments) {
        const text = untag(c.text).slice(0, 1000)
        addTalk(db, id, { authorId: editor(c.editor), body: text, jobId: job.id, flags: gate.check(text) }, next())
      }
      remember(db, out.memories.slice(0, 6), job.id, t)
      gate.redoIfAny()
      into = id
    })
  } catch (e) {
    if (!(e instanceof NumbersRedo)) throw e
    // The revert (if any) is undone with the comments: the same answer again, with a note.
    hooks.requeue!(WIKI_PUSHBACK, { ...input, numberRetry: e.numbers, retryOf: job.id })
    return
  }
  // Answers still waiting in that thread see these comments (and number theirs after them).
  const thread = into
  if (thread !== null && hooks.answered) afterwards('rebuilding a waiting answer', () => hooks.answered!(thread))
}

// ── Kinds ────────────────────────────────────────────────────────────────

const TALK_RULES = `
토론 규칙:
- 토론 댓글은 존댓말로, 근거를 들어 쓴다. 앞 댓글에 답할 때는 "#3 "처럼 번호로 시작한다. 성격과 응원 학교는 무엇을 주장하고 어디까지 물러서느냐로 드러난다. 욕설, 비하는 쓰지 않는다.
- "나"는 사용자다. 나에게 답할 때도 위키 토론답게 쓴다.
- 자료(기록, 순위)로 맞는 지적이면 받아들인다. 해석이나 평가의 문제면 성격대로 반박하거나 절충안을 낸다.
- 합의는 수정안(#번호)에 동의가 모이면 "#4를 합의안으로 하겠습니다"라고 정리한 뒤 고친다. 합의 없이 고치지 않는다.
- 편집 요약은 짧게("편향 서술 수정", "반달 복구"). 숫자와 사실은 자료에 있는 것만 쓴다.
- 숫자 뒤에 "(확인 안 된 숫자)"가 붙어 있으면 확인되지 않은 숫자다. 문제 삼을 수는 있지만 사실처럼 되풀이하지 않는다.`

const INSTRUCTIONS = {
  [WIKI_TALK]:
    '토론에 내가 쓴 글에 편집자들이 답한다(comments 1~4개). 문제 삼은 서술을 쓴 사람이 먼저 답한다. 다른 편집자가 끼어들어 편을 든다. 합의가 되면 edit로 문서를 고친다(내가 쓴 부분은 고칠 수 없고, 합의 없이는 고치지 않는다). 토론이 끝났으면 close. 의견이 너무 갈려 편집자들끼리 문단을 두고 싸울 판이면 escalate.',
  [WIKI_WAR]:
    '편집 분쟁을 쓴다. steps는 다툰 줄들을 두고 오간 되돌리기다: 첫 번째는 challenger, 다음은 defender, 번갈아 1~3번. 갈림이 클수록 길다. text가 null이면 자기 쪽 판으로 되돌리고, 글이면 다툰 줄들을 고쳐 쓴다. 그다음 토론(topic, comments 4~10개): 양쪽과 중재자, 끼어드는 사람. outcome: 합의했으면 agreed와 합의한 줄들(text), 못 했으면 agreed false(지금 판이 남고 토론은 열린 채로 간다).',
  [WIKI_PUSHBACK]:
    '내가(사용자) 편집자의 서술을 고쳤다. 그 편집자가 반응한다: 얼마나 다르게 생각하느냐에 따라 stance를 고른다. 맞는 지적이거나 사소하면 accept, 따질 만하면 talk, 절대 못 받아들이면 revert(내 수정을 한 번 되돌린다). accept가 아니면 토론 topic과 comments 2~6개: 그 편집자가 먼저 쓰고, 편드는 사람과 내 편을 드는 사람이 끼어든다.',
} as const

export interface WikiTalkKindsOptions {
  style?: () => string | null
  hooks?: WikiTalkHooks
}

/** The three 토론 kinds. `style` is the editable wiki guide (defaults/prompts/wiki.md); null falls back to the built-in one. */
export function wikiTalkKinds(db: Db, opts: WikiTalkKindsOptions = {}): JobKind<unknown, unknown>[] {
  const system = () => opts.style?.() ?? STYLE
  // The 토론 rules ride with each job, so a league's own guide without them still gets them.
  const prompt = (kind: keyof typeof INSTRUCTIONS) => (input: Base) => withRetryNote(`${INSTRUCTIONS[kind]}\n${TALK_RULES}\n\n${input.instructions}`.trim(), input.numberRetry)
  const fresh = (job: JobRow, hours: number) => Date.now() - Date.parse(job.createdAt) < hours * 3600_000
  const talk: JobKind<WikiTalkInput, WikiTalkOutput> = {
    kind: WIKI_TALK,
    model: (i) => i.model,
    effort: (i) => i.effort,
    tools: [],
    output: talkOutputSchema,
    systemPrompt: system,
    prompt: prompt(WIKI_TALK),
    stdin: (i) => i.context,
    timeoutMs: 6 * 60_000,
    stillWanted: (i, job) => fresh(job, 6) && threadById(db, i.threadId)?.status === 'open',
    accept: (out, job) => acceptTalk(db, out, job, opts.hooks ?? {}),
  }
  const war: JobKind<WikiWarInput, WikiWarOutput> = {
    kind: WIKI_WAR,
    model: (i) => i.model,
    effort: (i) => i.effort,
    tools: [],
    output: warOutputSchema,
    systemPrompt: system,
    prompt: prompt(WIKI_WAR),
    stdin: (i) => i.context,
    timeoutMs: 6 * 60_000,
    stillWanted: (_i, job) => fresh(job, 24) && loadConfig(db).config.wiki.editWars !== 'off',
    accept: (out, job) => acceptWar(db, out, job, opts.hooks ?? {}),
  }
  const pushback: JobKind<WikiPushbackInput, WikiPushbackOutput> = {
    kind: WIKI_PUSHBACK,
    model: (i) => i.model,
    effort: (i) => i.effort,
    tools: [],
    output: pushbackOutputSchema,
    systemPrompt: system,
    prompt: prompt(WIKI_PUSHBACK),
    stdin: (i) => i.context,
    timeoutMs: 6 * 60_000,
    stillWanted: (_i, job) => fresh(job, 24) && loadConfig(db).config.wiki.editWars !== 'off',
    accept: (out, job) => acceptPushback(db, out, job, opts.hooks ?? {}),
  }
  return [talk, war, pushback] as unknown as JobKind<unknown, unknown>[]
}

/** Demo answers (TWOK_FAKE_AI=1): a polite reply, a two-step war settled by a footnote, a pushback that reverts once. */
export function wikiTalkDemo(kind: string, input: unknown): unknown {
  if (kind === WIKI_TALK) {
    const i = input as WikiTalkInput
    const [a, b] = [i.demo.editors[0] ?? 'system', i.demo.editors[1] ?? i.demo.editors[0] ?? 'system']
    return {
      comments: [
        { editor: a, text: `${said(i.demo.text, 30)} 부분은 자료를 다시 확인해 보겠습니다.` },
        { editor: b, text: '근거가 있으면 고치는 게 맞다고 봅니다.' },
      ],
      edit: null,
      close: null,
      escalate: null,
      memories: [],
    } satisfies WikiTalkOutput
  }
  if (kind === WIKI_WAR) {
    const i = input as WikiWarInput
    const lines = i.demo.after.split('\n')
    lines[lines.length - 1] = `${lines.at(-1) ?? ''}[* 토론 합의로 표현을 다듬었다.]`
    return {
      steps: [
        { text: null, summary: '편향 서술 삭제' },
        { text: null, summary: '반달 복구' },
      ],
      topic: `'${i.section}' 문단 서술 관련`,
      comments: [
        { editor: i.challenger, text: '근거 없는 평가라 지웠습니다.' },
        { editor: i.defender, text: '기록에 있는 내용입니다. 합의 없이 지우지 마시죠.' },
        { editor: i.mediator ?? i.challenger, text: '표현만 다듬고 남기는 쪽으로 정리하겠습니다.' },
      ],
      outcome: { agreed: true, text: lines.join('\n'), editor: i.mediator ?? i.defender, summary: '토론 합의 반영', note: '표현을 다듬어 남기기로 함' },
      memories: [],
    } satisfies WikiWarOutput
  }
  if (kind === WIKI_PUSHBACK) {
    const i = input as WikiPushbackInput
    return {
      stance: i.canRevert ? 'revert' : 'talk',
      summary: '근거 없는 수정 되돌림',
      topic: `'${i.section}' 문단 서술 관련`,
      comments: [
        { editor: i.editor, text: '기록을 근거로 쓴 문장입니다. 지우신 이유를 듣고 싶습니다.' },
        { editor: i.demo.editors[1] ?? i.editor, text: '양쪽 다 일리가 있어 보입니다. 표현을 조정하면 어떨까요.' },
      ],
      memories: [],
    } satisfies WikiPushbackOutput
  }
  return null
}
