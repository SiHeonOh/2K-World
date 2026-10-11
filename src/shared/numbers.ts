/**
 * Numbers in text, read the way the check on AI text reads them
 * (src/story/numbers.ts) and the way the screens mark them, so a number marked
 * on screen is exactly one the check counted.
 *
 * Digits glued to Korean count (3연승, 31득점, 2위), a score is two numbers
 * (155:115), and 22.0, 1,234, .750, 49% and 32.3%p (a gap between two
 * shares) are one each. Digits that aren't a
 * number anyone would check are skipped: 토론 replies (#3), the game's name
 * (2K26), revision and persona ids (r12, f012), years (2026 시즌) and dates
 * (10/3 경기), times (19:30 경기, 10시, 5초), ages and school years (18세,
 * 고3), heights and weights (190cm, 80kg), positions (3번 자리, 3번, 4번),
 * zone defences (2-3 지역방어), view counts (조회수 1,234), basketball
 * idioms (3점슛, 4쿼터, 3대3, 50-50 볼, "100%", "1000%"), and round
 * thresholds (30점대, 20점 넘게).
 */

export interface NumberToken {
  /** As written: digits, thousands commas, a decimal point. */
  raw: string
  value: number
  /** Digits after the decimal point: the precision it was written to. */
  decimals: number
  /** Followed by % (or 퍼센트, 프로): a share, which may be worked out as a ratio. */
  percent: boolean
  /**
   * The count glued to it (점, 리바, 연승…), % for a share, %p for a gap
   * between two shares (32.3%p, 6.7퍼센트포인트), '' for none: what tells
   * 41점 from 41위.
   */
  unit: string
  start: number
  end: number
  /** Where the number and its unit end. */
  stop: number
}

// A win rate is written with no leading zero too (승률 .750): three digits after a lone point.
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<![\w.,])\.\d{3}(?!\d)/g
const DAY = '(?:3[01]|[12]\\d|0?[1-9])'
const MONTH = '(?:1[0-2]|0?[1-9])'
const HOUR = '(?:[01]?\\d|2[0-3])'

/** Spans whose digits are skipped. */
const MASKS: readonly RegExp[] = [
  // 토론 replies (#3), colours in markup (#ff0000), shirt numbers.
  /#[0-9A-Za-z_]+/g,
  // The game itself: 2K, 2K26.
  /(?<!\d)2[kK]\d{0,2}(?!\d)/g,
  // Wiki revisions and reporters (r12, r01), fans (f012).
  /(?<![A-Za-z])[rf]\d+(?![A-Za-z\d])/g,
  // Namumark text sizes: {{{+1 …}}}.
  /\{\{\{[+-]\d/g,
  // Years, when they read as one (2026 시즌, 2026-27 시즌, 2026 정규시즌; 2026년 is a date): 통산 2010점 is a number.
  /(?<![\d.,])(?:19|20)\d{2}(?:\s*[-–~/]\s*(?:19|20)?\d{2}(?!\d))?(?=\s*(?:년|시즌|학년도|정규\s*시즌))/g,
  // Dates: 2026-10-03, 2026.10.3; 10/3 경기, 10.3 일정, 10/3(토), 토요일 10/3.
  new RegExp(`(?<![\\d.,])(?:19|20)\\d{2}\\s*([-./])\\s*${MONTH}\\s*\\1\\s*${DAY}(?!\\d)`, 'g'),
  new RegExp(`(?<![\\d.,/])${MONTH}\\s*[./]\\s*${DAY}(?![\\d.,/])(?=\\s+(?:경기|일정)|\\s*\\(\\s*[월화수목금토일]\\s*\\))`, 'g'),
  new RegExp(`(?<=[월화수목금토일]요일\\s*)${MONTH}\\s*[./]\\s*${DAY}(?![\\d.,/])`, 'g'),
  // Times: 오후 7:30, 19:30 경기.
  new RegExp(`(?:오전|오후|저녁|밤|아침|낮)\\s*${HOUR}:[0-5]\\d(?!\\d)`, 'g'),
  new RegExp(`(?<![\\d:.])${HOUR}:[0-5]\\d(?![\\d:])(?=\\s*(?:에|경기|시작|팁오프|부터))`, 'g'),
  // School years: 고3, 중2.
  /(?<![가-힣])[고중][1-3](?!\d)/g,
  // Game formats: 3대3, 1on1, 5vs5.
  /(?<!\d)[1-5]\s*(?:대|on|vs)\s*[1-5](?!\d)/gi,
  // A three (or two) as a kind of shot, not points scored: 3점슛, 3점 라인, 2점 야투.
  /(?<![\d.])[23]\s*점\s*(?=슛|포|라인|플레이|슈터|슈팅|야투|성공|시도|짜리|률|율)/g,
  /(?<!\d)3(?:P[TAM%]?|&D|-and-D)(?![A-Za-z])/g,
  // Quarters.
  /(?<!\d)[1-4]\s*(?:쿼터|Q)(?![A-Za-z])/g,
  // "100%" as in "for sure", and a 50-50 ball.
  /(?<![\d.])100\s*(?:%|퍼센트|프로|퍼)/g,
  /(?<![\d.])50\s*[-:대]\s*50(?![\d.])/g,
  // Positions (1번 to 5번): 3번(스몰포워드), 4번 포지션, 2번 가드, "3번, 4번 다 본다". A shirt number (23번) is a number.
  /(?<![\d.])[1-5]\s*번(?=\s*(?:포지션|자리|가드|포워드|센터|역할|롤|\(|부터|까지|[,/·]?\s*[1-5]\s*번(?!\s*째)))/g,
  /(?<=(?:^|[^\d.])[1-5]\s*번\s*[,/·]?\s*)[1-5]\s*번(?!\s*째)/g,
  // Zone defences: 2-3 지역방어, 3-2 존, 1-3-1 드롭존, 2:3 수비.
  /(?<![\d.:])[1-3](?:\s*[-:]\s*[1-3]){1,2}(?![\d.:])(?=\s*(?:지역|존|드롭|zone|수비|매치업))/gi,
  // View counts: 조회수 1,234.
  /조회\s*수?\s*[:：]?\s*\d[\d,]*/g,
  // "Whether by one or a hundred" (1점차든 100점차든, 30점이든지): either way, not a claim.
  /(?<![\d.,])\d[\d,.]*\s*[가-힣]{0,3}?(?:이)?든(?:지)?(?=\s|[,.!?~…]|$)/g,
  // Round thresholds and ranges: 30점대, 20점 넘게, 40점 가까이, 10개 이상 (not a score: 80대 77).
  /(?<![\d.,])[1-9]\d*0(?:\s*(?:점|득점|경기|리바|어시|개|%|승|패))?\s*(?:대(?!\s*\d)|이상|이하|미만|넘|가까이|안팎|언저리|남짓|정도|쯤|근처)/g,
]

/**
 * Units after a number that make it a date, a time, an age, a school year, a
 * height or a weight rather than a stat. Minutes on court (30분 출전, 30분
 * 뛰고) are a stat.
 */
const UNIT =
  /^\s*(?:년|월|일(?![반부단정수본류])|시간|시(?![즌리작합도절대청])|분(?![의석위야기])(?!\s*(?:간\s*|동안\s*)?(?:출전|뛰|뛴|소화|활약|풀타임|코트))|초(?![반보])|살|세(?!트|이브|계|컨|대)|학년|교시|cm|센치|센티|kg|키로|킬로)/i
const PERCENT = /^\s*(?:%|퍼센트|프로|퍼)/
/** Percentage points: a gap between two shares, not a share. */
const POINTS = /^\s*(?:%\s*[pP](?![A-Za-z])|(?:%|퍼센트|프로)\s*포인트|퍼센트\s*[pP](?![A-Za-z]))/
/** Counts glued to a number, longest first. */
const COUNTS = [
  '리바운드', '어시스트', '턴오버', '라운드', '번째', '득점', '실점', '리바', '어시', '스틸', '블락', '블록', '연승', '연패', '경기', '게임', '시즌',
  '점', '개', '승', '패', '위', '번', '명', '표', '회', '강', '차', '골', '분', '초',
]

/** The numbers a text uses, in order (see the top of this file for what's skipped). */
export function numberTokens(text: string): NumberToken[] {
  if (!/\d/.test(text)) return []
  const masked: [number, number][] = []
  for (const re of MASKS) for (const m of text.matchAll(re)) masked.push([m.index, m.index + m[0].length])
  const out: NumberToken[] = []
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index
    const end = start + m[0].length
    if (masked.some(([a, b]) => start < b && end > a)) continue
    const after = text.slice(end, end + 8)
    if (UNIT.test(after)) continue
    const raw = m[0]
    const value = Number(raw.replace(/,/g, ''))
    const points = POINTS.exec(after)
    const share = points ? null : PERCENT.exec(after)
    // Over 100% is a manner of speaking (1000% 확신).
    if ((share || points) && value > 100) continue
    const count = share || points ? null : COUNTS.find((c) => after.startsWith(c))
    const dot = raw.indexOf('.')
    out.push({
      raw,
      value,
      decimals: dot < 0 ? 0 : raw.length - dot - 1,
      percent: share !== null,
      unit: points ? '%p' : share ? '%' : (count ?? ''),
      start,
      end,
      stop: end + (points ? points[0].length : share ? share[0].length : (count?.length ?? 0)),
    })
  }
  return out
}

/**
 * How a marked number is stored (ai_flags): as written, with its unit
 * ("41점", "45.5%", "65" for a score's side), so marks land on 41점 and not
 * on 41위. Rows from before units were kept hold bare numbers ("41"), which
 * mark that number whatever follows it, as does a number written without one.
 */
export const flagOf = (t: NumberToken) => `${t.raw}${t.unit}`

const FLAG = /^\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*(.*?)\s*$/

/** A stored mark read back: its value, and its unit ('' marks the value whatever its unit). */
export function parseFlag(flag: string): { value: number; unit: string } | null {
  const m = FLAG.exec(flag)
  if (!m) return null
  const unit = POINTS.test(m[2]!) ? '%p' : PERCENT.test(m[2]!) ? '%' : m[2]!
  return { value: Number(m[1]!.replace(/,/g, '')), unit }
}

/** Units that name the same count: 41점 and 41득점 are one number. */
const SAME_UNIT: Record<string, string> = { 득점: '점', 리바운드: '리바', 어시스트: '어시', 블록: '블락', 게임: '경기' }
export const sameUnit = (unit: string) => SAME_UNIT[unit] ?? unit

/** Whether a number in a text is the one a mark names. */
export function matchesFlag(t: NumberToken, flag: { value: number; unit: string }): boolean {
  return Math.abs(t.value - flag.value) < 1e-9 && (flag.unit === '' || sameUnit(flag.unit) === sameUnit(t.unit))
}

const parsed = (flags: readonly string[] | undefined) => (flags ?? []).map(parseFlag).filter((f): f is NonNullable<typeof f> => f !== null)

/** Whether a text uses this marked number (as the check reads it), written any way: 22점 and 22.0점 alike. */
export function usesNumber(text: string, flag: string): boolean {
  const f = parseFlag(flag)
  return f !== null && numberTokens(text).some((t) => matchesFlag(t, f))
}

/**
 * A text cut into plain runs and the numbers to mark (the ones a check found
 * nowhere in its job's facts), for the screens to underline. Only the digits
 * are marked, not the unit after them.
 */
export function splitMarked(text: string, numbers: readonly string[] | undefined): { text: string; marked: boolean }[] {
  const flags = parsed(numbers)
  if (flags.length === 0 || !text) return [{ text, marked: false }]
  const out: { text: string; marked: boolean }[] = []
  let at = 0
  for (const t of numberTokens(text)) {
    if (!flags.some((f) => matchesFlag(t, f))) continue
    if (t.start > at) out.push({ text: text.slice(at, t.start), marked: false })
    out.push({ text: t.raw, marked: true })
    at = t.end
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false })
  return out
}

/**
 * What writers read after a marked number they're shown again (a post title,
 * a comment, a page): it wasn't in the facts, and the check doesn't count it
 * as a fact either.
 */
export const UNVERIFIED = '(확인 안 된 숫자)'

/** A text a writer reads, with UNVERIFIED after each marked number (and its unit). */
export function tagUnverified(text: string, numbers: readonly string[] | undefined): string {
  const flags = parsed(numbers)
  if (flags.length === 0 || !text) return text
  let out = ''
  let at = 0
  for (const t of numberTokens(text)) {
    if (!flags.some((f) => matchesFlag(t, f))) continue
    out += `${text.slice(at, t.stop)}${UNVERIFIED}`
    at = t.stop
  }
  return out + text.slice(at)
}

/** The tag as writers copy it: spaced or not, in round or square brackets ("(확인안된 숫자)", "[확인 안 된 숫자]"). */
export const UNVERIFIED_TAG = /[(\[（［]\s*확인\s*(?:안\s*된|되지\s*않은)\s*숫자\s*[)\]）］]/

const TAGS = new RegExp(`[ \\t]*${UNVERIFIED_TAG.source}`, 'g')

/** AI text as saved or shown: a writer that copied the tag along with a number doesn't keep it. */
export const untag = (text: string) => (text.includes('숫자') ? text.replace(TAGS, '') : text)
