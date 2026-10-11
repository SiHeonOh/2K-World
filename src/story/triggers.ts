import type { EventPayloads, EventType, LeagueEvent } from '@shared/events'

/**
 * Which story jobs new league events call for. Every recorded game gets its
 * own thread; awards and draft moves that land together share one, as do
 * mood swings and the lineup changes behind them; trades, series results,
 * seeding, the season start, your news and each secret you approved as
 * revealed get one each.
 */

export type Reaction =
  | { kind: 'post_game_thread'; gameId: number; eventId: number }
  | { kind: 'event_thread'; events: LeagueEvent[] }
  /** A score was corrected: rebuild a thread still waiting, or post a correction. */
  | { kind: 'correction'; gameId: number; event: LeagueEvent }
  /** 기록 취소: drop a thread still waiting, or tell the board the result was taken back. */
  | { kind: 'unrecorded'; gameId: number; event: LeagueEvent }

const OWN_THREAD: EventType[] = ['trade_applied', 'series_won', 'playoffs_seeded', 'season_started', 'news_posted', 'secret_revealed']
const BATCHED: Partial<Record<EventType, string>> = {
  award_given: 'awards',
  draft_protect: 'draft',
  draft_swap: 'draft',
  draft_pass: 'draft',
  mood_changed: 'moods',
  // A starter sent to the bench (or brought in from it) shares a thread with the moods it stirs.
  slots_changed: 'moods',
  // Clinches, eliminations, a new #1 and streaks after one look share a thread.
  standings_moment: 'standings',
  wanting_out: 'moods',
  // Players' words after one look share a thread (an interview piece and the fans' take).
  player_said: 'quotes',
  // A window's close and the talks that leaked from it share one thread.
  trade_window_closed: 'market',
  trade_talks: 'market',
}

/** At most this many jobs from one batch of events (e.g. a whole round typed in at once still gets every game). */
export const MAX_REACTIONS = 40

export function planReactions(events: LeagueEvent[]): Reaction[] {
  const out: Reaction[] = []
  const games = new Map<number, number>()
  const corrections = new Map<number, LeagueEvent>()
  const unrecorded = new Map<number, LeagueEvent>()
  const groups = new Map<string, LeagueEvent[]>()
  for (const e of events) {
    if (e.type === 'game_corrected') {
      const id = (e.payload as { gameId: number }).gameId
      corrections.set(id, e)
      // Recorded and corrected in one look: the thread reads the corrected game, so it's keyed to the correction
      // (a thread is dropped unwritten when its game changed after its event; see gameAsTold).
      if (games.has(id)) games.set(id, e.id)
    } else if (e.type === 'game_recorded') {
      // A game recorded twice in one batch (a quick correction) gets one thread.
      games.set((e.payload as { gameId: number }).gameId, e.id)
    } else if (e.type === 'game_unrecorded') {
      const id = (e.payload as { gameId: number }).gameId
      corrections.delete(id)
      // Recorded and taken back in one batch: nobody heard of it. Otherwise its thread is taken back.
      if (games.has(id)) games.delete(id)
      else unrecorded.set(id, e)
    } else if (OWN_THREAD.includes(e.type)) {
      out.push({ kind: 'event_thread', events: [e] })
    } else if (e.type === 'slots_changed' && !(e.payload as EventPayloads['slots_changed']).rotation) {
      // A PG becoming the SG is bookkeeping: only a move between the starters and the bench is news.
    } else if (BATCHED[e.type]) {
      const key = BATCHED[e.type]!
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(e)
    }
  }
  const threads: Reaction[] = [...games].map(([gameId, eventId]) => ({ kind: 'post_game_thread', gameId, eventId }))
  // A game recorded in this same batch gets its thread with the corrected score anyway.
  const fixes: Reaction[] = [...corrections].filter(([gameId]) => !games.has(gameId)).map(([gameId, event]) => ({ kind: 'correction', gameId, event }))
  const batched: Reaction[] = [...groups.values()].map((list) => ({ kind: 'event_thread', events: list }))
  // Taken back first: a game recorded again in the same batch gets its new thread after the old one is dropped.
  const takenBack: Reaction[] = [...unrecorded].map(([gameId, event]) => ({ kind: 'unrecorded', gameId, event }))
  return [...takenBack, ...threads, ...fixes, ...out, ...batched].slice(0, MAX_REACTIONS)
}
