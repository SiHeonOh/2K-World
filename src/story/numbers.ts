import { flagOf, numberTokens, parseFlag, sameUnit, UNVERIFIED_TAG, type NumberToken } from '@shared/numbers'

/**
 * The check on numbers in AI text. Every writer is told to use only numbers
 * from its facts, but a model sometimes invents a stat. A number a text uses
 * is known when the job's facts (its context and instructions) hold it,
 * rounded to the precision written, or when it's simple arithmetic on the
 * facts: a score's total and margin, a record's games, two counts of one kind
 * on a line added up or apart (둘이 51점 합작), a gap between two numbers
 * under one label (리바 19 … 리바 45), the misses in a made/attempted line;
 * for a decimal or a percentage, a made/attempted line (12/20 → 60%), a
 * record (5승 3패 → 0.625) or a series (4-2); for percentage points, the gap
 * between two shares on a line. A percentage is known only as a share like
 * that (or one the facts write with %), not because some count happens to
 * match it. A sum, a gap or a share of two known numbers in the same sentence
 * of the text counts too.
 *
 * 0, 1 and 2 aren't checked (counts written as digits are common and
 * harmless), and neither is what numberTokens skips, or a number in a
 * clause that's a prediction or a condition ("40점 넣으면 인정", "16강은
 * 간다", "25.5점 찍겠네"); a past-tense claim always is, and so is a stat
 * ("시즌 평균 57점") next to a word that only looks ahead in time (내일).
 *
 * Not facts, though in the context: the cast (persona ids, nicknames, 매운맛
 * 3/5, their 기억), nicknames before what they wrote, players' 속마음, and
 * text nothing checked (a 토론's topic and status lines, why an editor
 * objects, a poll): writers wrote those. Numbers shown as unverified
 * (tagUnverified) aren't facts either, but quoting or disputing them isn't the
 * writer's invention: they count as known, and are marked where repeated.
 *
 * A job whose output fails is redone once with a note (retryNote); a retry
 * that still fails is saved with those numbers marked for the user.
 */

const MAX_PAIRS = 20_000
/** Known numbers in one sentence of a text that pair with each other: the first few. */
const MAX_OWN = 12
/** Numbers named in a retry note. */
const MAX_NOTED = 12

/** The cast block's heading (context.ts): the cast is who may write, not facts. */
export const CAST_HEADING = '# 쓸 수 있는 사람'

export interface Facts {
  /** Every number in the facts, sorted. */
  values: number[]
  /** Sums and differences of numbers that belong together on a line, sorted. */
  sums: number[]
  /** Shares: percentages written as such, made/attempted ratios and records' win rates, as fractions and percentages, sorted. */
  ratios: number[]
  /** Gaps between two shares on one line, in percentage points (65.3% and 33% → 32.3%p), sorted. */
  points: number[]
  /** Numbers shown as unverified, or handed in as marked: known for the check, but marked where a text repeats them. Sorted. */
  unverified: number[]
}

/** Parts of a line that writers wrote and nothing checked. */
const NOT_FACTS: readonly RegExp[] = [
  // A nickname before what that person wrote: 「아람고골수팬903」: …, 아람고골수팬903(f187): ….
  /「[^」\n]{1,24}」(?=\s*:)/g,
  /[^\s(「」:]+(?=\([fr]\d+\))/g,
  // A player's 속마음 and a persona's 기억.
  /속마음\s*「[^」\n]*」/g,
  /기억:\s*(?:「[^」\n]*」\s*)+/g,
  // A 토론's topic, its status lines (edit summaries, close notes), why an editor objects, and a poll (wikiTalk.ts, context.ts).
  /토론 「[^」\n]*」/g,
  /^\(「[^」\n]*」\)\s*$/g,
  /반대한다: 「[^」\n]*」/g,
  /^투표: 「.*$/g,
]

/** The tag right after a number shown as unverified (with its unit). */
const TAGGED = new RegExp(`^\\s*${UNVERIFIED_TAG.source}`)

/** The text of a job's facts that the check reads: without the cast block and NOT_FACTS. */
function factLines(text: string): string[] {
  const out: string[] = []
  let cast = false
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) cast = line.startsWith(CAST_HEADING)
    if (cast) continue
    out.push(NOT_FACTS.reduce((l, re) => l.replace(re, ' '), line))
  }
  return out
}

/** Counts that add up (in their sameUnit form): two players' points, a team's rebounds. Not places, streaks or shirt numbers. */
const ADDS = new Set(['점', '실점', '리바', '어시', '스틸', '블락', '턴오버', '개', '경기', '승', '패', '골', '분'])

/** The word naming a bare number (리바 19, 야투 12/20, 3점 3/7), or null. */
function labelOf(line: string, t: NumberToken): string | null {
  const m = /(\S+)\s*$/.exec(line.slice(Math.max(0, t.start - 24), t.start))
  const w = m ? m[1]!.replace(/^[(\[「]+|[:,·]+$/g, '') : ''
  return /^[가-힣A-Za-z]+$/.test(w) || /^[23]점$/.test(w) ? w : null
}

const slash = (line: string, a: NumberToken, b: NumberToken) => /^\s*\/\s*$/.test(line.slice(a.stop, b.start))

/** Reads the numbers in a job's facts once, for checking every text it wrote. */
export function readFacts(...texts: (string | null | undefined)[]): Facts {
  const values: number[] = []
  const sums: number[] = []
  const ratios: number[] = []
  const points: number[] = []
  const unverified: number[] = []
  let pairs = 0
  const pair = (list: number[], ...xs: number[]) => {
    if (pairs >= MAX_PAIRS) return
    list.push(...xs)
    pairs++
  }
  // Every two numbers of a list (up to the cap): their sum and gap, or only the gap.
  const pairUp = (list: readonly number[], into: number[], sum: boolean) => {
    for (let i = 0; i < list.length && pairs < MAX_PAIRS; i++) {
      for (let j = i + 1; j < list.length && pairs < MAX_PAIRS; j++) {
        if (sum) pair(into, list[i]! + list[j]!, Math.abs(list[i]! - list[j]!))
        else pair(into, Math.abs(list[i]! - list[j]!))
      }
    }
  }
  const share = (r: number, shares: number[]) => {
    ratios.push(r, r * 100)
    shares.push(r * 100)
  }
  for (const text of texts) {
    if (!text) continue
    for (const line of factLines(text)) {
      const tokens: NumberToken[] = []
      for (const t of numberTokens(line)) {
        // A number shown as unverified isn't a fact (nor part of any arithmetic), but it's known for the check.
        if (TAGGED.test(line.slice(t.stop, t.stop + 24))) unverified.push(t.value)
        else tokens.push(t)
      }
      if (tokens.length === 0) continue
      // Totals worked out for the writers ("평균 22.5점(총 90점)") are sums already: they pair with nothing.
      const totals = [...line.matchAll(/\(총 [^)]*\)/g)].map((m) => [m.index, m.index + m[0].length] as const)
      // This line's shares (as percentages), its counts by kind, and its bare numbers by label.
      const shares: number[] = []
      const byUnit = new Map<string, number[]>()
      const byLabel = new Map<string, number[]>()
      const add = (map: Map<string, number[]>, key: string, v: number) => {
        const list = map.get(key)
        if (list) list.push(v)
        else map.set(key, [v])
      }
      for (let i = 0; i < tokens.length; i++) {
        const a = tokens[i]!
        const b = tokens[i + 1]
        values.push(a.value)
        // A share written as one (야투율 45.5%) is one, as a percentage or a fraction.
        if (a.percent) share(a.value / 100, shares)
        const between = b ? line.slice(a.stop, b.start) : ''
        // Made/attempted (12/20, 16/28경기): a share, and the misses. 3점 9/32 is also 27 points.
        if (b && a.unit === '' && !b.percent && b.unit !== '%p' && slash(line, a, b) && a.value <= b.value && b.value > 0) {
          share(a.value / b.value, shares)
          pair(sums, b.value - a.value)
          if (labelOf(line, a) === '3점') values.push(3 * a.value)
        }
        // A record (5승 3패): a win rate, the games played and the gap.
        if (b && a.unit === '승' && b.unit === '패' && /^\s*,?\s*$/.test(between) && a.value + b.value > 0) {
          share(a.value / (a.value + b.value), shares)
          pair(sums, a.value + b.value, Math.abs(a.value - b.value))
        }
        // A score (98:85, 81-77, 80대 77): its total and margin. A series won 4-2 is a win rate too.
        if (b && a.unit === '' && b.unit === '' && /^\s*(?::|-|–|대)\s*$/.test(between)) {
          pair(sums, a.value + b.value, Math.abs(a.value - b.value))
          const games = a.value + b.value
          if (/[-–]/.test(between) && a.decimals + b.decimals === 0 && a.value <= 4 && b.value <= 4 && games >= 2) {
            ratios.push(a.value / games, (a.value / games) * 100, b.value / games, (b.value / games) * 100)
          }
        }
        // A 3점 or 2점 before a share is its label, not points.
        const shotLabel = (a.value === 2 || a.value === 3) && a.decimals === 0 && a.unit === '점' && b !== undefined && b.unit === '' && /^\s*$/.test(between) && tokens[i + 2] !== undefined && slash(line, b, tokens[i + 2]!)
        if (ADDS.has(sameUnit(a.unit)) && !shotLabel && !totals.some(([s, e]) => a.start > s && a.start < e)) add(byUnit, sameUnit(a.unit), a.value)
        if (a.unit === '') {
          // The second number of a share goes under its first one's label (야투 12/20: 20 is 야투's attempts).
          const prev = tokens[i - 1]
          const second = prev !== undefined && prev.unit === '' && slash(line, prev, a)
          const label = second ? labelOf(line, prev) : labelOf(line, a)
          if (label) add(byLabel, second ? `${label}/` : label, a.value)
        }
      }
      // Counts of one kind on a line, added up or apart (둘이 51점 합작, 2점 차).
      for (const list of byUnit.values()) pairUp(list, sums, true)
      // Bare numbers under one label, apart (리바 19 … 리바 45: 26개 차이; 야투 33/100 … 49/75: 16개 더).
      for (const list of byLabel.values()) pairUp(list, sums, false)
      // Shares on a line, apart in percentage points.
      pairUp(shares, points, false)
    }
  }
  const sorted = (list: number[]) => list.sort((a, b) => a - b)
  return { values: sorted(values), sums: sorted(sums), ratios: sorted(ratios), points: sorted(points), unverified: sorted(unverified) }
}

/** The facts plus numbers that count as known for this job without being facts: what a fan who misremembers on purpose wrote (so a fan correcting him may repeat it). */
export function alsoKnown(facts: Facts, numbers: readonly number[]): Facts {
  const extra = numbers.filter((n) => Number.isFinite(n))
  return extra.length ? { ...facts, values: [...facts.values, ...extra].sort((a, b) => a - b) } : facts
}

/** The facts plus marked numbers handed in (a player's words): known for the check, but marked where a text repeats them. */
export function alsoUnverified(facts: Facts, flags: readonly string[]): Facts {
  const extra = flags.map((f) => parseFlag(f)?.value ?? NaN).filter((n) => Number.isFinite(n))
  return extra.length ? { ...facts, unverified: [...facts.unverified, ...extra].sort((a, b) => a - b) } : facts
}

/** The range of values that read as this number: rounded to its precision (percentage points a step either way: shares rounded before they're taken apart). */
function range(t: NumberToken): [number, number] {
  const half = 10 ** -t.decimals / (t.unit === '%p' ? 1 : 2)
  return [t.value - half - 1e-9, t.value + half + 1e-9]
}

/** Whether a sorted list holds a value in [lo, hi]. */
function holds(sorted: readonly number[], [lo, hi]: [number, number]): boolean {
  let a = 0
  let b = sorted.length
  while (a < b) {
    const mid = (a + b) >> 1
    if (sorted[mid]! < lo) a = mid + 1
    else b = mid
  }
  return a < sorted.length && sorted[a]! <= hi
}

const small = (t: NumberToken) => t.decimals === 0 && t.value <= 2
const isShare = (t: NumberToken) => t.percent || t.unit === '%p'

/** Whether the facts hold a number (or work it out). A percentage only as a share; a decimal also as one (0.625, .750). */
function inFacts(t: NumberToken, facts: Facts): boolean {
  const r = range(t)
  if (t.unit === '%p') return holds(facts.points, r)
  if (t.percent) return holds(facts.ratios, r)
  return holds(facts.values, r) || holds(facts.sums, r) || (t.decimals > 0 && holds(facts.ratios, r))
}

/** Two counts that may be added up or apart: of one kind, or one of them bare (81-77, 4점 차). */
const together = (a: NumberToken, b: NumberToken) => a.unit === '' || b.unit === '' || sameUnit(a.unit) === sameUnit(b.unit)

/** Whether a number is a sum, a gap or a share of two known numbers in its sentence ("최고 41점, 오늘 31점, 10점 모자랐다"). */
function worksOut(t: NumberToken, known: readonly NumberToken[]): boolean {
  const [lo, hi] = range(t)
  const hit = (x: number) => x >= lo && x <= hi
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      const a = known[i]!
      const b = known[j]!
      if (isShare(t)) {
        // Shares apart (45.5% vs 40%: 5.5%p), or one count of another (31점 of 128점: 24%).
        if (a.percent && b.percent && hit(Math.abs(a.value - b.value))) return true
        if (t.percent && !isShare(a) && !isShare(b) && Math.max(a.value, b.value) > 0 && hit((Math.min(a.value, b.value) / Math.max(a.value, b.value)) * 100)) return true
      } else if (!isShare(a) && !isShare(b) && together(a, b) && (hit(Math.abs(a.value - b.value)) || hit(a.value + b.value))) return true
    }
  }
  return false
}

// ── Predictions and conditions ───────────────────────────────────────────

/** Where a sentence ends: . ! ? … (not a decimal point), a new line, ㅋㅋ and the like. */
const SENTENCE_END = /(?<!\d)\.(?!\d)|[!?…\n]+|[ㅋㅎㅠㅜ]{2,}/g
/**
 * A word that ends a clause: a connective (뛰고, 넣어서, 이기면, 졌지만,
 * 넣었는데), a quote (학교라고), or a sentence ending (넣음; not 다음, 처음,
 * 마음).
 */
const CLAUSE_END =
  /(?:[었았였했됐하되있없뛰넣기지치쏘잡먹주받보가오나않찍박막뺏털꽂올내따쳤켰]고|[라다냐]고|[어아해여워져려봐와줘]서|면서|며|지만|[는은인던한]데|니까|으니|다가|거나|든지|면|[다요임냐네지]|(?<![다처마걸믿웃울얼소])음|[,;])$/
/** Nouns that end in 면 without being a condition (그 장면, 반면). */
const NOT_CONDITION = /(?:반|측|정|전|국|장|화|양|단|표|방)면$/
/** "31점이면", "45%면", "78-65면": a number restated, which is usually a claim about it. */
const NUMBER_RESTATED = /^[\d,.:\-]+(?:%|[가-힣]{1,3})?면$/
/** A past condition (넣었으면) is a hypothetical only with what would have been (좋았을, 몰랐다, 이겼을 텐데), or alone as a wish (넣어줬으면). */
const PAST_CONDITION = /(?:었|았|였|했|됐|웠|졌|렸|켰|쳤|봤|왔|갔|냈|섰|줬|겼)으?면$/
const WOULD_HAVE = /좋겠|좋았|몰랐|텐데|[었았였했됐겼]을|걸|겠/
/** A condition that's a jab, not a hypothetical: what follows says it didn't matter ("41점 넣으면 뭐함 졌는데"). */
const RHETORICAL = /^(?:그게\s*)?(?:뭐\s*(?:함|하냐|해|하나|하노|하니|하는데|할래|하겠냐)|무슨\s*소용|뭔\s*소용|소용\s*(?:없|이\s*없)|의미\s*(?:없|가\s*없))/
/** Past tense: what happened, which the facts must hold (넣었다, 이겼고, 31점 넣은 바가바). */
const PAST = /[었았였했됐웠졌렸켰쳤봤왔갔냈섰줬뒀났겼]|(?:넣은|찍은|올린|기록한|이긴|터뜨린|꽂은|잡은|뺏은|막은|성공한|해낸|만든|뛴)(?:\s|$)/
/** Past tense that's still no claim: should have (넣었어야지), wanted (넣고 싶었는데), on pace (찍을 기세였음), could have (넣을 수도 있었는데), expected (넣을 줄 알았다). */
const SHOULD_HAVE = /[었았였했됐웠졌]어야/
const AFTER_FUTURE_PAST = /([가-힣])\s?(?:줄\s*알았|기세|수도\s*있었)/g
const WANT = /고\s*싶|(?:길|기를)\s*바|바란다|기원/
/**
 * Words that look ahead: a forecast (예상, 예언, not 예상대로), a target, a
 * chance (확률), a call (각, 무조건, 박제), a fixture (가람고 @ 나람고), hope
 * (기대), a request.
 */
const AHEAD =
  /(?:예상|예언|전망|예측)(?!\s*(?:대로|과|와|외|밖|적중|이\s*(?:맞|빗나|적중|틀)))|목표(?!\s*(?:를\s*)?(?:달성|이뤘|이룸|이루었))|박제(?!\s*(?:됐|됨|당))|확률|무조건|부탁|기대(?:해|한다|된다|됨|중)|(?<![생감착시지삼조망자입각])각(?:이다|임|이네|이야|이지|ㅋ+)?(?=[,.!?~]*$)|\S\s+@\s+\S|가즈아|ㄱㄱ/
/** A verb in the present that says what will happen (간다, 이긴다, 넣는다): not with a habit ("매 경기 20점은 넣는다" is a claim). */
const WILL = /간다|[찍넣잡먹막]는다|이긴다|넘긴다|넘는다|우승한다|끝낸다|진출한다|올라간다|터진다/
const HABIT = /매\s*경기|경기마다|항상|언제나|맨날|꼬박꼬박/
/** A proposal (이기자, 끝내자), an order or a request (넣어라, 이겨라, 넣어줘) as the clause's last word; a need anywhere (넣어야지, 넣어야 함). */
const PROPOSAL = /(?<![후평안])(?:이기|끝내|내|하|보|넣|잡|찍|먹|막|달리|올리|지키|버티|치|가|오|뛰|쏘|따|털|밀|만들|보내|올라가)자$/
const ORDER = /[어아여해와워봐줘져려쳐켜내서써겨]라$|(?:줘|줘요|주세요|주라)$/
// 가야 only with what follows it (4강 가야지): "역시 가가가야" is a name.
const NEED = /[어아여해와워봐줘져려쳐켜내서써겨]야(?:지|죠|함|해|돼|됨|된다|한다|할|하는|겠다?)?$|가야(?:지|죠|함|해|돼|됨|된다|한다|할|하는|겠다?)$/
/** A clause that ends on a forecast word leads into the next one ("내가 박제한다, 나람고 23승"). */
const LEAD_IN = /예상|예언|예측|전망|박제|장담|단언/
/** Words that say a clause is about the past, whatever else it says ("다음 상대 나람고는 지난 경기 41점 차 대패"). */
const PAST_WORDS = /(?:^|\s)(?:지난|직전|어제|저번|아까|방금|그날|당시|작년|지난해)/
/**
 * Words that only look ahead in time: next game, tomorrow. Not "그 다음",
 * "개막전 다음" (what came after something). A stat named in such a clause
 * is still a claim (STAT_BEFORE).
 */
const SOON = /(?<!(?:그|이|저|개막전|개막|결승전|차전)\s?)다음|담\s*경기|담엔|내일|앞으로|내년|언젠가/
/** A stat right before a number: "시즌 평균 57점", "야투율 85%" is what someone has, a claim even next to 내일. */
const STAT_BEFORE = /(?:평균|야투율|승률|성공률|통산|커리어\s*하이|시즌\s*(?:최고|하이)|현재|지금|경기당)\s*(?:은|는|이|가|도|:)?\s*$/
/** "겠" on writing it down (4321득점으로 고치겠습니다) is no forecast: what's written is a claim. */
const WILL_WRITE = /^(?:고치|고쳐|수정하|수정해|반영하|반영해|덧붙이|정리하|정리해|추가하|추가해|적|쓰|써|바꾸|바꿔|말씀드리|말하|밝히|확인하|정정하|기록하|표기하|기재하)겠/
/** After a verb in its future form (넣을, 찍을, 갈): 것, 듯, 거, 수… */
const AFTER_FUTURE = /^(?:것|거|걸|껄|꺼|듯|수|지도|예정|전망|텐데|테니|게)/

/** Whether a syllable ends in ㄹ (넣을, 갈, 이길): a verb's future form. */
const endsInL = (c: string | undefined) => {
  const code = c ? c.charCodeAt(0) - 0xac00 : -1
  return code >= 0 && code < 11172 && code % 28 === 8
}

const bare = (word: string) => word.replace(/^["'「(\[]+/, '').replace(/[,.;:!?…~"'」)\]ㅋㅎㅠㅜ^]+$/, '')

/** How a clause reads: a claim, a prediction (`weak`: one only by a word like 내일), and whether it carries into the next clause. */
interface Reading {
  ahead: boolean
  weak: boolean
  covers: boolean
}
const CLAIM: Reading = { ahead: false, weak: false, covers: false }
const AHEAD_OF: Reading = { ahead: true, weak: false, covers: false }

/** A verb in its future form somewhere in the clause: 넣을 듯, 갈 거, 이길 수도; or glued: 갈듯, 이길걸, 넣을거임. */
function future(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = bare(words[i]!)
    if (endsInL(w.at(-1)) && i + 1 < words.length && AFTER_FUTURE.test(words[i + 1]!)) return true
    for (let k = 0; k + 1 < w.length; k++) if (endsInL(w[k]) && /^(?:듯|걸|껄|거|꺼|게)(?:임|야|다|요|여|ㅋ+)?$/.test(w.slice(k + 1))) return true
  }
  return false
}

/**
 * How one clause reads. `next` is the next clause of the same sentence
 * (null at a sentence's end); `carried` says the clause before leads into
 * this one (a condition's consequence, "이대로 가면", "박제한다").
 */
function readClause(words: readonly string[], next: string | null, carried: boolean): Reading {
  const text = words.join(' ')
  const last = bare(words.at(-1)!)
  if (last.endsWith('면') && !NOT_CONDITION.test(last) && !NUMBER_RESTATED.test(last)) {
    if (next !== null && RHETORICAL.test(next)) return CLAIM
    if (!PAST_CONDITION.test(last) || next === null || WOULD_HAVE.test(next)) return { ahead: true, weak: false, covers: true }
    return CLAIM
  }
  // Past tense that isn't a claim: should have, wanted, on pace, could have, expected.
  if (SHOULD_HAVE.test(text) || WANT.test(text) || (last.endsWith('고') && next !== null && /^싶/.test(next))) return AHEAD_OF
  for (const m of text.matchAll(AFTER_FUTURE_PAST)) if (endsInL(m[1])) return AHEAD_OF
  // Anything else in the past tense makes the clause a claim about what happened ("37점 넣은 가가가 덕에 이기겠지").
  if (PAST.test(text)) return CLAIM
  const forecast =
    words.some((w) => (w.includes('겠') && !WILL_WRITE.test(w)) || NEED.test(bare(w))) ||
    future(words) ||
    AHEAD.test(text) ||
    (WILL.test(text) && !HABIT.test(text)) ||
    PROPOSAL.test(last) ||
    ORDER.test(last)
  if (forecast) return { ahead: true, weak: false, covers: LEAD_IN.test(last) }
  if (PAST_WORDS.test(text)) return CLAIM
  if (carried || SOON.test(text)) return { ahead: true, weak: true, covers: false }
  return CLAIM
}

/** Where each sentence ends, in order. */
const sentenceEnds = (text: string) => [...text.matchAll(SENTENCE_END)].map((m) => m.index)

/**
 * Spans of a text that are predictions or conditions: a clause whose verb
 * looks ahead or sets a condition. Numbers there aren't claims about what
 * happened. Past-tense claims never are, whatever words they use.
 */
function aheadSpans(text: string, ends: readonly number[]): { start: number; end: number; weak: boolean }[] {
  const words: { text: string; start: number; end: number; sentence: number }[] = []
  let e = 0
  for (const m of text.matchAll(/\S+/g)) {
    while (e < ends.length && ends[e]! < m.index) e++
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length, sentence: e })
  }
  const clauses: (typeof words)[] = []
  let current: typeof words = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    current.push(w)
    const next = words[i + 1]
    if (!next || CLAUSE_END.test(w.text) || /[.!?…]$/.test(w.text) || next.sentence !== w.sentence) {
      clauses.push(current)
      current = []
    }
  }
  const out: { start: number; end: number; weak: boolean }[] = []
  let carried = false
  clauses.forEach((c, i) => {
    const after = clauses[i + 1]
    const next = after && after[0]!.sentence === c[0]!.sentence ? after.map((w) => w.text).join(' ') : null
    const r = readClause(
      c.map((w) => w.text),
      next,
      carried,
    )
    if (r.ahead) out.push({ start: c[0]!.start, end: c.at(-1)!.end, weak: r.weak })
    carried = r.covers && next !== null
  })
  return out
}

/**
 * The numbers a text uses that its facts don't account for (`unknown`: the
 * job gets its retry), and the numbers shown as unverified that it repeats
 * (`unverified`: marked, not redone), as written with their units ("47점",
 * "45%"), each once, in order.
 */
export function checkNumbers(text: string, facts: Facts): { unknown: string[]; unverified: string[] } {
  const unknown: string[] = []
  const unverified: string[] = []
  const tokens = numberTokens(text)
  if (tokens.length === 0) return { unknown, unverified }
  const ends = sentenceEnds(text)
  const spans = aheadSpans(text, ends)
  // Each number's sentence and clause, in one pass: numbers, sentence ends and spans all run in order.
  let e = 0
  let s = 0
  const read = tokens.map((t) => {
    while (e < ends.length && ends[e]! < t.start) e++
    while (s < spans.length && spans[s]!.end <= t.start) s++
    const span = spans[s] && spans[s]!.start <= t.start ? spans[s]! : null
    // A prediction's numbers aren't claims, but a stat named next to a word like 내일 still is.
    const ahead = span !== null && (!span.weak || !STAT_BEFORE.test(text.slice(Math.max(span.start, t.start - 16), t.start)))
    const fact = inFacts(t, facts)
    const shown = !fact && holds(facts.unverified, range(t))
    return { t, sentence: e, skip: small(t) || ahead, fact, shown }
  })
  // What a sentence's own arithmetic may use: its known numbers (facts, or shown as unverified), the first few.
  const known = new Map<number, NumberToken[]>()
  for (const r of read) {
    if (small(r.t) || !(r.fact || r.shown)) continue
    const list = known.get(r.sentence) ?? []
    if (list.length < MAX_OWN) known.set(r.sentence, [...list, r.t])
  }
  for (const r of read) {
    if (r.skip || r.fact) continue
    const flag = flagOf(r.t)
    if (r.shown) {
      if (!unverified.includes(flag)) unverified.push(flag)
      continue
    }
    if (worksOut(r.t, (known.get(r.sentence) ?? []).filter((x) => x !== r.t))) continue
    if (!unknown.includes(flag)) unknown.push(flag)
  }
  return { unknown, unverified }
}

/** The numbers a text uses that its facts don't account for: what gets a job its retry. Empty when everything checks out. */
export const unknownNumbers = (text: string, facts: Facts): string[] => checkNumbers(text, facts).unknown

/** The note a retry gets, appended to its instructions (with no numbers: a retry now answering something else). */
export function retryNote(numbers: readonly string[]): string {
  const rule = '숫자는 자료에 있는 것만 쓰고, 계산한 숫자는 자료의 숫자로 바로 계산되는 것만 쓴다.'
  return numbers.length ? `지난번 글에 자료에 없는 숫자가 있었다: ${numbers.slice(0, MAX_NOTED).join(', ')}. ${rule}` : rule
}

/** A job's instructions, with the retry note when it's the retry. */
export function withRetryNote(prompt: string, numbers: readonly string[] | undefined): string {
  return numbers ? `${prompt}\n\n${retryNote(numbers)}` : prompt
}

/**
 * Thrown inside a save's transaction to undo it: the output used numbers its
 * facts don't hold, and the job gets one more try.
 */
export class NumbersRedo extends Error {
  constructor(readonly numbers: string[]) {
    super(`numbers not in the facts: ${numbers.join(', ')}`)
  }
}

/**
 * Gathers one job's unknown numbers as its texts are saved. `check` returns
 * what to mark on a text if it's saved (its unknown numbers, and unverified
 * ones it repeats); `redoIfAny` throws NumbersRedo when there were unknown
 * numbers and the job may still be redone.
 */
export function numberGate(facts: Facts, final: boolean) {
  const all: string[] = []
  return {
    check(text: string): string[] {
      const found = checkNumbers(text, facts)
      for (const n of found.unknown) if (!all.includes(n)) all.push(n)
      return [...found.unknown, ...found.unverified.filter((n) => !found.unknown.includes(n))]
    },
    redoIfAny(): void {
      if (!final && all.length > 0) throw new NumbersRedo([...all])
    },
    get unknown(): readonly string[] {
      return all
    },
  }
}
