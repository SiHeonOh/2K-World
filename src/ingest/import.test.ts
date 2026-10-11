import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { defaultConfig } from '@shared/config/defaults'
import { validateSetup, type Team } from '@shared/setup'
import type { ImportIssue, ImportMapping } from '@shared/import'
import { analyzeColumns, detectHeaderRow, headerSignature, slugify, suggestMapping, toNumber } from './analyze'
import { buildSetup, heightOfDate, importRoster, shortName, type ParsedRow } from './roster'
import { encodeEucKr, makeRosterWorkbook, makeWorkbook } from './testing/sheet'
import { decodeText, readWorkbook, type SheetTable } from './workbook'

const base = () => {
  const config = defaultConfig()
  config.league.name = '테스트'
  return { config }
}

function rosterSheet(): SheetTable {
  const sheets = readWorkbook(makeRosterWorkbook())
  return sheets.find((s) => s.name === 'Roster')!
}

const targets = (m: ImportMapping) => Object.fromEntries(m.columns.map((c) => [c.header || c.index, c.target]))

type Row = (string | number | null)[]
const table = (rows: Row[]): SheetTable => ({ name: 'Sheet1', rows })
const codes = (issues: ImportIssue[]) => issues.map((i) => i.code)

/** Guesses a mapping for `rows` and imports them. */
function importTable(rows: Row[], b: ReturnType<typeof base> = base(), teams?: Team[]) {
  const sheet = table(rows)
  const { suggested } = suggestMapping(sheet, { base: b.config })
  return importRoster(sheet, suggested, { ...b, teams })
}

const team = (id: string, name: string, divisionId: string): Team => ({
  id,
  name,
  shortName: name,
  divisionId,
  control: 'ai',
  colors: [],
})

describe('readWorkbook', () => {
  it('reads every sheet as a grid anchored at A1', () => {
    const sheets = readWorkbook(makeRosterWorkbook())
    expect(sheets.map((s) => s.name)).toEqual(['Roster', 'Other'])
    const roster = sheets[0]!
    expect(roster.rows[0]![1]).toBe('Team')
    expect(roster.rows[1]![5]).toBe(70)
    expect(roster.rows[40]![6]).toBe('가선수1')
  })
})

describe('suggestMapping', () => {
  it('finds the header row and guesses every column', () => {
    const sheet = rosterSheet()
    expect(detectHeaderRow(sheet.rows)).toBe(1)
    const analysis = suggestMapping(sheet, { base: base().config })
    expect(analysis.fromSaved).toBe(false)
    expect(analysis.dataRows).toBe(25)
    expect(targets(analysis.suggested)).toEqual({
      Division: { kind: 'division' },
      Team: { kind: 'team' },
      Name: { kind: 'name' },
      Height: { kind: 'height' },
      Position: { kind: 'slot' },
      'Ovrl Rating': { kind: 'rating', columnId: 'ovr', ratingKind: 'number' },
      Shooting: { kind: 'rating', columnId: 'shooting', ratingKind: 'grade' },
      Defense: { kind: 'rating', columnId: 'defense', ratingKind: 'grade' },
      Nicknames: { kind: 'nicknames' },
      9: { kind: 'ignore' },
      Notes: { kind: 'notes' },
    })
  })

  it('skips merged-away columns with no header and no data', () => {
    const analysis = suggestMapping(rosterSheet())
    // J has no header but holds a stray value, so it's listed (and ignored); K is dropped.
    expect(analysis.columns.map((c) => c.letter)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L'])
  })

  it('tolerates a stray cell when guessing a column type', () => {
    const analysis = suggestMapping(rosterSheet())
    expect(analysis.columns.find((c) => c.header === 'Shooting')?.inferred).toBe('grade')
  })

  it('reuses a saved mapping only for the same headers', () => {
    const sheet = rosterSheet()
    const first = suggestMapping(sheet)
    const saved = structuredClone(first.suggested)
    saved.columns[3]!.target = { kind: 'ignore' }
    expect(suggestMapping(sheet, { saved: [saved] })).toMatchObject({ fromSaved: true, suggested: saved })

    const changed = structuredClone(saved)
    changed.columns[0]!.header = 'Region'
    expect(suggestMapping(sheet, { saved: [changed] }).fromSaved).toBe(false)
  })

  it('matches template rating columns by name', () => {
    const config = base().config
    config.ratings.columns = [
      { id: 'overall', name: 'OVR', kind: 'number', min: 40, max: 99, weight: 2 },
      { id: 'shot', name: 'shooting', kind: 'grade', weight: 1 },
    ]
    config.ratings.overallColumnId = 'overall'
    const t = targets(suggestMapping(rosterSheet(), { base: config }).suggested)
    expect(t['Ovrl Rating']).toEqual({ kind: 'rating', columnId: 'overall', ratingKind: 'number' })
    expect(t.Shooting).toEqual({ kind: 'rating', columnId: 'shot', ratingKind: 'grade' })
  })

  it('makes header signatures from position and text', () => {
    expect(headerSignature([{ index: 0, header: 'Team ' }, { index: 2, header: '' }])).toBe('0:team')
    expect(slugify('Inside Scoring')).toBe('inside-scoring')
    expect(slugify('골밑 득점')).toBe('골밑-득점')
  })
})

describe('importRoster', () => {
  const run = () => {
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet, { base: base().config })
    return importRoster(sheet, suggested, base())
  }

  it('builds teams, divisions, slots, ratings and players', () => {
    const { setup, summary } = run()
    expect(summary).toEqual({ teams: 4, players: 24, divisions: 2, conferences: 0, slots: 6, ratingColumns: 3 })
    expect(setup.config.structure.divisions.map((d) => [d.id, d.name])).toEqual([
      ['d1', '북부'],
      ['d2', '남부'],
    ])
    expect(setup.teams.map((t) => [t.id, t.shortName])).toEqual([
      ['t01', '가람고'],
      ['t02', '누리고'],
      ['t03', '다솜고'],
      ['t04', '마루중학교'],
    ])
    expect(setup.config.roster.slots).toEqual([
      { id: 'pg', name: 'PG', starter: true },
      { id: 'sg', name: 'SG', starter: true },
      { id: 'sf', name: 'SF', starter: true },
      { id: 'pf', name: 'PF', starter: true },
      { id: 'c', name: 'C', starter: true },
      { id: '6th-man', name: '6th Man', starter: false },
    ])
    expect(setup.config.roster).toMatchObject({ minPlayers: 6, maxPlayers: 6 })
    expect(setup.config.ratings.overallColumnId).toBe('ovr')
    const first = setup.players[0]!
    expect(first).toEqual({
      id: 'p001',
      teamId: 't01',
      name: '가선수1',
      slotId: 'pg',
      height: `6'2`,
      nicknames: ['별명1', '별명2'],
      notes: '',
      ratings: { ovr: 70, shooting: 'A+', defense: 'A+' },
    })
  })

  it('produces a setup that passes validation once playoffs fit the league', () => {
    const { setup } = run()
    // The default 6 seeds + play-in need 10 teams; this sheet has 4.
    const errors = validateSetup(setup).filter((i) => i.level === 'error')
    expect([...new Set(errors.map((i) => i.code))]).toEqual(['playoff-field-too-big'])
    setup.config.season.playoffs.enabled = false
    expect(validateSetup(setup).filter((i) => i.level === 'error')).toEqual([])
  })

  it('reports the stray row, the trimmed name and the shared name', () => {
    const { issues, setup } = run()
    expect(issues).toEqual(
      expect.arrayContaining([
        { level: 'warning', code: 'row-skipped', rows: [41], params: {} },
        { level: 'info', code: 'name-trimmed', rows: [14], params: { count: 1 } },
        { level: 'info', code: 'duplicate-name', rows: [5, 14], params: { name: '동명이', teams: '가람고, 다솜고' } },
      ]),
    )
    expect(setup.players.filter((p) => p.name === '동명이')).toHaveLength(2)
  })

  it('normalizes grade case and flags unknown grades', () => {
    const sheet = rosterSheet()
    sheet.rows[2]![7] = 'E+'
    const { suggested } = suggestMapping(sheet, { base: base().config })
    const { setup, issues } = importRoster(sheet, suggested, base())
    expect(setup.players[0]!.ratings.defense).toBe('A+')
    expect(setup.players[1]!.ratings.defense).toBeNull()
    expect(issues).toContainEqual({
      level: 'warning',
      code: 'unknown-grade',
      rows: [3],
      params: { column: 'Defense', value: 'E+' },
    })
  })

  it('keeps template teams and divisions when names match', () => {
    const b = base()
    b.config.structure = {
      conferences: [{ id: 'east', name: '동' }],
      divisions: [
        { id: 'south', name: '남부', conferenceId: 'east' },
        { id: 'north', name: '북부', conferenceId: 'east' },
      ],
    }
    const teams = [
      { id: 'garam', name: '가람고등학교', shortName: '가람', divisionId: 'north', control: 'frozen' as const, colors: ['#112233'] },
      { id: 'gone', name: '없는고등학교', shortName: '없는고', divisionId: 'north', control: 'ai' as const, colors: [] },
    ]
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet, { base: b.config })
    const { setup, issues } = importRoster(sheet, suggested, { ...b, teams })
    expect(setup.config.structure.divisions).toEqual([
      { id: 'north', name: '북부', conferenceId: 'east' },
      { id: 'south', name: '남부', conferenceId: 'east' },
    ])
    expect(setup.teams[0]).toEqual({ ...teams[0], divisionId: 'north' })
    expect(setup.teams[1]!.id).toBe('t02')
    expect(issues).toContainEqual({
      level: 'warning',
      code: 'template-team-missing',
      rows: [],
      params: { teams: '없는고', count: 1 },
    })
  })

  it('errors without team or name columns', () => {
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet)
    suggested.columns[1]!.target = { kind: 'ignore' }
    const { issues, setup } = importRoster(sheet, suggested, base())
    expect(issues).toContainEqual({ level: 'error', code: 'no-team-column', rows: [], params: {} })
    expect(setup.players).toEqual([])
  })
})

describe('shortName', () => {
  it('applies the first matching suffix rule', () => {
    const rules = [{ from: '고등학교', to: '고' }]
    expect(shortName('가람고등학교', rules)).toBe('가람고')
    expect(shortName('가람고', rules)).toBe('가람고')
    expect(shortName('고등학교', rules)).toBe('고등학교')
  })
})

describe('readWorkbook text files', () => {
  const csv = 'Team,Name,Score,Date,OVR,Big,Odd\n가람고,가선수1,6-4,5/11,70,"1,234","87,5"\n'
  const expected = [
    ['Team', 'Name', 'Score', 'Date', 'OVR', 'Big', 'Odd'],
    ['가람고', '가선수1', '6-4', '5/11', '70', '1,234', '87,5'],
  ]

  it('reads UTF-8 CSV with or without a BOM, keeping values as text', () => {
    const utf8 = new TextEncoder().encode(csv)
    expect(readWorkbook(utf8)[0]!.rows).toEqual(expected)
    expect(readWorkbook(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))[0]!.rows).toEqual(expected)
  })

  it('falls back to CP949 (EUC-KR) when the bytes are not UTF-8', () => {
    expect(decodeText(new Uint8Array([0xb0, 0xa1]))).toBe('가')
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0xac]))).toBe('가')
    expect(readWorkbook(encodeEucKr(csv))[0]!.rows).toEqual(expected)
  })

  it('imports CSV numbers and grades from text', () => {
    const text = 'Team,Name,OVR,Shooting\n가람고,가선수1,70,B+\n가람고,가선수2,"1,000",a\n'
    const sheet = readWorkbook(new TextEncoder().encode(text))[0]!
    const { suggested } = suggestMapping(sheet)
    const { setup } = importRoster(sheet, suggested, base())
    expect(setup.players.map((p) => p.ratings)).toEqual([
      { ovr: 70, shooting: 'B+' },
      { ovr: 1000, shooting: 'A' },
    ])
  })
})

describe('readWorkbook merged cells', () => {
  const bytes = () =>
    makeWorkbook(
      [
        ['Division', 'Team', 'Name', 'Nicknames', null, null],
        ['북부', '가람고', '가선수1', '별명1', null, null],
        [null, null, '가선수2', null, null, null],
        [null, null, '가선수3', null, null, null],
        ['남부', '누리고', '나선수1', null, null, null],
      ],
      ['A2:A4', 'B2:B4', 'D1:F1', 'D2:F2'],
    )

  it('fills vertical merges down and keeps horizontal ones in the first column', () => {
    const rows = readWorkbook(bytes())[0]!.rows
    expect(rows.map((r) => r.slice(0, 3))).toEqual([
      ['Division', 'Team', 'Name'],
      ['북부', '가람고', '가선수1'],
      ['북부', '가람고', '가선수2'],
      ['북부', '가람고', '가선수3'],
      ['남부', '누리고', '나선수1'],
    ])
    expect(rows[0]!.slice(3)).toEqual(['Nicknames', null, null])
    expect(rows[1]!.slice(3)).toEqual(['별명1', null, null])
  })

  it('imports a sheet whose team and division cells are merged', () => {
    const sheet = readWorkbook(bytes())[0]!
    const { suggested } = suggestMapping(sheet, { base: base().config })
    const { setup, issues } = importRoster(sheet, suggested, base())
    expect(setup.teams.map((t) => [t.name, t.divisionId])).toEqual([
      ['가람고', 'd1'],
      ['누리고', 'd2'],
    ])
    expect(setup.players.filter((p) => p.teamId === 't01')).toHaveLength(3)
    expect(codes(issues)).not.toContain('team-two-divisions')
    expect(codes(issues)).not.toContain('row-skipped')
  })
})

describe('toNumber', () => {
  it('accepts plain numbers and proper thousands grouping only', () => {
    expect(toNumber(' 70 ')).toBe(70)
    expect(toNumber('-5.5')).toBe(-5.5)
    expect(toNumber('1,234')).toBe(1234)
    expect(toNumber('-1,234,567.5')).toBe(-1234567.5)
    expect(toNumber('87,5')).toBeNull()
    expect(toNumber('12,34')).toBeNull()
    expect(toNumber('1,2345')).toBeNull()
    expect(toNumber('6-4')).toBeNull()
  })

  it('flags a decimal comma instead of misreading it', () => {
    const { setup, issues } = importTable([
      ['Team', 'Name', 'OVR'],
      ['가람고', '가선수1', 70],
      ['가람고', '가선수2', '87,5'],
    ])
    expect(setup.players[1]!.ratings.ovr).toBeNull()
    expect(issues).toContainEqual({ level: 'warning', code: 'not-a-number', rows: [3], params: { column: 'OVR', value: '87,5' } })
  })
})

describe('suggestMapping with a template', () => {
  const template = () => {
    const config = base().config
    config.ratings.columns = [
      { id: 'overall', name: 'OVR', kind: 'number', min: 40, max: 99, weight: 2 },
      { id: 'shot', name: 'shooting', kind: 'grade', weight: 1 },
      { id: 'speed', name: 'Speed', kind: 'number', min: 0, max: 99, weight: 1 },
    ]
    config.ratings.overallColumnId = 'overall'
    return config
  }

  it('points the rating columns of a saved mapping at the template columns', () => {
    const sheet = rosterSheet()
    const saved = structuredClone(suggestMapping(sheet).suggested)
    // A saved id that now belongs to another template column must move.
    saved.columns.find((c) => c.header === 'Defense')!.target = { kind: 'rating', columnId: 'shot', ratingKind: 'grade' }
    const config = template()
    const analysis = suggestMapping(sheet, { base: config, saved: [saved] })
    expect(analysis.fromSaved).toBe(true)
    const t = targets(analysis.suggested)
    expect(t['Ovrl Rating']).toEqual({ kind: 'rating', columnId: 'overall', ratingKind: 'number' })
    expect(t.Shooting).toEqual({ kind: 'rating', columnId: 'shot', ratingKind: 'grade' })
    expect(t.Defense).toEqual({ kind: 'rating', columnId: 'shot-2', ratingKind: 'grade' })

    const { setup, issues } = importRoster(sheet, analysis.suggested, { config })
    expect(setup.config.ratings.columns.map((c) => c.id)).toEqual(['overall', 'shot', 'shot-2'])
    expect(setup.config.ratings.overallColumnId).toBe('overall')
    expect(issues).toContainEqual({
      level: 'warning',
      code: 'template-column-missing',
      rows: [],
      params: { columns: 'Speed', count: 1 },
    })
  })

  it('gives two columns that match one target separate ids', () => {
    const sheet = table([
      ['Team', 'Name', 'OVR', 'Overall', 'Shooting', 'SHOOTING'],
      ['가람고', '가선수1', 70, 71, 'A', 'B'],
      ['가람고', '가선수2', 72, 73, 'B', 'C'],
    ])
    const config = base().config
    config.ratings.columns.push({ id: 'shot', name: 'Shooting', kind: 'grade', weight: 1 })
    expect(targets(suggestMapping(sheet, { base: config }).suggested)).toMatchObject({
      OVR: { kind: 'rating', columnId: 'ovr', ratingKind: 'number' },
      Overall: { kind: 'rating', columnId: 'overall', ratingKind: 'number' },
      Shooting: { kind: 'rating', columnId: 'shot', ratingKind: 'grade' },
      SHOOTING: { kind: 'rating', columnId: 'shooting', ratingKind: 'grade' },
    })
    expect(targets(suggestMapping(sheet).suggested)).toMatchObject({
      OVR: { columnId: 'ovr' },
      Overall: { columnId: 'overall' },
      Shooting: { columnId: 'shooting' },
      SHOOTING: { columnId: 'shooting-2' },
    })
  })

  it('reuses a template column only when its kind matches', () => {
    const config = base().config
    config.ratings.columns.push({ id: 'shooting', name: 'Shooting', kind: 'number', min: 0, max: 99, weight: 1 })
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet, { base: config })
    expect(targets(suggested).Shooting).toEqual({ kind: 'rating', columnId: 'shooting-2', ratingKind: 'grade' })
    const { setup, issues } = importRoster(sheet, suggested, { config })
    expect(setup.config.ratings.columns.find((c) => c.id === 'shooting-2')).toMatchObject({ name: 'Shooting', kind: 'grade' })
    expect(issues).toContainEqual({
      level: 'warning',
      code: 'template-column-missing',
      rows: [],
      params: { columns: 'Shooting', count: 1 },
    })
  })
})

describe('importRoster checks', () => {
  it('raises nothing about a template when the base is the default config', () => {
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet, { base: base().config })
    const { issues } = importRoster(sheet, suggested, base())
    expect(codes(issues).filter((c) => c.startsWith('template-'))).toEqual([])
  })

  it('treats slot spellings that differ in case or spacing as one slot', () => {
    const { setup } = importTable([
      ['Team', 'Name', 'Position'],
      ['가람고', '가선수1', 'PG'],
      ['가람고', '가선수2', 'C'],
      ['가람고', '가선수3', '6th Man'],
      ['누리고', '나선수1', 'pg'],
      ['누리고', '나선수2', 'c'],
      ['누리고', '나선수3', '6th  man'],
    ])
    expect(setup.config.roster.slots).toEqual([
      { id: 'pg', name: 'PG', starter: true },
      { id: 'c', name: 'C', starter: true },
      { id: '6th-man', name: '6th Man', starter: false },
    ])
    expect(setup.players.map((p) => p.slotId)).toEqual(['pg', 'c', '6th-man', 'pg', 'c', '6th-man'])
  })

  it('takes the division of a team from any of its rows and flags a team with none', () => {
    const { setup, issues } = importTable([
      ['Division', 'Team', 'Name'],
      [null, '가람고', '가선수1'],
      ['북부', '가람고', '가선수2'],
      ['남부', '누리고', '나선수1'],
      [null, '다솜고', '다선수1'],
    ])
    expect(setup.teams.map((t) => t.divisionId)).toEqual(['d1', 'd2', 'd1'])
    expect(codes(issues)).not.toContain('team-two-divisions')
    expect(issues).toContainEqual({
      level: 'warning',
      code: 'team-no-division',
      rows: [5],
      params: { team: '다솜고', division: '북부' },
    })
  })

  it('flags a team listed under two divisions', () => {
    const { issues } = importTable([
      ['Division', 'Team', 'Name'],
      ['북부', '가람고', '가선수1'],
      [null, '가람고', '가선수2'],
      ['남부', '가람고', '가선수3'],
    ])
    expect(issues).toContainEqual({ level: 'error', code: 'team-two-divisions', rows: [4], params: { team: '가람고' } })
  })

  it('never shares objects with the base', () => {
    const b = base()
    const teams = [{ ...team('garam', '가람고등학교', 'd1'), colors: ['#112233'] }]
    const before = structuredClone({ config: b.config, teams })
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet, { base: b.config })
    const { setup } = importRoster(sheet, suggested, { ...b, teams })
    expect(setup.config.ratings.columns[0]!.id).toBe('ovr')
    setup.config.ratings.columns[0]!.name = 'changed'
    setup.config.roster.slots[0]!.name = 'changed'
    setup.config.ratings.gradeScale[0]!.label = 'Z'
    setup.teams[0]!.colors.push('#445566')
    expect({ config: b.config, teams }).toEqual(before)
  })

  it('sets the conference of each division from a conference column', () => {
    const b = base()
    b.config.structure = {
      conferences: [
        { id: 'east', name: '동' },
        { id: 'west', name: '서' },
        { id: 'south', name: '남' },
      ],
      divisions: [
        { id: 'north', name: '북부', conferenceId: 'east' },
        { id: 'south', name: '남부', conferenceId: 'west' },
      ],
    }
    const teams = [team('garam', '가람고', 'north'), team('nuri', '누리고', 'south')]
    const { setup, issues } = importTable(
      [
        ['Team', 'Name', 'Conference'],
        ['가람고', '가선수1', '서'],
        ['누리고', '나선수1', '동'],
      ],
      b,
      teams,
    )
    expect(setup.config.structure).toEqual({
      conferences: [
        { id: 'west', name: '서' },
        { id: 'east', name: '동' },
      ],
      divisions: [
        { id: 'north', name: '북부', conferenceId: 'west' },
        { id: 'south', name: '남부', conferenceId: 'east' },
      ],
    })
    expect(codes(issues)).not.toContain('division-two-conferences')
    expect(issues).toContainEqual({
      level: 'info',
      code: 'template-conference-missing',
      rows: [],
      params: { conferences: '남', count: 1 },
    })
  })

  it('flags a division whose teams name two conferences', () => {
    const { setup, issues } = importTable([
      ['Team', 'Name', 'Conference'],
      ['가람고', '가선수1', '동'],
      ['누리고', '나선수1', '서'],
    ])
    expect(issues).toContainEqual({
      level: 'error',
      code: 'division-two-conferences',
      rows: [],
      params: { division: '디비전 1', conferences: '동, 서' },
    })
    expect(setup.config.structure.divisions[0]!.conferenceId).toBe('c1')
  })

  it('reports template divisions the sheet drops', () => {
    const b = base()
    b.config.structure.divisions = [
      { id: 'north', name: '북부', conferenceId: null },
      { id: 'west', name: '서부', conferenceId: null },
    ]
    const sheet = rosterSheet()
    const { suggested } = suggestMapping(sheet, { base: b.config })
    const { setup, issues } = importRoster(sheet, suggested, b)
    expect(setup.config.structure.divisions.map((d) => d.id)).toEqual(['north', 'd2'])
    expect(issues).toContainEqual({
      level: 'info',
      code: 'template-division-missing',
      rows: [],
      params: { divisions: '서부', count: 1 },
    })
  })

  it('errors when two columns feed one field, and joins notes and nicknames', () => {
    const sheet = table([
      ['Team', 'School', 'Name', 'Nicknames', 'Alias', 'Notes', 'Memo'],
      ['가람고', '누리고', '가선수1', '별명1, 별명2', '별명3', '메모1', '메모2'],
      ['가람고', '누리고', '가선수2', null, null, null, '메모3'],
    ])
    const { suggested } = suggestMapping(sheet)
    suggested.columns[1]!.target = { kind: 'team' }
    suggested.columns[4]!.target = { kind: 'nicknames' }
    suggested.columns[6]!.target = { kind: 'notes' }
    const { setup, issues } = importRoster(sheet, suggested, base())
    expect(issues).toContainEqual({
      level: 'error',
      code: 'duplicate-target',
      rows: [],
      params: { target: 'team', kind: 'team', columns: 'Team, School' },
    })
    expect(setup.teams.map((t) => t.name)).toEqual(['가람고'])
    expect(setup.players[0]).toMatchObject({ nicknames: ['별명1', '별명2', '별명3'], notes: '메모1\n메모2' })
    expect(setup.players[1]).toMatchObject({ nicknames: [], notes: '메모3' })
  })

  it('errors when two columns feed one rating column and builds it once', () => {
    const sheet = table([
      ['Team', 'Name', 'OVR', 'Overall'],
      ['가람고', '가선수1', 70, 71],
    ])
    const { suggested } = suggestMapping(sheet)
    suggested.columns[3]!.target = { kind: 'rating', columnId: 'ovr', ratingKind: 'number' }
    const { setup, issues } = importRoster(sheet, suggested, base())
    expect(issues).toContainEqual({
      level: 'error',
      code: 'duplicate-target',
      rows: [],
      params: { target: 'ovr', kind: 'rating', columns: 'OVR, Overall' },
    })
    expect(setup.config.ratings.columns.map((c) => c.id)).toEqual(['ovr'])
    expect(setup.players[0]!.ratings).toEqual({ ovr: 70 })
  })

  it('replaces a rating id that is not a valid id', () => {
    const sheet = table([
      ['Team', 'Name', 'OVR'],
      ['가람고', '가선수1', 70],
    ])
    const { suggested } = suggestMapping(sheet)
    suggested.columns[2]!.target = { kind: 'rating', columnId: 'bad id', ratingKind: 'number' }
    const { setup } = importRoster(sheet, suggested, base())
    expect(setup.config.ratings.columns.map((c) => c.id)).toEqual(['col-c'])
    expect(setup.players[0]!.ratings).toEqual({ 'col-c': 70 })
  })

  it('cuts over-long text to the schema limits and says so', () => {
    const nicknames = Array.from({ length: 25 }, (_, i) => `별명${i + 1}`).join(', ')
    const { setup, issues } = importTable([
      ['Team', 'Name', 'Height', 'Nicknames'],
      ['가'.repeat(50), '선'.repeat(100), `6'2" ${'x'.repeat(30)}`, nicknames],
      ['가'.repeat(50), '가선수2', `6'3`, 'ㄱ'.repeat(70)],
    ])
    const [first, second] = setup.players
    expect(setup.teams[0]!.shortName).toHaveLength(40)
    expect(first!.name).toHaveLength(80)
    expect(first!.height.length).toBeLessThanOrEqual(20)
    expect(first!.nicknames).toHaveLength(20)
    expect(second!.nicknames).toEqual(['ㄱ'.repeat(60)])
    const truncated = (field: string, rows: number[]) => ({ level: 'warning', code: 'value-truncated', rows, params: { field } })
    expect(issues).toEqual(
      expect.arrayContaining([
        truncated('name', [2]),
        truncated('height', [2]),
        truncated('nicknames', [2, 3]),
        truncated('shortName', [2]),
      ]),
    )
    expect(validateSetup(setup).map((i) => i.code)).not.toContain('schema')
  })

  it('handles sheets too big for argument spreads', () => {
    const rows: Row[] = [['Team', 'Name', 'OVR']]
    for (let i = 0; i < 250_000; i++) rows.push(['가람고', `가선수${i}`, i % 100])
    expect(analyzeColumns(rows, 1).columns).toHaveLength(3)
    const parsed: ParsedRow[] = rows.slice(1).map((r, i) => ({
      row: i + 2,
      team: '가람고',
      division: null,
      conference: null,
      name: String(r[1]),
      slot: null,
      height: '',
      nicknames: [],
      notes: '',
      ratings: { ovr: i === 7 ? 120 : (r[2] as number) },
    }))
    const { suggested } = suggestMapping(table(rows.slice(0, 3)))
    const b = base()
    b.config.ratings.columns = []
    b.config.ratings.overallColumnId = null
    const { setup } = buildSetup(parsed, suggested, b, [])
    expect(setup.config.ratings.columns[0]).toMatchObject({ id: 'ovr', min: 0, max: 120 })
  })
})

/** An .xlsx as Excel saves it after a height was typed 6-2: the cell holds a day number with a date format. */
function workbookWithDates(rows: (string | number | null)[][], formats: Record<string, string>): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (const [ref, z] of Object.entries(formats)) ws[ref]!.z = z
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Roster')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

/** Excel's day number for a date (1900 system). */
const serial = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000)

describe('heights and other cells Excel made into dates', () => {
  it('reads date cells as Excel shows them, not as day numbers', () => {
    const sheet = readWorkbook(workbookWithDates([['Team', 'Name', 'Height'], ['가람고', '가선수1', serial(2024, 6, 2)]], { C2: 'd-mmm' }))[0]!
    expect(sheet.rows[1]![2]).toBe('2-Jun')
    expect(sheet.dates?.get('1:2')).toEqual({ year: 2024, month: 6, day: 2 })
  })

  it('turns a height Excel made a date back into feet and inches, in the column’s own style', () => {
    const data = workbookWithDates(
      [
        ['Team', 'Name', 'Height', 'Nicknames'],
        ['가람고', '가선수1', serial(2024, 6, 2), null],
        ['가람고', '가선수2', `6'4`, null],
        ['가람고', '가선수3', serial(2024, 6, 2), null],
        ['가람고', '가선수4', serial(2025, 5, 11), serial(2024, 3, 4)],
        // A number that lost its date format (pasted as a value): the day number alone.
        ['가람고', '가선수5', serial(2024, 7, 1), null],
        // Not a height in either order: left for you, with a warning.
        ['가람고', '가선수6', serial(2024, 12, 25), null],
      ],
      { C2: 'd-mmm', C4: 'mm"월" dd"일"', C5: 'yyyy-mm-dd', D5: 'd-mmm', C7: 'd-mmm' },
    )
    const sheet = readWorkbook(data)[0]!
    const { suggested } = suggestMapping(sheet, { base: base().config })
    const result = importRoster(sheet, suggested, base())
    expect(result.setup.players.map((p) => p.height)).toEqual([`6'2`, `6'4`, `6'2`, `5'11`, `7'1`, '25-Dec'])
    const mended = result.issues.filter((i) => i.code === 'height-from-date')
    expect(mended).toEqual([
      expect.objectContaining({ level: 'warning', rows: [2], params: { value: '2-Jun', height: `6'2` } }),
      expect.objectContaining({ rows: [4], params: { value: '06월 02일', height: `6'2` } }),
      expect.objectContaining({ rows: [5], params: { value: '2025-05-11', height: `5'11` } }),
      expect.objectContaining({ rows: [6], params: { value: String(serial(2024, 7, 1)), height: `7'1` } }),
    ])
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'height-unreadable', rows: [7], params: { value: '25-Dec' } }))
    // A nickname typed 3-4 became 4 March: said so, never turned into a day number.
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'date-cell', rows: [5], params: { column: 'Nicknames', value: '4-Mar' } }))
    expect(result.setup.players[3]!.nicknames).toEqual(['4-Mar'])
  })

  it('writes an inch mark when the column does', () => {
    const data = workbookWithDates(
      [
        ['Team', 'Name', 'Height'],
        ['가람고', '가선수1', `6'4"`],
        ['가람고', '가선수2', serial(2024, 6, 10)],
      ],
      { C3: 'd-mmm' },
    )
    const sheet = readWorkbook(data)[0]!
    const result = importRoster(sheet, suggestMapping(sheet, { base: base().config }).suggested, base())
    expect(result.setup.players.map((p) => p.height)).toEqual([`6'4"`, `6'10"`])
    expect(heightOfDate(2, 6)).toBe(`6'2"`)
    expect(heightOfDate(6, 5, false)).toBe(`6'5`)
    expect(heightOfDate(12, 25)).toBeNull()
  })

  it('reads the dates Excel wrote into a CSV', () => {
    const csv = 'Team,Name,Height\n가람고,가선수1,2-Jun\n가람고,가선수2,06월 02일\n가람고,가선수3,Jun-24\n'
    const sheet = readWorkbook(new TextEncoder().encode(csv))[0]!
    const result = importRoster(sheet, suggestMapping(sheet, { base: base().config }).suggested, base())
    // Jun-24 is how Excel writes a month and a year: left alone.
    expect(result.setup.players.map((p) => p.height)).toEqual([`6'2"`, `6'2"`, 'Jun-24'])
  })

  it('leaves real numbers and heights alone', () => {
    const sheet = table([
      ['Team', 'Name', 'Height', 'OVR'],
      ['가람고', '가선수1', 193, 45445],
      ['가람고', '가선수2', `6'4`, 80],
    ])
    const result = importRoster(sheet, suggestMapping(sheet, { base: base().config }).suggested, base())
    expect(result.setup.players.map((p) => p.height)).toEqual(['193', `6'4`])
    expect(codes(result.issues)).not.toContain('height-from-date')
    expect(codes(result.issues)).not.toContain('date-cell')
  })
})
