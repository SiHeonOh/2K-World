import { describe, expect, it } from 'vitest'
import type { EventType, LeagueEvent } from '@shared/events'
import { planReactions } from './triggers'

let next = 1
const event = (type: EventType, payload: object): LeagueEvent => ({ id: next++, type, seasonId: 1, payload: payload as never, createdAt: '' })
const game = (type: 'game_recorded' | 'game_unrecorded', gameId: number) =>
  event(type, { gameId, stage: 'regular', home: 't1', away: 't2', homeScore: 90, awayScore: 80 })
const corrected = (gameId: number) => event('game_corrected', { gameId, before: { homeScore: 90, awayScore: 80 }, after: { homeScore: 80, awayScore: 90 } })

describe('reactions to 기록 취소', () => {
  it('takes back a game recorded in an earlier look', () => {
    const e = game('game_unrecorded', 7)
    expect(planReactions([corrected(7), e])).toEqual([{ kind: 'unrecorded', gameId: 7, event: e }])
  })

  it('says nothing about a game recorded and taken back in the same look', () => {
    expect(planReactions([game('game_recorded', 7), corrected(7), game('game_unrecorded', 7)])).toEqual([])
  })

  it('keys the thread of a game recorded and corrected in one look to the correction (it reads the corrected game)', () => {
    const recorded = game('game_recorded', 7)
    const fix = corrected(7)
    expect(planReactions([recorded, fix])).toEqual([{ kind: 'post_game_thread', gameId: 7, eventId: fix.id }])
  })

  it('takes the old result back before a new one gets its thread', () => {
    const back = game('game_unrecorded', 7)
    const again = game('game_recorded', 7)
    expect(planReactions([back, again])).toEqual([
      { kind: 'unrecorded', gameId: 7, event: back },
      { kind: 'post_game_thread', gameId: 7, eventId: again.id },
    ])
  })
})
