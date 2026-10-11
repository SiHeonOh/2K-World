import { describe, expect, it } from 'vitest'
import { rng, shuffle } from '@core/random'
import { playedMode, roundLabel } from '@shared/played'
import { checkSetup, type LeagueSetup, type Player, type Team } from '@shared/setup'
import { settingsOf, type LeagueSettingsInput } from '@shared/settings'
import { sampleConfig, sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from './db'
import { currentSeason, listEvents, listTeams, loadConfig, seedLeague } from './league'
import { addPlayedGame, closeSession, openSession, playedPairs } from './played'
import { RuleError } from './rules'
import { addScheduledGame, clearRound, fillRound, flipScheduledGame, removeScheduledGame, roundComplete, scheduleInfo, scheduleOptions } from './schedule'
import { listGames, recordScore, standings, startPlayoffs, startSeason, unrecordGame } from './season'
import { checkSettings, commitSettings, settingsState } from './settings'

function league(change?: (s: LeagueSetup) => void): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  change?.(setup)
  seedLeague(db, setup)
  return db
}

/** The 8-team sample league in 2K 일정대로: each pair meets `cycles` times, 28 games a cycle. */
const played = (cycles = 1) => league((s) => void (s.config.season.schedule = { kind: 'round-robin', cycles, build: 'played' }))

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    throw e
  }
  return []
}
const refusalParams = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues[0]!.params
    throw e
  }
  return null
}

const games = (db: Db) => listGames(db, currentSeason(db).id).filter((g) => g.stage === 'regular')
const inRound = (db: Db, round: number) => games(db).filter((g) => g.round === round)
/** The home school wins by ten. */
const play = (db: Db, gameId: number) => recordScore(db, { gameId, homeScore: 80, awayScore: 70, lines: null })
const addAndPlay = (db: Db, home: string, away: string) => {
  const { gameId } = addPlayedGame(db, { home, away })
  play(db, gameId)
  return gameId
}

describe('2K 일정대로: games picked as they are played', () => {
  it('starts the season with no games, knowing the whole season, with session 1 open', () => {
    const db = played()
    expect(refusal(() => addPlayedGame(db, { home: 't1', away: 't2' }))).toEqual(['wrong-phase'])
    expect(startSeason(db)).toEqual({ games: 28 })
    expect(games(db)).toEqual([])
    expect(scheduleInfo(db)).toEqual({ build: 'played', rounds: 1, perRound: 0, total: 28, played: 0, editable: true, session: 1 })
    expect(standings(db)).toMatchObject({ played: 0, scheduled: 0, total: 28 })
    expect(listEvents(db, 'season_started')[0]!.payload).toEqual({ games: 28 })
  })

  it('takes any pair with a meeting left, the first school hosting, and a school more than once a session', () => {
    const db = played()
    startSeason(db)
    expect(addPlayedGame(db, { home: 't1', away: 't2' })).toMatchObject({ round: 1 })
    addPlayedGame(db, { home: 't3', away: 't1' })
    addPlayedGame(db, { home: 't1', away: 't4' })
    expect(inRound(db, 1).map((g) => [g.home, g.away])).toEqual([
      ['t1', 't2'],
      ['t3', 't1'],
      ['t1', 't4'],
    ])
    // The pair met already (either way round), a school against itself, a school that isn't there.
    expect(refusal(() => addPlayedGame(db, { home: 't2', away: 't1' }))).toEqual(['schedule-already-met'])
    expect(refusalParams(() => addPlayedGame(db, { home: 't2', away: 't1' }))).toEqual({ a: '나람고', b: '가람고' })
    expect(refusal(() => addPlayedGame(db, { home: 't5', away: 't5' }))).toEqual(['schedule-same-team'])
    expect(refusal(() => addPlayedGame(db, { home: 't5', away: 't99' }))).toEqual(['unknown-team'])
    // No rounds to build here.
    expect(refusal(() => addScheduledGame(db, { round: 2, home: 't5', away: 't6' }))).toEqual(['schedule-played'])
    expect(refusal(() => fillRound(db, 1))).toEqual(['schedule-played'])
    expect(refusal(() => scheduleOptions(db, 1, 't5'))).toEqual(['schedule-played'])
    // Unplayed games can still be flipped and taken out, as in a round built by hand.
    const [first] = inRound(db, 1)
    flipScheduledGame(db, first!.id)
    expect(inRound(db, 1)[0]).toMatchObject({ home: 't2', away: 't1' })
    removeScheduledGame(db, first!.id)
    // Taken out, the pair has its meeting back.
    expect(addPlayedGame(db, { home: 't1', away: 't2' }).round).toBe(1)
  })

  it('lets each pair meet exactly as often as the schedule says', () => {
    const db = played(2)
    startSeason(db)
    expect(standings(db).total).toBe(56)
    addAndPlay(db, 't1', 't2')
    // A second meeting may come in the same session.
    addAndPlay(db, 't2', 't1')
    expect(refusal(() => addPlayedGame(db, { home: 't1', away: 't2' }))).toEqual(['schedule-already-met'])
    const pairs = playedPairs(db)
    expect(pairs.meetings).toBe(2)
    expect(pairs.open.t1!.map((o) => o.teamId)).not.toContain('t2')
    expect(pairs.open.t1!.find((o) => o.teamId === 't3')).toEqual({ teamId: 't3', left: 2 })
  })

  it('shows the picker each school’s games and who it still has to meet', () => {
    const db = played()
    startSeason(db)
    addAndPlay(db, 't1', 't2')
    addPlayedGame(db, { home: 't1', away: 't3' })
    const pairs = playedPairs(db)
    expect(pairs.session).toBe(1)
    expect(pairs.teams.find((x) => x.teamId === 't1')).toEqual({ teamId: 't1', played: 1, scheduled: 1, left: 5 })
    expect(pairs.teams.find((x) => x.teamId === 't8')).toEqual({ teamId: 't8', played: 0, scheduled: 0, left: 7 })
    // A game added but not played counts as met.
    expect(pairs.open.t1!.map((o) => o.teamId)).toEqual(['t4', 't5', 't6', 't7', 't8'])
    expect(pairs.open.t2!.map((o) => o.teamId)).not.toContain('t1')
    expect(pairs.open.t3!.map((o) => o.teamId)).not.toContain('t1')
  })

  it('closes a session with 오늘 경기 끝, never with a game unplayed or none at all, and opens the next', () => {
    const db = played()
    startSeason(db)
    const season = currentSeason(db).id
    expect(refusal(() => closeSession(db))).toEqual(['session-empty'])
    const a = addAndPlay(db, 't1', 't2')
    const { gameId: b } = addPlayedGame(db, { home: 't3', away: 't4' })
    // The unplayed game is named, so the screen can say which.
    expect(refusal(() => closeSession(db))).toEqual(['session-unplayed'])
    expect(refusalParams(() => closeSession(db))).toEqual({ round: 1, count: 1, games: '다람고–라람고' })
    expect(roundComplete(db, season, 1)).toBe(false)
    play(db, b)
    // Played, but not closed: the session isn't complete yet, whatever its size.
    expect(roundComplete(db, season, 1)).toBe(false)
    expect(closeSession(db)).toEqual({ round: 1, next: 2 })
    expect(listEvents(db, 'round_closed').map((e) => e.payload)).toEqual([{ round: 1, games: 2, by: 'button' }])
    expect(roundComplete(db, season, 1)).toBe(true)
    expect(openSession(db, season)).toBe(2)
    expect(scheduleInfo(db)).toMatchObject({ build: 'played', rounds: 2, session: 2, played: 2 })
    // New games go to session 2; session 2 isn't complete until it's closed too.
    expect(addPlayedGame(db, { home: 't5', away: 't6' }).round).toBe(2)
    expect(roundComplete(db, season, 2)).toBe(false)
    expect(refusal(() => closeSession(db))).toEqual(['session-unplayed'])
    // 기록 취소 in a closed session: it stays closed (its round-up was told), and the game waits to be played again.
    unrecordGame(db, a)
    expect(roundComplete(db, season, 1)).toBe(false)
    expect(openSession(db, season)).toBe(2)
    play(db, a)
    expect(roundComplete(db, season, 1)).toBe(true)
  })

  it('works out standings and games behind with uneven games played', () => {
    const db = played()
    startSeason(db)
    // t1 plays three, t5 and t6 one each, t7 and t8 none.
    addAndPlay(db, 't1', 't2')
    addAndPlay(db, 't1', 't3')
    addAndPlay(db, 't1', 't4')
    addAndPlay(db, 't5', 't6')
    const view = standings(db)
    const line = (id: string) => view.overall.find((l) => l.teamId === id)!
    expect([line('t1').wins, line('t1').losses]).toEqual([3, 0])
    expect([line('t5').wins, line('t5').losses]).toEqual([1, 0])
    expect([line('t7').wins, line('t7').losses]).toEqual([0, 0])
    expect(view).toMatchObject({ played: 4, scheduled: 0, total: 28 })
    // Both unbeaten: t1 leads (point difference), and t5 is a game behind (two wins fewer, as many losses).
    expect(view.overall[0]!.teamId).toBe('t1')
    expect(line('t5').gamesBehind).toBe(1)
    expect(line('t2').gamesBehind).toBe(2)
    expect(line('t7').gamesBehind).toBe(1.5)
  })

  it('ends the regular season only once every pair has met; 플레이오프 시작 closes a last session left open', () => {
    const db = played()
    startSeason(db)
    const ids = listTeams(db).map((t) => t.id)
    const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const))
    pairs.slice(0, 10).forEach(([a, b]) => addAndPlay(db, a, b))
    closeSession(db)
    pairs.slice(10, 27).forEach(([a, b]) => addAndPlay(db, b, a))
    expect(refusal(() => startPlayoffs(db))).toEqual(['games-left'])
    const [x, y] = pairs[27]!
    const { gameId } = addPlayedGame(db, { home: x, away: y })
    expect(refusalParams(() => startPlayoffs(db))).toEqual({ count: 1 })
    play(db, gameId)
    expect(playedPairs(db).open).toEqual(Object.fromEntries(ids.map((id) => [id, []])))
    expect(standings(db)).toMatchObject({ played: 28, total: 28 })
    startPlayoffs(db)
    expect(currentSeason(db).phase).toBe('playoffs')
    expect(listEvents(db, 'round_closed').map((e) => e.payload)).toEqual([
      { round: 1, games: 10, by: 'button' },
      { round: 2, games: 18, by: 'playoffs' },
    ])
    expect(roundComplete(db, currentSeason(db).id, 2)).toBe(true)
    expect(scheduleInfo(db)).toMatchObject({ build: 'played', rounds: 2, editable: false })
  })

  it('doesn’t close an empty session at the playoffs when 오늘 경기 끝 closed the last one', () => {
    const db = played()
    startSeason(db)
    const ids = listTeams(db).map((t) => t.id)
    for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) addAndPlay(db, a, b)
    closeSession(db)
    startPlayoffs(db)
    expect(listEvents(db, 'round_closed').map((e) => e.payload)).toEqual([{ round: 1, games: 28, by: 'button' }])
  })

  it('plays a whole 36-school season in random, uneven order and reaches the playoffs', () => {
    const db = openDb(':memory:')
    seedLeague(db, schools(36))
    expect(startSeason(db)).toEqual({ games: 630 })
    const random = rng('2k-days')
    const uneven: number[] = []
    for (let day = 1; ; day++) {
      const left = playedPairs(db)
      const open = Object.entries(left.open).filter(([, list]) => list.length > 0)
      if (open.length === 0) break
      // A 2K play session: anywhere from 1 to 30 games, some schools twice, others resting.
      const count = 1 + Math.floor(random() * 30)
      for (let i = 0; i < count; i++) {
        const now = playedPairs(db).open
        const choices = Object.entries(now).filter(([, list]) => list.length > 0)
        if (choices.length === 0) break
        const [home, list] = choices[Math.floor(random() * choices.length)]!
        const away = shuffle(list, random)[0]!.teamId
        const { gameId, round } = addPlayedGame(db, { home, away })
        expect(round).toBe(day)
        const homeScore = 70 + Math.floor(random() * 30)
        recordScore(db, { gameId, homeScore, awayScore: homeScore + (random() < 0.5 ? 6 : -6), lines: null })
      }
      const view = standings(db)
      const gp = view.overall.map((l) => l.wins + l.losses)
      uneven.push(Math.max(...gp) - Math.min(...gp))
      // Most nights end with 오늘 경기 끝; the last one is left for 플레이오프 시작.
      if (playedPairs(db).teams.some((x) => x.left > 0)) closeSession(db)
    }
    // Games played drifted apart along the way, as in 2K, and everyone ended on 35.
    expect(Math.max(...uneven)).toBeGreaterThan(3)
    const end = standings(db)
    expect(end).toMatchObject({ played: 630, scheduled: 0, total: 630 })
    expect(end.overall.every((l) => l.wins + l.losses === 35)).toBe(true)
    const met = new Set(games(db).map((g) => [g.home, g.away].sort().join('|')))
    expect(met.size).toBe(630)
    startPlayoffs(db)
    expect(currentSeason(db).phase).toBe('playoffs')
    const closed = listEvents(db, 'round_closed')
    expect((closed.at(-1)!.payload as { by: string }).by).toBe('playoffs')
    expect(closed.map((e) => (e.payload as { round: number }).round)).toEqual(closed.map((_, i) => i + 1))
  }, 30_000) // A whole season: slow when the machine is busy.
})

describe('2K 일정대로 in the setup and 리그 설정', () => {
  /** The settings as they stand, to change and save. */
  const current = (db: Db): LeagueSettingsInput => structuredClone(settingsOf(loadConfig(db).config, listTeams(db)))
  const save = (db: Db, change: (s: LeagueSettingsInput) => void) => {
    const input = current(db)
    change(input)
    return commitSettings(db, checkSettings(db, input))
  }
  const build = (b: 'auto' | 'manual' | 'played') => (s: LeagueSettingsInput) => void (s.schedule = { kind: 'round-robin', cycles: 1, build: b })

  it('is a round robin’s way of building games: the setup check takes it, and refuses it for a custom game count', () => {
    const setup = sampleSetup()
    setup.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'played' }
    const ok = checkSetup(setup)
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.setup.config.season.schedule).toEqual({ kind: 'round-robin', cycles: 1, build: 'played' })
    const custom = { ...setup, config: { ...setup.config, season: { ...setup.config.season, schedule: { kind: 'custom', gamesPerTeam: 10, build: 'played' } } } }
    const refused = checkSetup(custom)
    expect(refused.ok).toBe(false)
    expect(refused.issues.map((i) => i.code)).toContain('played-needs-round-robin')
    expect(playedMode(sampleConfig())).toBe(false)
    expect(roundLabel(ok.ok ? ok.setup.config : sampleConfig(), 5)).toBe('5일차')
    expect([roundLabel(sampleConfig(), 5), roundLabel(sampleConfig(), 5, 'long')]).toEqual(['R5', '5라운드'])
  })

  it('switches either way in the preseason', () => {
    const db = league()
    save(db, build('played'))
    expect(loadConfig(db).config.season.schedule).toEqual({ kind: 'round-robin', cycles: 1, build: 'played' })
    expect(settingsState(db).playedSwitch).toBeNull()
    save(db, build('auto'))
    expect(loadConfig(db).config.season.schedule).toEqual({ kind: 'round-robin', cycles: 1, build: 'auto' })
  })

  it('switches a running season to it only while no built game waits unplayed, and never back', () => {
    // A drawn schedule has every game built: it waits for all of them, or for unplayed rounds cleared.
    const drawn = league()
    startSeason(drawn)
    expect(settingsState(drawn).playedSwitch).toEqual({ open: false, code: 'settings-played-unplayed', params: { count: 28 } })
    expect(refusal(() => save(drawn, build('played')))).toEqual(['settings-played-unplayed'])
    for (const g of inRound(drawn, 1)) play(drawn, g.id)
    for (let r = 2; r <= 7; r++) clearRound(drawn, r)
    expect(settingsState(drawn).playedSwitch).toEqual({ open: true, code: null, params: {} })
    // Only how games are built: meetings or the calendar don't change with it.
    expect(refusal(() => save(drawn, (s) => void (s.schedule = { kind: 'round-robin', cycles: 2, build: 'played' })))).toEqual(['settings-season-running'])
    save(drawn, build('played'))
    expect(playedMode(loadConfig(drawn).config)).toBe(true)

    // Rounds built by hand: round 1 played in full, round 2 half built and played. They become sessions 1 and 2, closed.
    const db = league((s) => void (s.config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'manual' }))
    startSeason(db)
    fillRound(db, 1)
    for (const g of inRound(db, 1)) play(db, g.id)
    addScheduledGame(db, { round: 2, home: 't1', away: scheduleOptions(db, 2, 't1').options.find((o) => o.status === 'ok')!.teamId })
    const season = currentSeason(db).id
    expect(refusal(() => save(db, build('played')))).toEqual(['settings-played-unplayed'])
    for (const g of inRound(db, 2)) play(db, g.id)
    expect(roundComplete(db, season, 2)).toBe(false)
    save(db, build('played'))
    expect(listEvents(db, 'round_closed').map((e) => e.payload)).toEqual([{ round: 2, games: 1, by: 'switch' }])
    expect(openSession(db, season)).toBe(3)
    expect(roundComplete(db, season, 1)).toBe(true)
    expect(roundComplete(db, season, 2)).toBe(true)
    expect(scheduleInfo(db)).toMatchObject({ build: 'played', rounds: 3, session: 3, played: 5 })
    // The pairs that met keep their meetings; the next game goes into session 3.
    const met = inRound(db, 1)[0]!
    expect(refusal(() => addPlayedGame(db, { home: met.away, away: met.home }))).toEqual(['schedule-already-met'])
    expect(addPlayedGame(db, { home: 't8', away: playedPairs(db).open.t8![0]!.teamId }).round).toBe(3)
    // Out of it mid-season: no.
    expect(settingsState(db).playedSwitch).toBeNull()
    expect(refusal(() => save(db, build('manual')))).toEqual(['settings-played-leave'])
  })
})

/** A made-up league of `n` schools in 2K 일정대로 (one conference bracket of eight), six players each. */
function schools(n: number): LeagueSetup {
  const config = sampleConfig()
  config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'played' }
  const divisions = config.structure.divisions.map((d) => d.id)
  const teams: Team[] = Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    name: `학교${i + 1}고등학교`,
    shortName: `학교${i + 1}`,
    divisionId: divisions[i % divisions.length]!,
    control: 'ai',
    colors: [],
  }))
  const players: Player[] = teams.flatMap((team, ti) =>
    config.roster.slots.map((slot, si) => ({
      id: `p${ti * 6 + si + 1}`,
      teamId: team.id,
      name: `선수${ti * 6 + si + 1}`,
      slotId: slot.id,
      height: `6'${si + 1}"`,
      nicknames: [],
      notes: '',
      ratings: { ovr: 70 + si, shoot: 'B+' },
    })),
  )
  return { config, teams, players }
}
