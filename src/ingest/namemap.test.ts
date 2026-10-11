import { describe, expect, it } from 'vitest'
import { bestAssignment, confidentPairs, fitScore, initialLetters, labelNamesTeam, matchNames, parseSource, romanize, splitKoreanName } from './namemap'

// Made-up roster.
const roster = [
  { id: 'a', name: '허다솜' },
  { id: 'b', name: '강하늘' },
  { id: 'c', name: '김온유' },
  { id: 'd', name: '김누리' },
  { id: 'e', name: '남궁새결' },
  { id: 'f', name: '로이 해밀턴' },
]

describe('romanization helpers', () => {
  it('finds initial letters, including vowel-led syllables', () => {
    expect(initialLetters('하')).toEqual(['h'])
    expect(initialLetters('온')).toEqual(['o'])
    expect(initialLetters('유')).toEqual(['y'])
    expect(initialLetters('지')).toEqual(['j', 'c'])
  })

  it('splits surnames, compound and foreign', () => {
    expect(splitKoreanName('남궁새결')).toEqual({ surname: '남궁', given: '새결', foreign: false })
    expect(splitKoreanName('로이 해밀턴')).toEqual({ surname: '해밀턴', given: '로이', foreign: true })
  })

  it('reads 2K name forms', () => {
    expect(parseSource('H. Hu')).toEqual({ initial: 'h', surname: 'hu' })
    expect(parseSource('Namgung')).toEqual({ initial: null, surname: 'namgung' })
    expect(parseSource('S. Namgung')).toEqual({ initial: 's', surname: 'namgung' })
  })

  it('scores fits', () => {
    expect(fitScore('D. Hu', '허다솜')).toBe(3)
    expect(fitScore('D. Heo', '허다솜')).toBe(3)
    expect(fitScore('X. Heo', '허다솜')).toBe(1)
    expect(fitScore('D. Kim', '허다솜')).toBe(0)
  })
})

describe('matchNames', () => {
  it('guesses by surname and initial, and settles the last one by elimination', () => {
    const rows = ['D. Hu', 'H. Kang', 'O. Kim', 'N. Kim', 'S. Namgung', 'R. Hamilton'].map((source, row) => ({ row, source }))
    const m = matchNames(rows, roster, [])
    expect(m.map((x) => [x.source, x.playerId, x.how])).toEqual([
      ['D. Hu', 'a', 'guess'],
      ['H. Kang', 'b', 'guess'],
      ['O. Kim', 'c', 'guess'],
      ['N. Kim', 'd', 'guess'],
      ['S. Namgung', 'e', 'guess'],
      // A foreign name written in Hangul is found by its sound now, not left to elimination.
      ['R. Hamilton', 'f', 'guess'],
    ])
  })

  it('suggests foreign players written in Hangul by the sound of their surname', () => {
    const team = [
      { id: 'cr', name: '애런 크로포드' },
      { id: 'le', name: '에릭 르끌레르' },
      { id: 'ah', name: '제이슨 안' },
      { id: 'jo', name: '마이클 존슨' },
      { id: 'kw', name: '케빈 윌리엄스' },
      { id: 'ha', name: '허다솜' },
    ]
    const rows = ['A. Crawford', 'E. Leclerc', 'J. Ahn', 'M. Johnson', 'K. Williams', 'D. Hu'].map((source, row) => ({ row, source }))
    expect(matchNames(rows, team, []).map((m) => [m.source, m.playerId, m.how])).toEqual([
      ['A. Crawford', 'cr', 'guess'],
      ['E. Leclerc', 'le', 'guess'],
      ['J. Ahn', 'ah', 'guess'],
      ['M. Johnson', 'jo', 'guess'],
      ['K. Williams', 'kw', 'guess'],
      ['D. Hu', 'ha', 'guess'],
    ])
  })

  it('scores foreign names: a near miss or a one-sound surname needs the initial', () => {
    expect(fitScore('A. Crawford', '애런 크로포드')).toBe(3)
    expect(fitScore('Crawford', '애런 크로포드')).toBe(2)
    expect(fitScore('B. Crawford', '애런 크로포드')).toBe(1)
    expect(fitScore('E. Leclerc', '에릭 르끌레르')).toBe(2)
    expect(fitScore('T. Leclerc', '에릭 르끌레르')).toBe(1)
    expect(fitScore('J. Ahn', '제이슨 안')).toBe(3)
    expect(fitScore('Ahn', '제이슨 안')).toBe(1)
    expect(fitScore('J. Han', '제이슨 안')).toBe(0)
    expect(fitScore('A. Crawford', '로이 해밀턴')).toBe(0)
    // Korean names still go by the romanization table: Ahn is 안 there too.
    expect(fitScore('J. Ahn', '안지훈')).toBe(3)
  })

  it('leaves two foreign players who sound alike for you to pick', () => {
    const team = [
      { id: 'a', name: '제이슨 안' },
      { id: 'b', name: '조던 안' },
    ]
    const [m] = matchNames([{ row: 0, source: 'J. Ahn' }], team, [])
    expect(m).toMatchObject({ playerId: null, how: 'none' })
    expect(m!.candidates.slice(0, 2).sort()).toEqual(['a', 'b'])
  })

  it('matches a name written exactly as 2K shows it, and Latin-letter names by surname', () => {
    const team = [
      { id: 'lj', name: 'L. James' },
      { id: 'ad', name: 'Anthony Davis' },
      { id: 'kim', name: '김온유' },
    ]
    const m = matchNames(
      ['l.  james', 'A. Davis', 'O. Kim'].map((source, row) => ({ row, source })),
      team,
      [],
    )
    expect(m.map((x) => [x.playerId, x.how])).toEqual([
      ['lj', 'exact'],
      ['ad', 'guess'],
      ['kim', 'guess'],
    ])
  })

  it('still puts learned names first, a foreign one included', () => {
    const team = [
      { id: 'cr', name: '애런 크로포드' },
      { id: 'cr2', name: '크리스 크로포드' },
    ]
    // Two Crawfords: the sound can't tell them apart, the learned name can.
    const m = matchNames([{ row: 0, source: 'C. Crawford' }], team, [{ source: 'C. Crawford', playerId: 'cr2', rowOrder: 0 }])
    expect(m[0]).toMatchObject({ playerId: 'cr2', how: 'learned' })
    const fresh = matchNames([{ row: 0, source: 'C. Crawford' }], team, [])
    expect(fresh[0]).toMatchObject({ playerId: 'cr2', how: 'guess' })
  })

  it('leaves ambiguous names open with candidates', () => {
    const twins = [
      { id: 'x', name: '김나래' },
      { id: 'y', name: '김나온' },
    ]
    const m = matchNames(
      [
        { row: 0, source: 'N. Kim' },
        { row: 1, source: 'N. Kim' },
      ],
      twins,
      [],
    )
    expect(m.every((x) => x.playerId === null)).toBe(true)
    expect(m[0]!.candidates).toEqual(['x', 'y'])
  })

  it('tells same-name players apart by learned row order, and flags them for a look', () => {
    const twins = [
      { id: 'x', name: '김나래' },
      { id: 'y', name: '김나온' },
    ]
    const learned = [
      { source: 'N. Kim', playerId: 'y', rowOrder: 0 },
      { source: 'N. Kim', playerId: 'x', rowOrder: 4 },
    ]
    const m = matchNames(
      [
        { row: 3, source: 'N. Kim' },
        { row: 1, source: 'N. Kim' },
      ],
      twins,
      learned,
    )
    // Row order can change between games, so neither is a plain learned match.
    expect(m.map((x) => [x.row, x.playerId, x.how, x.candidates])).toEqual([
      [3, 'x', 'same-name', ['y']],
      [1, 'y', 'same-name', ['x']],
    ])
  })

  it('flags a same-name pair when only one of them played', () => {
    const twins = [
      { id: 'x', name: '김나래' },
      { id: 'y', name: '김나온' },
      { id: 'z', name: '허다솜' },
    ]
    const learned = [
      { source: 'N. Kim', playerId: 'y', rowOrder: 0 },
      { source: 'N. Kim', playerId: 'x', rowOrder: 4 },
      { source: 'D. Hu', playerId: 'z', rowOrder: 1 },
    ]
    const m = matchNames(
      [
        { row: 0, source: 'D. Hu' },
        { row: 3, source: 'N. Kim' },
      ],
      twins,
      learned,
    )
    // The nearer learned row wins, but it is a warning, not 'learned'.
    expect(m.map((x) => [x.source, x.playerId, x.how])).toEqual([
      ['D. Hu', 'z', 'learned'],
      ['N. Kim', 'x', 'same-name'],
    ])
  })

  it('flags a learned name that shows up on two rows', () => {
    const twins = [
      { id: 'x', name: '김나래' },
      { id: 'y', name: '김나온' },
    ]
    const m = matchNames(
      [
        { row: 0, source: 'N. Kim' },
        { row: 1, source: 'N. Kim' },
      ],
      twins,
      [{ source: 'N. Kim', playerId: 'x', rowOrder: 0 }],
    )
    expect(m[0]).toMatchObject({ playerId: 'x', how: 'same-name' })
    expect(m[1]).toMatchObject({ playerId: 'y', how: 'guess' })
  })

  it('keeps a one-player name a plain learned match', () => {
    const m = matchNames([{ row: 2, source: 'D. Hu' }], roster, [{ source: 'D. Hu', playerId: 'a', rowOrder: 0 }])
    expect(m[0]).toMatchObject({ playerId: 'a', how: 'learned', candidates: [] })
  })

  it('ignores learned names for players no longer on the team', () => {
    const m = matchNames([{ row: 0, source: 'D. Hu' }], roster, [{ source: 'D. Hu', playerId: 'gone', rowOrder: 0 }])
    expect(m[0]).toMatchObject({ playerId: 'a', how: 'guess' })
  })

  it('places every guess at once, so one row can’t take another’s player, whatever the row order', () => {
    const team = [
      { id: 'rose', name: '데릭 로즈' },
      { id: 'lewis', name: '디온 루이스' },
      { id: 'moore', name: '마이클 무어' },
      { id: 'morris', name: '마커스 모리스' },
      { id: 'walker', name: '켐바 워커' },
      { id: 'kim', name: '김민수' },
    ]
    const names = ['D. Rose', 'D. Lewis', 'M. Moore', 'M. Morris', 'K. Walker', 'M. Kim']
    for (const order of [names, [...names].reverse()]) {
      const m = matchNames(
        order.map((source, row) => ({ row, source })),
        team,
        [],
      )
      expect(Object.fromEntries(m.map((x) => [x.source, `${x.playerId} ${x.how}`]))).toEqual({
        'D. Rose': 'rose guess',
        'D. Lewis': 'lewis guess',
        'M. Moore': 'moore guess',
        'M. Morris': 'morris guess',
        'K. Walker': 'walker guess',
        'M. Kim': 'kim guess',
      })
    }
    expect([fitScore('D. Rose', '데릭 로즈'), fitScore('D. Rose', '디온 루이스'), fitScore('D. Lewis', '데릭 로즈'), fitScore('M. Moore', '마커스 모리스')]).toEqual([3, 2.5, 2, 0])
    // A given name kept in Latin letters goes by its letter.
    expect([fitScore('P. Tucker', 'PJ 터커'), fitScore('O. Anunoby', 'OG 아누노비'), fitScore('T. Tucker', 'PJ 터커')]).toEqual([3, 3, 1])
  })

  it('leaves a guess open when another way of placing it fits as well, or nearly as well', () => {
    // 부커 and 베이커 sound alike (PK): neither row is filled in, and they aren't left to elimination.
    const team = [
      { id: 'booker', name: '데빈 부커' },
      { id: 'baker', name: '데빈 베이커' },
      { id: 'kim', name: '김민수' },
    ]
    const m = matchNames(
      ['D. Booker', 'D. Baker', 'M. Kim'].map((source, row) => ({ row, source })),
      team,
      [],
    )
    expect(m.map((x) => [x.playerId, x.how])).toEqual([
      [null, 'none'],
      [null, 'none'],
      ['kim', 'guess'],
    ])
    expect(m[0]!.candidates.slice().sort()).toEqual(['baker', 'booker'])
    // Lewis didn't play: "D. Rose" fits 로즈 best, but 루이스 only half a point less (heard as 로스). You pick.
    const [rose] = matchNames(
      [{ row: 0, source: 'D. Rose' }],
      [
        { id: 'rose', name: '데릭 로즈' },
        { id: 'lewis', name: '디온 루이스' },
      ],
      [],
    )
    expect(rose).toMatchObject({ playerId: null, how: 'none', candidates: ['rose', 'lewis'] })
  })
})

describe('placing guesses', () => {
  it('finds the best total over every row and player, and keeps only the pairs it clearly needs', () => {
    // Row by row, row 0 would take player 0 (its best) and leave row 1 with nothing.
    const crossed = [
      [3, 2],
      [3, 0],
    ]
    expect(bestAssignment(crossed)).toEqual({
      total: 5,
      pairs: [
        [0, 1],
        [1, 0],
      ],
    })
    expect(confidentPairs(crossed)).toEqual([
      [0, 1],
      [1, 0],
    ])
    // A tie, or a near tie, is left open; a clear lead isn't.
    expect(confidentPairs([[3, 3]])).toEqual([])
    expect(confidentPairs([[3, 2.5]])).toEqual([])
    expect(confidentPairs([[3, 2]])).toEqual([[0, 0]])
    // More rows than players, more players than rows, nothing at all.
    expect(confidentPairs([[3], [2]])).toEqual([[0, 0]])
    expect(bestAssignment([[0, 0, 2]])).toEqual({ total: 2, pairs: [[0, 2]] })
    expect(confidentPairs([[0, 0]])).toEqual([])
    expect(bestAssignment([])).toEqual({ total: 0, pairs: [] })
  })
})

describe('team labels', () => {
  it('romanizes Hangul syllable by syllable', () => {
    expect(romanize('가람고')).toBe('garamgo')
    expect(romanize('누리 FC')).toBe('nuri FC')
  })

  it('recognises a team by its name, short name or their romanization', () => {
    const names = ['가람고등학교', '가람고']
    for (const label of ['가람고', 'GARAM', 'Garam Go', 'garamgo', '가람고등학교']) expect(labelNamesTeam(label, names)).toBe(true)
    for (const label of ['NURI', 'HOME', '', 'GA']) expect(labelNamesTeam(label, names)).toBe(false)
  })
})
