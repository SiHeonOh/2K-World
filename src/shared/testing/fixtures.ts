import { defaultConfig } from '../config/defaults'
import type { LeagueConfig } from '../config/schema'
import type { LeagueSetup, Player, Team } from '../setup'

/**
 * A small made-up league for tests: 2 conferences, 4 divisions, 8 teams,
 * 6 players each (5 starters + 1 bench). No real league data.
 */
export function sampleConfig(): LeagueConfig {
  const config = defaultConfig()
  config.league = { name: '테스트 리그', shortName: 'TL' }
  config.structure = {
    conferences: [
      { id: 'east', name: '동' },
      { id: 'west', name: '서' },
    ],
    divisions: [
      { id: 'n', name: '북', conferenceId: 'east' },
      { id: 's', name: '남', conferenceId: 'east' },
      { id: 'e', name: '해', conferenceId: 'west' },
      { id: 'w', name: '달', conferenceId: 'west' },
    ],
  }
  config.roster = {
    slotMode: 'one-per-slot',
    minPlayers: 6,
    maxPlayers: 6,
    slots: [
      { id: 'pg', name: 'PG', starter: true },
      { id: 'sg', name: 'SG', starter: true },
      { id: 'sf', name: 'SF', starter: true },
      { id: 'pf', name: 'PF', starter: true },
      { id: 'c', name: 'C', starter: true },
      { id: 'bench', name: 'Bench', starter: false },
    ],
  }
  config.ratings.columns = [
    { id: 'ovr', name: 'OVR', kind: 'number', min: 40, max: 99, weight: 1 },
    { id: 'shoot', name: 'Shooting', kind: 'grade', weight: 1 },
  ]
  config.season.playoffs = {
    enabled: true,
    bracket: 'conference',
    directSeeds: 2,
    playIn: { enabled: false, format: 'nba', bestOf: 1 },
    seriesBestOf: 7,
    finals: { kind: 'conference-champions', bestOf: 7 },
  }
  return config
}

const SYLLABLES = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타']

export function sampleSetup(): LeagueSetup {
  const config = sampleConfig()
  const divisions = config.structure.divisions.map((d) => d.id)
  const teams: Team[] = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i + 1}`,
    name: `${SYLLABLES[i]}람고등학교`,
    shortName: `${SYLLABLES[i]}람고`,
    divisionId: divisions[i % divisions.length]!,
    control: 'ai',
    colors: [],
  }))
  const players: Player[] = []
  teams.forEach((team, ti) => {
    config.roster.slots.forEach((slot, si) => {
      players.push({
        id: `p${ti * 6 + si + 1}`,
        teamId: team.id,
        name: `${SYLLABLES[ti]}${SYLLABLES[si]}${SYLLABLES[(ti + si) % SYLLABLES.length]}`,
        slotId: slot.id,
        height: `6'${si + 1}"`,
        nicknames: [],
        notes: '',
        ratings: { ovr: 70 + si, shoot: 'B+' },
      })
    })
  })
  return { config, teams, players }
}
