/** What the wiki screens show; built in the main process, read by the renderer. */

import type { TextDiff } from './diff'

export type WikiKind = 'player' | 'team' | 'league' | 'season' | 'rules' | 'awards' | 'draft' | 'topic' | 'page'

export interface WikiAuthor {
  id: string
  nick: string
  kind: 'system' | 'user' | 'fan' | 'reporter'
}

/** The box at the top right, filled from the league data (never from the page text). */
export interface Infobox {
  title: string
  subtitle: string | null
  colors: string[]
  rows: { label: string; value: string; link: string | null }[]
}

/** A table the screen draws for a macro such as [기록]. */
export interface WikiTable {
  columns: string[]
  /** Which column shows the row's link. */
  linkColumn: number
  rows: { cells: string[]; link: string | null }[]
}

export interface HistoryItem {
  at: string
  season: string
  text: string
}

/** Live data for the page's infobox and macros. */
export interface WikiData {
  infobox: Infobox | null
  /** [기록]: season stats for a player or team, standings for a season, winners for awards. */
  record: WikiTable | null
  /** [역사]: a player's timeline. */
  history: HistoryItem[]
  /** [정보]: a team's roster. */
  roster: WikiTable | null
  /** [최근경기]: recent games. */
  recent: WikiTable | null
}

export interface WikiPageView {
  title: string
  exists: boolean
  kind: WikiKind | null
  /** The revision shown, and the newest one. */
  rev: number | null
  latestRev: number | null
  source: string
  updatedAt: string | null
  author: WikiAuthor | null
  /** Linked titles that exist (others show as red links). */
  existing: string[]
  backlinks: number
  data: WikiData
  talk: WikiPageTalk
  /**
   * Numbers an AI editor wrote that its facts didn't hold (only you see this):
   * the shown revision's, and earlier revisions' its text still uses.
   */
  flags: string[]
}

export interface WikiRevisionView {
  pageTitle: string
  rev: number
  author: WikiAuthor
  summary: string
  sizeDelta: number
  createdAt: string
  /** Numbers this revision's AI editor wrote that its facts didn't hold. */
  flags: string[]
}

/** A 토론 thread in a list. 'war' and 'pushback' threads are disputes over one section. */
export interface WikiThreadSummary {
  id: number
  pageTitle: string
  topic: string
  status: 'open' | 'closed'
  origin: 'user' | 'war' | 'pushback'
  section: string | null
  openedBy: WikiAuthor
  comments: number
  createdAt: string
  updatedAt: string
}

/** One line of a thread: a comment (numbered #1, #2…), or a grey status line (an edit made, closed…), unnumbered. */
export interface WikiTalkLine {
  /** Order in the thread, for every line. */
  seq: number
  /** The comment's number; null for a status line. */
  n: number | null
  kind: 'comment' | 'status'
  author: WikiAuthor
  body: string
  /** The revision a status line points at. */
  rev: number | null
  createdAt: string
  /** Numbers in a comment that its editor's facts didn't hold. */
  flags: string[]
}

export interface WikiThreadView extends WikiThreadSummary {
  lines: WikiTalkLine[]
  closeNote: string | null
  /** Editors are writing replies (a job is waiting or running). */
  replying: boolean
}

/** The 토론 side of a page: how many threads are open, and the sections editors are fighting over. */
export interface WikiPageTalk {
  open: number
  disputes: { threadId: number; section: string; topic: string; origin: 'war' | 'pushback' }[]
}

/** 비교: two revisions of a page, older first, and the lines between them. */
export interface WikiDiffView {
  title: string
  from: WikiRevisionView
  to: WikiRevisionView
  latestRev: number
  diff: TextDiff
}

export interface WikiSearchResult {
  title: string
  kind: WikiKind
  snippet: string
}

/** A new 토론 thread of yours: its topic and opening comment. */
export interface WikiThreadInput {
  title: string
  topic: string
  body: string
}

export interface WikiSaveInput {
  title: string
  source: string
  summary: string
  /** The revision the edit started from; a newer one in between is a conflict. Null for a new page. */
  baseRev: number | null
}
