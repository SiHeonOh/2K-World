import type { Phase } from './config/schema'

/**
 * What the League Office screens read for a season: games, standings,
 * playoffs, trades, cards, the draft, the 2K checklist and awards.
 */

export type GameStage = 'regular' | 'play-in' | 'playoffs' | 'finals'

export interface GameRow {
  id: number
  stage: GameStage
  /** Regular season: schedule round. Playoffs: game number in the series. */
  round: number
  seriesId: number | null
  home: string
  away: string
  homeScore: number | null
  awayScore: number | null
  status: 'scheduled' | 'final'
  recordedAt: string | null
  hasBox: boolean
}

export interface StandingLine {
  teamId: string
  wins: number
  losses: number
  pct: number
  gamesBehind: number
  pointsFor: number
  pointsAgainst: number
  home: string
  away: string
  conference: string
  division: string
  last10: string
  streak: string
}

export interface StandingsView {
  /** Overall 1..N, tiebreakers applied. */
  overall: StandingLine[]
  /** Per conference id, in rank order (seeds). */
  conferences: Record<string, StandingLine[]>
  /** Per division id, in rank order. */
  divisions: Record<string, StandingLine[]>
  /** Regular-season games played, and unplayed games built so far. */
  played: number
  scheduled: number
  /** Games in the whole regular season, built yet or not (rounds built by hand). */
  total: number
}

export interface SeriesRow {
  id: number
  slot: string
  stage: 'play-in' | 'playoffs' | 'finals'
  round: number
  group: string | null
  high: string | null
  low: string | null
  highSeed: number | null
  lowSeed: number | null
  bestOf: number
  highWins: number
  lowWins: number
  winner: string | null
}

export interface PlayoffsView {
  seeds: Record<string, string[]> | null
  series: SeriesRow[]
}

/** Where a series sits in the bracket: all that says what winning it gives. */
export type BracketSpot = Pick<SeriesRow, 'stage' | 'round' | 'group'>

/**
 * What winning a series gives, as the bracket says: the final's winner is
 * the league's champion. A group's last round gives the group's title (a
 * conference's), or the league's when no final follows and the bracket has
 * one group (that round is the final). Play-in games and earlier rounds give
 * none. The wiki and the 플레이오프 screen both go by this.
 */
export function seriesTitle(all: readonly BracketSpot[], s: BracketSpot): 'league' | 'group' | null {
  if (s.stage === 'finals') return 'league'
  if (s.stage !== 'playoffs') return null
  const last = Math.max(...all.filter((x) => x.stage !== 'play-in' && x.group === s.group).map((x) => x.round))
  if (s.round !== last) return null
  if (all.some((x) => x.stage === 'finals')) return 'group'
  return new Set(all.filter((x) => x.stage === 'playoffs').map((x) => x.group)).size <= 1 ? 'league' : 'group'
}

/** The league's champion: the winner of the series that gives the league's title, once it's decided. */
export function leagueChampion(all: readonly (BracketSpot & Pick<SeriesRow, 'winner'>)[]): string | null {
  return all.find((s) => s.winner !== null && seriesTitle(all, s) === 'league')?.winner ?? null
}

export interface TradeItemRow {
  kind: 'player' | 'card'
  from: string
  to: string
  playerId: string | null
  cardId: number | null
  /** The traded card's team, number and issuing season, so a trade names its card whichever season's list holds it now. */
  card: { originalTeamId: string; number: number; issuedSeasonId: number } | null
  fromSlotId: string | null
  toSlotId: string | null
}

export interface TradeRow {
  id: number
  phase: Phase
  status: 'applied' | 'vetoed'
  source: 'user' | 'gm'
  note: string
  createdAt: string
  items: TradeItemRow[]
  /** Not yet made in 2K, so it can still be vetoed. */
  pendingIn2k: boolean
}

export interface CardRow {
  id: number
  originalTeamId: string
  /** Who holds it. In a past season's list, a card that carried on shows who held it when that season ended. */
  ownerTeamId: string
  number: number
  /** In a past season's list, a card that carried on shows 'held' (it was, when that season ended), with `carriedTo` set. */
  status: 'held' | 'used' | 'expired'
  /** The season that issued it. Numbers restart each season, so a card from another season is named with its season too. */
  issuedSeasonId: number
  /** Listed for a past season but carried over, unplayed, into the next one: that season's id. */
  carriedTo: number | null
}

export interface DraftActionRow {
  id: number
  seq: number
  teamId: string
  kind: 'protect' | 'swap' | 'pass'
  cardId: number | null
  playerId: string | null
  targetPlayerId: string | null
  targetTeamId: string | null
  createdAt: string
}

export interface DraftView {
  /** Pick order: worst record first, frozen teams left out. */
  order: string[]
  cards: CardRow[]
  actions: DraftActionRow[]
  /** Protected now: protected with a card, or already moved this draft. */
  protectedPlayers: string[]
  /** Already moved this draft (swapped, or traded during it): they can't move again until it ends. */
  movedPlayers: string[]
  protectionOpen: boolean
  /** The card whose turn it is, or null when the swap phase is over. */
  next: CardRow | null
}

export interface ChecklistRow {
  id: number
  kind: 'trade' | 'draft-swap'
  refId: number
  teamIds: string[]
  createdAt: string
  appliedAt: string | null
  /** What to do in 2K: player moves with their new team and slot. */
  moves: { playerId: string; toTeamId: string; toSlotId: string | null }[]
}

export interface AwardRow {
  id: number
  awardId: string
  period: string
  teamRank: number
  playerId: string
  /** The team he won it for: his team when it was given (in the draft or offseason, his team when the games ended). */
  teamId: string
}

/** A rule the League engine refused a move on; translated in the renderer. */
export interface RuleIssue {
  code: string
  params: Record<string, string | number>
}

// ── Results the core computes (shared so the screens can show them) ──────

export type BoxIssue =
  | { code: 'line-points'; playerId: string; points: number; expected: number }
  | { code: 'team-points'; teamId: string; points: number; score: number }
  | { code: 'made-over-attempts'; playerId: string; column: string }

export interface LeaderBoard {
  /** A stat column id, or 'fg%', '3p%', 'ft%'. */
  key: string
  label: string
  kind: 'per-game' | 'percent'
  rows: { playerId: string; teamId: string; value: number; games: number }[]
}

/** What 일정 needs to build rounds by hand (or change unplayed games). */
export interface ScheduleInfo {
  /**
   * 'auto' or 'manual' for a round robin, 'played' for 2K 일정대로 (sessions, no
   * rounds); null for a custom game count, which has no rounds to build.
   */
  build: 'auto' | 'manual' | 'played' | null
  /** Rounds to show; in 2K 일정대로, sessions so far (the open one included). */
  rounds: number
  /** Games that fill a round (0 in 2K 일정대로: a session has no fixed size). */
  perRound: number
  /** Games in the whole regular season, built yet or not, and those played. */
  total: number
  played: number
  /** Unplayed games can be changed now (a round robin's regular season). */
  editable: boolean
  /** 2K 일정대로 only: the open session (N일차), where new games go; sessions before it are closed. */
  session?: number
}

/**
 * 2K 일정대로's game picker: each school's games so far, and who it still
 * has a meeting left with (a game added but not played counts as met).
 */
export interface PlayedPairs {
  /** The open session, where an added game goes. */
  session: number
  /** How often each pair meets in the season. */
  meetings: number
  teams: {
    teamId: string
    /** Games played (GP) and added but not played yet. */
    played: number
    scheduled: number
    /** Games not added yet: the season's games for a school minus played and scheduled ones. */
    left: number
  }[]
  /** Per school, the schools it still has a meeting to add with, with how many meetings are left. */
  open: Record<string, { teamId: string; left: number }[]>
}

/**
 * Who a school could meet in a round. 'placed': already playing in it;
 * 'met': no meetings left; 'dead-end': the rest of the season couldn't be
 * completed with that game; 'unsure': not checked in time (adding it checks
 * again). Home and away count the games built so far.
 */
export interface ScheduleOption {
  teamId: string
  status: 'ok' | 'placed' | 'met' | 'dead-end' | 'unsure'
  home: number
  away: number
}

export interface ScheduleOptions {
  self: { home: number; away: number }
  options: ScheduleOption[]
}

export type TradeIssueCode =
  | 'empty-trade'
  | 'trades-disabled'
  | 'wrong-phase'
  | 'two-teams'
  | 'unknown-team'
  | 'team-frozen'
  | 'unknown-player'
  | 'player-not-on-team'
  | 'duplicate-item'
  | 'player-locked'
  | 'player-moved-in-draft'
  | 'player-count-mismatch'
  | 'cards-with-players'
  | 'card-trades-disabled'
  | 'unknown-card'
  | 'card-not-owned'
  | 'card-used'
  | 'card-count-mismatch'
  | 'card-cap'
  | 'unknown-slot'
  | 'roster-size'
  | 'roster-slot'

export interface TradeIssue {
  code: TradeIssueCode
  params: Record<string, string | number>
}

export interface TradeCheck {
  ok: boolean
  issues: TradeIssue[]
  /** Where each traded player ends up: team and slot. */
  moves: { playerId: string; from: string; to: string; fromSlotId: string | null; toSlotId: string | null }[]
}

export type TradeItem =
  | { kind: 'player'; playerId: string; from: string; to: string; toSlotId?: string | null }
  | { kind: 'card'; cardId: number; from: string; to: string }
