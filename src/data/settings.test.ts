import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import type { Phase } from '@shared/config/schema'
import { sampleSetup } from '@shared/testing/fixtures'
import { SetupError, type LeagueSetup } from '@shared/setup'
import { settingsOf, type LeagueSettingsInput } from '@shared/settings'
import { openDb, type Db } from './db'
import { currentSeason, factsStamp, listEvents, listTeams, loadConfig, seedLeague, updateConfig } from './league'
import { applyTrade, closeProtection, finishDraft, giveAward, listCards } from './moves'
import { RuleError } from './rules'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from './season'
import { cardsExpiring, checkSettings, commitSettings, sectionLocks, settingsState } from './settings'

function league(change?: (s: LeagueSetup) => void): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 4, cards: 2 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
  }
  change?.(setup)
  seedLeague(db, setup)
  return db
}

/** The settings as they stand, to change and save. */
const current = (db: Db): LeagueSettingsInput => structuredClone(settingsOf(loadConfig(db).config, listTeams(db)))
const save = (db: Db, change: (s: LeagueSettingsInput) => void) => {
  const input = current(db)
  change(input)
  return commitSettings(db, checkSettings(db, input))
}
const refusal = (fn: () => unknown): string[] => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    if (e instanceof SetupError) return e.issues.filter((i) => i.level === 'error').map((i) => i.code)
    throw e
  }
  return []
}

function playRegular(db: Db) {
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && g.stage === 'regular')
    if (open.length === 0) return
    for (const g of open) {
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
  }
}
function playPlayoffs(db: Db) {
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && g.stage !== 'regular')
    if (open.length === 0) return
    for (const g of open) recordScore(db, { gameId: g.id, homeScore: 100, awayScore: 90, lines: null })
  }
}
/** Takes a new league to a phase the way the season really goes. */
function to(db: Db, phase: Phase) {
  if (phase === 'preseason') return
  startSeason(db)
  if (phase === 'regular') return
  playRegular(db)
  startPlayoffs(db)
  if (phase === 'playoffs') return
  playPlayoffs(db)
  finishPlayoffs(db)
  if (phase === 'draft') return
  closeProtection(db)
  finishDraft(db)
}

describe('when each section can change', () => {
  it('follows the season: teams, control, awards, trades and rating names any time; the rest at their own times', () => {
    const open = (phase: Phase) =>
      Object.entries(sectionLocks(phase))
        .filter(([, l]) => l.open)
        .map(([s]) => s)
    expect(open('preseason')).toEqual(['teams', 'control', 'awards', 'trades', 'labels', 'roster', 'playoffs', 'draft', 'structure', 'schedule'])
    expect(open('regular')).toEqual(['teams', 'control', 'awards', 'trades', 'labels', 'roster', 'playoffs', 'draft'])
    expect(open('playoffs')).toEqual(['teams', 'control', 'awards', 'trades', 'labels', 'roster', 'draft'])
    expect(open('draft')).toEqual(['teams', 'control', 'awards', 'trades', 'labels'])
    expect(open('offseason')).toEqual(['teams', 'control', 'awards', 'trades', 'labels', 'roster', 'draft', 'structure'])
    expect(sectionLocks('playoffs').playoffs).toEqual({ open: false, code: 'settings-playoffs-started', params: { phase: 'playoffs' } })
    expect(sectionLocks('offseason').schedule.code).toBe('settings-schedule-next')
  })

  it('tells the screen what’s open now, with the cards already handed out', () => {
    const db = league()
    expect(settingsState(db)).toMatchObject({ phase: 'preseason', issuedCards: 0, freeze: { open: true }, draftKind: { open: true } })
    startSeason(db)
    expect(settingsState(db)).toMatchObject({ phase: 'regular', issuedCards: 2, draftKind: { open: false, code: 'settings-draft-kind' } })
    expect(settingsState(db).locks.structure).toMatchObject({ open: false, code: 'settings-season-running' })
  })

  it('refuses a structure change once the schedule exists, and allows it before', () => {
    const db = league()
    const moved = (s: LeagueSettingsInput) => void (s.teams.find((t) => t.id === 't1')!.divisionId = 's')
    startSeason(db)
    expect(refusal(() => save(db, moved))).toEqual(['settings-season-running'])
    expect(refusal(() => save(db, (s) => void (s.structure.divisions[0]!.name = '새 북')))).toEqual(['settings-season-running'])

    const fresh = league()
    save(fresh, moved)
    expect(listTeams(fresh).find((t) => t.id === 't1')!.divisionId).toBe('s')
  })

  it('takes the playoff format until the playoffs start, then not until the next preseason', () => {
    const db = league()
    startSeason(db)
    const r = save(db, (s) => {
      s.playoffs.seriesBestOf = 5
      s.standings.tiebreakers = ['point-diff', 'random']
    })
    expect(r.changed).toEqual(['playoffs'])
    expect(r.version).toBeGreaterThan(1)
    expect(loadConfig(db).config.season.playoffs.seriesBestOf).toBe(5)
    expect(listEvents(db, 'config_changed').at(-1)!.payload).toEqual({ version: r.version, sections: ['playoffs'] })
    playRegular(db)
    startPlayoffs(db)
    expect(refusal(() => save(db, (s) => void (s.playoffs.seriesBestOf = 7)))).toEqual(['settings-playoffs-started'])
  })

  it('takes games per season only in the preseason (in the offseason they’d recount the season just played)', () => {
    const db = league()
    to(db, 'offseason')
    expect(refusal(() => save(db, (s) => void (s.schedule = { kind: 'round-robin', cycles: 2, build: 'manual' })))).toEqual(['settings-schedule-next'])
    const fresh = league()
    save(fresh, (s) => void (s.schedule = { kind: 'round-robin', cycles: 2, build: 'manual' }))
    expect(loadConfig(fresh).config.season.schedule).toEqual({ kind: 'round-robin', cycles: 2, build: 'manual' })
  })

  it('locks draft settings and freezing during the draft, but not who runs a team', () => {
    const db = league()
    to(db, 'draft')
    expect(refusal(() => save(db, (s) => void (s.draft.kind === 'card-swap' && (s.draft.protection = false))))).toEqual(['settings-during-draft'])
    expect(refusal(() => save(db, (s) => void (s.teams[0]!.control = 'frozen')))).toEqual(['settings-during-draft'])
    expect(refusal(() => save(db, (s) => void (s.roster.slots[5]!.name = '6th')))).toEqual(['settings-during-draft'])
    const r = save(db, (s) => void (s.teams[0]!.control = 'user'))
    expect(r).toMatchObject({ version: null, changed: ['control'] })
    expect(listTeams(db)[0]!.control).toBe('user')
    // After the draft, next season's draft settings can change again.
    closeProtection(db)
    finishDraft(db)
    save(db, (s) => void (s.teams[0]!.control = 'frozen'))
  })
})

describe('teams', () => {
  it('renames teams and changes colours any time, as one teams_edited event (the config version stays)', () => {
    const db = league()
    to(db, 'playoffs')
    const before = loadConfig(db).version
    const stamp = factsStamp(db)
    const r = save(db, (s) => {
      s.teams[0]!.name = '새가람고등학교'
      s.teams[0]!.shortName = '새가람고'
      s.teams[1]!.colors = ['#112233']
    })
    expect(r).toMatchObject({ version: null, changed: ['teams'], renamed: [{ teamId: 't1', from: '가람고', to: '새가람고' }] })
    expect(loadConfig(db).version).toBe(before)
    expect(listTeams(db).slice(0, 2).map((t) => [t.name, t.shortName, t.colors])).toEqual([
      ['새가람고등학교', '새가람고', []],
      ['나람고등학교', '나람고', ['#112233']],
    ])
    expect(listEvents(db, 'teams_edited').at(-1)!.payload).toEqual({
      teams: [
        { teamId: 't1', fields: ['name', 'shortName'], renamedFrom: '가람고' },
        { teamId: 't2', fields: ['colors'] },
      ],
    })
    // Screens reload when a team changes.
    expect(factsStamp(db)).toBeGreaterThan(stamp)
  })

  it('gives rating columns Korean names any time, even during the draft; a blank one goes back to the dictionary', () => {
    const db = league()
    to(db, 'draft')
    const r = save(db, (s) => void (s.ratingLabels.shoot = ' 슛 감각 '))
    expect(r).toMatchObject({ changed: ['labels'] })
    expect(r.version).toBeGreaterThan(1)
    expect(loadConfig(db).config.ratings.columns.map((c) => [c.id, c.label])).toEqual([
      ['ovr', undefined],
      ['shoot', '슛 감각'],
    ])
    expect(listEvents(db, 'config_changed').at(-1)!.payload).toMatchObject({ sections: ['labels'] })
    // Blank again: no label stored, so the column shows the dictionary's name (Shooting → 슈팅).
    save(db, (s) => void (s.ratingLabels.shoot = '  '))
    expect(loadConfig(db).config.ratings.columns.find((c) => c.id === 'shoot')).not.toHaveProperty('label')
    // A blank left blank isn't a change.
    expect(save(db, (s) => void (s.ratingLabels.ovr = ''))).toMatchObject({ changed: [] })
  })

  it('refuses the same short name twice, a short name a player has, and adding or dropping teams', () => {
    const db = league()
    expect(refusal(() => save(db, (s) => void (s.teams[1]!.shortName = s.teams[0]!.shortName)))).toEqual(['duplicate-name'])
    // p1 is 가가가: a school by that name would hold his file as its own.
    expect(refusal(() => save(db, (s) => void (s.teams[0]!.shortName = '가가가')))).toEqual(['settings-team-name-player'])
    expect(refusal(() => save(db, (s) => void s.teams.pop()))).toEqual(['settings-teams-fixed'])
  })
})

describe('the draft', () => {
  it('won’t hand out fewer cards than teams already got this season, and tops everyone up when it’s more', () => {
    const db = league()
    startSeason(db)
    const season = currentSeason(db).id
    expect(listCards(db, season)).toHaveLength(16)
    const tiers = (lowest: number) => (s: LeagueSettingsInput) => {
      if (s.draft.kind === 'card-swap') s.draft.allocation = [{ fromRank: 1, toRank: 8, cards: lowest }]
    }
    expect(refusal(() => save(db, tiers(1)))).toEqual(['settings-cards-issued'])
    const r = save(db, tiers(3))
    expect(r.cardsAdded).toBe(8)
    expect(listCards(db, season).filter((c) => c.originalTeamId === 't1').map((c) => c.number)).toEqual([1, 2, 3])
  })

  it('gives a team unfrozen mid-season the cards it missed at the start', () => {
    const db = league((s) => void (s.teams[7]!.control = 'frozen'))
    startSeason(db)
    const season = currentSeason(db).id
    expect(listCards(db, season).filter((c) => c.originalTeamId === 't8')).toHaveLength(0)
    const r = save(db, (s) => void (s.teams[7]!.control = 'ai'))
    expect(r.cardsAdded).toBe(2)
    expect(listCards(db, season).filter((c) => c.originalTeamId === 't8')).toHaveLength(2)
  })

  it('won’t freeze a team that traded cards this season (the draft would stall on them); its own cards sit out with it', () => {
    const db = league()
    startSeason(db)
    const season = currentSeason(db).id
    const card = listCards(db, season).find((c) => c.originalTeamId === 't1')!
    applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't1', to: 't2' }])
    expect(refusal(() => save(db, (s) => void (s.teams[0]!.control = 'frozen')))).toEqual(['settings-freeze-cards'])
    expect(refusal(() => save(db, (s) => void (s.teams[1]!.control = 'frozen')))).toEqual(['settings-freeze-cards'])
    save(db, (s) => void (s.teams[2]!.control = 'frozen'))
    expect(listTeams(db)[2]!.control).toBe('frozen')
  })

  it('switches the draft system only between seasons, and switching it off retires cards still held', () => {
    const db = league((s) => {
      if (s.config.draft.kind === 'card-swap') s.config.draft.unusedCards = 'carry-over'
    })
    startSeason(db)
    expect(refusal(() => save(db, (s) => void (s.draft = { kind: 'none' })))).toEqual(['settings-draft-kind'])
    playRegular(db)
    startPlayoffs(db)
    playPlayoffs(db)
    finishPlayoffs(db)
    closeProtection(db)
    finishDraft(db)
    const season = currentSeason(db).id
    const held = listCards(db, season).filter((c) => c.status === 'held').length
    expect(held).toBeGreaterThan(0)
    // The screen asks first, and the save makes a fresh backup: both know how many go.
    expect(settingsState(db).heldCards).toBe(held)
    expect(cardsExpiring(db, { draft: { kind: 'none' } })).toBe(held)
    expect(cardsExpiring(db, { draft: loadConfig(db).config.draft })).toBe(0)
    const r = save(db, (s) => void (s.draft = { kind: 'none' }))
    expect(r.cardsExpired).toBe(held)
    expect(listCards(db, season).every((c) => c.status !== 'held')).toBe(true)
  })

  it('reads an old “일반 드래프트” setting as none: no change when something else is saved', () => {
    const db = league()
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, draft: { kind: 'standard', rounds: 2, order: 'reverse-rank' } })
    startSeason(db)
    // The draft section is open mid-season, but its kind isn't: a spurious kind change would be refused.
    const r = save(db, (s) => void (s.trades.equalPlayerCount = false))
    expect(r.changed).toEqual(['trades'])
    expect(loadConfig(db).config.draft).toEqual({ kind: 'none' })
  })
})

describe('awards', () => {
  it('lets given awards be renamed, never removed or reshaped so what was given no longer fits', () => {
    const db = league()
    startSeason(db)
    giveAward(db, { awardId: 'all-league', period: '', teamRank: 2, playerId: 'p1' })
    giveAward(db, { awardId: 'potw', period: 'w1', teamRank: 1, playerId: 'p2' })
    const award = (s: LeagueSettingsInput, id: string) => [...s.awards.season, ...s.awards.periodic].find((a) => a.id === id)!
    expect(refusal(() => save(db, (s) => void (s.awards.season = s.awards.season.filter((a) => a.id !== 'all-league'))))).toEqual(['settings-award-given'])
    expect(refusal(() => save(db, (s) => void (award(s, 'all-league') as { teams: number }).teams--))).toEqual([])
    expect(refusal(() => save(db, (s) => void ((award(s, 'all-league') as { teams: number }).teams = 1)))).toEqual(['settings-award-shape'])
    expect(refusal(() => save(db, (s) => void ((award(s, 'potw') as { period: string }).period = 'month')))).toEqual(['settings-award-shape'])
    // Renaming one, adding one and removing one never given are fine.
    save(db, (s) => {
      award(s, 'potw').name = '주간 MVP'
      s.awards.season = s.awards.season.filter((a) => a.id !== 'dpoy')
      s.awards.season.push({ id: 'clutch', name: '클러치 선수', kind: 'player', teams: 1, perTeam: 1, timing: 'regular-season' })
    })
    const { awards } = loadConfig(db).config
    expect(awards.periodic.find((a) => a.id === 'potw')!.name).toBe('주간 MVP')
    expect(awards.season.map((a) => a.id)).toEqual(['mvp', 'all-league', 'finals-mvp', 'clutch'])
  })
})

describe('roster rules', () => {
  it('change any time but the draft, only when today’s rosters fit them', () => {
    const db = league()
    startSeason(db)
    // Six players a team: a seventh slot would leave every team one short.
    const errors = refusal(() => save(db, (s) => void s.roster.slots.push({ id: 'x', name: 'X', starter: false })))
    expect(errors).toContain('roster-slot-count')
    save(db, (s) => void (s.roster.slots[5]!.name = '식스맨'))
    expect(loadConfig(db).config.roster.slots[5]!.name).toBe('식스맨')
  })
})
