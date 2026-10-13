/** What the wiki screens show; built in the main process, read by the renderer. */

import type { TextDiff } from './diff'

export type WikiKind = 'player' | 'team' | 'league' | 'season' | 'rules' | 'awards' | 'draft' | 'topic' | 'page'

export interface WikiAuthor {
  id: string
  nick: string
  kind: 'system' | 'user' | 'fan' | 'reporter'
}

/** One row of an infobox. Rows without a value aren't sent. */
export interface InfoboxRow {
  label: string
  value: string
  link: string | null
  /** The value is namumark (a bold position, links to rivals), drawn as the page draws its text. */
  wiki?: boolean
  /** Colour swatches after the value (a school's 팀 컬러). */
  swatches?: string[]
}

/** The box at the top right, filled from the league data (never from the page text). */
export interface Infobox {
  /** A band above the title, in the school's colours: a player's school, as Namuwiki's "팀 No. 번호" bar. */
  band?: string | null
  title: string
  subtitle: string | null
  /** The school's colours (its lore's, else 리그 설정's): the header's background, then its text. */
  colors: string[]
  rows: InfoboxRow[]
  /**
   * A player's 2K ratings in Korean, folded away until opened ("[ 능력치
   * 펼치기 · 접기 ]": Namuwiki never shows a rating table openly): the overall
   * and every rating column, grades coloured by the league's scale. `source`
   * is the column's own name, a hover hint when the label translates it.
   */
  ratings?: { title: string; rows: { label: string; value: string; grade: boolean; source: string }[] } | null
}

/** How a playoff cell is coloured in a school's season table: 우승 gold, 준우승 silver, 진출 orange, 탈락 blue. */
export type CellTone = 'gold' | 'silver' | 'orange' | 'blue'

/** A table the screen draws for a macro such as [기록]. */
export interface WikiTable {
  columns: string[]
  /** Which column shows the row's link. */
  linkColumn: number
  /**
   * `bold`: cells to set in bold (a league-leading figure, a career high);
   * `total`: the 통산 row (pale yellow); `tones`: coloured cells, by column.
   */
  rows: { cells: string[]; link: string | null; bold?: number[]; total?: boolean; tones?: Record<number, CellTone> }[]
  /** Columns whose cells are grades (coloured by the league's scale). */
  grades?: number[]
  /** A header's hover hint (a rating column's own name), by column. */
  hints?: (string | null)[]
  /** The header row in these colours (a school's), as Namuwiki's tables have it. */
  colors?: string[]
}

/** One line of [인간관계]: a tie from the player's lore (or the other player's), public or rumoured, never secret. */
export interface WikiRelation {
  name: string
  /** The other player's page, when he has one. */
  link: string | null
  /** His school, when he's a player of this league. */
  team: string | null
  /** The kind of tie, as lore has it: friend, rival, family, mentor, dislikes. */
  kind: string
  /** As the page says it: 절친, 숙적, or "라이벌이라는 소문이 있다" for a rumour. */
  text: string
  /** Only rumoured (소문). */
  rumor: boolean
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
  /** [인간관계]: a player's ties, as his and other players' lore have them (public or rumoured, never secret). */
  relations: WikiRelation[]
  /**
   * Text the app writes for a section while it has none of its own, by the
   * section's title (namumark): a player's 개요 and 플레이 스타일. Never
   * stored, so it follows the league, and it's no one's edit.
   */
  auto: Record<string, string>
}

/** Whether one of the app's macros has anything to show (an empty one leaves its section out of the page). */
export function macroFilled(data: WikiData, name: string): boolean {
  switch (name) {
    case '기록':
      return (data.record?.rows.length ?? 0) > 0
    case '정보':
      return (data.roster?.rows.length ?? 0) > 0
    case '최근경기':
      return (data.recent?.rows.length ?? 0) > 0
    case '역사':
      return data.history.length > 0
    case '인간관계':
      return data.relations.length > 0
    default:
      return false
  }
}

/** 선수 문서 다듬기: players whose pages still show the app's own 플레이 스타일 (or one written from ratings or lore that changed), and the jobs they'd take. */
export interface PlayerPagesPlan {
  players: number
  jobs: number
}

/** Player-page jobs still in the queue. */
export interface PlayerPagesStatus {
  waiting: number
  running: number
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
