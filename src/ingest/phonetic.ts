/**
 * A rough sound key for matching foreign players' names written in Hangul
 * ("애런 크로포드") to the English names 2K shows ("A. Crawford"). Both
 * sides become a string of consonant classes (vowels drop out: Korean
 * transcription adds and changes them freely), and keys are compared with a
 * small edit distance. It suggests; the confirm screen still asks.
 *
 * Classes: K (k, hard c/g), T (t, d, th), P (p, b, f, v), S (s, sh, soft c),
 * J (j, ch, soft g, z), L (l, r), M, N, H. A vowel-led name has no first class.
 */

const VOWEL = /[aeiouyw]/

/** Consonant classes of a Hangul initial (ㄱ ㄲ ㄴ ㄷ ㄸ ㄹ ㅁ ㅂ ㅃ ㅅ ㅆ ㅇ ㅈ ㅉ ㅊ ㅋ ㅌ ㅍ ㅎ). */
const HANGUL_INITIAL = ['K', 'K', 'N', 'T', 'T', 'L', 'M', 'P', 'P', 'S', 'S', '', 'J', 'J', 'J', 'K', 'T', 'P', 'H']
/** Of a final consonant. In loanwords a final ㅅ stands for a t sound; ㅇ is ng. */
const HANGUL_FINAL = ['', 'K', 'K', 'K', 'N', 'N', 'N', 'T', 'L', 'L', 'L', 'L', 'L', 'L', 'L', 'L', 'M', 'P', 'P', 'T', 'T', 'N', 'T', 'T', 'K', 'T', 'P', '']

const collapse = (classes: string[]) => classes.filter((c, i) => c !== '' && c !== classes.slice(0, i).filter(Boolean).at(-1)).join('')

/** The sound key of Hangul text: 크로포드 → KLPT, 르끌레르 → LKL, 안 → N. Other characters are skipped. */
export function hangulKey(text: string): string {
  const out: string[] = []
  for (const ch of text.normalize('NFC')) {
    const code = ch.charCodeAt(0) - 0xac00
    if (code < 0 || code > 11171) continue
    out.push(HANGUL_INITIAL[Math.floor(code / 588)]!, HANGUL_FINAL[code % 28]!)
  }
  return collapse(out)
}

/** The class a Hangul syllable starts with ('' when it starts with a vowel). */
export function hangulStart(syllable: string): string | null {
  const code = syllable.normalize('NFC').charCodeAt(0) - 0xac00
  return code < 0 || code > 11171 ? null : HANGUL_INITIAL[Math.floor(code / 588)]!
}

/**
 * The sound key of an English (or Latin-letter) surname, read the way Korean
 * transcription hears it: Crawford → KLPT (the r before a consonant is
 * silent, as in 크로포드), Leclerc → LKLK, Ahn → N, Doncic → TNSJ (-ić as 치),
 * Moore → M (a final -re after a vowel is silent: 무어), Walker → K (so is
 * the l in -alk-: 워커), Rose → LJ (a final -se after a vowel as 즈: 로즈).
 */
export function englishKey(word: string): string {
  return englishKeys(word)[0]!.key
}

/**
 * Every way Korean transcription may hear an English surname, the usual one
 * first. A final -se after a vowel is 즈 (Rose 로즈, Wise 와이즈) as often as
 * 스 (Chase 체이스, Reese 리스): the second reading costs half a point.
 */
export function englishKeys(word: string): { key: string; cost: number }[] {
  const w = spelling(word)
  if (w === '') return [{ key: '', cost: 0 }]
  const out = [{ key: keyOf(w, 'J'), cost: 0 }]
  const other = keyOf(w, 'S')
  if (other !== out[0]!.key) out.push({ key: other, cost: 0.5 })
  return out
}

/** The letters as they sound: silent letters dropped, digraphs made one. */
function spelling(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  return w
    .replace(/^wr/, 'r')
    .replace(/^[kg]n/, 'n')
    .replace(/^ps/, 's')
    .replace(/mb$/, 'm')
    .replace(/ic$/, 'ich')
    .replace(/tch/g, 'ch')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/gh/g, '')
    .replace(/sch/g, 'sh')
    .replace(/qu/g, 'kw')
    .replace(/x/g, 'ks')
    // Moore 무어, Gore 고어: a final -re after a vowel is silent (as a final r already is).
    .replace(/([aeiouy])re$/, '$1')
    // Walker 워커, Chalk 초크: so is the l in -alk-.
    .replace(/alk/g, 'ak')
}

/** The key of letters `spelling` gave; `finalSe`: how a final -se after a vowel sounds. */
function keyOf(w: string, finalSe: 'S' | 'J'): string {
  const out: string[] = []
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!
    const next = w[i + 1] ?? ''
    const soft = /[eiy]/.test(next)
    if (VOWEL.test(c)) continue
    if (c === 's' && next === 'e' && i === w.length - 2 && VOWEL.test(w[i - 1] ?? '')) {
      out.push(finalSe)
      continue
    }
    if (next === 'h' && 'sct'.includes(c)) {
      out.push(c === 's' ? 'S' : c === 'c' ? 'J' : 'T')
      i++
      continue
    }
    switch (c) {
      case 'h':
        // Sounded only before a vowel (Hamilton 해밀턴); silent after one (Ahn 안).
        if (VOWEL.test(next)) out.push('H')
        break
      case 'c':
        out.push(soft ? 'S' : 'K')
        break
      case 'g':
        if (w[i - 1] === 'n') break // ng: one sound (Young 영)
        out.push(next === 'e' || next === 'y' ? 'J' : 'K')
        break
      case 'z':
        out.push(i === 0 ? 'J' : 'S')
        break
      case 'r':
        // Korean leaves out an r that isn't followed by a vowel (Ford 포드, Carter 카터).
        if (VOWEL.test(next)) out.push('L')
        break
      case 'j':
        out.push('J')
        break
      case 'k':
      case 'q':
        out.push('K')
        break
      case 'd':
      case 't':
        out.push('T')
        break
      case 'b':
      case 'p':
      case 'f':
      case 'v':
        out.push('P')
        break
      case 's':
        out.push('S')
        break
      case 'l':
        out.push('L')
        break
      case 'm':
        out.push('M')
        break
      case 'n':
        out.push('N')
        break
    }
  }
  return collapse(out)
}

/** Classes an English initial can stand for (C. may be Chris 크리스, Cedric 세드릭 or Charles 찰스). */
export function englishStarts(letter: string): string[] {
  const l = letter.toLowerCase()
  if (VOWEL.test(l)) return ['']
  const map: Record<string, string[]> = {
    h: ['H', ''],
    c: ['K', 'S', 'J'],
    g: ['K', 'J', ''],
    j: ['J', ''],
    k: ['K'],
    q: ['K'],
    d: ['T'],
    t: ['T'],
    b: ['P'],
    p: ['P'],
    f: ['P'],
    v: ['P'],
    s: ['S'],
    z: ['J', 'S'],
    l: ['L'],
    r: ['L'],
    m: ['M'],
    n: ['N'],
    x: ['S', 'K'],
  }
  return map[l] ?? []
}

/** Pairs Korean transcription mixes up often (스/즈/치, 스/트): swapping them costs half. */
const NEAR = new Set(['SJ', 'JS', 'ST', 'TS', 'TJ', 'JT'])

/** Edit distance between two keys: inserts and deletes cost 1, a swap 1, a near swap ½. */
export function keyDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1]!
      const y = b[j - 1]!
      const swap = x === y ? 0 : NEAR.has(x + y) ? 0.5 : 1
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + swap))
    }
    prev = row
  }
  return prev[b.length]!
}

/**
 * How close two keys are: 'same', 'near' (within the room their length
 * allows: none for one class, a near swap for two, one change for three to
 * five, two for longer), or null.
 */
export function keysMatch(a: string, b: string): 'same' | 'near' | null {
  if (a === '' || b === '') return null
  if (a === b) return 'same'
  const len = Math.max(a.length, b.length)
  const room = len >= 6 ? 2 : len >= 3 ? 1 : len === 2 ? 0.5 : 0
  return keyDistance(a, b) <= room ? 'near' : null
}
