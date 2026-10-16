import { describe, expect, it } from 'vitest'
import { awardGroups, awardLabel, awardTitle, byPeriod, groupName, groupOf, periodChoices, periodLabel, scopeIn, seasonSpan } from './awards'
import { migrateConfig } from './config/migrations'
import { leagueConfigSchema } from './config/schema'
import { sampleConfig, sampleSetup } from './testing/fixtures'

describe('weekly and monthly award labels', () => {
  it('says a period as a week or a month of the NBA calendar, never its code', () => {
    expect(periodLabel('w3')).toBe('3주차')
    expect(periodLabel('w12')).toBe('12주차')
    expect(periodLabel('m2')).toBe('11월')
    expect(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'].map(periodLabel)).toEqual(['10월', '11월', '12월', '1월', '2월', '3월', '4월', '5월'])
    expect(periodLabel('m13')).toBe('13번째 달')
    // A season award has no period.
    expect(periodLabel('')).toBe('')
    expect(['w10', 'w2', 'w1'].sort(byPeriod)).toEqual(['w1', 'w2', 'w10'])
  })

  it('names an award with its period and group: "3주차 동부 이주의 선수"', () => {
    expect(awardLabel({ award: '이주의 선수', period: 'w3', group: '동부' })).toBe('3주차 동부 이주의 선수')
    expect(awardLabel({ award: '이달의 선수', period: 'm2', group: '서부' })).toBe('11월 서부 이달의 선수')
    expect(awardLabel({ award: '이주의 선수', period: 'w1', group: '' })).toBe('1주차 이주의 선수')
    expect(awardLabel({ award: '이주의 선수', group: '동부' })).toBe('동부 이주의 선수')
    expect(awardLabel({ award: 'MVP' })).toBe('MVP')
    // From what's kept: the names come from the config (the sample's conferences are 동 and 서).
    const config = sampleConfig()
    expect(awardTitle(config, { awardId: 'potw', period: 'w3', group: 'east' })).toBe('3주차 동 이주의 선수')
    expect(awardTitle(config, { awardId: 'potm', period: 'm2', group: 'w' })).toBe('11월 달 이달의 선수')
    expect(awardTitle(config, { awardId: 'mvp', period: '' })).toBe('MVP')
    expect(groupName(config.structure, 'west')).toBe('서')
    expect(groupName(config.structure, null)).toBe('')
  })
})

describe('award groups', () => {
  const { config, teams } = sampleSetup()
  const { structure } = config

  it('counts per conference or division, and league-wide where the league has only one', () => {
    expect(scopeIn(structure, 'conference')).toBe('conference')
    expect(groupOf(structure, 'conference', 's')).toBe('east')
    expect(groupOf(structure, 'division', 's')).toBe('s')
    expect(groupOf(structure, 'league', 's')).toBeNull()
    expect(awardGroups(structure, 'conference', teams)).toEqual([
      { id: 'east', name: '동' },
      { id: 'west', name: '서' },
    ])
    expect(awardGroups(structure, 'division', teams).map((g) => g.name)).toEqual(['북', '남', '해', '달'])
    expect(awardGroups(structure, 'league', teams)).toEqual([{ id: null, name: '' }])
    // One conference: per conference is the whole league.
    const one = { ...structure, conferences: [structure.conferences[0]!], divisions: structure.divisions.map((d) => ({ ...d, conferenceId: 'east' })) }
    expect(scopeIn(one, 'conference')).toBe('league')
    expect(groupOf(one, 'conference', 'w')).toBeNull()
    expect(awardGroups(one, 'conference', teams)).toEqual([{ id: null, name: '' }])
  })

  it('gives the schools in no conference a group of their own', () => {
    const loose = { ...structure, divisions: structure.divisions.map((d) => (d.id === 'w' ? { ...d, conferenceId: null } : d)) }
    expect(groupOf(loose, 'conference', 'w')).toBeNull()
    expect(awardGroups(loose, 'conference', teams).map((g) => g.id)).toEqual(['east', 'west', null])
  })
})

describe('the period picker', () => {
  it('offers an NBA season at least (30 weeks, 10월 to 5월), more when the season runs longer', () => {
    // 8 schools, one round robin, 3 rounds a week: 7 rounds, 3 weeks, a month.
    const config = sampleConfig()
    expect(seasonSpan(config, 8)).toEqual({ weeks: 3, months: 1 })
    const weeks = periodChoices(config, 8, 'week')
    expect([weeks.length, weeks[0], weeks.at(-1)]).toEqual([30, 'w1', 'w30'])
    expect(periodChoices(config, 8, 'month').map(periodLabel)).toEqual(['10월', '11월', '12월', '1월', '2월', '3월', '4월', '5월'])
    // 36 schools, four cycles, a round a week: 140 weeks, 35 months.
    config.season.schedule = { kind: 'round-robin', cycles: 4, build: 'played' }
    config.season.calendar = { roundsPerWeek: 1, weeksPerMonth: 4 }
    expect(seasonSpan(config, 36)).toEqual({ weeks: 140, months: 35 })
    expect(periodChoices(config, 36, 'week')).toHaveLength(140)
    // An odd count has a school resting each round: 9 schools play 9 rounds a cycle.
    config.season.schedule = { kind: 'custom', gamesPerTeam: 82 }
    config.season.calendar = { roundsPerWeek: 3, weeksPerMonth: 4 }
    expect(seasonSpan(config, 9)).toEqual({ weeks: 28, months: 7 })
    expect(seasonSpan({ season: { ...config.season, schedule: { kind: 'round-robin', cycles: 1, build: 'auto' } } }, 9)).toEqual({ weeks: 3, months: 1 })
  })
})

describe('the award scope setting', () => {
  it('reads a config saved before scopes as league-wide awards', () => {
    const config = sampleConfig()
    const raw = JSON.parse(JSON.stringify(config)) as { awards: { periodic: Record<string, unknown>[] } }
    for (const a of raw.awards.periodic) delete a.scope
    expect(raw.awards.periodic[0]).not.toHaveProperty('scope')
    expect(leagueConfigSchema.parse(migrateConfig(raw)).awards.periodic.map((a) => [a.id, a.scope])).toEqual([
      ['potw', 'league'],
      ['potm', 'league'],
    ])
    // And keeps one it has.
    raw.awards.periodic[0]!.scope = 'conference'
    expect(leagueConfigSchema.parse(raw).awards.periodic[0]!.scope).toBe('conference')
    raw.awards.periodic[0]!.scope = 'team'
    expect(leagueConfigSchema.safeParse(raw).success).toBe(false)
  })
})
