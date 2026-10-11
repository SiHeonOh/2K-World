import type { LeagueConfig } from './config/schema'

/**
 * 2K 일정대로 (`season.schedule.build: 'played'`): a round robin with no
 * rounds. Like an NBA schedule in 2K, some schools play on a given day and
 * others rest, so games played per school drift apart. Each game is picked
 * as it's played (any pair with a meeting left) and goes into the open
 * session; 오늘 경기 끝 closes the session, and a closed session counts as a
 * completed round for everything rounds drive (round-ups, wiki edits, the
 * lore sweep, trade windows, round polls). Sessions are stored as the games'
 * round, so "round" means "session" there.
 */

type Mode = Pick<LeagueConfig, 'season'> | boolean

/** Whether the league plays its regular season as 2K 일정대로 sessions. */
export function playedMode(config: Mode): boolean {
  if (typeof config === 'boolean') return config
  const { schedule } = config.season
  return schedule.kind === 'round-robin' && schedule.build === 'played'
}

/**
 * How a regular-season round is named, for screens and for the writers'
 * prompts alike: a session is "5일차"; a round is "R5" (short) or "5라운드"
 * (long). One helper, so no screen or prompt calls a session a round.
 */
export function roundLabel(config: Mode, n: number, form: 'short' | 'long' = 'short'): string {
  if (playedMode(config)) return `${n}일차`
  return form === 'long' ? `${n}라운드` : `R${n}`
}
