import { describe, expect, it } from 'vitest'
import { leagueChampion, seriesTitle, type BracketSpot } from './season'

type Spot = BracketSpot & { winner: string | null }
const spot = (stage: Spot['stage'], round: number, group: string | null, winner: string | null = null): Spot => ({ stage, round, group, winner })

describe('seriesTitle and leagueChampion', () => {
  it('crown the final’s winner, and give each conference its last round', () => {
    const bracket = [spot('playoffs', 1, 'east', 't1'), spot('playoffs', 1, 'west', 't3'), spot('finals', 1, null)]
    expect(bracket.map((s) => seriesTitle(bracket, s))).toEqual(['group', 'group', 'league'])
    expect(leagueChampion(bracket)).toBeNull()
    bracket[2]!.winner = 't3'
    expect(leagueChampion(bracket)).toBe('t3')
  })

  it('take a league-wide bracket’s last round as the final, its play-in and earlier rounds as giving nothing', () => {
    const bracket = [spot('play-in', 1, 'league', 't5'), spot('playoffs', 1, 'league', 't1'), spot('playoffs', 1, 'league', 't2'), spot('finals', 2, 'league', 't1')]
    expect(bracket.map((s) => seriesTitle(bracket, s))).toEqual([null, null, null, 'league'])
    expect(leagueChampion(bracket)).toBe('t1')
  })

  it('crown a one-conference bracket’s last round when no final follows', () => {
    const bracket = [spot('playoffs', 1, 'east', 't1'), spot('playoffs', 1, 'east', 't2'), spot('playoffs', 2, 'east', 't2')]
    expect(bracket.map((s) => seriesTitle(bracket, s))).toEqual([null, null, 'league'])
    expect(leagueChampion(bracket)).toBe('t2')
  })

  it('give several conferences only their own titles when no final follows', () => {
    const bracket = [spot('playoffs', 1, 'east', 't1'), spot('playoffs', 1, 'west', 't3')]
    expect(bracket.map((s) => seriesTitle(bracket, s))).toEqual(['group', 'group'])
    expect(leagueChampion(bracket)).toBeNull()
  })
})
