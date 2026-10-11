import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sampleConfig } from '@shared/testing/fixtures'
import { boxScoreReadSchema, buildConfirmView, readBoxScoreJob, readProblem, type BoxScoreRead } from './boxscore'
import { englishStyleName } from './namemap'

const home = { teamId: 'h', roster: ['허다솜', '강하늘', '김온유'].map((name, i) => ({ id: `h${i}`, name })), learned: [] }
const away = { teamId: 'a', roster: ['박새봄', '최이든', '윤로운'].map((name, i) => ({ id: `a${i}`, name })), learned: [] }

const line = (name: string, fgm: number, tpm: number, ftm: number, extra = 0) => ({
  name,
  pts: 2 * fgm + tpm + ftm + extra,
  reb: 5,
  ast: 3,
  stl: 1,
  blk: 0,
  to: 2,
  fgm,
  fga: fgm + 5,
  tpm,
  tpa: tpm + 2,
  ftm,
  fta: ftm + 1,
})

describe('the read_box_score job', () => {
  it('asks for Read access only and a JSON schema Claude can follow', () => {
    expect(readBoxScoreJob.tools).toEqual(['Read'])
    const schema = z.toJSONSchema(boxScoreReadSchema, { target: 'draft-7' }) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['teams', 'notes'])
    expect(readBoxScoreJob.prompt({ images: ['1.png', '2.png'], teams: ['가람고', '누리고'] })).toContain('1.png, 2.png')
  })

  it('asks for each team total, and still reads answers from before it did', () => {
    const team = (schema: unknown) => (schema as { properties: { teams: { items: { properties: Record<string, unknown>; required?: string[] } } } }).properties.teams.items
    const items = team(z.toJSONSchema(boxScoreReadSchema, { target: 'draft-7' }))
    expect(Object.keys(items.properties)).toContain('score')
    expect(items.required ?? []).not.toContain('score')
    expect(boxScoreReadSchema.safeParse({ teams: [{ team: 'A', players: [] }], notes: '' }).success).toBe(true)
    // What the reader gets on stdin: the images and teams only (not the hashes or the game key).
    expect(JSON.parse(readBoxScoreJob.stdin({ images: ['1.png'], teams: ['가'], hashes: ['x'], gameKey: 'k' }))).toEqual({ images: ['1.png'], teams: ['가'] })
  })
})

describe('buildConfirmView', () => {
  const config = sampleConfig()
  // The away team's screenshot came first.
  const read: BoxScoreRead = {
    teams: [
      { team: 'NURI', players: [line('S. Park', 8, 2, 3), line('I. Choi', 5, 0, 2), line('R. Yoon', 4, 1, 0)] },
      { team: 'GARAM', players: [line('D. Hu', 10, 3, 4), line('H. Kang', 6, 0, 1, 2), line('O. Kim', 3, 1, 1)] },
    ],
    notes: '',
  }

  it('puts each read team on the right side and matches names', () => {
    const view = buildConfirmView(config, read, { id: 7, jobId: 3 }, home, away)
    expect(view.home.label).toBe('GARAM')
    expect(view.home.rows.map((r) => r.playerId)).toEqual(['h0', 'h1', 'h2'])
    expect(view.away.rows.map((r) => r.playerId)).toEqual(['a0', 'a1', 'a2'])
    expect(view.sidesUncertain).toBe(false)
  })

  it('maps stats onto the league columns and sums the score', () => {
    const view = buildConfirmView(config, read, { id: 7, jobId: 3 }, home, away)
    expect(view.home.rows[0]!.stats).toMatchObject({ pts: 27, fgm: 10, '3pm': 3, ftm: 4, reb: 5 })
    expect(view.home.score).toBe(27 + 15 + 8)
  })

  it('flags lines whose points do not add up, by row, before anything is saved', () => {
    const view = buildConfirmView(config, read, { id: 7, jobId: 3 }, home, away)
    expect(view.issues).toEqual([{ code: 'line-points', teamId: 'h', row: 1, source: 'H. Kang', points: 15, expected: 13 }])
    expect([view.home.shown, view.away.shown]).toEqual([null, null])
  })

  it('takes the total the screenshot shows over the rows, and says when the rows fall short', () => {
    // The home screenshot was cropped: its totals row says 58, its rows add up to 50.
    const cropped: BoxScoreRead = { ...read, teams: [{ ...read.teams[0]!, score: 42 }, { ...read.teams[1]!, score: 58 }] }
    const view = buildConfirmView(config, cropped, { id: 7, jobId: 3 }, home, away)
    expect([view.home.shown, view.home.score, view.away.shown, view.away.score]).toEqual([58, 50, 42, 42])
    expect(view.issues.filter((i) => i.code !== 'line-points')).toEqual([
      { code: 'shown-total', teamId: 'h', rows: 50, shown: 58 },
      { code: 'final-vs-rows', teamId: 'h', rows: 50, score: 58 },
    ])
  })

  it('says which read team each side is, so a swap keeps edits on the right rows', () => {
    const view = buildConfirmView(config, read, { id: 7, jobId: 3 }, home, away)
    expect([view.home.readIndex, view.away.readIndex]).toEqual([1, 0])
    const flipped = buildConfirmView(config, read, { id: 7, jobId: 3 }, home, away, true)
    expect([flipped.home.readIndex, flipped.home.label]).toEqual([0, 'NURI'])
    expect(view.problem).toBeNull()
  })

  it('prefers a label that names a team over name matches', () => {
    // Names that match nobody: only the labels can tell.
    const blind: BoxScoreRead = {
      teams: [
        { team: 'GARAM', players: [line('Q. Zed', 1, 0, 0)] },
        { team: 'NURI', players: [line('Q. Zod', 1, 0, 0)] },
      ],
      notes: '',
    }
    const named = (side: typeof home, names: string[]) => ({ ...side, names })
    const view = buildConfirmView(config, blind, { id: 7, jobId: 3 }, named(away, ['누리고등학교', '누리고']), named(home, ['가람고등학교', '가람고']))
    expect(view.home.label).toBe('NURI')
    expect(view.away.label).toBe('GARAM')
    expect(view.sidesUncertain).toBe(false)
    // Without names to go on, the same read is a guess.
    expect(buildConfirmView(config, blind, { id: 7, jobId: 3 }, away, home).sidesUncertain).toBe(true)
  })

  it('marks the sides uncertain when the label and the names disagree', () => {
    const labelled = { ...read, teams: [{ ...read.teams[0]!, team: '가람고' }, { ...read.teams[1]!, team: '누리고' }] }
    const view = buildConfirmView(config, labelled, { id: 7, jobId: 3 }, { ...home, names: ['가람고'] }, { ...away, names: ['누리고'] })
    // The label wins (the read team labelled 가람고 is home) but the names say otherwise.
    expect(view.home.label).toBe('가람고')
    expect(view.sidesUncertain).toBe(true)
  })

  it('refuses a read with one team, or the same team twice', () => {
    const one: BoxScoreRead = { teams: [read.teams[0]!], notes: '' }
    expect(readProblem(one)).toBe('one-team')
    expect(buildConfirmView(config, one, { id: 7, jobId: 3 }, home, away).problem).toBe('one-team')
    expect(readProblem({ teams: [read.teams[0]!, { team: 'X', players: [] }], notes: '' })).toBe('one-team')
    expect(readProblem({ teams: [read.teams[1]!, read.teams[1]!], notes: '' })).toBe('same-team')
    // One misread name still counts as the same screenshot twice.
    const misread = { ...read.teams[1]!, players: [line('D. Hu', 10, 3, 4), line('H. Kang', 6, 0, 1), line('O. Kin', 3, 1, 1), line('A. Bee', 1, 0, 0), line('C. Dee', 1, 0, 0)] }
    const again = { ...misread, players: misread.players.map((p, i) => (i === 2 ? { ...p, name: 'O. Kim' } : p)) }
    expect(readProblem({ teams: [misread, again], notes: '' })).toBe('same-team')
    expect(readProblem(read)).toBeNull()
  })
})

describe('englishStyleName', () => {
  it('makes 2K-style names that the matcher finds again', () => {
    expect(englishStyleName('허다솜')).toBe('D. Heo')
    expect(englishStyleName('남궁새결')).toBe('S. Namgung')
    expect(englishStyleName('로이 해밀턴')).toBeNull()
  })
})
