import { describe, expect, it } from 'vitest'
import { defaultConfig } from '@shared/config/defaults'
import type { LeagueConfig } from '@shared/config/schema'
import {
  autoOverview,
  fallbackPlayStyle,
  firstSentence,
  numberRanges,
  positionLine,
  ratedColumns,
  roleOf,
  specialties,
  strengthsOf,
  styleHash,
  styleLines,
  type Role,
} from './playerPage'

/** A league rated the way 2K sheets write it: an OVR and nine graded categories, in English. */
function sheetConfig(): LeagueConfig {
  const config = defaultConfig()
  const grade = (id: string, name: string) => ({ id, name, kind: 'grade' as const, weight: 1 })
  config.ratings.columns = [
    { id: 'ovr', name: 'OVR', kind: 'number', min: 40, max: 99, weight: 1 },
    grade('ins', 'Inside Scoring'),
    grade('mid', 'Midrange'),
    grade('three', '3pt'),
    grade('ind', 'Inside D'),
    grade('perd', 'Perimeter D'),
    grade('play', 'Playmaking'),
    grade('reb', 'Rebound'),
    grade('ath', 'Athleticism'),
    grade('bq', 'BQ'),
  ]
  return config
}

const ratings = (o: Record<string, string>) => ({ ovr: 80, ins: 'B', mid: 'B', three: 'B', ind: 'B', perd: 'B', play: 'B', reb: 'B', ath: 'B', bq: 'B', ...o })
const ACE = { school: '가람고', position: '스몰 포워드', role: 'ace' as Role }
const style = (config: LeagueConfig, id: string, r: Record<string, unknown>, who = ACE) => fallbackPlayStyle(ratedColumns(config, r, numberRanges(config, [])), id, who)
/** Its sentences (the bold first line counts as one). */
const sentences = (text: string) => text.split(/(?<=\.(?:''')?)\s+/)

describe('the 플레이 스타일 a page shows until someone writes one', () => {
  const config = sheetConfig()
  const star = ratings({ ath: 'A+', three: 'A', mid: 'B+', ind: 'D' })

  it('reads like Namuwiki’s: who he is in bold, his weapon, one more side, his weakness, a closing line', () => {
    const text = style(config, 'p1', star)!
    const lines = sentences(text)
    // The identity line: his part on his school and what kind of player he is, in bold.
    expect(lines[0]).toMatch(/^'''가람고의 에이스이자 .+ 스몰 포워드\.'''$/)
    // The main weapon by its grade in words, the next best side, the weakness, a judgement.
    expect(lines[1]).toContain('운동 능력')
    expect(lines[1]).toContain('리그 최정상급')
    expect(lines[2]).toMatch(/^3점 슛(도| 역시) 최상급이다\.$/)
    expect(lines[3]).toMatch(/약점이라면 골밑 수비다|반면 골밑 수비는 약점으로 꼽힌다|다만 골밑 수비는 좋지 못하다/)
    expect(lines.at(-1)).toMatch(/^(종합적으로|정리하자면|한마디로) /)
    expect(lines.length).toBe(5)
    // Korean only: no grade letters, no English, no number, no list.
    expect(text).not.toMatch(/[A-Za-z]/)
    expect(text.replaceAll('3점', '')).not.toMatch(/\d/)
    expect(text).not.toMatch(/^\s*\*/m)
  })

  it('is the same every time for the same player, and worded differently across players', () => {
    expect(style(config, 'p1', star)).toBe(style(config, 'p1', star))
    const texts = new Set(Array.from({ length: 20 }, (_, i) => style(config, `p${i}`, star)))
    expect(texts.size).toBeGreaterThan(3)
  })

  it('says so when nothing stands out, and when nothing is weak', () => {
    const plain = style(config, 'p2', ratings({}), { ...ACE, role: 'starter' })!
    expect(sentences(plain)[0]).toBe("'''가람고의 주전 스몰 포워드.'''")
    expect(plain).toMatch(/눈에 띄는 무기는 아직 없지만, 골밑 득점은 준수한 편이다|특출난 장기는 없고, 굳이 꼽자면 골밑 득점이 가장 낫다/)
    expect(plain).toMatch(/뚜렷한 약점이 없는 것도 장점이다|약점이라 할 만한 부분이 딱히 없다/)
    expect(plain).toMatch(/확실한 무기가 필요한 선수다|성장이 더 필요하다는 평이다/)
    const allRound = style(config, 'p3', ratings({ ath: 'A', three: 'A-', ins: 'B+', mid: 'B+' }))!
    expect(allRound).toMatch(/뚜렷한 약점이 없는 것도 장점이다|약점이라 할 만한 부분이 딱히 없다/)
    expect(allRound).not.toMatch(/다만|반면|약점이라면/)
  })

  it('says a bench player is one, without calling him an ace', () => {
    const text = style(config, 'p4', star, { school: '가람고', position: '식스맨', role: 'bench' })!
    expect(sentences(text)[0]).toMatch(/^'''.+ 가람고의 식스맨\.'''$/)
    expect(text).not.toContain('에이스')
  })

  it('leaves out ratings it can’t name in Korean, and has nothing to say without ratings', () => {
    const odd = sheetConfig()
    odd.ratings.columns.push({ id: 'clutch', name: 'Clutch Factor', kind: 'grade', weight: 0 })
    expect(style(odd, 'p1', { ...star, clutch: 'A+' })).not.toContain('Clutch')
    expect(style(config, 'p1', { ovr: 80 })).toBeNull()
  })

  it('reads the overall apart, and number columns against the league’s range', () => {
    const numbers = defaultConfig()
    numbers.ratings.columns = [
      { id: 'ovr', name: 'OVR', kind: 'number', min: 0, max: 99, weight: 1 },
      { id: 'three', name: '3pt', kind: 'number', min: 0, max: 99, weight: 1 },
      { id: 'ath', name: 'Athleticism', kind: 'number', min: 0, max: 99, weight: 1 },
    ]
    const league = [{ ratings: { three: 60, ath: 60 } }, { ratings: { three: 90, ath: 90 } }]
    const rated = ratedColumns(numbers, { ovr: 75, three: 90, ath: 61 }, numberRanges(numbers, league))
    expect(rated.map((r) => [r.label, r.tier, r.word])).toEqual([
      ['3점 슛', 'elite', '리그 최정상급'],
      ['운동 능력', 'weak', '치명적 약점'],
    ])
    expect(strengthsOf(rated)).toMatchObject({ top: [{ label: '3점 슛' }], weak: { label: '운동 능력' } })
  })
})

describe('the infobox’s 포지션 and 특기', () => {
  const config = sheetConfig()
  config.roster.slots.push({ id: 'six', name: '6th Man', starter: false })
  const player = (id: string, teamId: string, slotId: string | null, ovr: number) => ({ id, teamId, slotId, ratings: { ovr } })

  it('name the lineup’s best his school’s ace, and a bench slot the bench', () => {
    const players = [player('a', 't1', 'pg', 80), player('b', 't1', 'sf', 88), player('c', 't1', 'six', 95), player('d', 't2', 'pg', 99)]
    expect(players.map((p) => roleOf(config, players, p))).toEqual(['starter', 'ace', 'bench', 'ace'])
  })

  it('count the best of a school as its lineup when its players have no slots', () => {
    const players = Array.from({ length: 7 }, (_, i) => player(`p${i}`, 't1', null, 70 + i))
    expect(players.map((p) => roleOf(config, players, p))).toEqual(['bench', 'bench', 'starter', 'starter', 'starter', 'starter', 'ace'])
  })

  it('write the position in Korean, the slot’s abbreviation once, and the ace after a slash', () => {
    expect(positionLine(config, 'sf', 'ace')).toBe("'''스몰 포워드(SF)''' / 에이스")
    expect(positionLine(config, 'pg', 'starter')).toBe("'''포인트 가드(PG)'''")
    expect(positionLine(config, 'six', 'bench')).toBe("'''식스맨'''")
    expect(positionLine(config, null, 'starter')).toBe('')
  })

  it('give his ratings of A- and up as 특기, the best two', () => {
    const rated = (o: Record<string, string>) => ratedColumns(config, ratings(o), numberRanges(config, []))
    expect(specialties(rated({ three: 'A-', ath: 'A+', bq: 'A' })).map((x) => x.label)).toEqual(['운동 능력', '농구 센스'])
    expect(specialties(rated({ three: 'A-', mid: 'B+' })).map((x) => x.label)).toEqual(['3점 슛'])
    expect(specialties(rated({}))).toEqual([])
  })
})

describe('the 개요 a page shows until someone writes one', () => {
  const team = { title: '가람고', name: '가람고등학교', short: '가람고' }

  it('opens with a noun phrase for his school, then his position, one line about him and his nicknames', () => {
    expect(
      autoOverview({ team, position: '스몰 포워드', starter: true, role: 'starter', nicknames: ['총알', '하람이'], lore: '빠른 발로 코트를 가른다. 부모님은 체육 교사다.' }),
    ).toBe("[[가람고|가람고등학교]] 농구부 소속의 농구 선수. 포지션은 스몰 포워드. 빠른 발로 코트를 가른다. 별명은 '''총알''', '하람이'.")
    // No lore: the ace is called one.
    expect(autoOverview({ team, position: '센터', starter: true, role: 'ace', nicknames: [], lore: '' })).toBe(
      '[[가람고|가람고등학교]] 농구부 소속의 농구 선수. 포지션은 센터. 가람고의 에이스다.',
    )
    // Off the bench, the slot is his part.
    expect(autoOverview({ team, position: '식스맨', starter: false, role: 'bench', nicknames: [], lore: '' })).toBe('[[가람고|가람고등학교]] 농구부 소속의 식스맨.')
    expect(autoOverview({ team: { title: '누리고', name: '누리고', short: '누리고' }, position: '', starter: true, role: 'starter', nicknames: [], lore: '' })).toBe(
      '[[누리고]] 농구부 소속의 농구 선수.',
    )
  })

  it('takes one sentence from the lore, list marks and all', () => {
    expect(firstSentence('\n - 3점이 주무기다. 수비는 약하다.')).toBe('3점이 주무기다.')
    expect(firstSentence('Mr. Kim의 제자다. 둘째 문장.')).toBe('Mr. Kim의 제자다.')
    expect(firstSentence('')).toBe('')
  })
})

describe('what an AI 플레이 스타일 is written from', () => {
  const config = sheetConfig()
  const lore = '어릴 때 이사를 왔다. 3점슛이 주무기다.\n부모님은 체육 교사다.'

  it('is his ratings and the sentences of his lore about how he plays', () => {
    expect(styleLines(lore)).toEqual(['3점슛이 주무기다.'])
    const base = styleHash(config, ratings({}), lore)
    expect(styleHash(config, ratings({}), lore)).toBe(base)
    // A rating changed, or a play sentence: written again.
    expect(styleHash(config, ratings({ ath: 'A' }), lore)).not.toBe(base)
    expect(styleHash(config, ratings({}), lore.replace('3점슛이 주무기다.', '돌파가 주무기다.'))).not.toBe(base)
    // His family, a new anecdote: not about how he plays.
    expect(styleHash(config, ratings({}), `${lore}\n여름에 할머니 댁에 간다.`)).toBe(base)
  })
})
