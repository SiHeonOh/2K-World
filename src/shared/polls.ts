/**
 * Poll options as stored. The write form and the main process share this,
 * so the form never accepts options the main process would refuse.
 */

export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 6
/** The most characters an option keeps. */
export const POLL_OPTION_MAX = 40

/**
 * A leading "1.", "1)", "1:", "1번 ", "1번:" or "①", with the number it
 * gives. "1번타자", "2.5점" and "3:2" aren't numbering.
 */
const NUMBERING = /^(?:(\d{1,2})\s*(?:번\s*[.):]|번(?=\s)|[.):](?!\d))|([①-⑩]))\s*/

function numbering(line: string): { n: number; length: number } | null {
  const m = NUMBERING.exec(line)
  if (!m) return null
  return { n: m[1] !== undefined ? Number(m[1]) : m[2]!.charCodeAt(0) - 0x2460 + 1, length: m[0].length }
}

/** What makes two options the same: case and spaces aside. */
const keyOf = (text: string) => text.toLowerCase().replace(/\s/g, '')

/**
 * Option texts as stored: one line in NFC, trimmed, at most 40 characters,
 * blanks and repeats (ignoring case and spaces) left out. Numbering goes
 * only when every option is numbered 1, 2, 3… in order (writers like to
 * number them); "23번 김철수" on its own is a name with a number and keeps it.
 */
export function cleanOptions(options: readonly string[]): string[] {
  const lines: string[] = []
  const exact = new Set<string>()
  for (const raw of options) {
    // Zero-width characters count as nothing, so an invisible option is blank.
    const line = raw.normalize('NFC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim()
    // An exact repeat goes first, so "1. 가 / 2. 나 / 2. 나" still reads as numbered.
    if (!line || exact.has(keyOf(line))) continue
    exact.add(keyOf(line))
    lines.push(line)
  }
  const numbers = lines.map(numbering)
  const numbered = numbers.every((x, i) => x !== null && x.n === i + 1)
  const out: string[] = []
  const seen = new Set<string>()
  lines.forEach((line, i) => {
    const bare = numbered ? line.slice(numbers[i]!.length).trim() : ''
    // Cut by whole characters (an emoji is one), never inside one.
    const text = Array.from(bare || line).slice(0, POLL_OPTION_MAX).join('').trim()
    const key = keyOf(text)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(text)
  })
  return out
}
