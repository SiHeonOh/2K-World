import { hash32, rng } from '@core/random'
import { peckingOrder, playerValue } from '@core/value'
import type { LeagueConfig } from '@shared/config/schema'
import {
  gradeWordAt,
  isKorean,
  nameKey,
  positionAbbr,
  positionName,
  ratingKind,
  ratingLabel,
  ratingProse,
  tierAt,
  type GradeTier,
  type GradeWord,
  type SkillKind,
} from '@shared/labels'
import type { RatingValue } from '@shared/setup'
import type { WikiRelation } from '@shared/wiki'
import { short, type League } from './context'
import { relationTarget } from './mood'
import { particle } from './wiki'

/**
 * What a player's wiki page shows that nobody wrote: his ratings in Korean
 * with their tiers and words (리그 최정상급 … 치명적 약점), the 플레이
 * 스타일 and 개요 the page shows while those sections are empty, and his
 * ties from lore for [인간관계]. Code only, from the league as it is now;
 * never stored, so it's no one's edit. The wording follows a study of
 * Namuwiki's basketball pages (an identity line, the main weapon, a weakness,
 * a closing judgement; grades in words, never letters).
 */

type Ratings = Record<string, unknown>

/** One of a player's ratings, ready to show or write about. */
export interface Rated {
  id: string
  /** Its Korean name (the column's own name when the dictionary doesn't know it). */
  label: string
  /** The column's own name, as the sheet has it. */
  source: string
  /** As shown: B+, or 85. */
  value: string
  grade: boolean
  tier: GradeTier
  /** The grade in words, as prose puts it. */
  word: GradeWord
  /** The side of the game it measures, when the dictionary knows the column. */
  kind: SkillKind | null
  /** What prose calls that side of the game (골밑 마무리, 림 어택…). */
  prose: string[]
  /** From the best (0) to the worst (1): a grade's place in the scale, a number's in the league's range. */
  r: number
}

/** Each number column's lowest and highest value in the league, to place a player's numbers among everyone's. */
export function numberRanges(config: LeagueConfig, players: readonly { ratings: Ratings }[]): Map<string, { min: number; max: number }> {
  const out = new Map<string, { min: number; max: number }>()
  for (const c of config.ratings.columns) {
    if (c.kind !== 'number') continue
    const values = players.map((p) => p.ratings[c.id]).filter((v): v is number => typeof v === 'number')
    out.set(c.id, values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: c.min, max: c.max })
  }
  return out
}

/** A player's ratings other than the overall one, best first, each with its tier and word. Columns he has no value for are left out. */
export function ratedColumns(config: LeagueConfig, ratings: Ratings, ranges: Map<string, { min: number; max: number }>): Rated[] {
  const scale = config.ratings.gradeScale
  const out: Rated[] = []
  for (const c of config.ratings.columns) {
    if (c.id === config.ratings.overallColumnId) continue
    const v = ratings[c.id]
    let r: number
    if (c.kind === 'grade') {
      const i = typeof v === 'string' ? scale.findIndex((g) => g.label === v) : -1
      if (i < 0) continue
      r = scale.length <= 1 ? 0 : i / (scale.length - 1)
    } else {
      if (typeof v !== 'number') continue
      const range = ranges.get(c.id) ?? { min: c.min, max: c.max }
      r = range.max === range.min ? 0.5 : 1 - (v - range.min) / (range.max - range.min)
    }
    out.push({ id: c.id, label: ratingLabel(c), source: c.name, value: String(v), grade: c.kind === 'grade', tier: tierAt(r), word: gradeWordAt(r), kind: ratingKind(c), prose: ratingProse(c), r })
  }
  // A stable sort: equal ratings stay in the sheet's order.
  return out.sort((a, b) => a.r - b.r)
}

/**
 * What a player is good and bad at, as the prose and the writers' facts name
 * it: his two best strong ratings (`top`), up to two more strong ones
 * (`more`), up to two solid ones, and his worst when it's average or weak.
 */
export function strengthsOf(rated: readonly Rated[]): { top: Rated[]; more: Rated[]; solid: Rated[]; weak: Rated | null } {
  const strong = rated.filter((x) => x.tier === 'elite' || x.tier === 'strong')
  const top = strong.slice(0, 2)
  const worst = [...rated].reverse().find((x) => !top.includes(x))
  const weak = worst && (worst.tier === 'weak' || worst.tier === 'average') ? worst : null
  return { top, more: strong.slice(2, 4), solid: rated.filter((x) => x.tier === 'solid' && x !== weak).slice(0, 2), weak }
}

/** 특기: his ratings of A- and up (the top fifth of the scale), the best two. */
export const specialties = (rated: readonly Rated[]) => rated.filter((x) => x.r <= 0.17).slice(0, 2)

/** A player's part on his school: its best by value (in the lineup), another starter, or off the bench. */
export type Role = 'ace' | 'starter' | 'bench'

type Rostered = { id: string; teamId: string; slotId: string | null; ratings: Ratings }

/**
 * His part on his school: a bench slot is the bench, a starter's slot the
 * lineup; with no slot, he starts when he's among his school's best (by the
 * value model, as many as the league starts). The lineup's best is its ace.
 */
export function roleOf(config: LeagueConfig, players: readonly Rostered[], p: Rostered): Role {
  const order = peckingOrder(
    players.filter((x) => x.teamId === p.teamId).map((x) => ({ id: x.id, teamId: x.teamId, slotId: x.slotId, value: playerValue(config, x.ratings as Record<string, RatingValue>) })),
  )
  const starters = config.roster.slots.filter((s) => s.starter).length || 5
  const starts = (x: { id: string; slotId: string | null }) => config.roster.slots.find((s) => s.id === x.slotId)?.starter ?? order.findIndex((o) => o.id === x.id) < starters
  if (!starts(p)) return 'bench'
  return order.find(starts)?.id === p.id ? 'ace' : 'starter'
}

/** His position as the infobox writes it: the Korean name in bold, the slot's abbreviation once, his part after a slash ("'''스몰 포워드(SF)''' / 에이스"). */
export function positionLine(config: LeagueConfig, slotId: string | null, role: Role): string {
  const slot = config.roster.slots.find((s) => s.id === slotId)
  if (!slot) return ''
  const abbr = positionAbbr(slot.name)
  return `'''${positionName(slot.name)}${abbr ? `(${abbr})` : ''}'''${role === 'ace' ? ' / 에이스' : ''}`
}

// ── The 플레이 스타일 the page shows while it has none ───────────────────

const josa = particle
/** "운동 능력이다", "리바운드다". */
const cop = (w: string) => `${w}${josa(w, '이다', '다')}`

/** A grade's word ending a sentence about it ("…은 리그 최정상급이다", "…는 준수한 편이다"). */
const SAID: Record<GradeWord, string> = {
  '리그 최정상급': '리그 최정상급이다',
  최상급: '최상급이다',
  상급: '상급으로 평가받는다',
  수준급: '수준급이다',
  준수: '준수한 편이다',
  '평균 이상': '평균 이상은 된다',
  무난: '무난한 편이다',
  평범: '평범한 편이다',
  아쉬움: '아쉬운 편이다',
  약점: '약점으로 꼽힌다',
  '치명적 약점': '치명적인 약점이다',
}
/** The same before a noun ("리그 최정상급의 운동 능력"). */
const BEFORE: Partial<Record<GradeWord, string>> = { '리그 최정상급': '리그 최정상급의', 최상급: '최상급', 상급: '상급', 수준급: '수준급' }

/** What a player's best side makes him, for his identity line. */
const TYPE: Record<SkillKind, string[]> = {
  shoot: ['외곽 슛이 장기인', '슛 하나는 확실한'],
  inside: ['골밑 마무리가 장기인', '림 어택에 능한'],
  play: ['경기 운영에 능한', '볼 핸들링이 장기인'],
  rim: ['림 프로텍팅이 장기인', '골밑을 지키는'],
  perimeter: ['대인 수비가 장기인', '앞선 수비에 능한'],
  board: ['리바운드에 강한', '제공권이 장기인'],
  body: ['운동 능력이 돋보이는', '탄력과 스피드를 갖춘'],
  mind: ['농구 센스가 돋보이는', '판단력이 좋은'],
}

type Pick = <T>(list: readonly T[]) => T

/** The bold first line: his part on his school and what kind of player he is. */
function identity(who: { school: string; position: string; role: Role }, lead: Rated | null, pick: Pick): string {
  const position = who.position || '선수'
  const of = who.school ? `${who.school}의 ` : ''
  const type = lead ? (lead.kind ? pick(TYPE[lead.kind]) : `${lead.label}${josa(lead.label, '이', '가')} 장기인`) : null
  if (who.role === 'ace') return type ? `${of}에이스이자 ${type} ${position}.` : `${of}에이스 ${position}.`
  if (who.role === 'starter') return type ? pick([`${type} ${of}${position}.`, `${of}주전이자 ${type} ${position}.`]) : `${of}주전 ${position}.`
  return type ? `${type} ${of}${position}.` : `${of}${position}.`
}

/**
 * The 플레이 스타일 a page shows until someone writes one, Namuwiki's shape
 * in small: a bold line saying who he is on his school (by his part and his
 * best side), his main weapon, one more solid side, his weakness, and a
 * closing judgement. Grades go in words (리그 최정상급, 약점…), never
 * letters, and there's no number. Worded per player so pages don't all read
 * alike, and the same each time for the same player and ratings (`seed`: his
 * id). Only ratings with a Korean name are named. Null when he has none.
 */
export function fallbackPlayStyle(rated: readonly Rated[], seed: string, who: { school: string; position: string; role: Role }): string | null {
  const named = rated.filter((x) => isKorean(x.label))
  if (named.length === 0) return null
  const random = rng(hash32(`style:${seed}`))
  const pick: Pick = (list) => list[Math.floor(random() * list.length)]!
  const { top, more, solid, weak: worst } = strengthsOf(named)
  const lead = top[0] ?? null
  // With nothing to lead with, the best he has is named instead: it isn't his weakness too.
  const best = lead ?? named[0]!
  const weak = worst && worst !== best ? worst : null
  const second = [...top.slice(1), ...more, ...solid].find((x) => x !== best && x !== weak) ?? null
  const out = [`'''${identity(who, lead, pick)}'''`]
  if (lead) {
    out.push(
      pick([
        `최대의 무기는 ${BEFORE[lead.word] ?? ''} ${cop(lead.label)}.`.replace(/는 {2}/, '는 '),
        `주특기는 ${lead.label}${josa(lead.label, '으로', '로')}, ${lead.word}${josa(lead.word, '이라는', '라는')} 평가를 받는다.`,
        `${lead.label}${josa(lead.label, '은', '는')} ${SAID[lead.word]}.`,
      ]),
    )
  } else {
    out.push(pick([`눈에 띄는 무기는 아직 없지만, ${best.label}${josa(best.label, '은', '는')} ${SAID[best.word]}.`, `특출난 장기는 없고, 굳이 꼽자면 ${best.label}${josa(best.label, '이', '가')} 가장 낫다.`]))
  }
  if (second) out.push(pick([`${second.label}도 ${SAID[second.word]}.`, `${second.label} 역시 ${SAID[second.word]}.`]))
  if (weak) {
    const bad = weak.tier === 'weak'
    out.push(
      bad
        ? pick([`약점이라면 ${cop(weak.label)}.`, `반면 ${weak.label}${josa(weak.label, '은', '는')} ${SAID[weak.word]}.`, `다만 ${weak.label}${josa(weak.label, '은', '는')} 좋지 못하다.`])
        : pick([`다만 ${weak.label}${josa(weak.label, '은', '는')} ${SAID[weak.word]}.`, `${weak.label}${josa(weak.label, '이', '가')} 상대적으로 아쉽다는 평이다.`]),
    )
  } else if (named.length >= 3) {
    out.push(pick(['뚜렷한 약점이 없는 것도 장점이다.', '약점이라 할 만한 부분이 딱히 없다.']))
  }
  const close = !lead
    ? ['정리하자면 아직 확실한 무기가 필요한 선수다.', '종합적으로 성장이 더 필요하다는 평이다.']
    : weak
      ? ['종합적으로 장단점이 뚜렷한 선수다.', '정리하자면 확실한 무기만큼 약점도 분명한 선수다.', `한마디로 ${lead.label}${josa(lead.label, '으로', '로')} 승부하는 선수다.`]
      : ['종합적으로 약점이 적은 완성형에 가깝다는 평이다.', '정리하자면 믿고 쓸 수 있는 선수다.', `한마디로 ${lead.label}${josa(lead.label, '이', '가')} 빛나는 선수다.`]
  out.push(pick(who.role === 'bench' ? [...close, '정리하자면 벤치에서 제 몫을 해 주는 자원이다.'] : close))
  return out.join(' ')
}

// ── The 개요 the page shows while it has none ────────────────────────────

/** The first sentence of a text's first line (list markers dropped), or ''. */
export function firstSentence(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*+>]|\d{1,2}[.)])\s+/, '').trim())
    .find((l) => l !== '')
  if (!line) return ''
  // A Korean sentence's end, so an abbreviation (Mr.) doesn't end one.
  const m = /^(.+?(?:[가-힣][.!?]|[!?]))(?=\s|$)/.exec(line)
  const sentence = m ? m[1]! : line
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence
}

/**
 * The 개요 a page shows until someone writes one, as Namuwiki opens a
 * player's page: a noun phrase for his school and part ("[[가람고|가람고등학교]]
 * 농구부 소속의 농구 선수. 포지션은 스몰 포워드."), one identity line (the
 * first sentence of his public lore, else "…의 에이스다." for the ace), and
 * his nicknames, the first in bold.
 */
export function autoOverview(o: {
  team: { title: string; name: string; short: string } | null
  position: string
  starter: boolean
  role: Role | null
  nicknames: readonly string[]
  lore: string
}): string {
  const school = o.team ? (o.team.name && o.team.name !== o.team.title ? `[[${o.team.title}|${o.team.name}]]` : `[[${o.team.title}]]`) : ''
  // Off the bench the slot is his part (식스맨, 벤치 멤버); in the lineup it's his position.
  const what = o.starter || !o.position ? '농구 선수' : o.position
  const head = school ? `${school} 농구부 소속의 ${what}.` : `${what}.`
  const position = o.starter && o.position ? `포지션은 ${o.position}.` : ''
  const line = firstSentence(o.lore) || (o.role === 'ace' && o.team ? `${o.team.short}의 에이스다.` : '')
  const [first, ...rest] = o.nicknames
  const nick = first ? `별명은 '''${first}'''${rest.length ? `, ${rest.slice(0, 2).map((n) => `'${n}'`).join(', ')}` : ''}.` : ''
  return [head, position, line, nick].filter(Boolean).join(' ')
}

// ── [인간관계] ───────────────────────────────────────────────────────────

/** A tie in a word, by its kind and strength (1–5): 절친, 숙적, 껄끄러운 사이… */
const TIES: Record<string, (strength: number) => string> = {
  friend: (s) => (s >= 4 ? '절친' : '친구'),
  rival: (s) => (s >= 5 ? '숙적' : '라이벌'),
  family: () => '가족',
  mentor: () => '멘토',
  dislikes: (s) => (s >= 4 ? '악연' : '껄끄러운 사이'),
}

/**
 * A player's ties for [인간관계]: his own lore's first, then those other
 * players' lore has with him. A public one is said as fact (라이벌), a
 * rumoured one as a rumour (라이벌이라는 소문이 있다); a secret one never
 * shows, from either side.
 */
export function relationsOf(league: League, playerId: string, titles: ReadonlyMap<string, string>): WikiRelation[] {
  const out: WikiRelation[] = []
  const seen = new Set<string>()
  const add = (otherId: string | null, name: string, type: string, strength: number, visibility: string) => {
    if (visibility !== 'public' && visibility !== 'rumor') return
    if (otherId === playerId) return
    const key = otherId ?? `name:${nameKey(name)}`
    if (seen.has(key)) return
    seen.add(key)
    const other = otherId ? league.players.get(otherId) : undefined
    const word = TIES[type]?.(strength) ?? type
    out.push({
      name: other?.name ?? name.trim(),
      link: otherId ? (titles.get(otherId) ?? null) : null,
      team: other ? short(league, other.teamId) : null,
      kind: type,
      text: visibility === 'rumor' ? `${word}${josa(word, '이라는', '라는')} 소문이 있다` : word,
      rumor: visibility === 'rumor',
    })
  }
  const mine = league.lore.player.get(playerId)
  if (mine?.kind === 'player') for (const r of mine.settings.relationships) add(relationTarget(league, r.with), r.with, r.type, r.strength, r.visibility)
  for (const [id, entry] of league.lore.player) {
    if (id === playerId || entry.kind !== 'player') continue
    for (const r of entry.settings.relationships) {
      if (relationTarget(league, r.with) === playerId) add(id, league.players.get(id)?.name ?? id, r.type, r.strength, r.visibility)
    }
  }
  return out
}

// ── What an AI 플레이 스타일 is written from ─────────────────────────────

/** Words that make a lore sentence about how he plays. */
const PLAY_WORDS =
  /슛|슈팅|슈터|3점|삼점|미드레인지|중거리|레이업|덩크|돌파|드리블|핸들링|패스|어시스트|시야|리딩|플레이|수비|디펜스|리바운드|블록|블락|스틸|포스트|골밑|인사이드|외곽|운동능력|운동 능력|스피드|빠르|속공|점프|탄력|체력|피지컬|몸싸움|높이|득점|공격|포지션|가드|포워드|센터|빅맨|클러치|자유투|턴오버|실책|약점|강점|장점|단점|에이스|농구 ?IQ|센스|스타일|주전|식스맨|벤치/

/** The sentences of a player's public lore that say how he plays (what a rewrite of his 플레이 스타일 follows). */
export function styleLines(publicText: string): string[] {
  return publicText
    .split(/\r?\n|(?<=[다요]\.|[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '' && PLAY_WORDS.test(s))
}

/**
 * What a player's AI-written 플레이 스타일 is written from, as a short hash:
 * his ratings and the play sentences of his public lore. When either
 * changes, the page is written again (a new season's numbers don't count).
 */
export function styleHash(config: LeagueConfig, ratings: Ratings, publicText: string): string {
  const values = config.ratings.columns.map((c) => [c.id, ratings[c.id] ?? null])
  return hash32(JSON.stringify([values, styleLines(publicText)])).toString(36)
}
