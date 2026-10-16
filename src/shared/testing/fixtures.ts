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

/** 2K's nine rating categories (its own names) after OVR, as a 2K league's sheet lists them. */
export const TWO_K_CATEGORIES = ['Inside Scoring', 'Midrange', '3pt', 'Inside D', 'Perimeter D', 'Playmaking', 'Rebound', 'Athleticism', 'BQ'] as const

/**
 * A made-up 36-school 2K league's rules for tests: OVR (0–99) and 2K's nine
 * graded categories, all weighted 1; PG, SG, SF, PF, C and a 6th man; two
 * conferences of three divisions, six direct seeds a conference and a
 * play-in; a card-swap draft (5 cards for the best team, 4 for the next 15,
 * 3 for the rest; three a season may be given in trades).
 */
export function twoKConfig(): LeagueConfig {
  const config = sampleConfig()
  config.structure = {
    conferences: [
      { id: 'east', name: '동' },
      { id: 'west', name: '서' },
    ],
    divisions: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id, i) => ({ id, name: `${i + 1}지구`, conferenceId: i < 3 ? 'west' : 'east' })),
  }
  config.roster.slots = [
    { id: 'pg', name: 'PG', starter: true },
    { id: 'sg', name: 'SG', starter: true },
    { id: 'sf', name: 'SF', starter: true },
    { id: 'pf', name: 'PF', starter: true },
    { id: 'c', name: 'C', starter: true },
    { id: '6th-man', name: '6th Man', starter: false },
  ]
  config.ratings.columns = [
    { id: 'ovr', name: 'OVR', kind: 'number', min: 0, max: 99, weight: 1 },
    ...TWO_K_CATEGORIES.map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name, kind: 'grade' as const, weight: 1 })),
  ]
  config.season.playoffs = { ...config.season.playoffs, directSeeds: 6, playIn: { enabled: true, format: 'nba', bestOf: 1 } }
  config.draft = {
    kind: 'card-swap',
    allocation: [
      { fromRank: 1, toRank: 1, cards: 5 },
      { fromRank: 2, toRank: 16, cards: 4 },
      { fromRank: 17, toRank: 36, cards: 3 },
    ],
    order: 'reverse-rank',
    protection: true,
    turns: 'all',
    slotRule: 'any',
    incomingSlot: 'replaced',
    swappedProtected: true,
    unusedCards: 'expire',
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
    pickSlot: 'original-owner',
  }
  config.trades = { ...config.trades, oncePerSeason: { enabled: true, until: 'draft' } }
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
