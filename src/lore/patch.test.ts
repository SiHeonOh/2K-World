import { describe, expect, it } from 'vitest'
import type { LorePatch } from '@shared/suggestions'
import {
  applyPatch,
  blankParts,
  cleanLoreText,
  currentOf,
  cutText,
  defaultEditable,
  findExcerpt,
  fitReveal,
  fitToFile,
  restrictPatch,
  revealEdit,
  sanitizePatch,
  worthDrafting,
} from './patch'

describe('cleanLoreText', () => {
  it('drops heading lines, underlines and comment markers, and squeezes blank lines', () => {
    expect(cleanLoreText('## 비밀\n첫 줄\n\n\n\n둘째 줄\n---\n<!-- 숨김 -->')).toBe('비밀\n첫 줄\n\n둘째 줄\n숨김')
    expect(cleanLoreText('제목\n===\n본문')).toBe('제목\n본문')
    expect(cleanLoreText(42)).toBe('')
  })
})

describe('sanitizePatch', () => {
  it('keeps only fields of the file kind, clamped and checked', () => {
    expect(
      sanitizePatch('player', {
        traits: { ego: 9, usage: 0, risk: 4, ambition: 3.6 },
        media: 'loud',
        name: '김단장',
        fans: { size: 5 },
        relationships: [
          { with: '이순신', type: 'rival', strength: 7, visibility: 'public' },
          { with: '이순신', type: 'friend', strength: 2, visibility: 'public' },
          { with: '김철수', type: 'boss', strength: 2, visibility: 'public' },
        ],
        public: '  # 이야기\n좋은 선수다. ',
        nicknames: ['  킹  ', '킹', ''],
      }),
    ).toEqual({
      traits: { ego: 5, usage: 1, ambition: 4 },
      relationships: [{ with: '이순신', type: 'rival', strength: 5, visibility: 'public' }],
      public: '이야기\n좋은 선수다.',
      nicknames: ['킹'],
    })
    expect(sanitizePatch('gm', { name: ' 박 단장 ', philosophy: 'win-now', negotiation: 'cheat', traits: { star_chasing: 5, usage: 2 } })).toEqual({
      name: '박 단장',
      philosophy: 'win-now',
      traits: { star_chasing: 5 },
    })
    expect(sanitizePatch('team', { fans: { size: 5, pride: 'big' }, rivals: ['가람고', '가람고'], relationships: [{ with: 'x', type: 'rival' }] })).toEqual({
      fans: { size: 5 },
      rivals: ['가람고'],
    })
    expect(sanitizePatch('player', { media: 'loud' })).toBeNull()
    expect(sanitizePatch('player', null)).toBeNull()
  })
})

describe('applyPatch', () => {
  const base = () => ({
    settings: {
      id: '홍길동',
      traits: { ego: 3, usage: 3 },
      media: 'normal',
      relationships: [{ with: '김철수', type: 'friend', strength: 2, visibility: 'public', note: '중학교 동창' }],
      rivals: ['가람고'],
    },
    sections: { public: '원래 이야기.', rumor: '', secret: '비밀은 그대로.' },
  })

  it('takes the patch values, updates a relationship in place and appends text', () => {
    const next = applyPatch(base(), {
      traits: { ego: 5 },
      media: 'outspoken',
      relationships: [
        { with: '김철수', type: 'rival', strength: 4, visibility: 'rumor' },
        { with: '이영희', type: 'friend', strength: 3, visibility: 'public' },
      ],
      rivals: ['가람고', '누리고'],
      public: '새 이야기.',
      rumor: '소문 하나.',
    })
    expect(next.settings.traits).toEqual({ ego: 5, usage: 3 })
    expect(next.settings.media).toBe('outspoken')
    expect(next.settings.relationships).toEqual([
      { with: '김철수', type: 'rival', strength: 4, visibility: 'rumor', note: '중학교 동창' },
      { with: '이영희', type: 'friend', strength: 3, visibility: 'public' },
    ])
    expect(next.settings.rivals).toEqual(['가람고', '누리고'])
    expect(next.sections).toEqual({ public: '원래 이야기.\n\n새 이야기.', rumor: '소문 하나.', secret: '비밀은 그대로.' })
  })

  it('a card you edited sets a relationship as you wrote it', () => {
    const b = base()
    b.settings.relationships = [{ with: '김철수', type: 'family', strength: 5, visibility: 'secret' }] as never
    const next = applyPatch(b, { relationships: [{ with: '김철수', type: 'rival', strength: 2, visibility: 'public' }] })
    expect(next.settings.relationships).toEqual([{ with: '김철수', type: 'rival', strength: 2, visibility: 'public' }])
  })

  it('never changes what it was given', () => {
    const b = base()
    applyPatch(b, { traits: { ego: 1 }, public: 'x' })
    expect(b).toEqual(base())
  })
})

describe('blank parts', () => {
  it('counts a part as blank only while it is as the template left it', () => {
    expect(blankParts('player', null)).toEqual(['traits', 'relationships', 'public', 'rumor'])
    const player = defaultEditable('player', '홍길동')
    expect(blankParts('player', player)).toEqual(['traits', 'relationships', 'public', 'rumor'])
    player.settings.traits = { ...(player.settings.traits as object), ego: 4 }
    player.sections.public = '이미 쓴 이야기'
    expect(blankParts('player', player)).toEqual(['relationships', 'rumor'])
    const gm = defaultEditable('gm', '가람고 단장')
    expect(blankParts('gm', gm)).toEqual(['persona', 'public', 'rumor'])
    gm.settings.name = '박단장'
    expect(blankParts('gm', gm)).toEqual(['public', 'rumor'])
    const team = defaultEditable('team', '가람고')
    team.settings.rivals = ['누리고']
    expect(blankParts('team', team)).toEqual(['public', 'rumor'])
  })

  it('a file with only relationships and 소문 left is not worth a draft', () => {
    expect(worthDrafting(['relationships', 'rumor'])).toBe(false)
    expect(worthDrafting(['relationships', 'public'])).toBe(true)
  })

  it('restricts a draft to the blank parts', () => {
    const patch = { traits: { ego: 4 }, media: 'quiet', public: '이야기', rumor: '소문', relationships: [{ with: 'a', type: 'friend' as const, strength: 3, visibility: 'public' as const }] }
    expect(restrictPatch(patch, ['public'])).toEqual({ public: '이야기' })
    expect(restrictPatch(patch, ['traits', 'rumor'])).toEqual({ traits: { ego: 4 }, media: 'quiet', rumor: '소문' })
    expect(restrictPatch({ public: 'x' }, ['traits'])).toBeNull()
  })

  it('shows what a missing file reads as for the preview', () => {
    expect(currentOf('player', null, { traits: { ego: 4 }, public: 'x', nicknames: ['킹'] }, ['왕'])).toEqual({
      exists: false,
      traits: { ego: 3, usage: 3, competitiveness: 3, loyalty: 3, temperament: 3, professionalism: 3, ambition: 3 },
      public: '',
      nicknames: ['왕'],
    })
  })
})

describe('fitToFile (a card approved as you saw it)', () => {
  const file = () => {
    const e = defaultEditable('player', '홍길동')
    e.settings.relationships = [{ with: '김철수', type: 'family', strength: 5, visibility: 'secret' }]
    return e
  }
  const rival = { with: '김철수', type: 'rival' as const, strength: 2, visibility: 'rumor' as const }
  const friend = { with: '이영희', type: 'friend' as const, strength: 3, visibility: 'public' as const }

  it('never changes a relationship the file already has; a batch leaves it out, a single approval asks you', () => {
    expect(fitToFile('player', file(), { relationships: [rival, friend] }, { partial: false })).toEqual({ stale: 'part of it no longer fits' })
    expect(fitToFile('player', file(), { relationships: [rival, friend] }, { partial: true })).toEqual({ patch: { relationships: [friend] } })
    expect(fitToFile('player', file(), { relationships: [rival] }, { partial: true })).toEqual({ stale: 'nothing fits' })
  })

  it('fills only the parts still blank', () => {
    const e = file()
    e.sections.public = '내가 쓴 이야기.'
    const draft = { traits: { ego: 4 }, public: '초안 이야기.' }
    expect(fitToFile('player', e, draft, { parts: ['traits', 'public'], partial: false })).toEqual({ stale: 'part of it no longer fits' })
    expect(fitToFile('player', e, draft, { parts: ['traits', 'public'], partial: true })).toEqual({ patch: { traits: { ego: 4 } } })
  })

  it('applies a trait change only from the value it was suggested against', () => {
    const e = file()
    e.settings.traits = { ...(e.settings.traits as object), ego: 2 }
    expect(fitToFile('player', e, { traits: { ego: 4 } }, { from: 3, partial: true })).toEqual({ stale: 'nothing fits' })
    expect(fitToFile('player', e, { traits: { ego: 3 } }, { from: 2, partial: false })).toEqual({ patch: { traits: { ego: 3 } } })
  })

  it('counts what the file already holds as fitting (a retry after a crash)', () => {
    const e = file()
    e.sections.public = '초안 이야기.'
    e.settings.traits = { ...(e.settings.traits as object), ego: 4 }
    expect(fitToFile('player', e, { traits: { ego: 4 }, public: '초안 이야기.' }, { parts: ['traits', 'public'], partial: false })).toEqual({
      patch: { traits: { ego: 4 }, public: '초안 이야기.' },
    })
    expect(fitToFile('player', e, { traits: { ego: 4 } }, { from: 3, partial: false })).toEqual({ patch: { traits: { ego: 4 } } })
    const same = { with: '김철수', type: 'family' as const, strength: 5, visibility: 'secret' as const }
    expect(fitToFile('player', e, { relationships: [same] }, { partial: false })).toEqual({ patch: { relationships: [same] } })
  })
})

describe('secret reveals', () => {
  const SECRET = '중학교 때 무릎을 다쳐 1년을 쉬었다. 사실은 전학을 원한다.\n\n동생이 「가람고」 농구부에 있다.'
  const file = () => {
    const e = defaultEditable('player', '홍길동')
    e.settings.relationships = [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'secret' }]
    e.sections = { public: '팀의 에이스.', rumor: '', secret: SECRET }
    return e
  }

  it('finds an excerpt as the file has it, apart from spacing and quote marks', () => {
    expect(findExcerpt(SECRET, '사실은 전학을 원한다.')).toBe('사실은 전학을 원한다.')
    // Korean typed on a Mac (NFD) matches too.
    expect(findExcerpt(SECRET.normalize('NFD'), '사실은 전학을 원한다.')).toBe('사실은 전학을 원한다.')
    expect(findExcerpt(SECRET, '사실은 이적을 원한다.')).toBeNull()
    expect(findExcerpt(SECRET, '  ')).toBeNull()
    // The job saw each secret in 「」: copied with them, the brackets are dropped; brackets the secret really has still match.
    expect(findExcerpt('사실은 전학을 원한다', '「사실은 전학을 원한다」')).toBe('사실은 전학을 원한다')
    expect(findExcerpt('사실은 전학을 원한다', '"사실은 전학을 원한다"')).toBe('사실은 전학을 원한다')
    expect(findExcerpt('「가람고」의 재단이 돈을 빼돌렸다.', '"가람고"의 재단이')).toBe('「가람고」의 재단이 돈을 빼돌렸다.')
  })

  it('widens an excerpt to whole sentences, never past a line', () => {
    const s = '아버지가 사업에 실패했다. 그래서 장학금이 필요하다.'
    expect(findExcerpt(s, '버지가 사업')).toBe('아버지가 사업에 실패했다.')
    expect(findExcerpt(s, '실패했다. 그래서')).toBe(s)
    expect(findExcerpt(SECRET, '사실은 전학을 원한다')).toBe('사실은 전학을 원한다.')
    // Copied across a paragraph break (the job reads a secret on one line): whole sentences at both ends.
    expect(findExcerpt(SECRET, '원한다.  동생이 "가람고" 농구부에')).toBe('사실은 전학을 원한다.\n\n동생이 「가람고」 농구부에 있다.')
    // A line with no end punctuation ends at its line break.
    expect(findExcerpt('첫 줄\n둘째 줄 끝이 없다\n셋째 줄', '줄 끝')).toBe('둘째 줄 끝이 없다')
    // Quotes after the full stop belong to the sentence; a decimal point doesn't end one.
    expect(findExcerpt('그가 말했다. "나는 떠난다." 모두 놀랐다.', '나는 떠난다')).toBe('"나는 떠난다."')
    expect(findExcerpt('평균 3.5점을 넣었다. 사실 부상이다.', '3.5점')).toBe('평균 3.5점을 넣었다.')
    // A list item's text, without its marker.
    expect(findExcerpt('- 사실 그는 입양아다.\n- 친부는 상대팀 감독이다.', '그는 입양아')).toBe('사실 그는 입양아다.')
    expect(findExcerpt('1. 사실 그는 입양아다.', '그는 입양아')).toBe('사실 그는 입양아다.')
    expect(findExcerpt('- 사실 그는 입양아다.\n- 친부는 상대팀 감독이다.', '- 사실 그는 입양아다.')).toBe('사실 그는 입양아다.')
    // Two items copied as the check saw them (on one line) are both items, as the file has them.
    expect(findExcerpt('- 사실 그는 입양아다.\n- 친부는 상대팀 감독이다.', '사실 그는 입양아다. - 친부는 상대팀')).toBe('사실 그는 입양아다.\n- 친부는 상대팀 감독이다.')
    expect(cutText('- 사실 그는 입양아다.\n- 친부는 상대팀 감독이다.\n- 형이 있다.', '사실 그는 입양아다.\n- 친부는 상대팀 감독이다.')).toBe('- 형이 있다.')
  })

  it('cuts an excerpt out and tidies only around it', () => {
    expect(cutText(SECRET, '사실은 전학을 원한다.')).toBe('중학교 때 무릎을 다쳐 1년을 쉬었다.\n\n동생이 「가람고」 농구부에 있다.')
    expect(cutText(SECRET, '동생이 "가람고" 농구부에 있다.')).toBe('중학교 때 무릎을 다쳐 1년을 쉬었다. 사실은 전학을 원한다.')
    expect(cutText('하나. 둘. 셋.', '둘.')).toBe('하나. 셋.')
    expect(cutText(SECRET, SECRET)).toBe('')
    expect(cutText(SECRET, '없는 말')).toBeNull()
    expect(cutText('A 문단.\n\n사실은 전학을 원한다.\n\nB 문단.', '사실은 전학을 원한다.')).toBe('A 문단.\n\nB 문단.')
    expect(cutText('A 줄.\n사실은 전학을 원한다.\nB 줄.', '사실은 전학을 원한다.')).toBe('A 줄.\nB 줄.')
    // The rest stays byte for byte: a Mac file stays NFD, hard breaks (two trailing spaces) and wide gaps elsewhere stay.
    const nfd = '중학교 때 다쳤다. 사실은 전학을 원한다.'.normalize('NFD')
    expect(cutText(nfd, '사실은 전학을 원한다.')).toBe('중학교 때 다쳤다.'.normalize('NFD'))
    expect(cutText('첫 줄  \n둘째 줄\n\n사실은 전학을 원한다.', '사실은 전학을 원한다.')).toBe('첫 줄  \n둘째 줄')
    expect(cutText('가.\n\n\n\n나.\n\n다.', '다.')).toBe('가.\n\n\n\n나.')
    expect(cutText('가.   나.\n\n다.', '다.')).toBe('가.   나.')
  })

  it('takes a list item whole, marker and all, and never leaves a bare marker', () => {
    const list = '- 사실 그는 입양아다.\n- 친부는 상대팀 감독이다.'
    expect(cutText(list, '사실 그는 입양아다.')).toBe('- 친부는 상대팀 감독이다.')
    expect(cutText(list, '친부는 상대팀 감독이다.')).toBe('- 사실 그는 입양아다.')
    expect(cutText('* 하나다.\n* 둘이다.\n* 셋이다.', '둘이다.')).toBe('* 하나다.\n* 셋이다.')
    expect(cutText('+ 하나다.\n+ 둘이다.', '하나다.')).toBe('+ 둘이다.')
    expect(cutText('1. 하나다.\n2. 둘이다.', '하나다.')).toBe('2. 둘이다.')
    expect(cutText('가족:\n  - 사실 그는 입양아다.  \n  - 형이 있다.', '사실 그는 입양아다.')).toBe('가족:\n  - 형이 있다.')
    // Part of an item leaves the item with the rest of its text.
    expect(cutText('- 사실 그는 입양아다. 친부는 감독이다.', '사실 그는 입양아다.')).toBe('- 친부는 감독이다.')
    expect(cutText('- 사실 그는 입양아다. 친부는 감독이다.', '친부는 감독이다.')).toBe('- 사실 그는 입양아다.')
    // What you keep takes the item's place.
    expect(cutText('- 사실 그는 입양아다.\n- 형이 있다.', '사실 그는 입양아다.', '가족 이야기를 피한다.')).toBe('- 가족 이야기를 피한다.\n- 형이 있다.')
  })

  it('moves the text from 비밀 to the end of 공개 or 소문, or makes a secret tie known', () => {
    const moved = fitReveal(file(), { fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' })
    expect(moved).toMatchObject({ next: { sections: { public: '팀의 에이스.\n\n사실은 전학을 원한다.', secret: '중학교 때 무릎을 다쳐 1년을 쉬었다.\n\n동생이 「가람고」 농구부에 있다.' } } })
    const whispered = fitReveal(file(), { fromSecret: '사실은 전학을 원한다.', rumor: '전학을 원한다는 말이 돈다.' })
    expect(whispered).toMatchObject({ next: { sections: { public: '팀의 에이스.', rumor: '전학을 원한다는 말이 돈다.' } } })
    const tie = fitReveal(file(), { relationships: [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'rumor' }] })
    expect('next' in tie && tie.next.settings.relationships).toEqual([{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'rumor' }])
    expect(tie).toMatchObject({ tie: { with: '이영희', type: 'dislikes', visibility: 'rumor' } })
    // What you keep stays in 비밀 in the text's place.
    const kept = fitReveal(file(), { fromSecret: '사실은 전학을 원한다.', public: '전학을 원한다.', keepSecret: '아버지가 반대한다.' })
    expect(kept).toMatchObject({ next: { sections: { public: '팀의 에이스.\n\n전학을 원한다.', secret: '중학교 때 무릎을 다쳐 1년을 쉬었다. 아버지가 반대한다.\n\n동생이 「가람고」 농구부에 있다.' } } })
  })

  it('adds the text even when the destination already holds it, as long as it is still in 비밀', () => {
    const e = file()
    e.sections = { public: '사실은 전학을 원한다는 소문은 거짓이라고 본인이 말했다.', rumor: '', secret: '사실은 전학을 원한다.' }
    expect(fitReveal(e, { fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' })).toMatchObject({
      next: { sections: { public: '사실은 전학을 원한다는 소문은 거짓이라고 본인이 말했다.\n\n사실은 전학을 원한다.', secret: '' } },
    })
  })

  it('counts a reveal already made as fitting, and anything else that changed as stale, with why', () => {
    const done = file()
    done.sections.secret = '중학교 때 무릎을 다쳐 1년을 쉬었다.'
    done.sections.public = '팀의 에이스.\n\n사실은 전학을 원한다.'
    expect(fitReveal(done, { fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' })).toEqual({ next: done })
    const gone = file()
    gone.sections.secret = '다른 비밀.'
    expect(fitReveal(gone, { fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' })).toEqual({ stale: 'secret-gone' })
    expect(fitReveal(file(), { fromSecret: '사실은 전학을 원한다.' })).toEqual({ stale: 'nothing' })
    // A tie you made public by hand meanwhile isn't changed again; one already where the card says counts as done.
    const open = file()
    open.settings.relationships = [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'public' }]
    expect(fitReveal(open, { relationships: [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'rumor' }] })).toEqual({ stale: 'tie-not-secret' })
    expect(fitReveal(open, { relationships: [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'public' }] })).toMatchObject({ next: open })
    // A tie whose kind you changed is another tie.
    const changed = file()
    changed.settings.relationships = [{ with: '이영희', type: 'friend', strength: 2, visibility: 'secret' }]
    expect(fitReveal(changed, { relationships: [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'public' }] })).toEqual({ stale: 'tie-gone' })
  })

  it('reveals only the tie of the card’s kind when there are several with one person', () => {
    const e = file()
    e.settings.relationships = [
      { with: '이영희', type: 'rival', strength: 3, visibility: 'public' },
      { with: '이영희', type: 'family', strength: 5, visibility: 'secret' },
      { with: '이영희', type: 'mentor', strength: 4, visibility: 'secret' },
    ]
    for (const visibility of ['public', 'rumor'] as const) {
      const r = fitReveal(e, { relationships: [{ with: '이영희', type: 'family', strength: 5, visibility }] })
      expect('next' in r && r.next.settings.relationships).toEqual([
        { with: '이영희', type: 'rival', strength: 3, visibility: 'public' },
        { with: '이영희', type: 'family', strength: 5, visibility },
        { with: '이영희', type: 'mentor', strength: 4, visibility: 'secret' },
      ])
      expect(r).toMatchObject({ tie: { with: '이영희', type: 'family', visibility } })
    }
  })

  it('an edited card keeps what leaves 비밀, and takes only your wording, destination, what stays, or visibility', () => {
    const card = { fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' }
    expect(revealEdit(card, { rumor: '## 전학설\n전학을 원한다는 말이 돈다.', fromSecret: '다른 비밀' })).toEqual({ fromSecret: '사실은 전학을 원한다.', rumor: '전학설\n전학을 원한다는 말이 돈다.' })
    expect(revealEdit(card, { public: '전학을 원한다.', keepSecret: '  아버지가 반대한다. ' })).toEqual({ fromSecret: '사실은 전학을 원한다.', public: '전학을 원한다.', keepSecret: '아버지가 반대한다.' })
    expect(revealEdit(card, { public: '전학을 원한다.', keepSecret: '  ' })).toEqual({ fromSecret: '사실은 전학을 원한다.', public: '전학을 원한다.' })
    expect(revealEdit(card, { public: '  ' })).toBeNull()
    const tie = { relationships: [{ with: '이영희', type: 'dislikes' as const, strength: 2, visibility: 'public' as const }] }
    expect(revealEdit(tie, { relationships: [{ with: '이영희', type: 'friend', strength: 5, visibility: 'rumor' }] })).toEqual({
      relationships: [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'rumor' }],
    })
    // Back to secret is turning the card down, not approving it.
    expect(revealEdit(tie, { relationships: [{ with: '이영희', type: 'dislikes', strength: 2, visibility: 'secret' }] })).toBeNull()
  })

  it('never shortens a long secret: all of it moves, and an edit longer than it is refused, not cut', () => {
    const long = `${'가'.repeat(900)}. ${'나'.repeat(800)}.`
    const found = findExcerpt(long, long)!
    expect(found).toBe(long)
    const text = cleanLoreText(found, found.length)
    expect(text).toBe(long)
    const e = file()
    e.sections.secret = long
    expect(fitReveal(e, { fromSecret: found, public: text })).toMatchObject({ next: { sections: { public: `팀의 에이스.\n\n${long}`, secret: '' } } })
    const card = { fromSecret: found, public: text }
    expect(revealEdit(card, { public: long })).toEqual(card)
    expect(revealEdit(card, { public: `${long}다` })).toBe('too-long')
    // What you keep has its own reason, so the card can say which box to shorten.
    expect(revealEdit(card, { public: '짧다.', keepSecret: `${long}다` })).toBe('keep-too-long')
    // A short secret's edit may still run to 1500 characters.
    expect(revealEdit({ fromSecret: '짧다.', public: '짧다.' }, { public: '가'.repeat(1500) })).toMatchObject({ public: '가'.repeat(1500) })
    expect(revealEdit({ fromSecret: '짧다.', public: '짧다.' }, { public: '가'.repeat(1501) })).toBe('too-long')
  })

  it('shows 공개, 소문 and 비밀 for a reveal, since editing can send it to either and the card shows what stays', () => {
    expect(currentOf('player', file(), { fromSecret: 'x', public: 'x' }, [], true)).toEqual({ exists: true, public: '팀의 에이스.', rumor: '', secret: SECRET })
    // 비밀 only when asked for (a card still waiting).
    expect(currentOf('player', file(), { fromSecret: 'x', public: 'x' }, [])).toEqual({ exists: true, public: '팀의 에이스.', rumor: '' })
  })

  it('previews what stays in 비밀 exactly as approving writes it, what you keep cleaned the same way', () => {
    const card = { fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' }
    const typed = '## 메모\n---\n  들여쓴 줄 <!-- 숨김 -->\n\n\n\n아버지가 반대한다.'
    const server = fitReveal(file(), revealEdit(card, { public: '전학을 원한다.', keepSecret: typed }) as LorePatch)
    const preview = cutText(SECRET, card.fromSecret, cleanLoreText(typed, Infinity))
    expect(preview).toBe('중학교 때 무릎을 다쳐 1년을 쉬었다. 메모\n들여쓴 줄  숨김\n\n아버지가 반대한다.\n\n동생이 「가람고」 농구부에 있다.')
    expect(server).toMatchObject({ next: { sections: { secret: preview } } })
    // Raw, it would have shown a heading and an underline that never reach the file.
    expect(cutText(SECRET, card.fromSecret, typed)).not.toBe(preview)
  })

  it('a retry after a crash adds neither the text nor what you kept again, even when what you kept holds the card’s text', () => {
    for (const keepSecret of ['사실은 전학을 원한다.', '사실은 전학을 원한다. (반만 사실이다)']) {
      const patch = revealEdit({ fromSecret: '사실은 전학을 원한다.', public: '사실은 전학을 원한다.' }, { public: '전학을 원한다고 밝혔다.', keepSecret }) as LorePatch
      const first = fitReveal(file(), patch)
      if (!('next' in first)) throw new Error('not applied')
      expect(first.next.sections.public).toBe('팀의 에이스.\n\n전학을 원한다고 밝혔다.')
      expect(first.next.sections.secret).toBe(SECRET.replace('사실은 전학을 원한다.', keepSecret))
      // The file was written, the approval wasn't recorded: approving again finds it done.
      expect(fitReveal(first.next, patch)).toEqual({ next: first.next })
    }
    // Without a crash, a destination that merely holds the words still gets the text (the secret is still there to move).
    const e = file()
    e.sections.public = '전학을 원한다고 밝혔다는 기사는 오보였다.'
    const patch = { fromSecret: '사실은 전학을 원한다.', public: '전학을 원한다고 밝혔다.', keepSecret: '사실은 전학을 원한다.' }
    expect(fitReveal(e, patch)).toMatchObject({ next: { sections: { public: '전학을 원한다고 밝혔다는 기사는 오보였다.\n\n전학을 원한다고 밝혔다.' } } })
  })
})
