import { describe, expect, it } from 'vitest'
import { defaultCardSwap, defaultConfig } from './config/defaults'
import { leagueConfigSchema } from './config/schema'
import { checkSetup, hasErrors, validateSetup, type SetupIssue } from './setup'
import { sampleSetup } from './testing/fixtures'

const codes = (issues: SetupIssue[]) => issues.map((i) => i.code)

describe('league config schema', () => {
  const named = () => {
    const config = defaultConfig()
    config.league.name = '새 리그'
    return config
  }

  it('accepts the default config once it has a name', () => {
    expect(leagueConfigSchema.safeParse(defaultConfig()).success).toBe(false)
    expect(leagueConfigSchema.safeParse(named()).success).toBe(true)
  })

  it('accepts the card-swap draft defaults', () => {
    const config = named()
    config.draft = defaultCardSwap(10)
    expect(leagueConfigSchema.safeParse(config).success).toBe(true)
  })

  it('rejects even series lengths', () => {
    const config = named()
    config.season.playoffs.seriesBestOf = 4
    expect(leagueConfigSchema.safeParse(config).success).toBe(false)
  })

  it('rejects ids with spaces', () => {
    const config = named()
    config.structure.divisions[0]!.id = 'a b'
    expect(leagueConfigSchema.safeParse(config).success).toBe(false)
  })

  it('reads an old “일반 드래프트” as no draft, with a warning (it never ran one)', () => {
    const setup = sampleSetup()
    setup.config.draft = { kind: 'standard', rounds: 2, order: 'reverse-rank' }
    const checked = checkSetup(setup)
    expect(checked.ok).toBe(true)
    expect(codes(checked.issues)).toEqual(['draft-standard-none'])
    expect(checked.ok && checked.setup.config.draft).toEqual({ kind: 'none' })
  })
})

describe('validateSetup', () => {
  it('passes a consistent setup', () => {
    const issues = validateSetup(sampleSetup())
    expect(issues.filter((i) => i.level === 'error')).toEqual([])
  })

  it('maps schema errors to the right section', () => {
    const setup = sampleSetup()
    ;(setup.config.season as { schedule: unknown }).schedule = { kind: 'round-robin', cycles: 0 }
    const issues = validateSetup(setup)
    expect(issues[0]).toMatchObject({ code: 'schema', section: 'season' })
  })

  it('catches a team in an unknown division', () => {
    const setup = sampleSetup()
    setup.teams[0]!.divisionId = 'nowhere'
    expect(codes(validateSetup(setup))).toContain('unknown-division')
  })

  it('catches duplicate team short names', () => {
    const setup = sampleSetup()
    setup.teams[1]!.shortName = setup.teams[0]!.shortName
    expect(codes(validateSetup(setup))).toContain('duplicate-name')
  })

  it('enforces one player per slot', () => {
    const setup = sampleSetup()
    const [a, b] = setup.players.filter((p) => p.teamId === 't1')
    b!.slotId = a!.slotId
    const issues = validateSetup(setup)
    expect(codes(issues)).toEqual(expect.arrayContaining(['roster-slot-duplicate', 'roster-slot-missing']))
    expect(issues.find((i) => i.code === 'roster-slot-duplicate')?.params).toMatchObject({ team: '가람고', count: 2 })
  })

  it('enforces roster size', () => {
    const setup = sampleSetup()
    setup.players = setup.players.filter((p) => p.id !== 'p1')
    expect(codes(validateSetup(setup))).toContain('roster-size')
  })

  it('checks rating values against their column', () => {
    const setup = sampleSetup()
    setup.players[0]!.ratings.ovr = 120
    setup.players[1]!.ratings.shoot = 'Z'
    setup.players[2]!.ratings.ovr = 'high'
    setup.players[3]!.ratings.speed = 3
    expect(codes(validateSetup(setup))).toEqual(
      expect.arrayContaining(['rating-out-of-range', 'rating-unknown-grade', 'rating-not-number', 'unknown-rating-column']),
    )
  })

  it('warns, not errors, on a missing rating', () => {
    const setup = sampleSetup()
    setup.players[0]!.ratings.shoot = null
    const issues = validateSetup(setup)
    expect(hasErrors(issues)).toBe(false)
    expect(codes(issues)).toContain('rating-missing')
  })

  it('requires two conferences for a conference-champions final', () => {
    const setup = sampleSetup()
    setup.config.structure.conferences.pop()
    for (const d of setup.config.structure.divisions) d.conferenceId = 'east'
    expect(codes(validateSetup(setup))).toContain('finals-needs-two-conferences')
  })

  it('needs a power-of-two playoff field', () => {
    const setup = sampleSetup()
    setup.config.season.playoffs.directSeeds = 3
    expect(codes(validateSetup(setup))).toContain('playoff-field-not-power-of-two')
  })

  it('counts the play-in when sizing the field', () => {
    const setup = sampleSetup()
    // 4 teams per conference: 2 direct seeds + a 4-team play-in needs 6.
    setup.config.season.playoffs.playIn.enabled = true
    expect(codes(validateSetup(setup))).toContain('playoff-field-too-big')
  })

  it('checks card tiers for gaps and overlaps', () => {
    const setup = sampleSetup()
    setup.config.draft = {
      ...defaultCardSwap(8),
      allocation: [
        { fromRank: 1, toRank: 1, cards: 5 },
        { fromRank: 3, toRank: 5, cards: 4 },
        { fromRank: 5, toRank: 8, cards: 3 },
      ],
    }
    expect(codes(validateSetup(setup))).toEqual(expect.arrayContaining(['card-tier-gap', 'card-tier-overlap']))
  })

  it('warns when card tiers stop short of the last rank', () => {
    const setup = sampleSetup()
    setup.config.draft = { ...defaultCardSwap(8), allocation: [{ fromRank: 1, toRank: 6, cards: 3 }] }
    const issues = validateSetup(setup)
    expect(issues.find((i) => i.code === 'card-tier-short')).toMatchObject({ level: 'warning' })
  })

  it('accepts card tiers in any order and flags reversed ranges', () => {
    const setup = sampleSetup()
    setup.config.draft = {
      ...defaultCardSwap(8),
      allocation: [
        { fromRank: 5, toRank: 8, cards: 3 },
        { fromRank: 1, toRank: 4, cards: 4 },
      ],
    }
    expect(hasErrors(validateSetup(setup))).toBe(false)
    setup.config.draft.allocation[0] = { fromRank: 8, toRank: 5, cards: 3 }
    expect(codes(validateSetup(setup))).toContain('card-tier-order')
  })

  it('checks playoff settings fit together', () => {
    const setup = sampleSetup()
    setup.config.season.playoffs.bracket = 'league'
    expect(codes(validateSetup(setup))).toContain('finals-needs-conference-bracket')
    setup.config.season.playoffs.finals.kind = 'none'
    expect(hasErrors(validateSetup(setup))).toBe(false)
    setup.config.season.playoffs.directSeeds = 1
    expect(codes(validateSetup(setup))).toContain('playoff-field-too-small')
  })

  it('needs conferences for a conference bracket', () => {
    const setup = sampleSetup()
    setup.config.structure.conferences = []
    for (const d of setup.config.structure.divisions) d.conferenceId = null
    expect(codes(validateSetup(setup))).toEqual(expect.arrayContaining(['no-conferences', 'division-without-conference']))
  })

  it('keeps short names usable as folder names', () => {
    const setup = sampleSetup()
    setup.teams[0]!.shortName = 'CON'
    setup.teams[1]!.shortName = 'a:b'
    setup.teams[2]!.shortName = 'Lakers'
    setup.teams[3]!.shortName = 'lakers'
    const issues = validateSetup(setup)
    expect(issues.filter((i) => i.code === 'team-name-not-folder-safe').map((i) => i.params.name)).toEqual(['CON', 'a:b'])
    expect(issues.find((i) => i.code === 'duplicate-name')?.params.name).toBe('lakers')
  })

  it('needs unique award ids, tiebreakers and an ordered grade scale', () => {
    const setup = sampleSetup()
    setup.config.awards.periodic[0]!.id = 'mvp'
    setup.config.season.standings.tiebreakers = ['point-diff', 'point-diff']
    setup.config.ratings.gradeScale[1]!.value = 200
    expect(codes(validateSetup(setup))).toEqual(
      expect.arrayContaining(['duplicate-id', 'duplicate-tiebreaker', 'grade-scale-order']),
    )
  })

  it('keeps one-per-slot rosters sized to the slots', () => {
    const setup = sampleSetup()
    setup.config.roster.maxPlayers = 30
    expect(codes(validateSetup(setup))).toContain('roster-slot-count')
  })

  it('checks free rosters against min and max', () => {
    const setup = sampleSetup()
    setup.config.roster = { ...setup.config.roster, slotMode: 'free', minPlayers: 7, maxPlayers: 9 }
    expect(validateSetup(setup).filter((i) => i.code === 'roster-size')).toHaveLength(8)
  })

  it('flags slot, overall and column problems', () => {
    const setup = sampleSetup()
    setup.players[0]!.slotId = 'nope'
    setup.players[1]!.slotId = null
    setup.config.ratings.overallColumnId = 'gone'
    setup.config.ratings.columns[0] = { id: 'ovr', name: 'OVR', kind: 'number', min: 99, max: 40, weight: 1 }
    setup.teams.push({ ...setup.teams[0]! })
    expect(codes(validateSetup(setup))).toEqual(
      expect.arrayContaining(['unknown-slot', 'roster-slot-required', 'unknown-overall', 'rating-min-max', 'duplicate-id']),
    )
  })

  it('warns when every team is frozen', () => {
    const setup = sampleSetup()
    for (const t of setup.teams) t.control = 'frozen'
    expect(validateSetup(setup).find((i) => i.code === 'all-frozen')).toMatchObject({ level: 'warning' })
  })

  it('refuses a league whose secret reveals would apply themselves', () => {
    const setup = sampleSetup()
    setup.config.lore = { roundSweep: true, suggest: { fact: 'auto', reveal: 'auto' } }
    expect(validateSetup(setup).find((i) => i.code === 'reveal-always-asks')).toMatchObject({ level: 'error', section: 'league', path: ['config', 'lore', 'suggest', 'reveal'] })
    setup.config.lore.suggest.reveal = 'off'
    expect(hasErrors(validateSetup(setup))).toBe(false)
  })

  it('returns the parsed copy from checkSetup', () => {
    const setup = sampleSetup()
    setup.teams[0]!.name = ' 가람고등학교 '
    const result = checkSetup(setup)
    expect(result.ok && result.setup.teams[0]!.name).toBe('가람고등학교')
  })

  it('rejects own-slot swaps that would break one-per-slot rosters', () => {
    const setup = sampleSetup()
    setup.config.draft = { ...defaultCardSwap(8), incomingSlot: 'own', slotRule: 'any' }
    expect(codes(validateSetup(setup))).toContain('incoming-slot-conflict')
    setup.config.draft.slotRule = 'same-slot'
    expect(codes(validateSetup(setup))).not.toContain('incoming-slot-conflict')
  })
})
