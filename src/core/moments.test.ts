import { describe, expect, it } from 'vitest'
import { aloneAtTop, currentMoments, milestoneReached, playoffPicture, runs, streakMilestone, type MomentTeam } from './moments'

const team = (teamId: string, wins: number, losses: number, left: number, group = 'east', results: boolean[] = [], settled = true): MomentTeam => ({
  teamId,
  group,
  wins,
  losses,
  left,
  results,
  // Game ids 101, 102, … in order.
  gameIds: results.map((_, i) => 101 + i),
  settled,
})

describe('playoffPicture', () => {
  it('says nothing early on, when everyone can still get anywhere', () => {
    const teams = ['a', 'b', 'c', 'd', 'e'].map((id) => team(id, 1, 1, 8))
    for (const p of playoffPicture(teams, 2, 4).values()) expect(p).toEqual({ top: false, direct: false, field: false, out: false })
  })

  it('clinches a place only when no later result can take it away, ties counting against', () => {
    // Five teams, 2 straight in, 4 with the play-in. a: 9 wins with 1 left; b can reach 9; c, d, e can't.
    const teams = [team('a', 9, 0, 1), team('b', 7, 2, 2), team('c', 5, 4, 2), team('d', 3, 6, 3), team('e', 2, 7, 2)]
    const p = playoffPicture(teams, 2, 4)
    // b could tie a (9), so a hasn't clinched 1st; but only b can reach it, so a is surely top 2.
    expect(p.get('a')).toEqual({ top: false, direct: true, field: true, out: false })
    // c (5): a, b and d (3+3 = 6) could reach 5, e (2+2 = 4) can't. Three rivals could pass: not surely top 2, but surely top 4.
    expect(p.get('c')).toMatchObject({ direct: false, field: true })
    // e can reach 4 at most; a (9), b (7) and c (5) are already above that, d (3) isn't: 3 < 4, so e isn't out yet.
    expect(p.get('e')!.out).toBe(false)
    const later = [team('a', 10, 0, 0), team('b', 8, 2, 0), team('c', 6, 4, 0), team('d', 5, 5, 0), team('e', 2, 8, 0)]
    const end = playoffPicture(later, 2, 4)
    expect(end.get('a')).toEqual({ top: true, direct: true, field: true, out: false })
    expect(end.get('e')!.out).toBe(true)
  })

  it('keeps groups apart, and a place every team in a group gets is no news', () => {
    const teams = [team('a', 5, 0, 0, 'east'), team('b', 0, 5, 0, 'east'), team('c', 5, 0, 0, 'west')]
    const p = playoffPicture(teams, 2, 4)
    // Two teams in the east and 2 go straight in: not news. 1st place is.
    expect(p.get('a')).toEqual({ top: true, direct: false, field: false, out: false })
    expect(p.get('b')!.out).toBe(false)
    expect(p.get('c')!.top).toBe(false)
  })
})

describe('streaks', () => {
  it('finds the current run and the one before it', () => {
    expect(runs([])).toEqual({ current: null, previous: null })
    expect(runs([true, true, true])).toEqual({ current: { won: true, length: 3, start: 0 }, previous: null })
    expect(runs([false, true, true, true, true, true, false])).toEqual({
      current: { won: false, length: 1, start: 6 },
      previous: { won: true, length: 5, start: 1 },
    })
    expect([3, 5, 6, 7, 9, 10, 15, 20].filter(streakMilestone)).toEqual([5, 7, 10, 15, 20])
    // A run that skipped past a milestone (two results at once) still has it.
    expect([4, 5, 6, 7, 9, 12, 16].map(milestoneReached)).toEqual([0, 5, 5, 7, 7, 10, 15])
  })

  it('reports clinches, eliminations, streak milestones and snapped runs, a run known by its first game', () => {
    const fiveWins = [false, true, true, true, true, true]
    const snapped = [true, true, true, true, true, false]
    const moments = currentMoments(
      [team('a', 10, 0, 0, 'east', fiveWins), team('b', 5, 5, 0, 'east', snapped), team('c', 0, 10, 0, 'east'), team('d', 0, 10, 0, 'east')],
      1,
      2,
    )
    expect(moments).toEqual([
      { kind: 'clinch', teamId: 'a', place: 'top' },
      { kind: 'streak', teamId: 'a', won: true, length: 5, runStart: 102 },
      { kind: 'clinch', teamId: 'b', place: 'field' },
      { kind: 'streak-snapped', teamId: 'b', won: true, length: 5, runStart: 101 },
      { kind: 'eliminated', teamId: 'c' },
      { kind: 'eliminated', teamId: 'd' },
    ])
  })

  it('tells no streak while an earlier game is unplayed, and a snapped run only while it is fresh', () => {
    const unsettled = currentMoments([team('a', 5, 0, 5, 'east', [true, true, true, true, true], false)], 0, 0)
    expect(unsettled).toEqual([])
    const stale = currentMoments([team('b', 5, 3, 5, 'east', [true, true, true, true, true, false, false, false])], 0, 0)
    expect(stale).toEqual([])
  })
})

describe('aloneAtTop', () => {
  it('needs a lead that games in hand can’t close, so entry order within a round makes no leader', () => {
    // Level at 3-1; one has played its 5th game (a win), the other not yet.
    expect(aloneAtTop({ wins: 4, games: 5 }, [{ wins: 3, games: 4 }])).toBe(false)
    // Once both have played it and only one won, the winner is alone.
    expect(aloneAtTop({ wins: 4, games: 5 }, [{ wins: 3, games: 5 }])).toBe(true)
    expect(aloneAtTop({ wins: 4, games: 5 }, [{ wins: 4, games: 5 }])).toBe(false)
  })
})
