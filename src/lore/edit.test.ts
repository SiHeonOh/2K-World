import { describe, expect, it } from 'vitest'
import { editLore, LoreEditError, splitSectionsOf, type LoreEditable } from './edit'
import { parseLoreFile } from './parse'

/** The player template as the league ships it: comments, aligned hints, commented-out examples. */
const TEMPLATE = `---
# 새 선수 파일이 필요하면: 이 파일을 복사해서 teams/학교/ 폴더에 선수 이름으로 저장
id: 허다솜
traits:              # 1(낮음) ~ 5(높음)
  ego: 3             # 자존심, 대우받고 싶은 마음
  usage: 3           # 볼 욕심
  competitiveness: 3 # 승부욕
  loyalty: 3         # 학교·팀에 대한 애정
  temperament: 3     # 감정 기복
  professionalism: 3 # 프로 의식
  ambition: 3        # 기록 욕심
media: normal        # quiet / normal / outspoken
relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요
  # - with: 이순신
  #   type: rival          # friend / rival / family / mentor / dislikes
hooks:               # 나만의 규칙 (선택)
  # - when: traded         # 트레이드되면
  #   mood: { stability: -30 }
canon: true          # false로 바꾸면 AI가 자유롭게 살을 붙여도 됨
---

# 허다솜

## 공개
<!-- 누구나 아는 이야기 -->

## 소문
<!-- 팬들 사이에서 도는 이야기 -->

## 비밀
<!-- 본인만 아는 이야기 -->
`

const FILE = 'teams/가람고/허다솜.md'

function loaded(text: string, file = FILE): LoreEditable {
  const { entry } = parseLoreFile(file, text)
  if (!entry) throw new Error('fixture does not parse')
  return { settings: structuredClone(entry.settings) as Record<string, unknown>, sections: { ...entry.sections } }
}

function edit(text: string, change: (d: LoreEditable) => void, file = FILE): string {
  const base = loaded(text, file)
  const next = structuredClone(base)
  change(next)
  const r = editLore(text, file, base, next)
  if (!('text' in r)) throw new Error(`conflicts: ${r.conflicts.join(', ')}`)
  return r.text
}

/** Lines that differ, in order (a cheap line diff for files whose line count didn't change). */
const changedLines = (a: string, b: string) => {
  const x = a.split('\n')
  const y = b.split('\n')
  return y.filter((l, i) => l !== x[i])
}

describe('editing a lore file in place', () => {
  it('changes only the values that changed, keeping every comment and alignment', () => {
    const out = edit(TEMPLATE, (d) => {
      ;(d.settings.traits as Record<string, number>).ego = 5
      d.settings.media = 'outspoken'
      d.settings.canon = false
    })
    expect(changedLines(TEMPLATE, out)).toEqual([
      '  ego: 5             # 자존심, 대우받고 싶은 마음',
      'media: outspoken        # quiet / normal / outspoken',
      'canon: false          # false로 바꾸면 AI가 자유롭게 살을 붙여도 됨',
    ])
  })

  it('adds list items under the key, above the commented-out examples', () => {
    const out = edit(TEMPLATE, (d) => {
      d.settings.relationships = [{ with: '강하늘', type: 'rival', strength: 4, visibility: 'public' }]
      d.settings.hooks = [{ when: 'traded', mood: { stability: -30 } }]
    })
    expect(out).toContain(`relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요
  - with: 강하늘
    type: rival
    strength: 4
    visibility: public
  # - with: 이순신`)
    expect(out).toContain(`hooks:               # 나만의 규칙 (선택)
  - when: traded
    mood: { stability: -30 }
  # - when: traded`)

    // Replacing and then clearing a list leaves the key as it was.
    const again = edit(out, (d) => {
      d.settings.relationships = [
        { with: '강하늘', type: 'friend', strength: 2, visibility: 'secret' },
        { with: '김온유(누리고)', type: 'mentor', strength: 5, visibility: 'rumor' },
      ]
    })
    expect(loaded(again).settings.relationships).toHaveLength(2)
    const cleared = edit(again, (d) => {
      d.settings.relationships = []
      d.settings.hooks = []
    })
    expect(cleared).toBe(TEMPLATE)
  })

  it('creates settings a short file leaves out, and edits flow-style maps and lists', () => {
    const bare = '---\nid: 허다솜\n---\n## 공개\n슈터.\n'
    const out = edit(bare, (d) => {
      ;(d.settings.traits as Record<string, number>).usage = 5
      d.settings.media = 'quiet'
    })
    expect(out).toBe('---\nid: 허다솜\ntraits:\n  usage: 5\nmedia: quiet\n---\n## 공개\n슈터.\n')

    const flow = '---\nid: 허다솜\ntraits: { ego: 4, usage: 5 }\n---\n'
    expect(
      edit(flow, (d) => {
        ;(d.settings.traits as Record<string, number>).ego = 2
      }),
    ).toBe('---\nid: 허다솜\ntraits: { ego: 2, usage: 5 }\n---\n')
    expect(
      loaded(
        edit(flow, (d) => {
          ;(d.settings.traits as Record<string, number>).loyalty = 1
        }),
      ).settings.traits,
    ).toMatchObject({ ego: 4, usage: 5, loyalty: 1 })

    const team = '---\nid: 가람고\ncolors: ["#000000", "#ffffff"]   # 학교 색\nfans:\n  size: 3\nrivals:\n  - 누리고\n---\n'
    const teamOut = edit(
      team,
      (d) => {
        d.settings.colors = ['#e8590c']
        d.settings.rivals = ['누리고', '다온고']
        ;(d.settings.fans as Record<string, number>).pride = 5
      },
      'teams/가람고/가람고.md',
    )
    expect(teamOut).toBe('---\nid: 가람고\ncolors: [ "#e8590c" ]   # 학교 색\nfans:\n  size: 3\n  pride: 5\nrivals:\n  - 누리고\n  - 다온고\n---\n')
  })

  it('fills an empty value that has a comment after it, and empties it again', () => {
    const gm = '---\nid: 가람고 단장\nname:                  # 단장 이름\nteam: 가람고\n---\n'
    const file = 'teams/가람고/가람고 단장.md'
    const named = edit(gm, (d) => void (d.settings.name = '홍단장'), file)
    expect(named).toBe('---\nid: 가람고 단장\nname:                  홍단장 # 단장 이름\nteam: 가람고\n---\n')
    expect(loaded(edit(named, (d) => void (d.settings.name = null), file), file).settings.name).toBeNull()
    expect(edit('---\nid: 가람고 단장\nname:\nteam: 가람고\n---\n', (d) => void (d.settings.name = '홍단장'), file)).toContain('name: 홍단장\n')
  })

  it('writes each section under its heading, keeping the hint comments', () => {
    const out = edit(TEMPLATE, (d) => {
      d.sections.public = '3점 슈터.\n\n별명은 "가람 저격수".'
      d.sections.secret = '전학을 고민 중.'
    })
    expect(out.endsWith(`## 공개
<!-- 누구나 아는 이야기 -->
3점 슈터.

별명은 "가람 저격수".

## 소문
<!-- 팬들 사이에서 도는 이야기 -->

## 비밀
<!-- 본인만 아는 이야기 -->
전학을 고민 중.
`)).toBe(true)
    // And back to empty: the file is as it was.
    expect(edit(out, (d) => {
      d.sections.public = ''
      d.sections.secret = ''
    })).toBe(TEMPLATE)
  })

  it('adds a missing section heading in order, in any heading style', () => {
    const file = '---\nid: 허다솜\n---\n# 허다솜\n\n비밀\n===\n숨긴 이야기.\n'
    const out = edit(file, (d) => void (d.sections.rumor = '이적설.'))
    expect(out).toBe('---\nid: 허다솜\n---\n# 허다솜\n\n## 소문\n이적설.\n\n비밀\n===\n숨긴 이야기.\n')
    expect(edit('---\nid: 허다솜\n---\n', (d) => void (d.sections.public = '슈터.'))).toBe('---\nid: 허다솜\n---\n## 공개\n슈터.\n')
  })

  it('refuses headings inside text and sections split across headings', () => {
    expect(() => edit(TEMPLATE, (d) => void (d.sections.public = '## 비밀\n들켰다'))).toThrow(LoreEditError)
    const split = '---\nid: 허다솜\n---\n## 소문\n하나.\n## 소문 2\n둘.\n'
    expect(splitSectionsOf(split.split('---\n')[2]!)).toEqual(['rumor'])
    expect(() => edit(split, (d) => void (d.sections.rumor = '셋.'))).toThrow(/split-section/)
  })

  it('keeps edits made elsewhere, and stops only when both sides changed the same thing', () => {
    const base = loaded(TEMPLATE)
    const mine = structuredClone(base)
    ;(mine.settings.traits as Record<string, number>).ego = 5
    mine.sections.public = '내가 쓴 공개.'
    // Meanwhile someone changed usage and the rumor section in another editor.
    const theirs = edit(TEMPLATE, (d) => {
      ;(d.settings.traits as Record<string, number>).usage = 1
      d.sections.rumor = '남이 쓴 소문.'
    })
    const merged = editLore(theirs, FILE, base, mine)
    if (!('text' in merged)) throw new Error('expected a merge')
    const result = loaded(merged.text)
    expect(result.settings.traits).toMatchObject({ ego: 5, usage: 1 })
    expect(result.sections).toMatchObject({ public: '내가 쓴 공개.', rumor: '남이 쓴 소문.' })

    const clash = structuredClone(base)
    ;(clash.settings.traits as Record<string, number>).usage = 5
    clash.sections.rumor = '내 소문.'
    expect(editLore(theirs, FILE, base, clash)).toEqual({ conflicts: ['traits.usage', 'sections.rumor'] })
    // Both made the same change: nothing to fight over.
    const same = structuredClone(base)
    ;(same.settings.traits as Record<string, number>).usage = 1
    expect(editLore(theirs, FILE, base, same)).toEqual({ changed: false, text: theirs })
  })

  it('keeps Windows line endings and a byte order mark', () => {
    const crlf = '﻿' + TEMPLATE.replace(/\n/g, '\r\n')
    const out = edit(crlf, (d) => {
      d.settings.hooks = [{ when: 'benched', mood: { role: -20 } }]
      d.sections.rumor = '한 줄.\n두 줄.'
    })
    expect(out.startsWith('﻿---\r\n')).toBe(true)
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
    expect(loaded(out).sections.rumor).toBe('한 줄.\n두 줄.')
  })
})

describe('editing a lore file: what must never be lost', () => {
  it('“overwrite with mine” wins only where both changed, keeping everything else done elsewhere', () => {
    const base = loaded(TEMPLATE)
    const mine = structuredClone(base)
    ;(mine.settings.traits as Record<string, number>).ego = 5
    mine.sections.public = '내 공개.'
    const theirs = edit(TEMPLATE, (d) => {
      ;(d.settings.traits as Record<string, number>).ego = 4
      ;(d.settings.traits as Record<string, number>).usage = 1
      d.sections.public = '남의 공개.'
      d.sections.secret = '남이 쓴 비밀.'
    })
    expect(editLore(theirs, FILE, base, mine)).toEqual({ conflicts: ['traits.ego', 'sections.public'] })
    const r = editLore(theirs, FILE, base, mine, { overwrite: true })
    if (!('text' in r)) throw new Error('expected a save')
    const result = loaded(r.text)
    expect(result.settings.traits).toMatchObject({ ego: 5, usage: 1 })
    expect(result.sections).toMatchObject({ public: '내 공개.', secret: '남이 쓴 비밀.' })
  })

  it('refuses to rewrite a section with comments inside its text, and keeps multi-line hints', () => {
    const withTodo = TEMPLATE.replace('<!-- 누구나 아는 이야기 -->\n', '<!-- 누구나 아는 이야기 -->\n첫 문단.\n<!-- TODO -->\n둘째.\n')
    expect(() => edit(withTodo, (d) => void (d.sections.public = '새 글.'))).toThrow(/comments-in-section/)
    const inline = TEMPLATE.replace('<!-- 누구나 아는 이야기 -->\n', '<!-- 힌트 --> 본문.\n')
    expect(() => edit(inline, (d) => void (d.sections.public = '새 글.'))).toThrow(/comments-in-section/)
    // The other sections can still be edited.
    expect(loaded(edit(withTodo, (d) => void (d.sections.rumor = '소문.'))).sections.rumor).toBe('소문.')
    // Text written above the hint (as in Obsidian): the hint below it stays.
    const above = TEMPLATE.replace('## 소문\n', '## 소문\n밖에서 쓴 소문.\n')
    expect(edit(above, (d) => void (d.sections.rumor = '고친 소문.'))).toBe(above.replace('밖에서 쓴 소문.', '고친 소문.'))

    const longHint = TEMPLATE.replace('<!-- 누구나 아는 이야기 -->\n', '<!--\n누구나 아는 이야기:\n별명, 스타일\n-->\n')
    const out = edit(longHint, (d) => void (d.sections.public = '슈터.'))
    expect(out).toContain('## 공개\n<!--\n누구나 아는 이야기:\n별명, 스타일\n-->\n슈터.\n\n## 소문')
    expect(edit(out, (d) => void (d.sections.public = ''))).toBe(longHint)
  })

  it('keeps the blank lines around the text, and a file that ends at its closing ---', () => {
    const spaced = TEMPLATE.replace('<!-- 누구나 아는 이야기 -->\n', '<!-- 누구나 아는 이야기 -->\n\n옛 글.\n\n')
    expect(edit(spaced, (d) => void (d.sections.public = '새 글.'))).toBe(spaced.replace('옛 글.', '새 글.'))
    expect(edit('---\nid: 허다솜\n---', (d) => void (d.sections.public = '슈터.'))).toBe('---\nid: 허다솜\n---\n## 공개\n슈터.\n')
    // Trailing spaces on the --- lines are still a settings block.
    expect(loaded(edit('--- \nid: 허다솜\n---  \n## 공개\n', (d) => void (d.settings.media = 'quiet'))).settings.media).toBe('quiet')
  })

  it('changes one list item without touching the others, their comments or keys the app doesn’t know', () => {
    const file = TEMPLATE.replace(
      'relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n',
      'relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n  - with: 강하늘     # 동창\n    type: friend\n    strength: 3\n    visibility: public\n    note: 중학교 동창\n  - with: 김온유\n    type: rival\n    strength: 2\n    visibility: rumor\n  - with: 허강\n    type: mentor\n    strength: 4\n    visibility: public\n',
    )
    const rels = () => loaded(file).settings.relationships as Record<string, unknown>[]
    expect(rels()[0]).toMatchObject({ note: '중학교 동창' })

    const stronger = edit(file, (d) => {
      const r = d.settings.relationships as Record<string, unknown>[]
      r[1]!.strength = 5
    })
    expect(changedLines(file, stronger)).toEqual(['    strength: 5'])

    const dropped = edit(file, (d) => {
      d.settings.relationships = (d.settings.relationships as unknown[]).filter((_, i) => i !== 1)
    })
    expect(dropped).toBe(file.replace('  - with: 김온유\n    type: rival\n    strength: 2\n    visibility: rumor\n', ''))

    const added = edit(file, (d) => {
      ;(d.settings.relationships as unknown[]).push({ with: '도은찬', type: 'family', strength: 5, visibility: 'secret' })
    })
    expect(added).toContain('    visibility: public\n  - with: 도은찬\n    type: family\n    strength: 5\n    visibility: secret\n  # - with: 이순신')
    expect(added).toContain('  - with: 강하늘     # 동창\n')
  })

  it('merges lists item by item, so a relationship added elsewhere survives', () => {
    const rel = (w: string, s: number) => `  - with: ${w}\n    type: friend\n    strength: ${s}\n    visibility: public\n`
    const withList = (items: string) => TEMPLATE.replace('relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n', `relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n${items}`)
    const base = loaded(withList(rel('강하늘', 3)))
    const mine = structuredClone(base)
    ;(mine.settings.relationships as Record<string, unknown>[])[0]!.strength = 5
    // Elsewhere: someone added 김온유.
    const added = withList(rel('강하늘', 3) + rel('김온유', 2))
    const merged = editLore(added, FILE, base, mine)
    if (!('text' in merged)) throw new Error('expected a merge')
    expect((loaded(merged.text).settings.relationships as { with: string; strength: number }[]).map((r) => [r.with, r.strength])).toEqual([
      ['강하늘', 5],
      ['김온유', 2],
    ])
    // Elsewhere: someone changed 강하늘 too, and added 김온유. A clash, and overwriting keeps 김온유.
    const both = withList(rel('강하늘', 4) + rel('김온유', 2))
    expect(editLore(both, FILE, base, mine)).toEqual({ conflicts: ['relationships'] })
    const over = editLore(both, FILE, base, mine, { overwrite: true })
    if (!('text' in over)) throw new Error('expected a save')
    expect((loaded(over.text).settings.relationships as { with: string; strength: number }[]).map((r) => [r.with, r.strength])).toEqual([
      ['강하늘', 5],
      ['김온유', 2],
    ])
  })

  it('keeps list comments with the right items, and edits nested values in place', () => {
    const file = TEMPLATE.replace(
      'relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n',
      'relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n  - with: 강하늘\n    type: friend\n    strength: 3\n    visibility: public\n  # 김온유는 라이벌\n  - with: 김온유\n    type: rival\n    strength: 2\n    visibility: rumor\n  - with: 허강   # 멘토 선배\n    type: mentor\n    strength: 4\n    visibility: public\n',
    ).replace(
      'hooks:               # 나만의 규칙 (선택)\n',
      'hooks:               # 나만의 규칙 (선택)\n  - when: rival_award\n    rival: 김온유   # 수상하면\n    mood:\n      rivalry: -15\n      stability: -30   # 크게\n',
    )
    // Removing 강하늘 leaves the comment above 김온유 where it is.
    const removed = edit(file, (d) => {
      d.settings.relationships = (d.settings.relationships as unknown[]).slice(1)
    })
    expect(removed).toContain('relationships:       # 쓰려면 아래 줄 앞의 # 를 지우세요\n  # 김온유는 라이벌\n  - with: 김온유')
    // Removing one and editing another: each comment stays with its own person.
    const both = edit(file, (d) => {
      const r = (d.settings.relationships as Record<string, unknown>[]).filter((x) => x.with !== '김온유')
      r[1]!.strength = 5
      d.settings.relationships = r
    })
    expect(both).toContain('  - with: 허강   # 멘토 선배\n    type: mentor\n    strength: 5\n')
    expect(both).not.toContain('# 김온유는 라이벌\n  - with: 허강')
    // A hook's rival cleared, and one mood part changed: the other lines and their comments stay.
    const hook = edit(file, (d) => {
      const h = (d.settings.hooks as Record<string, unknown>[])[0]!
      delete h.rival
      ;(h.mood as Record<string, number>).rivalry = -20
    })
    expect(hook).toContain('  - when: rival_award\n    mood:\n      rivalry: -20\n      stability: -30   # 크게\n')
  })

  it('adds to an oddly indented list, and saves other changes with it', () => {
    const odd = '---\nid: 허다솜\nrelationships:\n-   with: 강하늘\n    type: friend\n    strength: 3\n    visibility: public\n---\n'
    const out = edit(odd, (d) => {
      ;(d.settings.relationships as unknown[]).push({ with: '김온유', type: 'rival', strength: 2, visibility: 'rumor' })
      d.settings.canon = false
    })
    expect((loaded(out).settings.relationships as { with: string }[]).map((r) => r.with)).toEqual(['강하늘', '김온유'])
    expect(loaded(out).settings.canon).toBe(false)
  })

  it('treats an arrow in prose as text, and keeps new text off a setext heading', () => {
    const arrow = TEMPLATE.replace('<!-- 누구나 아는 이야기 -->\n', '<!-- 누구나 아는 이야기 -->\n1학년 --> 2학년 때 주전.\n')
    expect(loaded(edit(arrow, (d) => void (d.sections.public = '3학년 때 에이스.'))).sections.public).toBe('3학년 때 에이스.')
    const setext = '---\nid: 허다솜\n---\n공개\n----\n<!-- 힌트 -->\n소문\n----\n'
    const out = edit(setext, (d) => void (d.sections.public = '본문.'))
    expect(out).toBe('---\nid: 허다솜\n---\n공개\n----\n<!-- 힌트 -->\n본문.\n\n소문\n----\n')
  })

  it('leaves every other line’s ending alone in a file with mixed line endings', () => {
    const mixed = '---\r\nid: 허다솜\r\n---\r\n# 허다솜\n\n## 공개\r\n옛 글.\r\n\r\n## 소문\n소문.\n'
    const out = edit(mixed, (d) => void (d.sections.public = '새 글.'))
    expect(out).toBe(mixed.replace('옛 글.', '새 글.'))
  })
})
