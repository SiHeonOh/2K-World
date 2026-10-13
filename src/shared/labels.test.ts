import { describe, expect, it } from 'vitest'
import { DEFAULT_GRADE_SCALE, defaultConfig, defaultStatColumns } from './config/defaults'
import {
  bodyText,
  builtInRatingLabel,
  gradeTier,
  gradeWord,
  heightCm,
  leaderLabel,
  positionAbbr,
  positionName,
  positionOf,
  ratingKind,
  ratingLabel,
  ratingProse,
  ratingShort,
  statLabel,
} from './labels'

describe('rating labels', () => {
  it('translate 2K’s names whatever their case and spacing', () => {
    const shown = (name: string) => ratingLabel({ name })
    expect(['Inside Scoring', 'INSIDE SCORING', 'insidescoring', ' inside  scoring '].map(shown)).toEqual(Array(4).fill('골밑 득점'))
    expect(['Outside Scoring', 'outside'].map(shown)).toEqual(Array(2).fill('외곽 득점'))
    expect(['Midrange', 'Mid-Range', 'mid range'].map(shown)).toEqual(Array(3).fill('중거리 슛'))
    expect(['3pt', '3PT', 'Three', 'three point'].map(shown)).toEqual(Array(4).fill('3점 슛'))
    expect(['Inside D', 'Interior Defense', 'inside d'].map(shown)).toEqual(Array(3).fill('골밑 수비'))
    expect(['Perimeter D', 'perimeter defense'].map(shown)).toEqual(Array(2).fill('외곽 수비'))
    expect(shown('Playmaking')).toBe('플레이메이킹')
    expect(['Rebound', 'Rebounding', 'REB'].map(shown)).toEqual(Array(3).fill('리바운드'))
    expect(shown('Athleticism')).toBe('운동 능력')
    expect(['BQ', 'Basketball IQ', 'basketball-iq'].map(shown)).toEqual(Array(3).fill('농구 센스'))
    expect(['OVR', 'Overall'].map(shown)).toEqual(['종합', '종합'])
  })

  it('let a column’s own label win, else fall back to its name', () => {
    expect(ratingLabel({ name: 'Athleticism', label: '탄력' })).toBe('탄력')
    // A blank label is no label.
    expect(ratingLabel({ name: 'Athleticism', label: '  ' })).toBe('운동 능력')
    expect(ratingLabel({ name: 'Clutch Factor' })).toBe('Clutch Factor')
    expect(ratingLabel({ name: '슈팅' })).toBe('슈팅')
    expect(ratingShort({ name: 'OVR' })).toBe('종합')
    expect(ratingShort({ name: 'OVR', label: '오버롤' })).toBe('오버롤')
    expect(ratingShort({ name: 'Athleticism' })).toBe('운동 능력')
    expect(builtInRatingLabel('Perimeter D')).toBe('외곽 수비')
    expect(builtInRatingLabel('Clutch Factor')).toBeNull()
  })

  it('know what each side of the game is called in prose, and what kind of skill it is', () => {
    expect(ratingProse({ name: 'Inside D' })).toContain('림 프로텍팅')
    expect(ratingProse({ name: 'Playmaking' })).toContain('볼 핸들링')
    expect(ratingProse({ name: 'Clutch Factor' })).toEqual([])
    expect(['3pt', 'Inside Scoring', 'Inside D', 'Perimeter D', 'Playmaking', 'Rebound', 'Athleticism', 'BQ', 'OVR'].map((name) => ratingKind({ name }))).toEqual([
      'shoot',
      'inside',
      'rim',
      'perimeter',
      'play',
      'board',
      'body',
      'mind',
      null,
    ])
  })
})

describe('stat headers', () => {
  it('come from what each column means', () => {
    const byMeaning = Object.fromEntries(defaultStatColumns().map((c) => [c.meaning, statLabel(c)]))
    expect(byMeaning).toMatchObject({ points: '득점', rebounds: '리바운드', assists: '어시스트', steals: '스틸', blocks: '블록', turnovers: '턴오버', tpm: '3점 슛' })
    // 'other' columns by the names box scores give them, else as they are.
    expect(statLabel({ name: 'MIN', meaning: 'other' })).toBe('출전 시간')
    expect(statLabel({ name: '+/-', meaning: 'other' })).toBe('득실 마진')
    expect(statLabel({ name: 'XYZ', meaning: 'other' })).toBe('XYZ')
  })

  it('name the league leaders’ boards, shooting splits included', () => {
    const config = defaultConfig()
    expect(leaderLabel(config, { key: 'pts', label: 'PTS', kind: 'per-game' })).toBe('득점')
    expect(leaderLabel(config, { key: '3pm', label: '3PM', kind: 'per-game' })).toBe('3점 슛')
    expect(leaderLabel(config, { key: 'fg%', label: 'FG%', kind: 'percent' })).toBe('야투율')
    expect(leaderLabel(config, { key: '3p%', label: '3P%', kind: 'percent' })).toBe('3점 슛 성공률')
  })
})

describe('positions and heights', () => {
  it('read slots as positions in full Korean, leaving names the dictionary doesn’t know', () => {
    expect(['PG', 'pg', 'Point Guard'].map(positionName)).toEqual(Array(3).fill('포인트 가드'))
    expect(['SG', 'SF', 'PF', 'C'].map(positionName)).toEqual(['슈팅 가드', '스몰 포워드', '파워 포워드', '센터'])
    expect(['6th Man', 'Sixth man', '6TH'].map(positionName)).toEqual(Array(3).fill('식스맨'))
    expect(['Bench', '벤치'].map(positionName)).toEqual(['벤치 멤버', '벤치 멤버'])
    expect(positionName('센터')).toBe('센터')
    expect(positionName('Wing2')).toBe('Wing2')
    const config = defaultConfig()
    expect(positionOf(config, 'sf')).toBe('스몰 포워드')
    expect(positionOf(config, null)).toBe('')
  })

  it('keep a slot’s own abbreviation for the infobox, when it is one', () => {
    expect(['sf', 'PG', 'C', 'GF'].map(positionAbbr)).toEqual(['SF', 'PG', 'C', 'GF'])
    // A name that isn't a position's abbreviation, or that's spelled out, has none.
    expect(['Small Forward', '6th Man', 'XYZ', '센터'].map(positionAbbr)).toEqual([null, null, null, null])
  })

  it('show heights in cm, and the infobox’s feet and inches after them', () => {
    expect(heightCm(203.2, `6'8"`)).toBe('203cm')
    expect(heightCm(null, ' 6-8? ')).toBe('6-8?')
    expect(bodyText(203.2, `6'8"`, 'ft-in')).toBe(`203cm (6' 8")`)
    expect(bodyText(203.2, '203', 'cm')).toBe('203cm')
    expect(bodyText(null, '6-8?', 'ft-in')).toBe('6-8?')
  })
})

describe('grades', () => {
  it('place a grade in the league’s scale', () => {
    const tier = (g: string) => gradeTier(DEFAULT_GRADE_SCALE, g)
    expect(['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'F'].map(tier)).toEqual([
      'elite',
      'elite',
      'strong',
      'strong',
      'solid',
      'solid',
      'average',
      'average',
      'average',
      'weak',
      'weak',
      'weak',
    ])
    expect(tier('Z')).toBeNull()
  })

  it('put a grade into words, as prose names it', () => {
    const word = (g: string) => gradeWord(DEFAULT_GRADE_SCALE, g)
    expect(DEFAULT_GRADE_SCALE.map((g) => word(g.label))).toEqual([
      '리그 최정상급',
      '최상급',
      '상급',
      '수준급',
      '준수',
      '평균 이상',
      '무난',
      '평범',
      '아쉬움',
      '약점',
      '약점',
      '치명적 약점',
      '치명적 약점',
    ])
    // A shorter scale is read against A+ to F.
    expect(['S', 'A', 'B', 'C'].map((g) => gradeWord([{ label: 'S' }, { label: 'A' }, { label: 'B' }, { label: 'C' }], g))).toEqual(['리그 최정상급', '준수', '아쉬움', '치명적 약점'])
    expect(word('Z')).toBeNull()
  })
})
