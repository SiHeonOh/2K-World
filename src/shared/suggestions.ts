import type { LoreRelationship } from './lore'

/**
 * The lore suggestion inbox (제안함). Everything the AI proposes for your lore
 * waits here as a patch: nothing reaches a lore file (or the roster) until you
 * approve it, so news, community and wiki writers never use an unapproved idea.
 */

/**
 * Round suggestions; each kind can be asked about, applied at once, or never
 * suggested (편집실). A secret reveal (`reveal`) only ever asks or is off.
 */
export const SUGGESTION_KINDS = ['nickname', 'relationship', 'trait', 'fact', 'reveal'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]
/** What the round sweep (lore_suggest) may suggest; reveals come from their own sealed job (lore_reveal). */
export const SWEEP_KINDS = ['nickname', 'relationship', 'trait', 'fact'] as const satisfies readonly SuggestionKind[]
/** Kinds that are never applied by a setting: each card waits for you. */
export const ALWAYS_ASK: readonly SuggestionKind[] = ['reveal']
/** What a card is: an AI draft of a whole file (from lore_draft), or one round suggestion. */
export type SuggestionCardKind = 'draft' | SuggestionKind
export type SuggestionMode = 'ask' | 'auto' | 'off'
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** Who a suggestion is about: a player, a school, or a school's GM. */
export type SuggestionTarget = { kind: 'player'; playerId: string } | { kind: 'team' | 'gm'; teamId: string }

/**
 * What approving changes. Settings fields replace the file's values (lists
 * add or update by name); text is added at the end of its section (or fills
 * it when empty); nicknames go on the roster.
 */
export interface LorePatch {
  /** Player traits, or a GM's leanings (1–5). */
  traits?: Record<string, number>
  media?: string
  /** GM only. */
  name?: string
  philosophy?: string
  negotiation?: string
  /** School only. */
  fans?: Partial<Record<'size' | 'temperament' | 'pride', number>>
  /** School only: rival schools to add (short names). */
  rivals?: string[]
  /** Added, or updated when the file already has one with that person. */
  relationships?: LoreRelationship[]
  public?: string
  rumor?: string
  /** Player only: added to the roster's nicknames. */
  nicknames?: string[]
  /**
   * A secret reveal only: the 비밀 text that leaves the secret section when
   * it's approved (whole sentences, exactly as the file has them); its
   * wording for 공개 or 소문 is `public` or `rumor`. A secret relationship's
   * reveal is `relationships` with its new visibility.
   */
  fromSecret?: string
  /** A reveal you edited: what stays in 비밀 in place of `fromSecret` (left out: nothing does). Never told to anyone. */
  keepSecret?: string
}

/**
 * Why a reveal can't be approved as it is (stored on the card as `stale:<why>`):
 * no lore file; nothing to move; the text no longer in 비밀; no tie with
 * that person of that kind; or that tie made known some other way.
 */
export type RevealStale = 'no-file' | 'nothing' | 'secret-gone' | 'tie-gone' | 'tie-not-secret'

/** What the file (and roster) holds now for the fields a patch touches, for the before → after preview. */
export interface LoreCurrent {
  exists: boolean
  traits?: Record<string, number>
  media?: string
  name?: string | null
  philosophy?: string
  negotiation?: string
  fans?: Record<'size' | 'temperament' | 'pride', number>
  rivals?: string[]
  relationships?: LoreRelationship[]
  public?: string
  rumor?: string
  /** A text reveal only: 비밀 as it is now, for the card's "what stays in 비밀" (your own screen; no writer reads cards). */
  secret?: string
  nicknames?: string[]
}

export interface SuggestionView {
  id: number
  kind: SuggestionCardKind
  status: SuggestionStatus
  target: SuggestionTarget
  /** The player's name, the school's short name, or "<school> 단장". */
  name: string
  teamId: string
  /** The lore file it goes to; null when there's none yet (approving makes it). */
  file: string | null
  patch: LorePatch
  current: LoreCurrent
  /** Why the AI suggested it, in its words. */
  reason: string
  /** How many times the same thing came up. */
  times: number
  seasonId: number | null
  round: number | null
  /**
   * What started it: a thread, a game, or your own description of the player.
   * parts: the blank parts a bulk draft was asked to fill; from: a trait's value when it was suggested.
   * Approving a card as it is checks the file still matches these.
   */
  source: { postId?: number; gameId?: number; hint?: string; parts?: string[]; from?: number }
  /** Applied by an "always approve" setting, not by you. */
  auto: boolean
  /** The last time approving it failed, and why: a code the screen translates, sometimes with a reason after a colon (stale:secret-gone, lore-error:heading-in-text). Kept until you approve or turn it down (or a newer draft or trait value replaces its patch). */
  error: string | null
  createdAt: string
  decidedAt: string | null
}

export interface SuggestionStatusView {
  pending: number
  /** lore_draft jobs waiting or running. */
  drafting: number
  /** Of those, the ones still waiting their turn (대기 중인 초안 취소 cancels these; the running one finishes). */
  draftsQueued: number
  /** Round jobs (lore_suggest, lore_reveal) waiting or running. */
  sweeping: number
  aiReady: boolean
}

/** Which files to draft: every blank part in one school or the whole league, or one entity (with your own description). */
export type DraftRequest =
  | { scope: 'league' }
  | { scope: 'team'; teamId: string }
  | { scope: 'one'; target: SuggestionTarget; hint?: string }

export interface DraftResult {
  /** Jobs queued. */
  jobs: number
  /** Players, schools and GMs going into them. */
  targets: number
}

/** stale: the file changed since the card was made (you filled the part, or the trait moved), so it no longer fits as it is. */
export type ApproveError = 'gone' | 'conflict' | 'invalid' | 'lore-error' | 'roster' | 'no-file' | 'stale'

export type ApproveResult = { status: 'approved'; file: string | null } | { status: 'error'; code: ApproveError; detail: string }
