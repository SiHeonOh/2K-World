import { describe, expect, it } from 'vitest'
import { sectionKeys } from '@data/wiki'
import { disputedPart, fightable, setSectionText } from './wikiTalk'

const PAGE = ['[목차]', '== 개요 ==', '첫 줄.', '== 시즌별 활약 ==', '[기록]', '=== 시즌 1 ===', '가.', '나.', '다.', '== 여담 ==', ' * 하나', '[각주]', '[[분류:선수]]'].join('\n')

describe('disputedPart', () => {
  it('trims the lines both versions share', () => {
    expect(disputedPart('가\n나\n다', '가\n새 줄\n다')).toEqual({ head: ['가'], before: ['나'], after: ['새 줄'], tail: ['다'] })
    // An append: nothing before, the new lines after.
    expect(disputedPart(' * 하나', ' * 하나\n * 둘')).toEqual({ head: [' * 하나'], before: [], after: [' * 둘'], tail: [] })
    expect(disputedPart('', '새로 씀')).toEqual({ head: [], before: [], after: ['새로 씀'], tail: [] })
    expect(disputedPart('같다', '같다')).toEqual({ head: ['같다'], before: [], after: [], tail: [] })
  })
})

describe('setSectionText', () => {
  it("rewrites one section's own text, keeping its heading and closing lines, and nothing else", () => {
    const next = setSectionText(PAGE, '시즌 1#1', '새 문단.')!
    expect(next).toContain('=== 시즌 1 ===\n새 문단.\n== 여담 ==')
    expect(sectionKeys(next).get('시즌 1#1')).toBe('새 문단.')
    for (const key of ['개요#1', '시즌별 활약#1', '여담#1']) expect(sectionKeys(next).get(key)).toBe(sectionKeys(PAGE).get(key))
    // The last section keeps its [각주] and 분류 lines after the new text.
    const tail = setSectionText(PAGE, '여담#1', ' * 하나\n * 둘')!
    expect(tail.endsWith(' * 하나\n * 둘\n[각주]\n[[분류:선수]]')).toBe(true)
    // Emptied, the heading stays.
    expect(setSectionText(PAGE, '개요#1', '')).toContain('== 개요 ==\n== 시즌별 활약 ==')
    expect(setSectionText(PAGE, '없음#1', 'x')).toBeNull()
  })

  it('keeps the blank line before the next heading, and drops an emptied preamble whole', () => {
    const spaced = '머리말.\n== 가 ==\n첫째.\n\n== 나 ==\n둘째.'
    expect(setSectionText(spaced, '가#1', '바뀜.')).toBe('머리말.\n== 가 ==\n바뀜.\n\n== 나 ==\n둘째.')
    expect(setSectionText(spaced, '#1', '')).toBe('== 가 ==\n첫째.\n\n== 나 ==\n둘째.')
    expect(setSectionText(spaced, '나#1', '셋째.')).toBe('머리말.\n== 가 ==\n첫째.\n\n== 나 ==\n셋째.')
    // Emptied and filled again (a war over new lines), the spacing comes back as it was.
    const emptied = setSectionText(spaced, '가#1', '')!
    expect(emptied).toBe('머리말.\n== 가 ==\n\n== 나 ==\n둘째.')
    expect(setSectionText(emptied, '가#1', '첫째.')).toBe(spaced)
    // A blank line between the text and the closing lines stays.
    const closing = '== 여담 ==\n * 하나\n\n[각주]\n[[분류:선수]]'
    expect(setSectionText(closing, '여담#1', ' * 둘')).toBe('== 여담 ==\n * 둘\n\n[각주]\n[[분류:선수]]')
  })

  it('round-trips: setting a section to its own text changes nothing', () => {
    for (const [key, text] of sectionKeys(PAGE)) expect(setSectionText(PAGE, key, text)).toBe(PAGE)
  })
})

describe('fightable', () => {
  it('leaves macro lines and folds out of edit wars', () => {
    expect(fightable('평범한 문장.')).toBe(true)
    expect(fightable('[기록]\n문장')).toBe(false)
    expect(fightable('{{{#!folding 접기\n내용\n}}}')).toBe(false)
  })
})
