import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import type { EventPayloads } from '@shared/events'
import { openDb, type Db } from './db'
import { currentSeason, listEvents, loadConfig, seedLeague } from './league'
import { announceStandingsMoments } from './moments'
import { fillRound } from './schedule'
import { listGames, recordScore, startSeason, teamRefs } from './season'

/** The 8-team sample league (two conferences of 4; the top 2 of each go straight in), its season started. */
function league(): Db {
  const db = openDb(':memory:')
  seedLeague(db, sampleSetup())
  startSeason(db)
  return db
}

/** Plays a round: the lower team number always wins, by 10. */
function playRound(db: Db, round: number) {
  for (const g of listGames(db, currentSeason(db).id).filter((x) => x.round === round)) {
    const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
    recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
  }
}

const moments = (db: Db) => listEvents(db, 'standings_moment').map((e) => e.payload as EventPayloads['standings_moment'])

describe('standings moments', () => {
  it('announces each clinch, elimination, new #1 and streak milestone once, and only when it can no longer change', () => {
    const db = league()
    const refs = teamRefs(db, loadConfig(db).config)
    const byConference = new Map<string, string[]>()
    for (const r of refs) byConference.set(r.conferenceId!, [...(byConference.get(r.conferenceId!) ?? []), r.id])
    // Final order in each conference: lower numbers first (they beat everyone above them).
    const finalRank = (id: string) => {
      const list = byConference.get(refs.find((r) => r.id === id)!.conferenceId!)!
      return [...list].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).indexOf(id) + 1
    }
    for (let round = 1; round <= 7; round++) {
      playRound(db, round)
      announceStandingsMoments(db)
      // Asking again with nothing new says nothing new.
      expect(announceStandingsMoments(db)).toEqual([])
      for (const m of moments(db)) {
        // Whatever was announced holds in the final table.
        if (m.kind === 'clinch') expect(finalRank(m.teamId)).toBeLessThanOrEqual(m.place === 'top' ? 1 : 2)
        if (m.kind === 'eliminated') expect(finalRank(m.teamId)).toBeGreaterThan(2)
      }
    }
    const all = moments(db)
    // t1 wins all seven: 1st place, a #1 once everyone had three games, and streaks of 5 and 7.
    expect(all).toContainEqual({ kind: 'clinch', teamId: 't1', place: 'top' })
    expect(all.filter((m) => m.kind === 'leader')).toEqual([{ kind: 'leader', teamId: 't1', previous: null }])
    expect(all.filter((m) => m.teamId === 't1' && m.kind === 'streak').map((m) => m.length)).toEqual([5, 7])
    // t8 loses all seven: out, and losing streaks of 5 and 7.
    expect(all).toContainEqual({ kind: 'eliminated', teamId: 't8' })
    expect(all.filter((m) => m.teamId === 't8' && m.kind === 'streak').map((m) => [m.won, m.length])).toEqual([
      [false, 5],
      [false, 7],
    ])
    // Each moment once.
    const keys = all.map((m) => JSON.stringify(m))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('waits for a game typed late for an earlier round before telling a streak, and tells it once', () => {
    const db = league()
    const t5Wins = (round: number) => round !== 1 && round !== 2
    const play = (round: number) => {
      for (const g of listGames(db, currentSeason(db).id).filter((x) => x.round === round)) {
        const t5 = g.home === 't5' || g.away === 't5'
        const homeWins = t5 ? (g.home === 't5') === t5Wins(round) : Number(g.home.slice(1)) < Number(g.away.slice(1))
        recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
      }
    }
    const streaks = () => moments(db).filter((m) => m.teamId === 't5' && m.kind === 'streak')
    // t5 loses R1, its R2 game waits, and it wins R3–R7: five straight, but R2 could still break the run.
    play(1)
    for (let r = 3; r <= 7; r++) {
      play(r)
      announceStandingsMoments(db)
    }
    expect(streaks()).toEqual([])
    // R2 comes in late, a loss: the run of five stands, told once, known by its first game (R3's).
    play(2)
    announceStandingsMoments(db)
    announceStandingsMoments(db)
    const r3 = listGames(db, currentSeason(db).id).find((g) => g.round === 3 && (g.home === 't5' || g.away === 't5'))!
    expect(streaks()).toEqual([{ kind: 'streak', teamId: 't5', won: true, length: 5, runStart: r3.id }])
  })

  it('doesn’t tell a streak again when a correction stretches it back, nor before earlier rounds are built', () => {
    // Built by hand: rounds 1, 3–7 first, round 2 last.
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'manual' }
    seedLeague(db, setup)
    startSeason(db)
    const t5Wins = (round: number) => round >= 3
    const play = (round: number) => {
      fillRound(db, round)
      for (const g of listGames(db, currentSeason(db).id).filter((x) => x.round === round && x.status === 'scheduled')) {
        const t5 = g.home === 't5' || g.away === 't5'
        const homeWins = t5 ? (g.home === 't5') === t5Wins(round) : Number(g.home.slice(1)) < Number(g.away.slice(1))
        recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
      }
      announceStandingsMoments(db)
    }
    const streaks = () => moments(db).filter((m) => m.teamId === 't5' && m.kind === 'streak')
    play(1)
    for (let r = 3; r <= 7; r++) play(r)
    // Round 2 isn't built yet: a game could still come in behind the run.
    expect(streaks()).toEqual([])
    play(2)
    expect(streaks().map((m) => m.length)).toEqual([5])
    // R2 corrected to a win: the run now starts a game earlier (six straight), but it's the same run, already told.
    const r2 = listGames(db, currentSeason(db).id).find((g) => g.round === 2 && (g.home === 't5' || g.away === 't5'))!
    recordScore(db, { gameId: r2.id, homeScore: r2.home === 't5' ? 100 : 90, awayScore: r2.home === 't5' ? 90 : 100, lines: null })
    announceStandingsMoments(db)
    expect(streaks().map((m) => m.length)).toEqual([5])
  })

  it('says nothing outside the regular season', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    expect(announceStandingsMoments(db)).toEqual([])
  })
})
