import { describe, expect, it } from 'vitest'
import { cleanLoreText, cutText, findExcerpt } from './secretText'

describe('an excerpt found in more than one place', () => {
  it('makes no card when the places widen to different sentences', () => {
    // The mother's belief and the truth both say it: which one went public isn't clear.
    expect(findExcerpt('어머니는 그가 전학을 원한다고 생각한다. 사실 그는 전학을 원한다.', '전학을 원한다')).toBeNull()
    // The same sentence twice is unclear too, copied in part or whole.
    expect(findExcerpt('그는 입양아다. 아무도 모른다. 그는 입양아다.', '입양아다')).toBeNull()
    expect(findExcerpt('그는 입양아다. 아무도 모른다. 그는 입양아다.', '그는 입양아다.')).toBeNull()
  })

  it('takes the one place it is a whole sentence by itself, and cuts it there', () => {
    const s = '어머니는 「사실 그는 전학을 원한다.」고 믿는다. 사실 그는 전학을 원한다.'
    expect(findExcerpt(s, '사실 그는 전학을 원한다.')).toBe('사실 그는 전학을 원한다.')
    expect(cutText(s, '사실 그는 전학을 원한다.')).toBe('어머니는 「사실 그는 전학을 원한다.」고 믿는다.')
    // Twice in one sentence is one place.
    expect(findExcerpt('전학을 원하고 또 전학을 원한다. 뒤.', '전학을 원')).toBe('전학을 원하고 또 전학을 원한다.')
  })

  it('never takes a short excerpt across a paragraph when it also sits within one', () => {
    // The check reads a secret on one line, so "비밀이다. 나" could be either place.
    const two = '가 문단 앞. 가 문단 비밀이다.\n\n나 문단 비밀이다. 나 문단 뒤.\n\n다 문단.'
    expect(findExcerpt(two, '비밀이다. 나')).toBeNull()
    // Only across one: both sentences, as the file has them.
    expect(findExcerpt('가 문단 비밀이다.\n\n나 문단 뒤.', '비밀이다. 나')).toBe('가 문단 비밀이다.\n\n나 문단 뒤.')
  })
})

describe('sentence boundaries', () => {
  it('reads a no-break or ideographic space after a sentence the same at both ends', () => {
    for (const space of [' ', '　']) {
      const s = `앞 비밀이다.${space}그는 입양아다. 뒤.`
      expect(findExcerpt(s, '입양아다')).toBe('그는 입양아다.')
      expect(cutText(s, '그는 입양아다.')).toBe('앞 비밀이다. 뒤.')
    }
  })

  it('doesn’t end a sentence at an abbreviation or a number’s full stop', () => {
    expect(findExcerpt('그는 A고 vs. B고 경기에서 일부러 졌다. 다른 문장.', '일부러 졌다')).toBe('그는 A고 vs. B고 경기에서 일부러 졌다.')
    expect(findExcerpt('등번호는 No. 7이다. 사실 그는 입양아다.', '7이다')).toBe('등번호는 No. 7이다.')
    // A date belongs to its sentence.
    expect(findExcerpt('2024. 3. 15. 그는 몰래 전학 서류를 냈다.', '몰래 전학 서류를')).toBe('2024. 3. 15. 그는 몰래 전학 서류를 냈다.')
  })

  it('reads a line starting with a year as text, not a numbered list item', () => {
    const s = '2024. 그는 몰래 전학 서류를 냈다.\n다른 줄.'
    expect(findExcerpt(s, '몰래 전학 서류를')).toBe('2024. 그는 몰래 전학 서류를 냈다.')
    // The year goes with its sentence, never left behind or dropped as a marker.
    expect(cutText(s, '2024. 그는 몰래 전학 서류를 냈다.')).toBe('다른 줄.')
    expect(cutText(s, '그는 몰래 전학 서류를 냈다.')).toBe('2024.\n다른 줄.')
    // One- and two-digit numbers still mark items.
    expect(findExcerpt('1. 하나다.\n12) 열둘이다.', '열둘')).toBe('열둘이다.')
    expect(cutText('1. 하나다.\n12) 열둘이다.', '열둘이다.')).toBe('1. 하나다.')
  })
})

describe('cleanLoreText', () => {
  it('is the same for the server and the card’s preview: no headings, underlines, comments, indentation or blank-line runs', () => {
    expect(cleanLoreText('## 메모\n---\n  들여쓴 줄\n\n\n\n<!-- 숨김 -->새 비밀', Infinity)).toBe('메모\n들여쓴 줄\n\n숨김 새 비밀')
    expect(cleanLoreText('가'.repeat(10), 3)).toBe('가가가')
  })
})
