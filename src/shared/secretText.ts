/**
 * Lore text work shared by the main process and 제안함, so the screen shows
 * exactly what approving will do to the file: cleaning text before it goes
 * into a section, and finding and cutting a secret's text for reveals
 * (making and approving reveal cards, and the card's "what stays in 비밀"
 * preview).
 */

/** The longest text a suggestion may add to a section (a reveal moves all of its secret, however long). */
export const MAX_TEXT = 1500

/**
 * Text made safe to put into a section: no heading lines or underlines
 * (they'd open another section), no comment markers, no indentation, no runs
 * of blank lines. Used on everything an AI wrote and on what you type into a
 * card, by the server and by the card's preview alike.
 */
export function cleanLoreText(text: unknown, max = MAX_TEXT): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/<!--|-->/g, '')
    .split('\n')
    .map((l) => l.trim().replace(/^#+\s*/, ''))
    .filter((l) => !/^(=+|-+|\*+|_+)$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim()
}

/** Quote marks matched as one another: the reveal job reads a secret in corner brackets, with brackets inside it turned into straight quotes. */
const QUOTES = '"「」“”'
/** One wrapping pair an excerpt may be copied with (the job saw each secret in 「」). */
const PAIRS: Record<string, string> = { '「': '」', '『': '』', '"': '"', '“': '”', "'": "'", '‘': '’' }
/** What ends a sentence (다. 요. and the rest), and the closing quotes that may follow it. */
const ENDERS = '.?!。？！…'
const CLOSERS = '"\'」』”’)]'
/** Abbreviations whose full stop doesn't end a sentence (A고 vs. B고). */
const ABBREVIATION = /(?:^|[^A-Za-z])(?:[Vv][Ss]|cf|e\.g|i\.e|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|No|Vol)$/
/**
 * A list marker: -, *, + or a number of one or two digits with . or ). A
 * longer number is a year ("2024. 그는 …"), never a list.
 */
const MARKER = String.raw`(?:[-*+]|\d{1,2}[.)])`
/** What may sit before a list item's text on its line: indentation and a marker. */
const MARKER_BEFORE = new RegExp(String.raw`^[ \t]*${MARKER}[ \t]+$`)
/** A line that's only a list marker (a cut must never leave one: a bare - reads as a heading underline). */
const MARKER_LINE = new RegExp(String.raw`^[ \t]*${MARKER}[ \t]*$`)
/** A list item's marker at the start of an excerpt. */
const MARKER_START = new RegExp(String.raw`^${MARKER}[ \t]+`)
/** Spacing within a line: any whitespace but a line break (a no-break or ideographic space too). */
const SPACE = /[^\S\n]/

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The text in NFC, and the way back from an NFC offset to the text as
 * written, so a cut in a file typed on a Mac (NFD) leaves the rest of it
 * byte for byte. Pieces are whole graphemes: NFC never joins across them.
 */
function nfcView(text: string): { nfc: string; back: (i: number, up: boolean) => number } {
  if (text === text.normalize('NFC')) return { nfc: text, back: (i) => i }
  const pieces = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment) : [...text]
  const starts: number[] = []
  const origins: number[] = []
  let nfc = ''
  let at = 0
  for (const p of pieces) {
    starts.push(nfc.length)
    origins.push(at)
    nfc += p.normalize('NFC')
    at += p.length
  }
  starts.push(nfc.length)
  origins.push(at)
  const back = (i: number, up: boolean) => {
    let k = 0
    while (k + 1 < starts.length && starts[k + 1]! <= i) k++
    return starts[k] === i || !up ? origins[k]! : origins[k + 1]!
  }
  return { nfc, back }
}

/**
 * Every place an excerpt sits in NFC text (overlapping ones too), matched
 * apart from spacing and quote marks; copied in one wrapping pair of quotes,
 * it's tried without them too.
 */
function locate(nfc: string, excerpt: string): [number, number][] {
  const want = excerpt.normalize('NFC').trim()
  if (!want) return []
  const tries = [want]
  const close = PAIRS[want[0]!]
  if (want.length > 2 && close && want.endsWith(close)) tries.push(want.slice(1, -1).trim())
  for (const w of tries) {
    if (!w) continue
    let pattern = ''
    for (const part of w.split(/(\s+)/)) {
      if (part === '') continue
      pattern += /^\s+$/.test(part) ? '\\s+' : [...part].map((ch) => (QUOTES.includes(ch) ? `[${QUOTES}]` : escapeRe(ch))).join('')
    }
    const re = new RegExp(pattern, 'gu')
    const out: [number, number][] = []
    for (let m = re.exec(nfc); m; m = re.exec(nfc)) {
      out.push([m.index, m.index + m[0].length])
      // The next try starts one letter on, so a match inside this one isn't missed.
      re.lastIndex = m.index + (nfc.codePointAt(m.index)! > 0xffff ? 2 : 1)
    }
    if (out.length) return out
  }
  return []
}

/**
 * Whether a sentence ends at offset i: at a line's end, or after end
 * punctuation (and any closing quotes) followed by a space. A full stop
 * right after a digit (a date, 2024. 3. 15.) or an abbreviation (vs.)
 * doesn't end one.
 */
function endsAt(t: string, i: number): boolean {
  if (i >= t.length || t[i] === '\n') return true
  if (!/\s/.test(t[i]!)) return false
  let k = i
  while (k > 0 && CLOSERS.includes(t[k - 1]!)) k--
  if (k === 0 || !ENDERS.includes(t[k - 1]!)) return false
  return t[k - 1] !== '.' || !(/\d/.test(t[k - 2] ?? '') || ABBREVIATION.test(t.slice(Math.max(0, k - 9), k - 1)))
}

/** Whether a sentence starts at offset i: at a line's start (after any list marker), or after a sentence's end and its spaces. */
function startsAt(t: string, i: number): boolean {
  if (i <= 0) return true
  const head = t.slice(t.lastIndexOf('\n', i - 1) + 1, i)
  if (head.trim() === '' || MARKER_BEFORE.test(head)) return true
  // The same spacing endsAt reads after a sentence (a no-break space too), or the sentence before would be pulled in.
  if (!SPACE.test(t[i - 1]!)) return false
  let j = i
  while (j > 0 && SPACE.test(t[j - 1]!)) j--
  return endsAt(t, j)
}

/** One place an excerpt sits, widened to whole sentences (a list item copied with its marker is the item's text). */
function widen(nfc: string, a: number, b: number): [number, number] {
  let s = a
  let e = b
  while (!startsAt(nfc, s)) s--
  while (SPACE.test(nfc[s] ?? '') && s < a) s++
  while (!endsAt(nfc, e)) e++
  // Cutting the item's text still takes its marker.
  const marker = nfc.slice(s, e).match(MARKER_START)?.[0]
  if (marker && !nfc.slice(s, e).includes('\n') && MARKER_BEFORE.test(nfc.slice(nfc.lastIndexOf('\n', s - 1) + 1, s + marker.length))) s += marker.length
  return [s, e]
}

/**
 * Where an excerpt sits in a section, widened to whole sentences: the text
 * exactly as the section has it (in NFC), from a sentence's start to a
 * sentence's end. A sentence ends at 다. 요. . ? ! (with any closing
 * quotes) before a space, or at a line's end, so widening never crosses a
 * line break, let alone a blank line. A cut never starts or ends mid-word.
 * An excerpt found in more than one place that widens differently is only
 * taken where it's whole sentences by itself, if that's one place; any
 * other way it's unclear which is meant, and it's null (better no card than
 * the wrong sentence). Null too when it isn't there.
 */
export function findExcerpt(section: string, excerpt: string): string | null {
  const { nfc } = nfcView(section)
  const spans = new Map<string, { s: number; e: number; whole: boolean }>()
  for (const [a, b] of locate(nfc, excerpt)) {
    const [s, e] = widen(nfc, a, b)
    const key = `${s}:${e}`
    spans.set(key, { s, e, whole: (s >= a && e === b) || (spans.get(key)?.whole ?? false) })
  }
  const all = [...spans.values()]
  const sure = all.length === 1 ? all : all.filter((x) => x.whole)
  return sure.length === 1 ? nfc.slice(sure[0]!.s, sure[0]!.e) : null
}

/** Newlines in a run of line breaks and blank lines. */
const breaks = (run: string) => (run.match(/\n/g) ?? []).length

/** Two pieces of a section put back together where whole lines were taken out: the blank lines there become the larger of the two runs. */
function joinLines(pre: string, post: string): string {
  const tail = pre.match(/(?:\n[ \t]*)+$/)?.[0] ?? ''
  const lead = post.match(/^(?:[ \t]*\n)+/)?.[0] ?? (post.trim() === '' ? post : '')
  const a = pre.slice(0, pre.length - tail.length)
  const b = post.slice(lead.length)
  if (a === '' || b.trim() === '') return a === '' ? b : a
  return `${a}${'\n'.repeat(Math.max(breaks(tail), breaks(lead), 1))}${b}`
}

/** A line left holding only a list marker where the cut was, dropped with its line break. */
function dropMarkerLine(t: string, at: number): string {
  const start = t.lastIndexOf('\n', at - 1) + 1
  const nl = t.indexOf('\n', at)
  const end = nl < 0 ? t.length : nl
  return MARKER_LINE.test(t.slice(start, end)) ? joinLines(t.slice(0, start), t.slice(end)) : t
}

/**
 * The section with t[a, b) taken out. Everything else stays byte for byte,
 * apart from the spaces and blank lines right around the cut:
 * - whole lines (a list item with its marker included) go with their line
 *   break, and the blank lines on either side become one run;
 * - part of a line leaves its two sides joined by a space (or by the line
 *   breaks the cut text held).
 */
function removeSpan(t: string, a: number, b: number): string {
  const lineStart = t.lastIndexOf('\n', a - 1) + 1
  const nl = t.indexOf('\n', b)
  const lineEnd = nl < 0 ? t.length : nl
  const head = t.slice(lineStart, a)
  const atStart = head.trim() === '' || MARKER_BEFORE.test(head)
  const atEnd = t.slice(b, lineEnd).trim() === ''
  if (atStart && atEnd) return joinLines(t.slice(0, lineStart), t.slice(lineEnd))
  const pre = t.slice(0, a)
  const post = t.slice(b)
  // Spacing as a sentence's start reads it (a no-break space too).
  const after = post.replace(/^[^\S\n]+/, '')
  if (atStart) return dropMarkerLine(pre + after, pre.length)
  const before = pre.replace(/[^\S\n]+$/, '')
  if (atEnd) return dropMarkerLine(before + after, before.length)
  const held = Math.max(0, ...(t.slice(a, b).match(/\n(?:[ \t]*\n)*/g) ?? []).map(breaks))
  return `${before}${held ? '\n'.repeat(held) : ' '}${after}`
}

/**
 * The section after a reveal: the excerpt (as the card holds it, found apart
 * from spacing and quote marks, never widened again) taken out, or replaced
 * by `keep` when you chose to leave something in 비밀 in its place. Where
 * it's there more than once, it's cut where it's whole sentences (as the card
 * found it), else where it's first. A list item whose whole text goes takes
 * its marker with it. The rest of the section stays byte for byte (see
 * removeSpan). Null when the excerpt isn't there.
 */
export function cutText(section: string, excerpt: string, keep = ''): string | null {
  const v = nfcView(section)
  const all = locate(v.nfc, excerpt)
  if (all.length === 0) return null
  const at = all.find(([s, e]) => startsAt(v.nfc, s) && endsAt(v.nfc, e)) ?? all[0]!
  const a = v.back(at[0], false)
  const b = v.back(at[1], true)
  const kept = keep.trim()
  return kept ? `${section.slice(0, a)}${kept}${section.slice(b)}` : removeSpan(section, a, b)
}
