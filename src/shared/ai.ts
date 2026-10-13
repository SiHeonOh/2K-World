import type { AiJob } from './config/schema'

/** What the app knows about Claude Code on this PC and the job queue; shown in settings and game day. */
export interface ClaudeStatus {
  installed: boolean
  command: string | null
  version: string | null
  loggedIn: boolean
  /** From `claude auth status`: 'claude.ai' is a subscription; 'api_key' would bill per use. */
  authMethod: string | null
  /** Raw error text when something failed, for the details panel. */
  detail?: string
}

/**
 * Why an AI job didn't finish, as the queue sorts it (ARCHITECTURE section 6):
 * - limit: the plan's usage limit; the queue waits for the reset.
 * - auth, missing, cli: no usable sign-in, no claude command, or one too old or blocked from
 *   running (an unknown option, EACCES/EPERM); the queue waits for a re-check.
 * - offline, overloaded: no internet, Claude's servers busy or failing; the queue pauses and
 *   tries the same job again later.
 * - timeout, failed (anything else): the queue pauses too, but these count as the job's tries.
 * - invalid: the answer didn't fit the job's format; model: the chosen model can't be used;
 *   job: a problem with this job alone (too long, unreadable). Only these fail just the job.
 */
export type AiErrorKind = 'limit' | 'auth' | 'missing' | 'offline' | 'overloaded' | 'cli' | 'timeout' | 'invalid' | 'model' | 'job' | 'failed'

export const AI_ERROR_KINDS = ['limit', 'auth', 'missing', 'offline', 'overloaded', 'cli', 'timeout', 'invalid', 'model', 'job', 'failed'] as const satisfies readonly AiErrorKind[]

export interface QueueState {
  running: number | null
  pausedUntil: string | null
  /** Why it's paused (a usage limit, or a problem that should pass); null when it isn't. */
  pauseReason: AiErrorKind | null
  /** Set when sign-in or the claude command is missing: nothing runs until fixed. */
  blocked: AiErrorKind | null
  /** Claude Code's own words for the pause or block (for a details panel); null when running normally. */
  detail: string | null
  /** Pauses in a row without a job getting through (the backoff step); 0 once one does. */
  failures: number
}

export interface AiStatus {
  claude: ClaudeStatus
  /** True when the app uses the stand-in reader (TWOK_FAKE_AI=1), for demos and tests. */
  fake: boolean
  /** True when AI calls would be billed per use; nothing runs until that's fixed. */
  billing: boolean
  queue: QueueState | null
}

/** Tokens as Claude Code counts them. `input` leaves out the cached part, which is counted on its own. */
export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Which exact models answered a job and what each used (from Claude Code's `modelUsage`). */
export interface RunUsage {
  /** The one that wrote the answer: the most output tokens (a small model can help on the side). Null when only totals are known. */
  model: string | null
  /** Keyed by exact model id (e.g. claude-sonnet-…); empty when only totals are known. */
  models: Record<string, TokenCounts>
  total: TokenCounts
}

/** Which AI 모델 row each job kind runs under: the setting `aiFor` read when it was queued. */
export const AI_JOB_OF_KIND: Readonly<Record<string, AiJob>> = {
  read_box_score: 'screenshot',
  post_game_thread: 'gameThread',
  // Event threads carry articles, news and round-ups.
  event_thread: 'article',
  reply_to_user: 'reply',
  chatter_batch: 'chatter',
  live_comments: 'live',
  wiki_edits: 'wiki',
  wiki_talk: 'wikiTalk',
  wiki_pushback: 'wikiTalk',
  wiki_war: 'wikiWar',
  wiki_player: 'wikiPlayer',
  player_reaction: 'player',
  lore_draft: 'loreDraft',
  lore_suggest: 'loreSweep',
  // The secret check runs with the round sweep, on its setting.
  lore_reveal: 'loreSweep',
  gm_intent: 'gmIntent',
  gm_respond: 'gmRespond',
  gm_protect: 'gmDraft',
  gm_swap: 'gmDraft',
}

/** At most this many jobs still in the queue lead 최근 작업 (the ones that run first). */
export const IN_QUEUE_SHOWN = 100

/**
 * One AI job for 편집실 → AI 모델's 최근 작업: still in the queue (대기 중),
 * or finished. It never carries the job's input, output or error text: those
 * can hold league lore (`ai.jobError` reads the error on request).
 */
export interface RecentJob {
  id: number
  kind: string
  /** The AI 모델 row it ran under; null for a kind this list doesn't know. */
  job: AiJob | null
  /**
   * In the queue: 'running' now, 'queued' for its turn, or 'waiting': its last
   * try failed and it waits for another. Finished: 'done' or 'failed'.
   */
  status: 'running' | 'queued' | 'waiting' | 'done' | 'failed'
  errorKind: AiErrorKind | null
  /** A failed job that 다시 시도 can queue again (its input is still kept and nothing retried it yet). */
  canRetry: boolean
  /** The job a 다시 시도 of this one queued, once there is one. */
  retriedBy: number | null
  /** What it asked Claude Code for: --model (an alias such as 'sonnet') and --effort (null: Claude Code's default). */
  askedModel: string | null
  askedEffort: string | null
  /** The exact model that answered, when Claude Code said. */
  model: string | null
  /** Summed over every model and attempt; null when Claude Code didn't say. */
  tokens: TokenCounts | null
  /** Claude Code's own estimate; the subscription isn't billed per job. */
  costUsd: number | null
  /** When it was queued. */
  queuedAt: string
  /** When its last try started (a running job: this one); null when it never ran. */
  startedAt: string | null
  /** When it finished; for a job still in the queue, when its last try started, or when it was queued. */
  finishedAt: string
  /** From its last start to the finish (a retry starts the clock again); null while in the queue. */
  durationMs: number | null
  /**
   * The number check's redo: `retryOf` is the job it redoes (null when it
   * isn't one, or the first job isn't known); `redoneBy`, the redo of this
   * job, once that has finished. A redone job's answer wasn't kept.
   */
  numberRetry: boolean
  retryOf: number | null
  redoneBy: number | null
}
