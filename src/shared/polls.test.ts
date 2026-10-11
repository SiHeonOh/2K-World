import { describe, expect, it } from 'vitest'
import { cleanOptions } from './polls'

describe('poll options', () => {
  it('drop numbering when every option is numbered 1, 2, 3… in order', () => {
    expect(cleanOptions(['1.가람고', '2번: 나람고', '3) 다람고', '4번 라람고', '5 . 마람고', '6:바람고'])).toEqual(['가람고', '나람고', '다람고', '라람고', '마람고', '바람고'])
    expect(cleanOptions(['①가람고', '② 나람고'])).toEqual(['가람고', '나람고'])
    // Blanks don't break the count, and an exact repeat goes before it's checked.
    expect(cleanOptions(['1. 가람고', '  ', '2. 나람고', '2. 나람고'])).toEqual(['가람고', '나람고'])
    // Numbers that differ only by it become one option.
    expect(cleanOptions(['1. 가람고', '2. 가 람고', '3. 나람고'])).toEqual(['가람고', '나람고'])
  })

  it('keep numbers that are part of the text, or not a 1…n list', () => {
    expect(cleanOptions(['23번 김철수', '7번 이영희'])).toEqual(['23번 김철수', '7번 이영희'])
    expect(cleanOptions(['1번 김철수', '3번 이영희'])).toEqual(['1번 김철수', '3번 이영희'])
    expect(cleanOptions(['2. 가람고', '1. 나람고'])).toEqual(['2. 가람고', '1. 나람고'])
    // Only some numbered: they keep it.
    expect(cleanOptions(['1. 가람고', '2. 나람고', '기타'])).toEqual(['1. 가람고', '2. 나람고', '기타'])
    // Not numbering at all, even in order.
    expect(cleanOptions(['1번타자', '2번타자'])).toEqual(['1번타자', '2번타자'])
    expect(cleanOptions(['1.5점 차', '2.5점 차'])).toEqual(['1.5점 차', '2.5점 차'])
    // Just a number keeps it rather than leave nothing.
    expect(cleanOptions(['1.', '2. 나람고'])).toEqual(['1.', '나람고'])
  })

  it('store one NFC line, at most 40 characters, without blanks or repeats (case and spaces aside)', () => {
    const nfd = '가람고'.normalize('NFD')
    expect(cleanOptions([nfd, '가람고', '  나람\n고  ', 'ABC', 'a b c', ''])).toEqual(['가람고', '나람 고', 'ABC'])
    expect(cleanOptions([nfd])[0]).toBe('가람고')
    expect(cleanOptions(['x'.repeat(60)])[0]).toHaveLength(40)
    // Cut by whole characters: an emoji at the edge stays whole (or goes), never half.
    expect(cleanOptions(['a'.repeat(39) + '😀😀'])[0]).toBe('a'.repeat(39) + '😀')
    // An option of nothing but zero-width characters is blank.
    expect(cleanOptions(['\u200b', '가', '나\u200b'])).toEqual(['가', '나'])
  })
})
