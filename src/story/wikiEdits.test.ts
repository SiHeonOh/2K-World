import { describe, expect, it } from 'vitest'
import { sectionKeys } from '@data/wiki'
import { applySectionEdit, ensureSeasonSection, guardedEdit } from './wikiEdits'

const page = `[목차]
== 개요 ==
가람고의 슈터다.
== 시즌별 활약 ==
[기록]
== 여담 ==
 * 첫 줄
[각주]
[[분류:선수]]
`

describe('applySectionEdit', () => {
  it('appends to a section, before the closing 각주 and 분류 lines', () => {
    const out = applySectionEdit(page, '여담', 'append', ' * 새 줄')
    expect(out).toContain(' * 첫 줄\n * 새 줄\n[각주]\n[[분류:선수]]')
  })

  it('replaces a plain section but only appends where a macro line lives', () => {
    expect(applySectionEdit(page, '개요', 'replace', '새 개요.')).toContain('== 개요 ==\n새 개요.\n== 시즌별 활약 ==')
    const macro = applySectionEdit(page, '시즌별 활약', 'replace', '이번 시즌 득점 1위.')
    expect(macro).toContain('[기록]\n이번 시즌 득점 1위.')
  })

  it('adds a missing section before the closing lines, and ignores empty text', () => {
    const out = applySectionEdit(page, '별명', 'append', '불꽃 슈터')
    expect(out).toContain(' * 첫 줄\n== 별명 ==\n불꽃 슈터\n[각주]\n[[분류:선수]]')
    expect(applySectionEdit(page, '여담', 'append', '   ')).toBe(page)
  })
})

describe('ensureSeasonSection', () => {
  it('adds the season paragraph under 시즌별 활약, after its table and any earlier seasons', () => {
    const one = ensureSeasonSection(page, '시즌 1')
    expect(one).toContain('== 시즌별 활약 ==\n[기록]\n=== 시즌 1 ===\n== 여담 ==')
    expect(ensureSeasonSection(one, '시즌 1')).toBe(one)
    const two = ensureSeasonSection(applySectionEdit(one, '시즌 1', 'replace', '득점 선두로 시작했다.'), '시즌 2')
    expect(two).toContain('=== 시즌 1 ===\n득점 선두로 시작했다.\n=== 시즌 2 ===\n== 여담 ==')
  })

  it('works for a school page whose 시즌별 성적 comes last, and leaves pages without a parent alone', () => {
    const school = '== 개요 ==\n학교.\n== 시즌별 성적 ==\n[기록]\n[각주]\n[[분류:학교]]'
    const ensured = ensureSeasonSection(school, '시즌 1')
    expect(ensured).toBe('== 개요 ==\n학교.\n== 시즌별 성적 ==\n[기록]\n=== 시즌 1 ===\n[각주]\n[[분류:학교]]\n')
    // The page's closing lines now sit in the paragraph, and a rewrite still replaces it (keeping them).
    let text = applySectionEdit(ensured, '시즌 1', 'append', '첫 문단.', true)
    text = applySectionEdit(text, '시즌 1', 'replace', '다시 쓴 문단.', true)
    text = applySectionEdit(text, '시즌 1', 'replace', '세 번째.', true)
    expect(text).toBe('== 개요 ==\n학교.\n== 시즌별 성적 ==\n[기록]\n=== 시즌 1 ===\n세 번째.\n[각주]\n[[분류:학교]]\n')
    // 여담 holds the closing lines too, but isn't the season paragraph: it's only added to.
    expect(applySectionEdit(page, '여담', 'replace', ' * 새 줄')).toContain(' * 첫 줄\n * 새 줄\n[각주]')
    const bare = '== 개요 ==\n학교.\n'
    expect(ensureSeasonSection(bare, '시즌 1')).toBe(bare)
  })

  it('lets an editor rewrite the paragraph while the table and your own sections stay', () => {
    const body = page.replace('== 시즌별 활약 ==\n[기록]', '== 시즌별 활약 ==\n[기록]\n내가 쓴 시즌 메모')
    const mine = new Map([['시즌별 활약#1', sectionKeys(body).get('시즌별 활약#1')!]])
    const first = guardedEdit(ensureSeasonSection(body, '시즌 1'), mine, { section: '시즌 1', mode: 'append', text: '개막전에서 40점을 넣었다.' })!
    const next = guardedEdit(first, mine, { section: '시즌 1', mode: 'replace', text: '3경기 평균 41점으로 득점 선두다.' })!
    expect(next).toContain('[기록]\n내가 쓴 시즌 메모\n=== 시즌 1 ===\n3경기 평균 41점으로 득점 선두다.\n== 여담 ==')
    expect(next).not.toContain('개막전에서')
  })
})

describe('guardedEdit: your sections stay yours', () => {
  // You wrote 여담 (the last section, no trailing newline); the system wrote the rest.
  const body = '== 개요 ==\n시스템 개요\n== 여담 ==\n내가 쓴 여담'
  const owned = sectionKeys(body)
  const mine = new Map([['여담#1', owned.get('여담#1')!]])

  it('lets an editor add to another section without touching yours', () => {
    const next = guardedEdit(body, mine, { section: '개요', mode: 'append', text: '덧붙임' })
    expect(next).not.toBeNull()
    expect(sectionKeys(next!).get('여담#1')).toBe('내가 쓴 여담')
  })

  it('refuses headings, categories and unbalanced folds in the text, and multi-line section names', () => {
    expect(guardedEdit(body, mine, { section: '개요', mode: 'append', text: '덧붙임\n== 개요 ==\nAI 개요' })).toBeNull()
    expect(guardedEdit(body, mine, { section: '개요', mode: 'append', text: '[[분류:가짜]]' })).toBeNull()
    expect(guardedEdit(body, mine, { section: '개요', mode: 'append', text: '{{{#!folding 열기' })).toBeNull()
    expect(guardedEdit(body, mine, { section: '개요', mode: 'append', text: '시즌 기록은 아래와 같다.\n[기록]' })).toBeNull()
    expect(guardedEdit(body, mine, { section: '개요\n[[분류:가짜]]', mode: 'append', text: 'x' })).toBeNull()
  })

  it('refuses any edit that would change your section, by whatever path', () => {
    expect(guardedEdit(body, mine, { section: '여담', mode: 'replace', text: 'AI가 덮어씀' })).toBeNull()
    expect(guardedEdit(body, mine, { section: '여담', mode: 'append', text: 'AI 덧붙임' })).toBeNull()
    // A new section lands after yours without changing it.
    const added = guardedEdit(body, mine, { section: '별명', mode: 'append', text: '불꽃 슈터' })
    expect(added).not.toBeNull()
    expect(sectionKeys(added!).get('여담#1')).toBe('내가 쓴 여담')
  })

  it('keys same-titled sections by occurrence, and only appends to a section holding part of a fold', () => {
    const twice = '== 2025 ==\n첫째\n== 2025 ==\n둘째'
    const keys = sectionKeys(twice)
    expect([...keys.keys()]).toEqual(['2025#1', '2025#2'])
    const folded = '== 개요 ==\n{{{#!folding 더 보기\n접힌 내용\n}}}\n== 여담 ==\n끝'
    const next = guardedEdit(folded, new Map(), { section: '개요', mode: 'replace', text: '새 개요' })
    expect(next).toContain('}}}')
    expect(next).toContain('새 개요')
  })
})
