import { describe, expect, it } from 'vitest'
import { kindOf, parseLoreFile, playerNameOf, splitSections } from './parse'

// Made-up lore, shaped like the templates (comments, commented-out examples).
const player = `---
id: 허다솜
traits:              # 1 ~ 5
  ego: 4
  usage: 5
media: outspoken
relationships:
  # - with: 예시
  - with: 강하늘
    type: rival
    strength: 4
    visibility: public
hooks:
  - when: traded
    mood: { stability: -30 }
canon: true
---

# 허다솜

## 공개
<!-- 힌트 -->
3점슛이 장기.

## 소문
감독과 사이가 안 좋다는 말이 있다.

## 비밀
사실 이적을 원한다.
`

describe('lore files', () => {
  it('reads settings, fills defaults and splits sections', () => {
    const { entry, errors } = parseLoreFile('teams/가람고/허다솜.md', player)
    expect(errors).toEqual([])
    expect(entry?.kind).toBe('player')
    if (entry?.kind !== 'player') return
    expect(entry.team).toBe('가람고')
    expect(entry.settings.traits).toMatchObject({ ego: 4, usage: 5, loyalty: 3 })
    expect(entry.settings.relationships).toEqual([{ with: '강하늘', type: 'rival', strength: 4, visibility: 'public' }])
    expect(entry.settings.hooks[0]).toEqual({ when: 'traded', mood: { stability: -30 } })
    expect(entry.sections).toEqual({ public: '3점슛이 장기.', rumor: '감독과 사이가 안 좋다는 말이 있다.', secret: '사실 이적을 원한다.' })
  })

  it('accepts an untouched template: commented-out lists are empty', () => {
    const template = `---
id: 가람고
colors: ["#000000", "#ffffff"]
fans:
  size: 3
rivals:
  # - 누리고
canon: true
---

# 가람고

## 공개
<!-- 힌트 -->

## 소문

## 비밀
`
    const { entry, errors } = parseLoreFile('teams/가람고/가람고.md', template)
    expect(errors).toEqual([])
    expect(entry?.kind).toBe('team')
    if (entry?.kind === 'team') {
      expect(entry.settings.rivals).toEqual([])
      expect(entry.settings.fans).toEqual({ size: 3, temperament: 3, pride: 3 })
      expect(entry.sections).toEqual({ public: '', rumor: '', secret: '' })
    }
  })

  it('points errors at the right line', () => {
    const bad = player.replace('  usage: 5', '  usage: 9')
    const { entry, errors } = parseLoreFile('teams/가람고/허다솜.md', bad)
    expect(entry).toBeNull()
    expect(errors).toHaveLength(1)
    // Line 1 is ---, so "usage: 9" is file line 5.
    // A code and the setting's path for the screen to translate; the parser's own words stay as the detail.
    expect(errors[0]).toMatchObject({ file: 'teams/가람고/허다솜.md', line: 5, code: 'field', field: 'traits.usage' })
    expect(errors[0]!.message).not.toContain('traits.usage')
    expect(errors[0]!.message).not.toBe('')
  })

  it('reports broken YAML, a missing settings block and a file in the wrong place, each with its code', () => {
    const yaml = parseLoreFile('teams/가람고/허다솜.md', '---\nid: [oops\n---\n').errors[0]!
    expect(yaml.line).toBeGreaterThan(0)
    expect(yaml.code).toBe('yaml')
    expect(yaml.message).not.toBe('')
    expect(parseLoreFile('teams/가람고/허다솜.md', '# no settings').errors[0]).toMatchObject({ line: 1, code: 'no-settings' })
    expect(parseLoreFile('notes.md', '---\nid: x\n---\n').errors[0]).toMatchObject({ line: 0, code: 'not-in-folder' })
    // A problem with the block as a whole has an empty path.
    expect(parseLoreFile('teams/가람고/허다솜.md', '---\n- 목록\n---\n').errors[0]).toMatchObject({ code: 'field', field: '' })
  })

  it('knows each kind from where the file sits', () => {
    expect(kindOf('teams/가람고/가람고.md')).toEqual({ kind: 'team', team: '가람고' })
    expect(kindOf('teams/가람고/가람고 단장.md')).toEqual({ kind: 'gm', team: '가람고' })
    expect(kindOf('teams\\가람고\\허다솜.md')).toEqual({ kind: 'player', team: '가람고' })
    expect(kindOf('world/왕 논쟁.md')).toEqual({ kind: 'world', team: null })
    expect(kindOf('notes.md')).toBeNull()
    expect(playerNameOf('teams/누리고/김온유(가람고).md')).toEqual({ name: '김온유', originalTeam: '가람고' })
  })

  it('ignores the title and unknown headings', () => {
    expect(splitSections('# 제목\n\n## 공개\n가\n## 메모\n나\n## 비밀\n다')).toEqual({ public: '가', rumor: '', secret: '다' })
  })

  it('never lets secret text into 공개 or 소문, whatever the heading style', () => {
    const variants = [
      '## 공개\n가\n##비밀\n숨김',
      '## 공개\n가\n# 비밀\n숨김',
      '## 공개\n가\n   ## 비밀\n숨김',
      '## 공개\n가\n비밀\n---\n숨김',
      '## 공개\n가\n비밀\n===\n숨김',
      '## 공개\n가\n### 비밀 (아무도 모름) ###\n숨김',
      '## 공개\n가\n## 공개 아님, 비밀\n숨김',
      '## 소문\n가\n####비밀\n숨김',
    ]
    for (const v of variants) {
      const s = splitSections(v)
      expect(s.public + s.rumor, v).not.toContain('숨김')
      expect(s.secret, v).toBe('숨김')
    }
    // An unknown heading closes the section; a plain rule after a blank line is just a line.
    expect(splitSections('## 공개\n가\n# 메모\n나')).toEqual({ public: '가', rumor: '', secret: '' })
    expect(splitSections('## 공개\n가\n\n---\n나')).toEqual({ public: '가\n\n---\n나', rumor: '', secret: '' })
  })
})
