/**
 * The AI GMs (단장) as the 단장실 screen sees them: trade windows, the
 * negotiations in them with every step (message and 속마음), and each GM's
 * plan and trust. Moves still become facts only through the League engine.
 */

/** A deal as the proposing team (a) sees it: what each side sends. */
export interface DealView {
  a: string
  b: string
  aGives: string[]
  bGives: string[]
  aCards: number[]
  bCards: number[]
}

export type WindowStatus = 'open' | 'closed'
/**
 * open: talks going on. agreed: both GMs said yes, waiting for your approval.
 * accepted: the trade was made. rejected: a GM said no. failed: the rules
 * refused it by then. declined: you turned it down.
 */
export type NegotiationStatus = 'open' | 'agreed' | 'accepted' | 'rejected' | 'failed' | 'declined'
export type StepAction = 'offer' | 'counter' | 'accept' | 'reject'

/** What one GM saw before acting: the deal's effect on its side, in numbers from code. */
export interface ValueReport {
  strengthBefore: number
  strengthAfter: number
  /** Value points of cards in and out. */
  cardsIn: number
  cardsOut: number
  /** Raw value gained (players and cards in minus out). */
  gain: number
  /** Its own liking for the deal, by its leanings. */
  utility: number
}

export interface StepView {
  id: number
  round: number
  teamId: string
  action: StepAction
  deal: DealView | null
  message: string
  /** The 속마음: never shown to the other GM. */
  note: string
  report: ValueReport | null
  /** Its trust toward the other GM when it acted (-100..100). */
  trust: number | null
  createdAt: string
}

export interface NegotiationView {
  id: number
  windowId: number
  fromTeam: string
  toTeam: string
  status: NegotiationStatus
  deal: DealView | null
  tradeId: number | null
  /** The value the proposer gained; big either way = lopsided (사기 트레이드). */
  valueGap: number | null
  lopsided: boolean
  /** Can still be vetoed: the trade isn't made in 2K yet. */
  vetoable: boolean
  /** The trade was made, then vetoed by you. */
  vetoed: boolean
  reason: string | null
  steps: StepView[]
  createdAt: string
  closedAt: string | null
}

export interface WindowView {
  id: number
  seasonId: number
  round: number | null
  status: WindowStatus
  reason: 'scheduled' | 'manual'
  openedAt: string
  closedAt: string | null
  /** Hidden until the window closes (the negotiation log's spoiler setting). */
  hidden: boolean
  negotiations: NegotiationView[]
}

export interface GmPlanView {
  stance: 'buy' | 'sell' | 'hold' | null
  targets: string[]
  available: string[]
  untouchables: string[]
  note: string
  quote: string | null
}

export interface GmView {
  teamId: string
  /** The GM's name from the 단장 lore file, or null. */
  name: string | null
  philosophy: string
  negotiation: string
  traits: Record<string, number>
  plan: GmPlanView | null
  /** Trust toward other GMs, strongest feelings first. */
  trust: { teamId: string; value: number }[]
  /** Run by the AI (not frozen, not yours). */
  active: boolean
}

export interface GmStatusView {
  /** The open window, if any. */
  open: { id: number; round: number | null; jobs: number } | null
  /** The round after which the next scheduled window opens; null when trades are closed now, or windows open only by hand. */
  nextRound: number | null
  /** Windows open only from 단장실 (no schedule). */
  manual: boolean
  canOpen: boolean
  /** Why a window can't open now (a phase, or one already open). */
  blocked: 'phase' | 'open' | 'no-ai' | null
  aiReady: boolean
  /** Deals waiting for your approval. */
  agreed: number
  /** Moves with every negotiation step, so a screen knows when to read the log again. */
  version: number
  /** During the draft: GM draft jobs waiting or running, and a team you run whose turn it is (the AI waits for it). */
  /**
   * protectDone: the AI teams have all decided their protections. stuck:
   * nothing is running, yet the AI has a move to make (a nudge would help;
   * without Claude, the nudge lets code play the AI's turns).
   */
  draft: { working: number; waitingFor: string | null; protectDone: boolean; stuck: boolean } | null
}

/** One AI GM decision in the draft: whom it protected or picked, why, and what it said. */
export interface DraftNoteView {
  id: number
  teamId: string
  kind: 'protect' | 'swap' | 'pass'
  /** Protected, or sent away in a swap. */
  playerId: string | null
  /** Brought in by a swap, and from where. */
  targetPlayerId: string | null
  targetTeamId: string | null
  note: string
  quote: string | null
  /** You vetoed the swap. */
  vetoed: boolean
  createdAt: string
}
