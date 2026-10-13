import type { CommunityConfig, LeagueConfig, AiConfig } from './config/schema'
import type { ImportMapping, ImportResult, SheetAnalysis, WorkbookSummary } from './import'
import type { FolderInspection, LeagueListing, LeagueSnapshot } from './league'
import type { LeagueSetup, SetupIssue, Team } from './setup'
import type {
  AwardRow,
  BoxIssue,
  CardRow,
  ChecklistRow,
  DraftView,
  GameRow,
  LeaderBoard,
  PlayedPairs,
  PlayoffsView,
  RuleIssue,
  ScheduleInfo,
  ScheduleOptions,
  StandingsView,
  TradeCheck,
  TradeItem,
  TradeRow,
} from './season'
import type { TemplateError, TemplateFile } from './template'
import type { AiStatus, RecentJob } from './ai'
import type { ConfirmInput, ConfirmView, JobInfo } from './gameday'
import type {
  BoardPage,
  CommunityStatus,
  NewsInput,
  PollView,
  PostSummary,
  PostView,
  RefreshResult,
  WriteCommentInput,
  WritePostInput,
} from './community'
import type { WikiDiffView, WikiPageView, WikiRevisionView, WikiSaveInput, WikiSearchResult, WikiThreadInput, WikiThreadSummary, WikiThreadView } from './wiki'
import type { LockerRoomView, PlayerStateView } from './mood'
import type { PlayerEdit, RosterSaveResult } from './roster'
import type { LoreCreateTarget, LoreDocView, LoreIndexView, LoreSaveInput, LoreSaveResult, LoreTableView } from './lore'
import type { ApproveResult, DraftRequest, DraftResult, SuggestionKind, SuggestionMode, SuggestionStatusView, SuggestionView } from './suggestions'
import type { LoreConfig } from './config/schema'
import type { DraftNoteView, GmStatusView, GmView, WindowView } from './gm'
import type { BackupsView, LoreRestoreResult, RestoreResult } from './backups'
import type { LeagueSettingsInput, SettingsSaveResult, SettingsState } from './settings'

/**
 * The main ↔ renderer contract. Every call is request/response over one IPC
 * channel per name; the renderer never touches disk itself.
 */

export interface AppInfo {
  version: string
  dataDir: string
  isPackaged: boolean
}

export interface TemplateListing {
  id: string
  source: 'builtin' | 'user'
  name: string
  description: string
  fileName: string
  hasTeams: boolean
  hasPlayers: boolean
  /** Set when the file can't be used. */
  error?: TemplateError
}

/** Labels for native dialogs; they come from the renderer so all text stays in one file. */
export interface DialogLabels {
  title: string
  filterName: string
}

export interface CreateLeagueInput {
  slug: string
  setup: LeagueSetup
  /** Saved under the data folder's templates/ when set. */
  saveTemplate: { name: string; includePlayers: boolean } | null
  /** Remembered for the next import of a sheet with the same headers. */
  importMapping: ImportMapping | null
}

export interface CreateLeagueResult {
  slug: string
  warnings: SetupIssue[]
  templatePath: string | null
}

export interface ImportBaseInput {
  /** The wizard's config so far; its league name may still be blank. */
  config: LeagueConfig
  teams?: Team[]
}

export interface ScoreInput {
  gameId: number
  homeScore: number
  awayScore: number
  /** Box lines to store with the game; null keeps whatever is stored. */
  lines: { playerId: string; teamId: string; stats: Record<string, number> }[] | null
}

/** Protection spends the team's last card automatically, so it names no card. */
export type DraftMoveInput =
  | { kind: 'protect'; teamId: string; playerId: string }
  | { kind: 'swap'; teamId: string; cardId: number; playerId: string; targetPlayerId: string }
  | { kind: 'pass'; teamId: string; cardId: number }

/** Sheet names and column headers for the Excel export; they come from the renderer's language file. */
export type ExportLabels = Record<string, string>

/** What the Excel export covers: the current season, or every season (with a season column; rosters stay current). */
export type ExportScope = 'current' | 'all'

export interface Api {
  'app.info': () => AppInfo
  'app.openDataFolder': (slug?: string) => void
  'app.chooseDataFolder': (labels: DialogLabels) => AppInfo | null

  'leagues.list': () => LeagueListing[]
  'leagues.inspect': (slug: string) => FolderInspection
  'leagues.create': (input: CreateLeagueInput) => CreateLeagueResult
  /** Moves a league's folder to _deleted in the data folder (not erased). */
  'leagues.remove': (slug: string) => { movedTo: string }
  'leagues.openDeleted': () => void
  'leagues.snapshot': (slug: string) => LeagueSnapshot
  'leagues.exportTemplate': (slug: string, options: { name: string; includePlayers: boolean }) => { path: string }
  /** 리그 설정: which sections can change now (and why not), given awards and cards already handed out. */
  'leagues.settingsState': (slug: string) => SettingsState
  /** Saves 리그 설정 (teams, structure, rules, awards, the draft) with a backup first; a section whose time has passed is refused with its reason. */
  'leagues.saveSettings': (slug: string, input: LeagueSettingsInput) => SettingsSaveResult

  'templates.list': () => TemplateListing[]
  'templates.load': (id: string) => TemplateFile
  'templates.openFile': (labels: DialogLabels) => TemplateFile | null

  'import.chooseFile': (labels: DialogLabels) => WorkbookSummary | null
  /** `templateMapping`: the column matching a template carries, tried before saved ones. */
  'import.analyze': (input: {
    path: string
    sheet: string
    headerRow?: number
    base: ImportBaseInput
    templateMapping?: ImportMapping
  }) => SheetAnalysis
  'import.run': (input: { path: string; mapping: ImportMapping; base: ImportBaseInput }) => ImportResult

  // Reads take an optional season id (an unknown one is refused); without it they read the current season.
  'season.start': (slug: string) => { games: number }
  'season.games': (slug: string, seasonId?: number) => GameRow[]
  'season.boxScore': (slug: string, gameId: number) => { playerId: string; teamId: string; stats: Record<string, number> }[]
  'season.recordScore': (slug: string, input: ScoreInput) => { warnings: BoxIssue[] }
  /** 기록 취소: a played game back to unplayed, where nothing was built on it yet (refused with the reason otherwise). */
  'season.unrecord': (slug: string, gameId: number) => void
  'season.standings': (slug: string, seasonId?: number) => StandingsView
  'season.leaders': (slug: string, minGames: number, seasonId?: number) => LeaderBoard[]
  'season.startPlayoffs': (slug: string) => void
  // Rounds built by hand, and changes to unplayed games
  'schedule.info': (slug: string, seasonId?: number) => ScheduleInfo
  'schedule.options': (slug: string, round: number, teamId: string) => ScheduleOptions
  'schedule.add': (slug: string, input: { round: number; home: string; away: string }) => { gameId: number }
  'schedule.remove': (slug: string, gameId: number) => void
  'schedule.flip': (slug: string, gameId: number) => void
  'schedule.fill': (slug: string, round: number) => { added: number }
  'schedule.clear': (slug: string, round: number) => { removed: number; kept: number }
  // 2K 일정대로: games picked as they're played, into the open session (N일차), which 오늘 경기 끝 closes
  'schedule.pairs': (slug: string) => PlayedPairs
  'schedule.addPlayed': (slug: string, input: { home: string; away: string }) => { gameId: number; round: number }
  'schedule.closeSession': (slug: string) => { round: number; next: number }
  'season.playoffs': (slug: string, seasonId?: number) => PlayoffsView
  'season.finishPlayoffs': (slug: string) => void
  'season.next': (slug: string, label: string) => void

  'trades.preview': (slug: string, items: TradeItem[]) => TradeCheck
  'trades.apply': (slug: string, items: TradeItem[], note: string) => { tradeId: number }
  'trades.veto': (slug: string, tradeId: number) => void
  'trades.list': (slug: string, seasonId?: number) => TradeRow[]
  'cards.list': (slug: string, seasonId?: number) => CardRow[]
  'checklist.list': (slug: string) => ChecklistRow[]
  'checklist.apply': (slug: string, id: number) => void

  'draft.view': (slug: string, seasonId?: number) => DraftView
  'draft.move': (slug: string, move: DraftMoveInput) => { actionId: number }
  'draft.closeProtection': (slug: string) => void
  'draft.vetoSwap': (slug: string, actionId: number) => void
  'draft.finish': (slug: string) => void

  'awards.list': (slug: string, seasonId?: number) => AwardRow[]
  'awards.give': (slug: string, input: { awardId: string; period: string; teamRank: number; playerId: string }) => { id: number }
  'awards.remove': (slug: string, id: number) => void

  /** `scope` defaults to the current season. */
  'leagues.exportExcel': (slug: string, labels: ExportLabels, scope?: ExportScope) => { path: string }
  /** Your own backup: the database (its path), plus a snapshot of the lore folder when there is one. */
  'leagues.backup': (slug: string) => { path: string }
  /** The league's database backups and lore snapshots, newest first. */
  'backups.list': (slug: string) => BackupsView
  /** Puts a database backup in place (after a 'before-restore' copy); the lore folder isn't touched. */
  'backups.restore': (slug: string, id: string) => RestoreResult
  /** Puts a lore snapshot in place of the lore folder (after a 'before-restore' snapshot); the database isn't touched. */
  'backups.restoreLore': (slug: string, id: string) => LoreRestoreResult
  /** Opens a lore snapshot's folder in Explorer, to take files from it by hand. */
  'backups.openLore': (slug: string, id: string) => void

  'ai.status': (slug?: string) => AiStatus
  'ai.recheck': () => AiStatus
  /** Every AI job's model and effort (편집실 → AI 모델). */
  'ai.saveJobs': (slug: string, ai: AiConfig) => { version: number }
  /** The jobs in the queue, then the latest finished ones: the model asked for and the one that answered, tokens, cost, time. Never their inputs. */
  'ai.recentJobs': (slug: string) => RecentJob[]
  /** One job's error text, as Claude Code (or the app) put it, for 최근 작업's 자세히. */
  'ai.jobError': (slug: string, jobId: number) => { error: string | null }
  /** Queues a failed job again as a new job (same input, on its AI 모델 row's model and effort now). */
  'ai.retryJob': (slug: string, jobId: number) => { jobId: number }
  /** 취소: a waiting job never runs; a running one is ended and its answer dropped. Refused once it's done, failed or cancelled. */
  'ai.cancelJob': (slug: string, jobId: number) => void
  /** Cancels every waiting job of one kind (not the one running); returns how many. */
  'ai.cancelWaiting': (slug: string, kind: string) => { cancelled: number }
  /** 지금 다시 시도: ends the league queue's pause now (a block gets a fresh check first). */
  'ai.resume': (slug: string) => AiStatus
  'gameday.saveImage': (slug: string, bytes: Uint8Array) => { token: string }
  /** Deletes a screenshot from the inbox that won't be read (taken back, or over the limit). */
  'gameday.discardImage': (slug: string, token: string) => void
  'gameday.read': (slug: string, gameId: number, tokens: string[]) => { jobId: number }
  'gameday.job': (slug: string, jobId: number) => JobInfo
  /** A game's reading jobs, latest first. */
  'gameday.jobs': (slug: string, gameId: number) => JobInfo[]
  /** Reads a failed job's screenshots again, as a new job. */
  'gameday.retry': (slug: string, jobId: number) => { jobId: number }
  /** `flip` swaps which read team is home, when the automatic choice was wrong. */
  'gameday.confirmView': (slug: string, jobId: number, flip?: boolean) => ConfirmView
  'gameday.confirm': (slug: string, input: ConfirmInput) => { warnings: BoxIssue[] }
  /** A reading's screenshots, shown beside the confirm tables. */
  'gameday.shots': (slug: string, jobId: number) => { files: { name: string; bytes: Uint8Array }[] }
  /** The folder 2K's screenshots land in (an app setting), and choosing or clearing it. */
  'gameday.screenshotFolder': () => { folder: string | null }
  'gameday.chooseScreenshotFolder': (labels: DialogLabels) => { folder: string | null }
  'gameday.clearScreenshotFolder': () => void
  /** The newest screenshots (taken in the last few hours) from that folder, newest first. */
  'gameday.latestShots': (count: number) => { files: { name: string; bytes: Uint8Array }[] }

  // Community (Phase 3). Reading never changes facts; writing only adds posts and comments.
  'community.status': (slug: string) => CommunityStatus
  'community.latest': (slug: string) => PostSummary[]
  'community.board': (slug: string, boardId: string, page: number) => BoardPage
  /** `again`: the page already showing this post reads it again (comments or votes arriving, a vote), so it isn't another view. */
  'community.post': (slug: string, postId: number, again?: boolean) => PostView
  /** Reveals the next buffered items and moves views and votes; may queue a chatter job. */
  'community.refresh': (slug: string) => RefreshResult
  'community.write': (slug: string, input: WritePostInput) => { postId: number }
  'community.comment': (slug: string, input: WriteCommentInput) => { commentId: number }
  'community.vote': (slug: string, target: 'post' | 'comment', id: number, value: -1 | 1) => { up: number; down: number; myVote: -1 | 0 | 1 }
  /** Your vote on a poll (an option index): one per poll, changeable while it's open. */
  'community.pollVote': (slug: string, pollId: number, option: number) => PollView
  /** The 뉴스 box: a news event the reporters and fans pick up. */
  'community.news': (slug: string, input: NewsInput) => { eventId: number }
  'lore.index': (slug: string) => LoreIndexView
  /** Moves player files into their current team's folder again (it also happens on its own after moves); returns how many moved. */
  'lore.sync': (slug: string) => { moved: number }
  /** Saves roster facts (names, heights, nicknames, notes, ratings) for many players at once, all or nothing. */
  'roster.update': (slug: string, edits: PlayerEdit[]) => RosterSaveResult
  /** One file for the editor: its text, the form's starting point, problems and backups. */
  'lore.open': (slug: string, file: string) => LoreDocView
  /** Every player, GM and school with its settings, for the tables. */
  'lore.table': (slug: string) => LoreTableView
  /** Saves the form's changes (merged with changes made elsewhere) or the raw text; keeps a backup of what it replaces. */
  'lore.save': (slug: string, input: LoreSaveInput) => LoreSaveResult
  /** A new file from the template, or the one already there. */
  'lore.create': (slug: string, target: LoreCreateTarget) => { file: string; created: boolean }
  /** Blank files for every school, GM and player without one. */
  'lore.createMissing': (slug: string) => { created: number }
  'lore.backupText': (slug: string, file: string, backupId: string) => { text: string }
  /** Puts an earlier version back; the version it replaces is kept as a backup too. */
  'lore.restore': (slug: string, file: string, backupId: string) => LoreDocView
  /** Moves the file out of the lore folder into backups/lore/_deleted. */
  'lore.remove': (slug: string, file: string) => void
  /** Shows the file in Explorer. */
  'lore.reveal': (slug: string, file: string) => void
  /** Saves the community settings (boards can be renamed, not added or removed); returns the new config version. */
  'community.saveSettings': (slug: string, community: CommunityConfig) => { version: number }

  // The lore suggestion inbox (제안함). Nothing the AI drafts reaches a lore file until it's approved.
  'suggestions.status': (slug: string) => SuggestionStatusView
  'suggestions.list': (slug: string, which: 'pending' | 'decided') => SuggestionView[]
  /** Queues lore_draft jobs: the blank parts of one school's files or every school's, or one file (with your description). */
  'suggestions.draft': (slug: string, request: DraftRequest) => DraftResult
  /** Applies a card (as it is, or as you edited it): the lore file through the editor's merge, nicknames on the roster. */
  'suggestions.approve': (slug: string, id: number, patch?: unknown) => ApproveResult
  'suggestions.approveMany': (slug: string, ids: number[]) => { approved: number; failed: number }
  'suggestions.reject': (slug: string, id: number) => void
  /** Ask, approve by itself, or never suggest one kind; auto also approves the waiting ones. */
  'suggestions.setMode': (slug: string, kind: SuggestionKind, mode: SuggestionMode) => { applied: number }
  'suggestions.saveSettings': (slug: string, lore: LoreConfig) => { version: number; applied: number }

  // AI GMs (단장실). Their deals go through the League engine like yours.
  'gm.status': (slug: string) => GmStatusView
  /** This season's trade windows with every negotiation and step (an open one hidden when the log waits). */
  'gm.windows': (slug: string) => WindowView[]
  'gm.list': (slug: string) => GmView[]
  /** Opens a trade window now: the most motivated GMs get a turn. */
  'gm.openWindow': (slug: string) => { windowId: number | null; gms: number }
  /** Changes whenever rosters or the config change (trades, swaps, vetoes, edits), so screens can refresh a stale snapshot. */
  'leagues.stamp': (slug: string) => { stamp: number }
  /** A deal both GMs agreed to, waiting for you: made now if the rules still allow it. */
  'gm.approve': (slug: string, negotiationId: number) => { status: 'accepted' | 'failed' }
  'gm.decline': (slug: string, negotiationId: number) => void
  /** This season's AI draft decisions (protections and picks), with each GM's 속마음 and quote. */
  'gm.draftNotes': (slug: string) => DraftNoteView[]
  /** Nudges the AI GMs in the draft (they move by themselves; this is for when they seem stuck). */
  'gm.reconcileDraft': (slug: string) => void
  /** Saves the GM settings; returns the new config version. */
  'gm.saveSettings': (slug: string, gm: LeagueConfig['gm']) => { version: number }

  // Wiki (Phase 4). Every save is a revision; a stale edit is refused.
  'wiki.home': (slug: string) => { title: string }
  'wiki.page': (slug: string, title: string, rev?: number) => WikiPageView
  'wiki.save': (slug: string, input: WikiSaveInput) => { rev: number; title: string }
  'wiki.history': (slug: string, title: string) => WikiRevisionView[]
  'wiki.diff': (slug: string, title: string, from: number, to: number) => WikiDiffView
  'wiki.recent': (slug: string) => WikiRevisionView[]
  'wiki.backlinks': (slug: string, title: string) => string[]
  'wiki.search': (slug: string, query: string) => WikiSearchResult[]
  'wiki.random': (slug: string) => { title: string | null }
  'wiki.threads': (slug: string, title: string) => WikiThreadSummary[]
  'wiki.thread': (slug: string, threadId: number) => WikiThreadView
  'wiki.recentThreads': (slug: string) => WikiThreadSummary[]
  'wiki.openThread': (slug: string, input: WikiThreadInput) => { id: number }
  'wiki.comment': (slug: string, threadId: number, body: string) => { n: number }
  'wiki.setThread': (slug: string, threadId: number, open: boolean, note: string) => { ok: true }
  'wiki.saveSettings': (slug: string, wiki: LeagueConfig['wiki']) => { version: number }

  // Player minds (Phase 5)
  'mood.team': (slug: string, teamId: string) => LockerRoomView
  'mood.player': (slug: string, playerId: string, seasonId?: number) => PlayerStateView
}

export type ApiChannel = keyof Api

/** Runtime list of channels; the preload refuses anything else. */
export const API_CHANNELS = [
  'app.info',
  'app.openDataFolder',
  'app.chooseDataFolder',
  'leagues.list',
  'leagues.inspect',
  'leagues.create',
  'leagues.remove',
  'leagues.openDeleted',
  'leagues.snapshot',
  'leagues.exportTemplate',
  'leagues.settingsState',
  'leagues.saveSettings',
  'templates.list',
  'templates.load',
  'templates.openFile',
  'import.chooseFile',
  'import.analyze',
  'import.run',
  'season.start',
  'season.games',
  'season.boxScore',
  'season.recordScore',
  'season.unrecord',
  'season.standings',
  'season.leaders',
  'season.startPlayoffs',
  'schedule.info',
  'schedule.options',
  'schedule.add',
  'schedule.remove',
  'schedule.flip',
  'schedule.fill',
  'schedule.clear',
  'schedule.pairs',
  'schedule.addPlayed',
  'schedule.closeSession',
  'season.playoffs',
  'season.finishPlayoffs',
  'season.next',
  'trades.preview',
  'trades.apply',
  'trades.veto',
  'trades.list',
  'cards.list',
  'checklist.list',
  'checklist.apply',
  'draft.view',
  'draft.move',
  'draft.closeProtection',
  'draft.vetoSwap',
  'draft.finish',
  'awards.list',
  'awards.give',
  'awards.remove',
  'leagues.exportExcel',
  'leagues.backup',
  'backups.list',
  'backups.restore',
  'backups.restoreLore',
  'backups.openLore',
  'ai.status',
  'ai.recheck',
  'ai.saveJobs',
  'ai.recentJobs',
  'ai.jobError',
  'ai.retryJob',
  'ai.cancelJob',
  'ai.cancelWaiting',
  'ai.resume',
  'gameday.saveImage',
  'gameday.discardImage',
  'gameday.read',
  'gameday.job',
  'gameday.jobs',
  'gameday.retry',
  'gameday.confirmView',
  'gameday.confirm',
  'gameday.shots',
  'gameday.screenshotFolder',
  'gameday.chooseScreenshotFolder',
  'gameday.clearScreenshotFolder',
  'gameday.latestShots',
  'community.status',
  'community.latest',
  'community.board',
  'community.post',
  'community.refresh',
  'community.write',
  'community.comment',
  'community.vote',
  'community.pollVote',
  'community.news',
  'lore.index',
  'lore.sync',
  'roster.update',
  'lore.open',
  'lore.table',
  'lore.save',
  'lore.create',
  'lore.createMissing',
  'lore.backupText',
  'lore.restore',
  'lore.remove',
  'lore.reveal',
  'community.saveSettings',
  'suggestions.status',
  'suggestions.list',
  'suggestions.draft',
  'suggestions.approve',
  'suggestions.approveMany',
  'suggestions.reject',
  'suggestions.setMode',
  'suggestions.saveSettings',
  'gm.status',
  'gm.windows',
  'gm.list',
  'gm.openWindow',
  'gm.approve',
  'gm.decline',
  'gm.draftNotes',
  'gm.reconcileDraft',
  'gm.saveSettings',
  'leagues.stamp',
  'wiki.home',
  'wiki.page',
  'wiki.save',
  'wiki.history',
  'wiki.diff',
  'wiki.recent',
  'wiki.backlinks',
  'wiki.search',
  'wiki.random',
  'wiki.threads',
  'wiki.thread',
  'wiki.recentThreads',
  'wiki.openThread',
  'wiki.comment',
  'wiki.setThread',
  'wiki.saveSettings',
  'mood.team',
  'mood.player',
] as const satisfies readonly ApiChannel[]

// Compile-time check that the list above names every channel.
type Missing = Exclude<ApiChannel, (typeof API_CHANNELS)[number]>
const _allChannelsListed: [Missing] extends [never] ? true : Missing = true
void _allChannelsListed

export type ErrorCode =
  | 'invalid-input'
  | 'invalid-setup'
  | 'league-exists'
  // A league folder another program holds a file of, so it can't be moved (deleting a league).
  | 'league-busy'
  | 'not-found'
  | 'file-read'
  | 'bad-template'
  | 'rule'
  | 'backup-failed'
  | 'lore-taken'
  | 'ai-unavailable'
  // A screenshot over 20 MB, or not a PNG or JPEG (WebP, HEIC…).
  | 'image-too-large'
  | 'image-type'
  // Database troubles (main/errors.ts knownError): a league saved by a newer app, a clash with a stored row,
  // the file busy in another program, a full disk, a damaged file.
  | 'db-too-new'
  | 'db-constraint'
  | 'db-busy'
  | 'disk-full'
  | 'db-corrupt'
  | 'internal'

export interface ApiErrorShape {
  code: ErrorCode
  message: string
  /** Setup issues for 'invalid-setup'; template error for 'bad-template'; refusals for 'rule'. */
  issues?: SetupIssue[]
  templateError?: TemplateError
  rules?: RuleIssue[]
}

/** What crosses the IPC boundary: errors are values, so their codes survive. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: ApiErrorShape }

/**
 * Not in API_CHANNELS: only the preload calls it, with a path it read from a
 * real dropped File. The page itself can't name a path to open.
 */
export const OPEN_DROPPED_CHANNEL = 'import.openDropped'

/**
 * Notes the main process sends the page when something changed in the
 * background (a writer finished), so open screens can look again instead of
 * waiting for a poll. They carry no data: the screen asks for what it shows.
 */
export const PUSH_CHANNEL = 'twok:push'
/** 'waiting': a job was queued, started, put back or cancelled (only 최근 작업's 대기 중 listens). */
export type PushTopic = 'community' | 'wiki' | 'gm' | 'inbox' | 'gameday' | 'other' | 'jobs' | 'waiting'
export interface PushNote {
  slug: string
  topic: PushTopic
  /** The job kind that finished (or, for 'waiting', changed). */
  kind: string
}

/** The bridge the preload script exposes as `window.twok`. */
export interface Bridge {
  invoke<K extends ApiChannel>(channel: K, ...args: Parameters<Api[K]>): Promise<Envelope<ReturnType<Api[K]>>>
  /** Opens a spreadsheet dropped onto the page. */
  openDroppedFile(file: File): Promise<Envelope<WorkbookSummary>>
  /** Listens for background changes; returns the way to stop listening. */
  onPush(listener: (note: PushNote) => void): () => void
}
