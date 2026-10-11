/**
 * Matching the English names a 2K box score shows ("H. Hu") to a team's
 * Korean roster. Learned matches come first; then a roster name written
 * exactly as 2K shows it; then surname + first-initial guesses (Korean
 * romanization for Korean names, a sound key for foreign names written in
 * Hangul, the letters for names written in Latin letters), placed for every
 * row at once, leaving open any that another placing fits about as well;
 * then elimination when one is left. Anything still open goes to the
 * confirm screen, where guesses must be ticked before they're remembered.
 */
import { englishKeys, englishStarts, hangulKey, hangulStart, keysMatch } from './phonetic'

export interface RosterEntry {
  id: string
  name: string
}

/** A confirmed match, remembered per team. `rowOrder` tells same-name players apart. */
export interface LearnedName {
  source: string
  playerId: string
  rowOrder: number | null
}

export interface BoxRowName {
  /** 0-based position of the row in this team's box score. */
  row: number
  source: string
}

export type { MatchHow } from '@shared/gameday'
import type { MatchHow } from '@shared/gameday'

export interface NameMatch {
  row: number
  source: string
  playerId: string | null
  how: MatchHow
  /** Other plausible players, best first, for the confirm screen. */
  candidates: string[]
}

export const normalizeSource = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

// ── Romanization ─────────────────────────────────────────────────────────

/** Common spellings of Korean surnames, including less usual ones players pick. */
const SURNAMES: Record<string, string[]> = {
  김: ['kim', 'gim'], 이: ['lee', 'yi', 'rhee', 'i', 'li'], 박: ['park', 'bak', 'pak'], 최: ['choi', 'choe'],
  정: ['jung', 'jeong', 'chung'], 강: ['kang', 'gang'], 조: ['cho', 'jo'], 윤: ['yoon', 'yun'], 장: ['jang', 'chang'],
  임: ['lim', 'im', 'rim'], 한: ['han'], 오: ['oh', 'o'], 서: ['seo', 'suh', 'so'], 신: ['shin', 'sin'], 권: ['kwon', 'gwon'],
  황: ['hwang'], 안: ['ahn', 'an'], 송: ['song'], 류: ['ryu', 'yoo', 'yu', 'ryoo'], 유: ['yoo', 'yu', 'you'],
  전: ['jeon', 'jun', 'chun'], 홍: ['hong'], 고: ['ko', 'go'], 문: ['moon', 'mun'], 양: ['yang'], 손: ['son', 'sohn'],
  배: ['bae', 'pae'], 백: ['baek', 'paik', 'baik'], 허: ['heo', 'hur', 'huh', 'hu', 'her'], 남: ['nam'], 심: ['shim', 'sim'],
  노: ['noh', 'no', 'roh', 'ro'], 하: ['ha'], 곽: ['kwak', 'gwak'], 성: ['sung', 'seong'], 차: ['cha'], 주: ['joo', 'ju', 'chu'],
  우: ['woo', 'u'], 구: ['koo', 'gu', 'ku'], 민: ['min'], 나: ['na', 'ra'], 진: ['jin', 'chin'], 지: ['ji', 'chi'],
  엄: ['eom', 'um', 'uhm'], 채: ['chae'], 원: ['won'], 천: ['cheon', 'chun'], 방: ['bang'], 공: ['kong', 'gong'],
  현: ['hyun', 'hyeon'], 함: ['ham'], 변: ['byun', 'byeon'], 염: ['yeom', 'yum'], 여: ['yeo', 'yuh'], 추: ['choo', 'chu'],
  도: ['do', 'doh'], 소: ['so'], 석: ['seok', 'suk'], 선: ['sun', 'seon'], 설: ['seol', 'sul', 'sol'], 마: ['ma'], 길: ['gil', 'kil'],
  연: ['yeon', 'yun'], 위: ['wi', 'wee'], 표: ['pyo'], 명: ['myung', 'myeong'], 기: ['ki', 'gi'], 반: ['ban'], 라: ['ra', 'la'],
  왕: ['wang'], 금: ['keum', 'geum', 'kum'], 옥: ['ok'], 육: ['yook', 'yuk'], 인: ['in'], 맹: ['maeng'], 제: ['je'], 모: ['mo'],
  탁: ['tak'], 국: ['kook', 'guk'], 어: ['eo', 'uh'], 은: ['eun'], 편: ['pyeon', 'pyun'], 용: ['yong'], 예: ['ye', 'yae'],
  경: ['kyung', 'gyeong'], 봉: ['bong'], 사: ['sa'], 부: ['boo', 'bu'], 가: ['ka', 'ga'], 범: ['bum', 'beom'],
  남궁: ['namgung', 'namkung'], 황보: ['hwangbo'], 제갈: ['jegal'], 선우: ['sunwoo', 'seonu'], 독고: ['dokgo'], 사공: ['sagong'],
}
const COMPOUND = Object.keys(SURNAMES).filter((s) => s.length === 2)

const INITIALS: string[][] = [
  ['g', 'k'], ['k', 'g'], ['n'], ['d', 't'], ['d', 't'], ['r', 'l'], ['m'], ['b', 'p'], ['b', 'p'], ['s'], ['s'],
  [], ['j', 'c'], ['j'], ['c'], ['k'], ['t'], ['p'], ['h'],
]
/** Letters a syllable starting with ㅇ may romanize to, by vowel. */
const VOWEL_LETTERS: string[][] = [
  ['a'], ['a', 'e'], ['y'], ['y'], ['e', 'o'], ['e'], ['y'], ['y'], ['o'], ['w'], ['w'], ['o', 'w'], ['y'], ['u', 'w', 'o'],
  ['w'], ['w'], ['w'], ['y'], ['e', 'u'], ['u', 'e'], ['i', 'y', 'e'],
]

/** First letters a Korean syllable could be written with (e.g. 하 → h; 윤 → y). */
export function initialLetters(syllable: string): string[] {
  const code = syllable.charCodeAt(0) - 0xac00
  if (code < 0 || code > 11171) return [syllable[0]?.toLowerCase() ?? '']
  const initial = Math.floor(code / 588)
  const vowel = Math.floor((code % 588) / 28)
  return initial === 11 ? (VOWEL_LETTERS[vowel] ?? []) : (INITIALS[initial] ?? [])
}

/** Splits a Korean name into surname and given name; foreign names split on the last space. */
export function splitKoreanName(name: string): { surname: string; given: string; foreign: boolean } {
  const n = name.trim()
  if (n.includes(' ')) {
    const parts = n.split(/\s+/)
    return { surname: parts[parts.length - 1]!, given: parts.slice(0, -1).join(' '), foreign: true }
  }
  const compound = COMPOUND.find((c) => n.startsWith(c) && n.length > 2)
  const surname = compound ?? n.slice(0, 1)
  return { surname, given: n.slice(surname.length), foreign: false }
}

/** "H. Hu" → { initial: 'h', surname: 'hu' }; "Hu" → { surname: 'hu' }. */
export function parseSource(source: string): { initial: string | null; surname: string } {
  const s = normalizeSource(source).replace(/[^a-z.\s'-]/g, '')
  const m = s.match(/^([a-z])\.?\s+(.+)$/)
  if (m) return { initial: m[1]!, surname: m[2]!.replace(/[.\s'-]/g, '') }
  const parts = s.split(/\s+/)
  if (parts.length > 1) return { initial: parts[0]![0] ?? null, surname: parts[parts.length - 1]!.replace(/[.'-]/g, '') }
  return { initial: null, surname: s.replace(/[.'-]/g, '') }
}

/** Compares names as written: case, spaces, dots, apostrophes and hyphens don't count ("L. James" = "l james"). */
export const exactKey = (s: string) => normalizeSource(s).replace(/[.\s'’-]/g, '')

const HANGUL = /[가-힣]/

/**
 * How well a box-score name fits a roster name: 0 = no, 1 = plausible (only
 * listed first), 2 = surname, 3 = surname + initial. Korean names go by the
 * romanization table; foreign names written in Hangul ("애런 크로포드") by
 * a sound key of the surname (the last word), where a near miss ("르끌레르"
 * for Leclerc) needs the initial to fit too, and a sound heard the less usual
 * way costs half a point; names in Latin letters by their letters ("LeBron
 * James" for "L. James").
 */
export function fitScore(source: string, korean: string): number {
  const { initial, surname } = parseSource(source)
  if (!HANGUL.test(korean)) return latinFit(initial, surname, korean)
  const k = splitKoreanName(korean)
  if (k.foreign) return foreignFit(initial, surname, k)
  const spellings = SURNAMES[k.surname] ?? []
  if (!spellings.includes(surname)) return 0
  if (initial === null) return 2
  const first = k.given.slice(0, 1)
  return first && initialLetters(first).includes(initial) ? 3 : 1
}

/**
 * A foreign name written in Hangul: the surname by sound, the given name's
 * first sound against the initial. A surname that fits only as it's less
 * often heard ("Rose" as 로스, not 로즈) scores half a point less.
 */
function foreignFit(initial: string | null, surname: string, k: { surname: string; given: string }): number {
  const b = hangulKey(k.surname)
  const first = k.given.trim().slice(0, 1)
  const start = hangulStart(first)
  // A given name kept in Latin letters ("PJ 터커", "OG 아누노비") goes by its letter.
  const fits = initial !== null && (/[a-z]/i.test(first) ? first.toLowerCase() === initial : start !== null && englishStarts(initial).includes(start))
  let best = 0
  for (const { key: a, cost } of englishKeys(surname)) {
    const how = keysMatch(a, b)
    if (how === null) continue
    // A one-sound surname (안 for Ahn) says little alone: it needs the initial.
    const short = Math.max(a.length, b.length) <= 1
    const score = initial === null ? (how === 'same' && !short ? 2 : 1) : how === 'same' ? (fits ? 3 : 1) : fits ? 2 : 1
    best = Math.max(best, score - cost)
  }
  return best
}

/** A name written in Latin letters ("LeBron James", "L. James"): surname letters, then the initial. */
function latinFit(initial: string | null, surname: string, name: string): number {
  const roster = parseSource(name)
  if (roster.surname === '' || roster.surname !== surname) return 0
  if (initial === null || roster.initial === null) return 2
  return roster.initial === initial ? 3 : 1
}

/**
 * A 2K-style English name for a Korean name ("H. Heo"), or null for names
 * that aren't Korean-style. Used by the stand-in reader for demos and tests.
 */
export function englishStyleName(korean: string): string | null {
  const k = splitKoreanName(korean)
  if (k.foreign || k.given === '') return null
  const surname = SURNAMES[k.surname]?.[0]
  const initial = initialLetters(k.given.slice(0, 1))[0]
  if (!surname || !initial) return null
  return `${initial.toUpperCase()}. ${surname[0]!.toUpperCase()}${surname.slice(1)}`
}

const RR_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h']
const RR_VOWELS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i']
const RR_FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't']

/**
 * A plain Revised Romanization of Korean text ("가람고" → "garamgo"), syllable
 * by syllable, without sound changes. Anything that isn't Hangul passes through.
 */
export function romanize(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFC')) {
    const code = ch.charCodeAt(0) - 0xac00
    if (code < 0 || code > 11171) {
      out += ch
      continue
    }
    out += RR_INITIALS[Math.floor(code / 588)]! + RR_VOWELS[Math.floor((code % 588) / 28)]! + RR_FINALS[code % 28]!
  }
  return out
}

/** Compares team labels: case, spaces and punctuation don't count. */
const labelKey = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s.\-_'"·]/g, '')

/** School-style endings 2K team names usually leave out ("가람고" is "Garam" in 2K). */
const TEAM_SUFFIXES = ['고등학교', '중학교', '대학교', '고교', '고', '중', '대']

/**
 * Whether a team label from a screenshot ("GARAM", "가람고") names this team:
 * its full or short name as written, romanized, or romanized without a
 * school ending.
 */
export function labelNamesTeam(label: string, teamNames: readonly string[]): boolean {
  const key = labelKey(label)
  if (key === '') return false
  return teamNames.some((n) => {
    const name = n.trim()
    const suffix = TEAM_SUFFIXES.find((s) => name.endsWith(s) && name.length - s.length >= 2)
    const forms = [name, romanize(name), ...(suffix ? [romanize(name.slice(0, -suffix.length))] : [])]
    return forms.some((f) => labelKey(f) === key)
  })
}

// ── Matching ─────────────────────────────────────────────────────────────

export function matchNames(rows: readonly BoxRowName[], roster: readonly RosterEntry[], learned: readonly LearnedName[]): NameMatch[] {
  const onRoster = new Set(roster.map((p) => p.id))
  const out = new Map<number, NameMatch>()
  const taken = new Set<string>()

  // 1. Learned names. Same-name rows are paired with learned entries in row
  // order. Row order can change from game to game, so a name that more than
  // one player goes by (learned, or on two rows here) is a 'same-name' match:
  // the confirm screen shows it as a warning, never as a plain learned one.
  const bySource = new Map<string, BoxRowName[]>()
  for (const r of rows) bySource.set(normalizeSource(r.source), [...(bySource.get(normalizeSource(r.source)) ?? []), r])
  for (const [source, group] of bySource) {
    const known = learned
      .filter((l) => normalizeSource(l.source) === source && onRoster.has(l.playerId))
      .filter((l, i, all) => all.findIndex((x) => x.playerId === l.playerId) === i)
      .sort((a, b) => (a.rowOrder ?? 0) - (b.rowOrder ?? 0))
    const sameName = known.length > 1 || group.length > 1
    const sortedRows = [...group].sort((a, b) => a.row - b.row)
    const pairs: [BoxRowName, LearnedName][] = []
    if (known.length <= sortedRows.length) {
      known.forEach((l, i) => pairs.push([sortedRows[i]!, l]))
    } else {
      // Fewer rows than players with this name (someone didn't play): each row takes the nearest learned row.
      const left = [...known]
      for (const r of sortedRows) {
        left.sort((a, b) => Math.abs((a.rowOrder ?? 0) - r.row) - Math.abs((b.rowOrder ?? 0) - r.row))
        pairs.push([r, left.shift()!])
      }
    }
    for (const [r, l] of pairs) {
      if (taken.has(l.playerId)) continue
      const others = sameName ? known.map((k) => k.playerId).filter((id) => id !== l.playerId) : []
      out.set(r.row, { row: r.row, source: r.source, playerId: l.playerId, how: sameName ? 'same-name' : 'learned', candidates: others })
      taken.add(l.playerId)
    }
  }

  // 2. A roster name written exactly as 2K shows it ("L. James"), when only one player is.
  for (const r of rows) {
    if (out.has(r.row)) continue
    const same = roster.filter((p) => !taken.has(p.id) && exactKey(p.name) === exactKey(r.source))
    if (same.length !== 1 || exactKey(r.source) === '') continue
    out.set(r.row, { row: r.row, source: r.source, playerId: same[0]!.id, how: 'exact', candidates: [] })
    taken.add(same[0]!.id)
  }

  // 3. Guesses by surname and initial, for all open rows and free players together: the
  // pairing that fits best overall, each pair kept only when it clearly beats every other
  // way to place that row and that player. Taking rows one by one in order could hand a
  // later row's player to an earlier one ("D. Rose" taking 루이스 before "D. Lewis" got there).
  const open = rows.filter((r) => !out.has(r.row))
  const free = roster.filter((p) => !taken.has(p.id))
  const scores = open.map((r) => free.map((p) => fitScore(r.source, p.name)))
  for (const [r, p] of confidentPairs(scores.map((line) => line.map((s) => (s >= GUESS ? s : 0))))) {
    out.set(open[r]!.row, { row: open[r]!.row, source: open[r]!.source, playerId: free[p]!.id, how: 'guess', candidates: [] })
    taken.add(free[p]!.id)
  }
  open.forEach((r, i) => {
    if (out.has(r.row)) return
    const plausible = free
      .map((p, j) => ({ id: p.id, score: scores[i]![j]! }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
    out.set(r.row, { row: r.row, source: r.source, playerId: null, how: 'none', candidates: plausible.map((s) => s.id) })
  })

  // 4. One row and one player left: they go together.
  const left = [...out.values()].filter((m) => m.playerId === null)
  const unplaced = roster.filter((p) => !taken.has(p.id))
  if (left.length === 1 && unplaced.length === 1) {
    left[0]!.playerId = unplaced[0]!.id
    left[0]!.how = 'elimination'
    left[0]!.candidates = []
  }
  // Candidates for the rest: plausible ones first, then everyone still free.
  for (const m of out.values()) {
    if (m.playerId !== null) continue
    m.candidates = [...m.candidates.filter((id) => !taken.has(id)), ...unplaced.map((p) => p.id).filter((id) => !m.candidates.includes(id))]
  }
  return rows.map((r) => out.get(r.row)!)
}

/** The least a fit must score to be guessed: the surname at least. */
const GUESS = 2
/** How much better a guess must fit than the best way of placing its row and player otherwise. */
const MARGIN = 1

/**
 * The pairs of the best overall assignment (rows to players, by score; 0 is
 * no fit) that it clearly needs: placing that row and that player any other
 * way loses at least MARGIN in total. Pairs another pairing does as well or
 * nearly as well with are left out, for the confirm screen to ask.
 */
export function confidentPairs(scores: readonly (readonly number[])[]): [row: number, player: number][] {
  const best = bestAssignment(scores)
  const out: [number, number][] = []
  for (const [r, p] of best.pairs) {
    if (scores[r]![p]! <= 0) continue
    const without = bestAssignment(scores.map((line, i) => (i === r ? line.map((s, j) => (j === p ? 0 : s)) : line)))
    if (best.total - without.total >= MARGIN) out.push([r, p])
  }
  return out
}

/**
 * The assignment of rows to players (each at most once) with the highest
 * total score: the Hungarian method on the scores made square with zeros,
 * so a row may go unplaced. Teams are small (a dozen or so a side).
 */
export function bestAssignment(scores: readonly (readonly number[])[]): { total: number; pairs: [row: number, player: number][] } {
  const rows = scores.length
  const cols = Math.max(0, ...scores.map((l) => l.length))
  const n = Math.max(rows, cols)
  if (n === 0) return { total: 0, pairs: [] }
  const top = Math.max(0, ...scores.flat())
  // Minimising cost = top - score; 1-based, as the method is usually written (index 0 is a sentinel).
  const cost = (i: number, j: number) => top - (scores[i - 1]?.[j - 1] ?? 0)
  const at = (a: number[], k: number) => a[k] ?? 0
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(n + 1).fill(0)
  /** Column j → the row it's given to (0: none yet). */
  const match = new Array<number>(n + 1).fill(0)
  const way = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    match[0] = i
    let j0 = 0
    const minv = new Array<number>(n + 1).fill(Infinity)
    const used = new Array<boolean>(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = at(match, j0)
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost(i0, j) - at(u, i0) - at(v, j)
        if (cur < at(minv, j)) {
          minv[j] = cur
          way[j] = j0
        }
        if (at(minv, j) < delta) {
          delta = at(minv, j)
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          const row = at(match, j)
          u[row] = at(u, row) + delta
          v[j] = at(v, j) - delta
        } else minv[j] = at(minv, j) - delta
      }
      j0 = j1
    } while (at(match, j0) !== 0)
    do {
      const j1 = at(way, j0)
      match[j0] = at(match, j1)
      j0 = j1
    } while (j0 !== 0)
  }
  const pairs: [number, number][] = []
  let total = 0
  for (let j = 1; j <= n; j++) {
    const i = at(match, j)
    // Padding (a row or player that isn't there) means unplaced.
    if (i < 1 || i > rows || j > (scores[i - 1]?.length ?? 0)) continue
    pairs.push([i - 1, j - 1])
    total += scores[i - 1]![j - 1]!
  }
  return { total, pairs: pairs.sort((a, b) => a[0] - b[0]) }
}
