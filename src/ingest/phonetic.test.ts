import { describe, expect, it } from 'vitest'
import { englishKey, englishKeys, englishStarts, hangulKey, hangulStart, keyDistance, keysMatch } from './phonetic'

// Surnames as 2K writes them and as Korean writes them (made-up players, real-world spellings).
const PAIRS: [string, string][] = [
  ['Crawford', '크로포드'],
  ['Leclerc', '르끌레르'],
  ['Ahn', '안'],
  ['Hamilton', '해밀턴'],
  ['Johnson', '존슨'],
  ['Williams', '윌리엄스'],
  ['Garcia', '가르시아'],
  ['Paul', '폴'],
  ['Doncic', '돈치치'],
  ['Jokic', '요키치'],
  ['Vucevic', '부체비치'],
  ['Curry', '커리'],
  ['Leonard', '레너드'],
  ['Westbrook', '웨스트브룩'],
  ['Smith', '스미스'],
  ['Brown', '브라운'],
  ['Rodriguez', '로드리게스'],
  ['Thompson', '톰슨'],
  ['Antetokounmpo', '아데토쿤보'],
  ['Nguyen', '응우옌'],
  ['James', '제임스'],
  // Reviewed: these used to miss, or to fit a teammate better.
  ['Rose', '로즈'],
  ['Lewis', '루이스'],
  ['Moore', '무어'],
  ['Morris', '모리스'],
  ['Walker', '워커'],
  // More NBA-style surnames.
  ['Davis', '데이비스'],
  ['Harris', '해리스'],
  ['Thomas', '토마스'],
  ['Miller', '밀러'],
  ['Mitchell', '미첼'],
  ['Butler', '버틀러'],
  ['Lowry', '라우리'],
  ['Holiday', '홀리데이'],
  ['Tatum', '테이텀'],
  ['Durant', '듀란트'],
  ['Edwards', '에드워즈'],
  ['Gilmore', '길모어'],
  ['Howard', '하워드'],
  ['Murray', '머레이'],
  ['Parker', '파커'],
  ['Chase', '체이스'],
  ['Wise', '와이즈'],
]

/** How a surname fits its Korean spelling, by whichever reading fits best. */
const fit = (en: string, ko: string) => {
  const hows = englishKeys(en).map((k) => keysMatch(k.key, hangulKey(ko)))
  return hows.includes('same') ? 'same' : hows.includes('near') ? 'near' : null
}

describe('sound keys', () => {
  it('reads Hangul as consonant classes, vowels and the extra 으 dropped', () => {
    expect(hangulKey('크로포드')).toBe('KLPT')
    expect(hangulKey('르끌레르')).toBe('LKL')
    expect(hangulKey('안')).toBe('N')
    expect(hangulKey('해밀턴')).toBe('HMLTN')
    expect(hangulKey('A안')).toBe('N')
  })

  it('reads English the way Korean transcription hears it', () => {
    expect(englishKey('Crawford')).toBe('KLPT')
    expect(englishKey('Leclerc')).toBe('LKLK')
    expect(englishKey('Ahn')).toBe('N')
    expect(englishKey('Hamilton')).toBe('HMLTN')
    expect(englishKey('Doncic')).toBe('TNSJ')
    expect(englishKey("O'Neal")).toBe('NL')
    expect(englishKey('')).toBe('')
    // A final -re after a vowel is silent (무어), and so is the l of -alk- (워커).
    expect(englishKey('Moore')).toBe('M')
    expect(englishKey('Walker')).toBe('K')
    expect(englishKey('Pierre')).toBe('PL')
    // A final -se after a vowel is 즈 first (로즈), 스 at half a point less (체이스); a final -s stays 스.
    expect(englishKeys('Rose')).toEqual([
      { key: 'LJ', cost: 0 },
      { key: 'LS', cost: 0.5 },
    ])
    expect(englishKeys('Lewis')).toEqual([{ key: 'LS', cost: 0 }])
    expect(englishKeys('Ross')).toEqual([{ key: 'LS', cost: 0 }])
  })

  it('matches each surname with its Korean spelling', () => {
    for (const [en, ko] of PAIRS) expect([en, ko, fit(en, ko)]).not.toContain(null)
  })

  it('keeps different names apart', () => {
    const misses: [string, string][] = [
      ['Crawford', '해밀턴'],
      ['Leclerc', '존슨'],
      ['Ahn', '한'],
      ['Paul', '커리'],
      ['Johnson', '윌리엄스'],
      ['Smith', '브라운'],
      ['Curry', '크로포드'],
      ['Moore', '모리스'],
      ['Morris', '무어'],
      ['Walker', '윌리엄스'],
    ]
    for (const [en, ko] of misses) expect([en, ko, fit(en, ko)]).toContain(null)
    // Rose and Lewis: each is 'same' with its own spelling as usually heard, only 'near' the other's
    // (Rose fits 루이스 fully only as the less usual 로스, which costs half a point).
    const usual = (en: string, ko: string) => keysMatch(englishKey(en), hangulKey(ko))
    expect([usual('Rose', '로즈'), usual('Lewis', '루이스'), usual('Rose', '루이스'), usual('Lewis', '로즈')]).toEqual(['same', 'same', 'near', 'near'])
  })

  it('costs half for the swaps Korean spelling makes often', () => {
    expect(keyDistance('SMT', 'SMS')).toBe(0.5)
    expect(keyDistance('KLPT', 'KLPT')).toBe(0)
    expect(keyDistance('LKLK', 'LKL')).toBe(1)
    // One sound is all or nothing; two allow one near swap.
    expect(keysMatch('N', 'M')).toBeNull()
    expect(keysMatch('HS', 'HJ')).toBe('near')
    expect(keysMatch('HS', 'HK')).toBeNull()
  })

  it('knows what an initial can stand for', () => {
    expect(englishStarts('C')).toEqual(['K', 'S', 'J'])
    expect(englishStarts('a')).toEqual([''])
    expect(hangulStart('앤')).toBe('')
    expect(hangulStart('크')).toBe('K')
    expect(hangulStart('A')).toBeNull()
  })
})
