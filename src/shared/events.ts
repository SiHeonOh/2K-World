/**
 * Event types and their payloads. Every fact change appends one in the same
 * transaction; the Story engine (later) reacts to them. Add a type here
 * before writing it, so readers can rely on the payload shape.
 */
export interface EventPayloads {
  league_created: { teams: number; players: number }
  /** `sections`: what 리그 설정 changed (older events and other settings cards have none). */
  config_changed: { version: number; sections?: string[] }
  /** 리그 설정 changed teams: per team, the fields (name, shortName, colors, divisionId, control) and its old short name. */
  teams_edited: { teams: { teamId: string; fields: string[]; renamedFrom?: string }[] }
  phase_changed: { from: string; to: string }
  season_started: { games: number }
  game_recorded: { gameId: number; stage: string; home: string; away: string; homeScore: number; awayScore: number }
  game_corrected: { gameId: number; before: { homeScore: number; awayScore: number }; after: { homeScore: number; awayScore: number } }
  /** 기록 취소: a played game went back to unplayed (box lines gone). The scores are what it had. */
  game_unrecorded: { gameId: number; stage: string; home: string; away: string; homeScore: number; awayScore: number }
  /**
   * 2K 일정대로: a session (N일차) closed, so it counts as a completed round. `by`: 오늘 경기 끝
   * ('button'), 플레이오프 시작 closing the last one ('playoffs'), or switching a running season
   * to 2K 일정대로 closing the rounds already played ('switch').
   */
  round_closed: { round: number; games: number; by: 'button' | 'playoffs' | 'switch' }
  playoffs_seeded: { seeds: Record<string, string[]> }
  series_won: { seriesId: number; slot: string; winner: string; loser: string; wins: number; losses: number }
  /** A correction or 기록 취소 changed (or undid) a series result. */
  series_result_changed: { seriesId: number; slot: string; before: string | null; after: string | null }
  draft_protection_closed: Record<string, never>
  season_created: { label: string }
  /** A GM trade also carries its negotiation, the value the proposer gained, and whether that's lopsided. */
  trade_applied: { tradeId: number; teams: string[]; players: string[]; cards: number[]; negotiationId?: number; valueGap?: number; lopsided?: boolean }
  trade_window_opened: { windowId: number; round: number | null }
  /** agreed: deals waiting for your approval (older events have none). */
  trade_window_closed: { windowId: number; trades: number; agreed?: number; talks: number }
  /** A player said something in public (an interview or a post): not a fact, a story. */
  player_said: { quoteId: number; playerId: string; teamId: string; channel: string; quote: string; action: string; targetId: string | null }
  /** Talks that came to nothing, leaked as a rumor (not a fact). */
  trade_talks: { negotiationId: number; teams: string[]; players: string[] }
  move_vetoed: { kind: 'trade' | 'draft-swap'; refId: number }
  checklist_applied: { checklistId: number; kind: string; refId: number }
  cards_allocated: { cards: number }
  draft_protect: { actionId: number; teamId: string; playerId: string; cardId: number }
  draft_swap: {
    actionId: number
    teamId: string
    playerId: string
    targetPlayerId: string
    targetTeamId: string
    cardId: number
    /** Slots after the swap, for the 2K checklist. */
    ownSlot: string | null
    targetSlot: string | null
  }
  draft_pass: { actionId: number; teamId: string; cardId: number }
  award_given: { awardId: string; period: string; teamRank: number; playerId: string }
  award_removed: { awardId: string; period: string; teamRank: number; playerId: string }
  /** News you typed in the 뉴스 box. It changes no facts; teams and players are the ones it names. */
  news_posted: { text: string; teams: string[]; players: string[] }
  /** A player's wish to leave crossed its line (derived from his lasting feelings, not a fact change). */
  wanting_out: { playerId: string; teamId: string; value: number }
  /**
   * A standings moment worth a post (derived from results, not a fact change): a place clinched
   * ('top' 1st in its group, 'direct' straight into the playoffs, 'field' at least the play-in),
   * elimination, a new overall #1 (`previous`: who it took over from), or a streak reaching a
   * milestone (`length`) or a run of 5+ snapped (`runStart`: the id of the run's first game, to
   * tell runs apart).
   */
  standings_moment: {
    kind: 'clinch' | 'eliminated' | 'leader' | 'streak' | 'streak-snapped'
    teamId: string
    place?: 'top' | 'direct' | 'field'
    won?: boolean
    length?: number
    runStart?: number
    previous?: string | null
  }
  /** A player crossed into or out of the unhappy bands (derived by the mood engine, not a fact change). */
  mood_changed: { playerId: string; teamId: string; from: string; to: string; reasons: string[] }
  /** You edited a player's roster facts (fields: name, height, nicknames, notes, ratings.<column>). */
  player_edited: { playerId: string; teamId: string; fields: string[]; renamedFrom?: string }
  /**
   * A secret you approved as revealed (제안함): its text left 비밀 for 공개 (`to` public: it's
   * confirmed) or 소문 (only whispered about), or a secret relationship became known. Not a fact
   * change: the community reacts to it like news. It carries only what is now public, never the
   * rest of the secret. `playerId` is null for a school or its GM; `text` is empty for a relationship.
   */
  secret_revealed: {
    suggestionId: number
    target: 'player' | 'team' | 'gm'
    playerId: string | null
    teamId: string
    to: 'public' | 'rumor'
    text: string
    relationship: { with: string; type: string; playerId: string | null } | null
  }
}

export type EventType = keyof EventPayloads

export interface LeagueEvent<T extends EventType = EventType> {
  id: number
  type: T
  seasonId: number | null
  payload: EventPayloads[T]
  createdAt: string
}
