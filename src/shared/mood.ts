/** Locker-room views: what the screens show about player moods. */

export type MoodBand = 'happy' | 'content' | 'neutral' | 'unhappy' | 'boiling'
export type MoodPartName = 'role' | 'usage' | 'production' | 'winning' | 'recognition' | 'relationships' | 'rivalry' | 'stability' | 'belonging'

/** Wanting out at or above this is news (a rumor, and a reason for him to speak). */
export const WANTING_OUT_LINE = 60
/** Attachment at or above this makes a franchise player (a loyal GM is slow to sell him). */
export const FRANCHISE_LINE = 80

/** What builds a feeling, with what's left of it now (signed). Keys are the engine's (src/core/feelings.ts). */
export interface FeelingReasonView {
  key: string
  name?: string
  /** The friend named is a secret tie (shown to you, never to writers). */
  secret?: boolean
  value: number
}

/** His lasting feelings: replayed from his whole history, fading slowly. */
export interface PlayerFeelingsView {
  /** −100..+100, toward his school's GM. */
  trust: number
  /** 0..100, to his school. */
  attachment: number
  /** 0..100. */
  wantingOut: number
  belonging: number
  grudges: { kind: 'team' | 'player'; id: string; name: string; value: number; why: string; games: number }[]
  why: { trust: FeelingReasonView[]; attachment: FeelingReasonView[] }
}

export interface PlayerMoodView {
  playerId: string
  name: string
  slot: string | null
  value: number
  overall: number
  band: MoodBand
  parts: Record<MoodPartName, number>
  /** What moves him most, strongest first (signed). */
  reasons: { part: MoodPartName; value: number }[]
  /** His share of the team's possessions over the last few games, and what he expects. */
  share: number | null
  expectedShare: number
  /** Traits came from his lore file (false: defaults). */
  fromLore: boolean
  /** His latest words this season: what he said (or did), his private reason (for you only), and numbers marked in it. */
  said: { channel: string; quote: string; action: string; note: string; at: string; flags: string[] } | null
  feelings: PlayerFeelingsView
}

/** One thing he said (or did), as stored: words, action, and his private reason. */
export interface PlayerWordsView {
  channel: string
  quote: string
  action: string
  targetName: string | null
  note: string
  /** What he was reacting to. */
  cause: string
  /** Numbers in the quote that weren't in the facts he was given (only you see the marks). */
  flags: string[]
}

/** Something that happened to him. Team ids for moves; `at` is when it was recorded. */
export type PlayerTimelineItem =
  | { kind: 'said'; at: string; words: PlayerWordsView }
  | { kind: 'trade'; at: string; from: string; to: string; vetoed: boolean }
  | { kind: 'draft'; at: string; from: string; to: string; vetoed: boolean }
  | { kind: 'award'; at: string; award: string; period: string; teamRank: number; removed: boolean }
  | { kind: 'mood'; at: string; from: MoodBand; to: MoodBand; reasons: MoodPartName[] }
  | { kind: 'wanting'; at: string; value: number }

/** One player over a season (선수 상태): mood history, what happened to him, what he said. */
export interface PlayerStateView {
  playerId: string
  name: string
  teamId: string
  slot: string | null
  ovr: number | null
  seasonId: number
  seasons: { id: number; label: string }[]
  /** The season shown is the current one. */
  current: boolean
  /** His mood now (current season only). */
  now: PlayerMoodView | null
  traits: Record<string, number>
  media: string | null
  /** Traits came from his lore file (false: defaults). */
  fromLore: boolean
  relationships: { name: string; playerId: string | null; type: string; strength: number; visibility: string }[]
  /** His mood after each of his team's games or moves, oldest first (feelings: none in older snapshots). */
  history: {
    at: string
    overall: number
    band: MoodBand
    parts: Record<MoodPartName, number>
    feelings: { trust: number; attachment: number; wantingOut: number } | null
  }[]
  /** Newest first. */
  timeline: PlayerTimelineItem[]
  /** His latest trade request this season, and whether it still stands. */
  request: { action: string; at: string; active: boolean } | null
}

export interface LockerRoomView {
  teamId: string
  strength: number
  /** Worst mood first. */
  players: PlayerMoodView[]
  /** Pairs of ball-hungry teammates both short of shots, by name. */
  clashes: [string, string][]
  /** Games the shot shares are taken from. */
  games: number
}
